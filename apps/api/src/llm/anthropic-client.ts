import Anthropic from '@anthropic-ai/sdk';
import type { LlmEnv } from '@near-autopilot/config';
import type { LlmClient } from '@near-autopilot/orchestrator';

export interface AnthropicLlmConfig {
  readonly model: string;
  readonly maxTokens: number;
}

/**
 * `LlmClient` over the Anthropic Messages API. A truncated, refused or empty reply throws, so the caller falls back
 * to heuristics instead of parsing half an answer.
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
    if (reply.stop_reason === 'max_tokens' || reply.stop_reason === 'refusal') {
      throw new Error(`LLM reply stopped on ${reply.stop_reason}`);
    }
    const text = reply.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    if (!text.trim()) throw new Error('LLM reply is empty');
    return text;
  }
}

/** null when no key is configured: the LLM is off and only heuristics run. */
export function anthropicLlmFromEnv(env: LlmEnv): LlmClient | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  return new AnthropicLlmClient(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }), {
    model: env.ANTHROPIC_MODEL,
    maxTokens: env.ANTHROPIC_MAX_TOKENS,
  });
}
