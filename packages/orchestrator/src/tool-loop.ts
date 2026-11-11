import type { z } from 'zod';
import type { LlmToolSpec, ToolCall, ToolLlm, ToolResult } from './ports';

export interface LoopTool {
  readonly spec: LlmToolSpec;
  /** The model's arguments are untrusted: anything this schema rejects is answered with an error, never run. */
  readonly input: z.ZodType;
  run(input: unknown): Promise<unknown>;
}

export interface ToolTraceEntry {
  readonly tool: string;
  readonly ok: boolean;
  readonly output: unknown;
}

/** More calls than any honest answer needs: a looping or manipulated model. */
export const MAX_CALLS_PER_TURN = 10;

export class ToolLoopError extends Error {
  override readonly name = 'ToolLoopError';
}

/**
 * The central-LLM loop: the model asks for tools, we run them and hand back their output, until it answers in text.
 * Bounded by `maxTurns` model calls; going over it is an error so the caller falls back instead of looping forever.
 */
export async function runToolLoop(args: {
  readonly llm: ToolLlm;
  readonly system: string;
  readonly prompt: string;
  readonly tools: readonly LoopTool[];
  readonly maxTurns: number;
  /** Once aborted, no further model call is made (a call already in flight still finishes). */
  readonly signal?: AbortSignal;
}): Promise<{ text: string; trace: ToolTraceEntry[] }> {
  const byName = new Map(args.tools.map((t) => [t.spec.name, t] as const));
  const chat = args.llm.open({
    system: args.system,
    prompt: args.prompt,
    tools: args.tools.map((t) => t.spec),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  const trace: ToolTraceEntry[] = [];
  let results: ToolResult[] | null = null;

  for (let turn = 0; turn < args.maxTurns; turn++) {
    if (args.signal?.aborted) throw new ToolLoopError('aborted');
    const reply = await chat.send(results);
    if (reply.kind === 'final') return { text: reply.text, trace };
    if (reply.calls.length > MAX_CALLS_PER_TURN)
      throw new ToolLoopError(`model asked for ${reply.calls.length} tool calls in one turn`);
    if (reply.calls.length === 0)
      throw new ToolLoopError('model asked for no tool and gave no answer');
    const done = await Promise.all(
      reply.calls.map(async (call) => ({ id: call.id, entry: await execute(byName, call) })),
    );
    trace.push(...done.map((d) => d.entry));
    results = done.map(({ id, entry }) => ({
      id,
      content: JSON.stringify(entry.output),
      isError: !entry.ok,
    }));
  }
  throw new ToolLoopError(`no answer within ${args.maxTurns} turns`);
}

async function execute(byName: Map<string, LoopTool>, call: ToolCall): Promise<ToolTraceEntry> {
  const tool = byName.get(call.name);
  if (!tool) return { tool: call.name, ok: false, output: { error: 'unknown tool' } };
  const input = tool.input.safeParse(call.input);
  if (!input.success) return { tool: call.name, ok: false, output: { error: 'invalid input' } };
  try {
    return { tool: call.name, ok: true, output: await tool.run(input.data) };
  } catch {
    return { tool: call.name, ok: false, output: { error: 'tool failed' } };
  }
}
