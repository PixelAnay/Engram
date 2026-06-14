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

import type { AIProvider, StreamOptions, ToolDefinition, ProviderStatus } from './types';
import type { ChatMessage, StreamChunk, ToolCall } from '../types';
import { requestUrl } from 'obsidian';

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

  async healthCheck(): Promise<ProviderStatus> {
    const start = Date.now();
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/models`,
        method: 'GET',
        headers: this.headers(),
        throw: false,
      });

      if (res.status !== 200) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = res.json as { data?: Array<{ id: string }> };
      const model = data?.data?.[0]?.id ?? 'unknown';
      return { ok: true, model, latencyMs: Date.now() - start };
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
    const body: Record<string, unknown> = {
      model: options.model || undefined,
      messages,
      stream: true,
      temperature: options.temperature,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice ?? 'auto';
    }

    if (options.maxTokens) {
      body.max_tokens = options.maxTokens;
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

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
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

          if (delta.content) {
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
    }

    const toolCalls: ToolCall[] = Object.values(partialToolCalls).map(tc => ({
      id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
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
