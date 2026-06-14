/**
 * providers/AnthropicProvider.ts
 *
 * Adapter for Anthropic's Messages API (/v1/messages).
 * Claude is the only major provider that doesn't offer an OpenAI-compat endpoint.
 *
 * Key differences from OpenAI:
 *  - Auth: x-api-key header + anthropic-version header
 *  - system prompt is top-level, NOT a message in the array
 *  - Strict user↔assistant alternation (consecutive same-role msgs merged)
 *  - Tool results sent as user messages with type:'tool_result' content blocks
 *  - SSE uses typed events: content_block_delta, message_stop (no [DONE])
 *  - max_tokens is REQUIRED
 *  - Tool use format: input_schema (not parameters), tool_use response block
 */

import type { AIProvider, StreamOptions, ProviderStatus } from './types';
import type { ChatMessage, StreamChunk, ToolCall } from '../types';
import { requestUrl } from 'obsidian';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

// ─── Anthropic-specific types ─────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: {
    type: string;
    text?: string;
    partial_json?: string;
  };
  content_block?: {
    type: string;
    id?: string;
    name?: string;
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class AnthropicProvider implements AIProvider {
  readonly name = 'Anthropic';
  readonly supportsTools = true;

  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  // ── Health check ────────────────────────────────────────────────────────────

  async healthCheck(): Promise<ProviderStatus> {
    const start = Date.now();
    // Anthropic has no /models list endpoint — do a tiny completion instead
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/v1/messages`,
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        throw: false,
      });

      if (res.status === 200 || res.status === 400) {
        // 400 might be model not found but connection works
        const model = (res.json as any)?.model ?? 'claude';
        return { ok: true, model, latencyMs: Date.now() - start };
      }
      throw new Error(`HTTP ${res.status}: ${res.text?.slice(0, 200)}`);
    } catch (e) {
      throw new Error(`Anthropic connection failed: ${(e as Error).message}`);
    }
  }

  async listModels(): Promise<string[]> {
    // Anthropic doesn't expose a /models endpoint — return known models
    return [
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
    ];
  }

  // ── Stream ──────────────────────────────────────────────────────────────────

  async stream(
    messages: ChatMessage[],
    options: StreamOptions,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<{ toolCalls: ToolCall[]; text: string; finishReason: string | null }> {
    // Extract system message
    const systemMsg = messages.find(m => m.role === 'system');
    const system = systemMsg ? (typeof systemMsg.content === 'string' ? systemMsg.content : '') : '';

    // Convert messages to Anthropic format (skip system, merge same-role)
    const anthropicMessages = this.convertMessages(messages.filter(m => m.role !== 'system'));

    // Convert tool definitions to Anthropic format
    const tools = options.tools?.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));

    const body: Record<string, unknown> = {
      model: options.model || 'claude-sonnet-4-5',
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      temperature: options.temperature,
      messages: anthropicMessages,
    };

    if (system) body.system = system;
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = { type: 'auto' };
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
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
      onChunk({ type: 'error', error: `Anthropic error ${response.status}: ${text.slice(0, 300)}` });
      return { toolCalls: [], text: '', finishReason: 'error' };
    }

    if (!response.body) {
      onChunk({ type: 'error', error: 'No response body' });
      return { toolCalls: [], text: '', finishReason: 'error' };
    }

    // Parse Anthropic SSE
    let assistantText = '';
    let finishReason: string | null = null;
    const toolUseBlocks: Record<number, { id: string; name: string; args: string }> = {};
    let currentBlockIndex = -1;

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
          if (trimmed.startsWith('event:')) continue; // skip event type lines
          if (!trimmed.startsWith('data:')) continue;

          const payload = trimmed.slice(5).trim();
          let event: AnthropicStreamEvent;
          try { event = JSON.parse(payload) as AnthropicStreamEvent; } catch { continue; }

          switch (event.type) {
            case 'content_block_start':
              currentBlockIndex = event.index ?? 0;
              if (event.content_block?.type === 'tool_use') {
                toolUseBlocks[currentBlockIndex] = {
                  id: event.content_block.id ?? '',
                  name: event.content_block.name ?? '',
                  args: '',
                };
              }
              break;

            case 'content_block_delta':
              if (!event.delta) break;
              if (event.delta.type === 'text_delta' && event.delta.text) {
                assistantText += event.delta.text;
                onChunk({ type: 'token', content: event.delta.text });
              } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
                const idx = event.index ?? currentBlockIndex;
                if (toolUseBlocks[idx]) {
                  toolUseBlocks[idx].args += event.delta.partial_json;
                }
              }
              break;

            case 'message_delta':
              if ((event as any).delta?.stop_reason) {
                finishReason = (event as any).delta.stop_reason;
              }
              break;

            case 'message_stop':
              finishReason = finishReason ?? 'end_turn';
              break;
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

    // Convert tool_use blocks to our ToolCall format
    const toolCalls: ToolCall[] = Object.values(toolUseBlocks).map(block => ({
      id: block.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      type: 'function' as const,
      function: { name: block.name, arguments: block.args || '{}' },
    }));

    const hasToolCalls = toolCalls.length > 0;
    if (hasToolCalls) finishReason = 'tool_calls';

    return { toolCalls, text: assistantText, finishReason };
  }

  // ── Message conversion ───────────────────────────────────────────────────────

  /**
   * Convert our internal ChatMessage[] to Anthropic's format.
   * - tool role messages become user messages with tool_result content blocks
   * - consecutive same-role messages are merged
   * - must start with a user message
   */
  private convertMessages(messages: ChatMessage[]): AnthropicMessage[] {
    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'tool') {
        // Tool results become user messages
        const toolResult: AnthropicContentBlock = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id ?? '',
          content: typeof msg.content === 'string' ? msg.content : '',
        };

        // Merge into previous user message if possible
        const last = result[result.length - 1];
        if (last && last.role === 'user') {
          if (typeof last.content === 'string') {
            last.content = [{ type: 'text', text: last.content }, toolResult];
          } else {
            (last.content as AnthropicContentBlock[]).push(toolResult);
          }
        } else {
          result.push({ role: 'user', content: [toolResult] });
        }
        continue;
      }

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant with tool calls — include text + tool_use blocks
        const blocks: AnthropicContentBlock[] = [];
        if (msg.content) {
          blocks.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : '' });
        }
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* ok */ }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
        result.push({ role: 'assistant', content: blocks });
        continue;
      }

      const role = (msg.role === 'user' || msg.role === 'assistant') ? msg.role : 'user';
      const content = typeof msg.content === 'string' ? msg.content : '';

      // Merge consecutive same-role (Anthropic requires strict alternation)
      const last = result[result.length - 1];
      if (last && last.role === role) {
        if (typeof last.content === 'string') {
          last.content += '\n\n' + content;
        }
      } else {
        result.push({ role, content });
      }
    }

    return result;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }
}
