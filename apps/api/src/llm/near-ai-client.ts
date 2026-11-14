import type { NearAiEnv } from '@near-autopilot/config';
import type { LlmToolTurn, ToolChat, ToolLlm } from '@near-autopilot/orchestrator';

const ENDPOINT = 'https://cloud-api.near.ai/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 120_000;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
}

interface NearAiConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly fetchImpl?: typeof fetch;
}

/** OpenAI-compatible NEAR AI Cloud adapter for Autopilot's client-executed tool loop. */
export class NearAiToolLlm implements ToolLlm {
  constructor(private readonly config: NearAiConfig) {}

  open(request: Parameters<ToolLlm['open']>[0]): ToolChat {
    const messages: ChatMessage[] = [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ];
    const tools = request.tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
    const fetchImpl = this.config.fetchImpl ?? fetch;

    return {
      send: async (results): Promise<LlmToolTurn> => {
        if (results) {
          for (const result of results) {
            messages.push({
              role: 'tool',
              tool_call_id: result.id,
              content: result.isError ? `Tool error: ${result.content}` : result.content,
            });
          }
        }

        const signal = request.signal
          ? AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            'content-type': 'application/json',
          },
          signal,
          body: JSON.stringify({
            model: this.config.model,
            max_tokens: this.config.maxTokens,
            messages,
            tools,
            tool_choice: 'auto',
          }),
        });
        if (!response.ok) {
          const requestId = response.headers.get('x-request-id');
          throw new Error(
            `NEAR AI request failed (HTTP ${response.status}${requestId ? `, request ${requestId}` : ''})`,
          );
        }

        const body = (await response.json()) as {
          choices?: {
            finish_reason?: string | null;
            message?: {
              content?: string | null;
              tool_calls?: {
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }[];
            };
          }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const choice = body.choices?.[0];
        const message = choice?.message;
        if (!choice || !message) throw new Error('NEAR AI returned no chat completion choice');

        if (body.usage) {
          request.onUsage?.({
            inputTokens: body.usage.prompt_tokens ?? 0,
            outputTokens: body.usage.completion_tokens ?? 0,
          });
        }

        const calls = message.tool_calls ?? [];
        if (calls.length > 0) {
          const normalized = calls.map((call) => {
            const name = call.function?.name;
            const id = call.id;
            const raw = call.function?.arguments;
            if (!id || !name || raw === undefined)
              throw new Error('NEAR AI returned an incomplete tool call');
            let input: unknown;
            try {
              input = JSON.parse(raw);
            } catch {
              throw new Error(`NEAR AI returned invalid arguments for tool ${name}`);
            }
            return { id, name, input };
          });
          messages.push({
            role: 'assistant',
            content: message.content ?? null,
            tool_calls: calls.map((call) => ({
              id: call.id!,
              type: 'function',
              function: {
                name: call.function!.name!,
                arguments: call.function!.arguments!,
              },
            })),
          });
          return { kind: 'tool_calls', calls: normalized };
        }

        if (choice.finish_reason !== 'stop')
          throw new Error(`NEAR AI reply stopped on ${choice.finish_reason ?? 'unknown reason'}`);
        if (!message.content?.trim()) throw new Error('NEAR AI reply is empty');
        messages.push({ role: 'assistant', content: message.content });
        return { kind: 'final', text: message.content };
      },
    };
  }
}

/** No key means heuristic-only analysis, matching the existing server fallback behavior. */
export function nearAiToolLlmFromEnv(env: NearAiEnv): ToolLlm | null {
  if (!env.NEAR_AI_API_KEY) return null;
  return new NearAiToolLlm({
    apiKey: env.NEAR_AI_API_KEY,
    model: env.NEAR_AI_MODEL,
    maxTokens: env.NEAR_AI_MAX_TOKENS,
  });
}
