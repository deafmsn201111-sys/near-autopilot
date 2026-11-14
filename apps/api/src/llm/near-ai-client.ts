import type { LlmEnv } from '@near-autopilot/config';
import type { LlmToolTurn, ToolChat, ToolLlm } from '@near-autopilot/orchestrator';
import { z } from 'zod';

/** NEAR AI Cloud gateway (OpenAI-compatible). Hard-coded: the key is only ever sent here. */
export const NEAR_AI_URL = 'https://cloud-api.near.ai/v1';
const TIMEOUT_MS = 120_000;
/** Measured (#232): by default GLM 5.3 Flash reasons until max_tokens (~60 s); `low` answers the same in ~2 s. */
const REASONING_EFFORT = 'low';

export interface NearAiLlmConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens: number;
}

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const completionSchema = z.object({
  id: z.string(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z.array(toolCallSchema).nullish(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).optional(),
});

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: z.infer<typeof toolCallSchema>[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * `ToolLlm` over NEAR AI Cloud chat completions, with plain `fetch` so the exact request and response bytes stay ours
 * (the TEE signature covers them). `x-no-aliasing` makes the gateway refuse rather than reroute to another model. Any
 * finish other than a final answer or a tool request throws, so the caller falls back to the labelled heuristics.
 */
export class NearAiToolLlm implements ToolLlm {
  constructor(
    private readonly fetch: typeof globalThis.fetch,
    private readonly config: NearAiLlmConfig,
  ) {}

  open(request: Parameters<ToolLlm['open']>[0]): ToolChat {
    const messages: ChatMessage[] = [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ];
    const tools = request.tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    return {
      send: async (results): Promise<LlmToolTurn> => {
        for (const r of results ?? [])
          messages.push({
            role: 'tool',
            tool_call_id: r.id,
            content: r.isError ? `Error: ${r.content}` : r.content,
          });
        const reply = await this.post(
          {
            model: this.config.model,
            max_tokens: this.config.maxTokens,
            reasoning_effort: REASONING_EFFORT,
            messages,
            ...(tools.length ? { tools } : {}),
          },
          request.signal,
        );
        if (reply.usage)
          request.onUsage?.({
            inputTokens: reply.usage.prompt_tokens,
            outputTokens: reply.usage.completion_tokens,
          });
        const { finish_reason, message } = reply.choices[0]!;
        if (finish_reason === 'tool_calls' && message.tool_calls?.length) {
          messages.push({
            role: 'assistant',
            content: message.content ?? null,
            tool_calls: message.tool_calls,
          });
          const calls = message.tool_calls.map((c) => ({
            id: c.id,
            name: c.function.name,
            input: JSON.parse(c.function.arguments) as unknown,
          }));
          return { kind: 'tool_calls', calls };
        }
        if (finish_reason !== 'stop') throw new Error(`LLM reply stopped on ${finish_reason}`);
        const text = message.content ?? '';
        if (!text.trim()) throw new Error('LLM reply is empty');
        return { kind: 'final', text };
      },
    };
  }

  /** No retry: a retried request is billed, but only the last reply's usage would be seen. */
  private async post(body: unknown, signal: AbortSignal | undefined) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const res = await this.fetch(`${NEAR_AI_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
        'x-no-aliasing': 'true',
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await res.text();
    // The body is not echoed: it may carry account details and ends up in logs.
    if (!res.ok) throw new Error(`NEAR AI Cloud answered HTTP ${res.status}`);
    return completionSchema.parse(JSON.parse(text));
  }
}

/** null when no key is configured: the analysis endpoint answers with the heuristic recommendations. */
export function nearAiToolLlmFromEnv(env: LlmEnv): ToolLlm | null {
  if (!env.NEAR_AI_API_KEY) return null;
  return new NearAiToolLlm(globalThis.fetch, {
    apiKey: env.NEAR_AI_API_KEY,
    model: env.LLM_MODEL,
    maxTokens: env.LLM_MAX_TOKENS,
  });
}
