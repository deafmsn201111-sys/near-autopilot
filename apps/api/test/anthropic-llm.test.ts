import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicLlmClient, anthropicLlmFromEnv } from '../src/llm/anthropic-client';

function fakeSdk(response: Partial<Anthropic.Message>) {
  const create = vi.fn().mockResolvedValue({ stop_reason: 'end_turn', ...response });
  return { sdk: { messages: { create } } as unknown as Anthropic, create };
}

const config = { model: 'claude-haiku-5-5', maxTokens: 4096 };
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as Anthropic.TextBlock;

describe('AnthropicLlmClient', () => {
  it('sends the prompt as one user message with the configured model and max_tokens', async () => {
    const { sdk, create } = fakeSdk({ content: [text('{"a":'), text('1}')] });
    const reply = await new AnthropicLlmClient(sdk, config).complete('hello');
    expect(reply).toBe('{"a":1}');
    expect(create).toHaveBeenCalledWith({
      model: 'claude-haiku-5-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it.each(['max_tokens', 'refusal', 'model_context_window_exceeded', 'pause_turn'] as const)(
    'fails closed when the reply stops on %s',
    async (stop_reason) => {
      const { sdk } = fakeSdk({ stop_reason, content: [text('{"partial":')] });
      await expect(new AnthropicLlmClient(sdk, config).complete('p')).rejects.toThrow(stop_reason);
    },
  );

  it.each([[[]], [[text('  \n')]]])('fails closed on an empty reply', async (content) => {
    const { sdk } = fakeSdk({ content });
    await expect(new AnthropicLlmClient(sdk, config).complete('p')).rejects.toThrow('empty');
  });

  it('returns only the text blocks', async () => {
    const thinking = {
      type: 'thinking',
      thinking: 'secret',
      signature: 's',
    } as Anthropic.ThinkingBlock;
    const { sdk } = fakeSdk({ content: [thinking, text('{}')] });
    await expect(new AnthropicLlmClient(sdk, config).complete('p')).resolves.toBe('{}');
  });
});

describe('anthropicLlmFromEnv', () => {
  const env = { ANTHROPIC_MODEL: 'claude-haiku-5-5', ANTHROPIC_MAX_TOKENS: 4096 };

  it('is null without a key (LLM off)', () => {
    expect(anthropicLlmFromEnv({ ...env, ANTHROPIC_API_KEY: undefined })).toBeNull();
  });

  it('builds a client with the configured model and cap when a key is set', () => {
    const client = anthropicLlmFromEnv({ ...env, ANTHROPIC_API_KEY: 'sk-test-key' });
    expect(client).toBeInstanceOf(AnthropicLlmClient);
    expect(client).toMatchObject({ config: { model: 'claude-haiku-5-5', maxTokens: 4096 } });
  });
});
