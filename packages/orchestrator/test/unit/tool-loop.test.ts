import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ToolLoopError,
  runToolLoop,
  type LlmToolTurn,
  type ToolChat,
  type ToolLlm,
  type ToolResult,
} from '../../src';

/** A fake model that plays back a fixed script and records what it was sent. */
function scripted(turns: LlmToolTurn[]) {
  const sent: (readonly ToolResult[] | null)[] = [];
  const opened: { system: string; prompt: string; tools: string[] }[] = [];
  const llm: ToolLlm = {
    open(req): ToolChat {
      opened.push({ system: req.system, prompt: req.prompt, tools: req.tools.map((t) => t.name) });
      let i = 0;
      return {
        async send(results) {
          sent.push(results);
          const turn = turns[i++];
          if (!turn) throw new Error('script exhausted');
          return turn;
        },
      };
    },
  };
  return { llm, sent, opened };
}

const echo = {
  spec: {
    name: 'echo',
    description: 'returns its input',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  input: z.object({}).strict(),
  run: async () => ({ ok: 1 }),
};

describe('runToolLoop', () => {
  it('runs the requested tools, returns their results to the model and ends on its final text', async () => {
    const { llm, sent, opened } = scripted([
      { kind: 'tool_calls', calls: [{ id: 'a', name: 'echo', input: {} }] },
      { kind: 'final', text: 'done' },
    ]);
    const out = await runToolLoop({ llm, system: 's', prompt: 'p', tools: [echo], maxTurns: 4 });
    expect(out.text).toBe('done');
    expect(out.trace).toEqual([{ tool: 'echo', ok: true, output: { ok: 1 } }]);
    expect(opened[0]?.tools).toEqual(['echo']);
    expect(sent[0]).toBeNull();
    expect(sent[1]).toEqual([{ id: 'a', content: JSON.stringify({ ok: 1 }), isError: false }]);
  });

  it('answers an unknown tool or invalid input with an error result instead of running anything', async () => {
    const { llm, sent } = scripted([
      {
        kind: 'tool_calls',
        calls: [
          { id: 'a', name: 'sign_tx', input: {} },
          { id: 'b', name: 'echo', input: { extra: 1 } },
        ],
      },
      { kind: 'final', text: 'ok' },
    ]);
    const out = await runToolLoop({ llm, system: 's', prompt: 'p', tools: [echo], maxTurns: 4 });
    expect(sent[1]?.map((r) => r.isError)).toEqual([true, true]);
    expect(out.trace.map((t) => t.ok)).toEqual([false, false]);
  });

  it('reports a tool that throws as an error result and keeps going', async () => {
    const boom = { ...echo, run: async () => Promise.reject(new Error('rpc down')) };
    const { llm, sent } = scripted([
      { kind: 'tool_calls', calls: [{ id: 'a', name: 'echo', input: {} }] },
      { kind: 'final', text: 'ok' },
    ]);
    await runToolLoop({ llm, system: 's', prompt: 'p', tools: [boom], maxTurns: 4 });
    expect(sent[1]?.[0]).toMatchObject({ id: 'a', isError: true });
  });

  it('stops with an error once the model exceeds the turn bound', async () => {
    const call: LlmToolTurn = {
      kind: 'tool_calls',
      calls: [{ id: 'a', name: 'echo', input: {} }],
    };
    const { llm, sent } = scripted([call, call, call, call, call]);
    await expect(
      runToolLoop({ llm, system: 's', prompt: 'p', tools: [echo], maxTurns: 3 }),
    ).rejects.toBeInstanceOf(ToolLoopError);
    expect(sent).toHaveLength(3);
  });

  it('rejects a turn with no tool calls and no text as an error', async () => {
    const { llm } = scripted([{ kind: 'tool_calls', calls: [] }]);
    await expect(
      runToolLoop({ llm, system: 's', prompt: 'p', tools: [echo], maxTurns: 3 }),
    ).rejects.toBeInstanceOf(ToolLoopError);
  });
});
