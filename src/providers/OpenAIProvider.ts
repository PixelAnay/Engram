/**
 * providers/OpenAIProvider.ts
 *
 * OpenAI-compatible adapter. Covers ~90% of providers:
 *   OpenAI, DeepSeek, Mistral, Groq, xAI, Together, Moonshot, Qwen,
 *   Perplexity, Cohere, Ollama, LM Studio, llama.cpp, OpenRouter,
 *   and Google Gemini (via its OpenAI-compat shim).
 *
 * Auth: Authorization: Bearer <apiKey>  (empty string ok for local providers)
 * Streaming: SSE  data: {...}  \u2026  data: [DONE]
 */

import type { AIProvider, StreamOptions, ProviderStatus } from './types';
import type { ChatMessage, StreamChunk, ToolCall } from '../types';
import { requestUrl } from 'obsidian';
import { sanitizeForApi } from './sanitize';

// ─── Raw SSE types ────────────────────────────────────────────────────────────

interface DeltaToolCall {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface StreamDelta {
  content?: string | null;
  tool_calls?: DeltaToolCall[];
}

interface StreamChoice {
  delta: StreamDelta;
  finish_reason: string | null;
}

interface RawStreamChunk {
  choices: StreamChoice[];
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class OpenAIProvider implements AIProvider {
  readonly name: string;
  readonly supportsTools = true;

  private baseUrl: string;
  private apiKey: string;

  constructor(name: string, baseUrl: string, apiKey: string) {
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  // ── Health check ────────────────────────────────────────────────────────────

  async healthCheck(model?: string): Promise<ProviderStatus> {
    const start = Date.now();
    try {
      // Always a free GET /models — never a billable chat completion.
      const res = await requestUrl({
        url: `${this.baseUrl}/models`,
        method: 'GET',
        headers: this.headers(),
        throw: false,
      });

      if (res.status !== 200) {
        const errMsg = (res.json as { error?: { message?: string } } | null)?.error?.message || `HTTP ${res.status}`;
        throw new Error(errMsg);
      }

      const data = res.json as { data?: Array<{ id: string }> };
      const ids = (data?.data ?? []).map(m => m.id);
      if (model) {
        const bare = (id: string) => id.replace(/^models\//, '');
        const found = ids.length === 0 || ids.some(id => id === model || bare(id) === bare(model));
        return { ok: true, model, latencyMs: Date.now() - start, modelFound: found };
      }
      return { ok: true, model: ids[0] ?? 'unknown', latencyMs: Date.now() - start };
    } catch (e) {
      throw new Error(`Connection failed: ${(e as Error).message}`);
    }
  }

  // ── List models ─────────────────────────────────────────────────────────────

  async listModels(): Promise<string[]> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/models`,
        method: 'GET',
        headers: this.headers(),
        throw: false,
      });
      if (res.status !== 200) return [];
      const data = res.json as { data?: Array<{ id: string }> };
      return (data?.data ?? []).map(m => m.id);
    } catch {
      return [];
    }
  }

  // ── Stream ──────────────────────────────────────────────────────────────────

  async stream(
    messages: ChatMessage[],
    options: StreamOptions,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<{ toolCalls: ToolCall[]; text: string; finishReason: string | null }> {
    // Strict OpenAI-compat providers (DeepSeek, Mistral, Qwen, ...) reject empty
    // assistant messages, unknown fields and unanswered tool calls. Clean the history.
    const sanitizedMessages = sanitizeForApi(messages, options.toolCallingMode);

    const body: Record<string, unknown> = {
      model: options.model,
      messages: sanitizedMessages,
      stream: true,
      temperature: options.temperature,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice ?? 'auto';
    }

    if (options.maxTokens) {
      // OpenAI's own API renamed the parameter (newer models reject max_tokens);
      // compatible servers still expect max_tokens.
      if (/(^|\/\/)api\.openai\.com/.test(this.baseUrl)) body.max_completion_tokens = options.maxTokens;
      else body.max_tokens = options.maxTokens;
    }

    let response: Response;
    try {
      // Use native fetch for streaming (requestUrl doesn't support SSE streaming)
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers(),
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        onChunk({ type: 'done' });
        return { toolCalls: [], text: '', finishReason: 'abort' };
      }
      const msg = `Connection failed: ${(e as Error).message}`;
      onChunk({ type: 'error', error: msg });
      return { toolCalls: [], text: '', finishReason: 'error' };
    }

    if (!response.ok) {
      const text = await response.text();
      const msg = `Provider error ${response.status}: ${text.slice(0, 300)}`;
      onChunk({ type: 'error', error: msg });
      return { toolCalls: [], text: '', finishReason: 'error' };
    }

    if (!response.body) {
      onChunk({ type: 'error', error: 'No response body' });
      return { toolCalls: [], text: '', finishReason: 'error' };
    }

    // Parse SSE stream
    let assistantText = '';
    let finishReason: string | null = null;
    const partialToolCalls: Record<number, { id: string; name: string; args: string }> = {};

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // Normalize carriage returns to avoid trailing \r (M-20)
        const normalizedBuffer = buffer.replace(/\r\n/g, '\n');
        const lines = normalizedBuffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') { finishReason = finishReason ?? 'stop'; continue; }

          let chunk: RawStreamChunk;
          try { chunk = JSON.parse(payload) as RawStreamChunk; } catch { continue; }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta;

          if (delta.content !== undefined && delta.content !== null) {
            assistantText += delta.content;
            onChunk({ type: 'token', content: delta.content });
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!partialToolCalls[tc.index]) {
                partialToolCalls[tc.index] = { id: tc.id ?? '', name: '', args: '' };
              }
              if (tc.function?.name) partialToolCalls[tc.index].name += tc.function.name;
              if (tc.function?.arguments) partialToolCalls[tc.index].args += tc.function.arguments;
              if (tc.id) partialToolCalls[tc.index].id = tc.id;
            }
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        onChunk({ type: 'done' });
        return { toolCalls: [], text: assistantText, finishReason: 'abort' };
      }
      throw e;
    } finally {
      if (reader) {
        try {
          reader.cancel().catch(() => { /* ignored */ });
        } catch {
          // Ignored
        }
      }
    }

    const toolCalls: ToolCall[] = Object.values(partialToolCalls)
      .filter(tc => tc.name)
      .map(tc => ({
        id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.args },
      }));

    return { toolCalls, text: assistantText, finishReason };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      h['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return h;
  }
}
