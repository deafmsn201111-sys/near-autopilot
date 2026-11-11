import Anthropic from '@anthropic-ai/sdk';
import type { LlmEnv } from '@near-autopilot/config';
import type { LlmClient, LlmToolTurn, ToolChat, ToolLlm } from '@near-autopilot/orchestrator';

export interface AnthropicLlmConfig {
  readonly model: string;
  readonly maxTokens: number;
}

/**
 * `LlmClient` over the Anthropic Messages API. Any reply that did not end normally (truncated, refused, paused) or has
 * no text throws, so the caller falls back to heuristics instead of parsing half an answer.
 */
export class AnthropicLlmClient implements LlmClient {
  constructor(
    private readonly sdk: Pick<Anthropic, 'messages'>,
    private readonly config: AnthropicLlmConfig,
  ) {}

  async complete(prompt: string): Promise<string> {
    const reply = await this.sdk.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    if (reply.stop_reason !== 'end_turn') {
      throw new Error(`LLM reply stopped on ${reply.stop_reason}`);
    }
    const text = reply.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    if (!text.trim()) throw new Error('LLM reply is empty');
    return text;
  }
}

/**
 * `ToolLlm` over the Messages API with client tools. Each chat keeps the raw assistant content (thinking blocks
 * included) and replays it unchanged, as the API requires. Any stop other than a finished turn or a tool request throws.
 */
export class AnthropicToolLlm implements ToolLlm {
  constructor(
    private readonly sdk: Pick<Anthropic, 'messages'>,
    private readonly config: AnthropicLlmConfig,
  ) {}

  open(request: Parameters<ToolLlm['open']>[0]): ToolChat {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: request.prompt }];
    const tools: Anthropic.Tool[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
    return {
      send: async (results): Promise<LlmToolTurn> => {
        if (results)
          messages.push({
            role: 'user',
            content: results.map((r) => ({
              type: 'tool_result' as const,
              tool_use_id: r.id,
              content: r.content,
              is_error: r.isError,
            })),
          });
        const reply = await this.sdk.messages.create(
          {
            model: this.config.model,
            max_tokens: this.config.maxTokens,
            system: request.system,
            tools,
            messages: [...messages],
          },
          request.signal ? { signal: request.signal } : undefined,
        );
        if (reply.stop_reason === 'tool_use') {
          messages.push({ role: 'assistant', content: reply.content });
          const calls = reply.content.flatMap((b) =>
            b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : [],
          );
          return { kind: 'tool_calls', calls };
        }
        if (reply.stop_reason !== 'end_turn')
          throw new Error(`LLM reply stopped on ${reply.stop_reason}`);
        const text = reply.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
        if (!text.trim()) throw new Error('LLM reply is empty');
        return { kind: 'final', text };
      },
    };
  }
}

const sdkFromEnv = (key: string) => new Anthropic({ apiKey: key, timeout: 120_000, maxRetries: 1 });
const configFromEnv = (env: LlmEnv): AnthropicLlmConfig => ({
  model: env.ANTHROPIC_MODEL,
  maxTokens: env.ANTHROPIC_MAX_TOKENS,
});

/** null when no key is configured: the LLM is off and only heuristics run. */
export function anthropicLlmFromEnv(env: LlmEnv): LlmClient | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  return new AnthropicLlmClient(sdkFromEnv(env.ANTHROPIC_API_KEY), configFromEnv(env));
}

/** null when no key is configured: the analysis endpoint answers with the heuristic recommendations. */
export function anthropicToolLlmFromEnv(env: LlmEnv): ToolLlm | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  return new AnthropicToolLlm(sdkFromEnv(env.ANTHROPIC_API_KEY), configFromEnv(env));
}
