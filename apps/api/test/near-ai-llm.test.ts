import { describe, expect, it, vi } from 'vitest';
import { NEAR_AI_URL, NearAiToolLlm, nearAiToolLlmFromEnv } from '../src/llm/near-ai-client';

const config = { apiKey: 'sk-test-key', model: 'z-ai/glm-5.3-flash', maxTokens: 4096 };
const tool = {
  name: 'echo',
  description: 'd',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};
const call = (id: string) => ({
  id,
  type: 'function',
  function: { name: 'echo', arguments: '{"a":1}' },
});
const reply = (
  finish_reason: string,
  message: Record<string, unknown>,
  usage = { prompt_tokens: 10, completion_tokens: 2 },
) => ({ id: 'chat-1', choices: [{ finish_reason, message }], usage });

function fakeFetch(...bodies: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const body of bodies)
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
  return fetch;
}
const sentBody = (fetch: ReturnType<typeof fakeFetch>, n: number) =>
  JSON.parse(fetch.mock.calls[n]?.[1]?.body as string) as Record<string, unknown>;

describe('NearAiToolLlm', () => {
  it('posts system, prompt and tools to the gateway with the canonical model and no aliasing', async () => {
    const fetch = fakeFetch(reply('stop', { role: 'assistant', content: '{"picks":[]}' }));
    const turn = await new NearAiToolLlm(fetch, config)
      .open({ system: 'sys', prompt: 'go', tools: [tool] })
      .send(null);

    expect(turn).toEqual({ kind: 'final', text: '{"picks":[]}' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${NEAR_AI_URL}/chat/completions`);
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer sk-test-key',
      'content-type': 'application/json',
      'x-no-aliasing': 'true',
    });
    expect(sentBody(fetch, 0)).toEqual({
      model: 'z-ai/glm-5.3-flash',
      max_tokens: 4096,
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'go' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'echo', description: 'd', parameters: tool.inputSchema },
        },
      ],
    });
  });

  it('returns tool calls with parsed input, then replays the assistant turn and the tool results', async () => {
    const fetch = fakeFetch(
      reply('tool_calls', { role: 'assistant', content: null, tool_calls: [call('t1')] }),
      reply('stop', { role: 'assistant', content: '{"picks":[]}' }),
    );
    const chat = new NearAiToolLlm(fetch, config).open({ system: 's', prompt: 'p', tools: [tool] });

    await expect(chat.send(null)).resolves.toEqual({
      kind: 'tool_calls',
      calls: [{ id: 't1', name: 'echo', input: { a: 1 } }],
    });
    await expect(chat.send([{ id: 't1', content: '{"ok":1}', isError: false }])).resolves.toEqual({
      kind: 'final',
      text: '{"picks":[]}',
    });
    expect(sentBody(fetch, 1).messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'p' },
      { role: 'assistant', content: null, tool_calls: [call('t1')] },
      { role: 'tool', tool_call_id: 't1', content: '{"ok":1}' },
    ]);
  });

  it('reads tool calls that finish on stop, and blank arguments as no input', async () => {
    const blank = { ...call('t1'), function: { name: 'echo', arguments: '' } };
    const fetch = fakeFetch(
      reply('stop', { role: 'assistant', content: null, tool_calls: [blank] }),
    );
    await expect(
      new NearAiToolLlm(fetch, config).open({ system: 's', prompt: 'p', tools: [tool] }).send(null),
    ).resolves.toEqual({ kind: 'tool_calls', calls: [{ id: 't1', name: 'echo', input: {} }] });
  });

  it('reports the usage of a reply whose body then fails the schema', async () => {
    const fetch = fakeFetch({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 40 } });
    const usage: unknown[] = [];
    await expect(
      new NearAiToolLlm(fetch, config)
        .open({ system: 's', prompt: 'p', tools: [], onUsage: (u) => usage.push(u) })
        .send(null),
    ).rejects.toThrow();
    expect(usage).toEqual([{ inputTokens: 900, outputTokens: 40 }]);
  });

  it('marks a failed tool result as an error for the model', async () => {
    const fetch = fakeFetch(
      reply('tool_calls', { role: 'assistant', content: null, tool_calls: [call('t1')] }),
      reply('stop', { role: 'assistant', content: '{}' }),
    );
    const chat = new NearAiToolLlm(fetch, config).open({ system: 's', prompt: 'p', tools: [tool] });
    await chat.send(null);
    await chat.send([{ id: 't1', content: 'boom', isError: true }]);
    expect((sentBody(fetch, 1).messages as unknown[])[3]).toEqual({
      role: 'tool',
      tool_call_id: 't1',
      content: 'Error: boom',
    });
  });

  it.each(['length', 'content_filter', 'unknown'])(
    'fails closed on finish_reason %s',
    async (r) => {
      const fetch = fakeFetch(reply(r, { role: 'assistant', content: 'x' }));
      await expect(
        new NearAiToolLlm(fetch, config).open({ system: 's', prompt: 'p', tools: [] }).send(null),
      ).rejects.toThrow(r);
    },
  );

  it('fails closed on an empty final text', async () => {
    const fetch = fakeFetch(reply('stop', { role: 'assistant', content: '  ' }));
    await expect(
      new NearAiToolLlm(fetch, config).open({ system: 's', prompt: 'p', tools: [] }).send(null),
    ).rejects.toThrow('empty');
  });

  it('fails closed on tool arguments that are not JSON', async () => {
    const bad = { ...call('t1'), function: { name: 'echo', arguments: '{oops' } };
    const fetch = fakeFetch(reply('tool_calls', { role: 'assistant', tool_calls: [bad] }));
    await expect(
      new NearAiToolLlm(fetch, config).open({ system: 's', prompt: 'p', tools: [tool] }).send(null),
    ).rejects.toThrow();
  });

  it('fails closed on an HTTP error without echoing the body', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{"error":"secret detail"}', { status: 402 }));
    const send = new NearAiToolLlm(fetch, config)
      .open({ system: 's', prompt: 'p', tools: [] })
      .send(null);
    await expect(send).rejects.toThrow('402');
    await expect(send).rejects.not.toThrow('secret');
  });

  it('fails closed on a reply without usage, so the call is booked at its worst case', async () => {
    const { usage: _, ...noUsage } = reply('stop', { role: 'assistant', content: '{}' });
    const fetch = fakeFetch(noUsage);
    await expect(
      new NearAiToolLlm(fetch, config).open({ system: 's', prompt: 'p', tools: [] }).send(null),
    ).rejects.toThrow();
  });

  it('fails closed on a 200 that is not JSON without echoing the body', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('<html>alice.near holds', { status: 200 }));
    const send = new NearAiToolLlm(fetch, config)
      .open({ system: 's', prompt: 'p', tools: [] })
      .send(null);
    await expect(send).rejects.toThrow('reply is not JSON');
    await expect(send).rejects.not.toThrow('alice');
  });

  it('fails closed on a reply that is not a chat completion', async () => {
    const fetch = fakeFetch({ choices: [] });
    await expect(
      new NearAiToolLlm(fetch, config).open({ system: 's', prompt: 'p', tools: [] }).send(null),
    ).rejects.toThrow();
  });

  it('reports the usage of every reply, also one that then fails closed', async () => {
    const fetch = fakeFetch(
      reply(
        'tool_calls',
        { role: 'assistant', tool_calls: [call('t1')] },
        { prompt_tokens: 1200, completion_tokens: 80 },
      ),
      reply(
        'length',
        { role: 'assistant', content: '{"pi' },
        { prompt_tokens: 1500, completion_tokens: 4096 },
      ),
    );
    const usage: unknown[] = [];
    const chat = new NearAiToolLlm(fetch, config).open({
      system: 's',
      prompt: 'p',
      tools: [tool],
      onUsage: (u) => usage.push(u),
    });
    await chat.send(null);
    await expect(chat.send([{ id: 't1', content: '{}', isError: false }])).rejects.toThrow();
    expect(usage).toEqual([
      { inputTokens: 1200, outputTokens: 80 },
      { inputTokens: 1500, outputTokens: 4096 },
    ]);
  });

  it('aborts on the caller signal', async () => {
    const fetch = fakeFetch(reply('stop', { role: 'assistant', content: '{}' }));
    const controller = new AbortController();
    await new NearAiToolLlm(fetch, config)
      .open({ system: 's', prompt: 'p', tools: [], signal: controller.signal })
      .send(null);
    const signal = fetch.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe('nearAiToolLlmFromEnv', () => {
  const env = {
    LLM_MODEL: 'z-ai/glm-5.3-flash' as const,
    LLM_MAX_TOKENS: 4096,
    LLM_DAILY_CAP_USD: 5,
  };

  it('is off without a key', () => {
    expect(nearAiToolLlmFromEnv({ ...env, NEAR_AI_API_KEY: undefined })).toBeNull();
  });

  it('builds the client from the key, model and max tokens', () => {
    const llm = nearAiToolLlmFromEnv({ ...env, NEAR_AI_API_KEY: 'sk-test-key' });
    expect(llm).toBeInstanceOf(NearAiToolLlm);
    expect(llm).toMatchObject({ config: { model: 'z-ai/glm-5.3-flash', maxTokens: 4096 } });
  });
});
