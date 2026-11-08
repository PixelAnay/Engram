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
import { sanitizeForApi } from './sanitize';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

// ─── Anthropic-specific types ─────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image';
  text?: string;
  source?:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
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
    stop_reason?: string;
  };
  content_block?: {
    type: string;
    id?: string;
    name?: string;
  };
}

// ─── Content conversion ───────────────────────────────────────────────────────

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/** OpenAI-style content parts become Anthropic content blocks. */
export function convertContentParts(
  parts: Array<{ type: string; text?: string; image_url?: { url: string } }>
): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && part.image_url?.url) {
      const url = part.image_url.url;
      const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
      if (m) {
        const mediaType = m[1].toLowerCase();
        if (SUPPORTED_IMAGE_TYPES.includes(mediaType)) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: m[2] } });
        } else {
          blocks.push({ type: 'text', text: `[Attachment omitted: ${mediaType} is not a supported image type]` });
        }
      } else if (/^https?:\/\//i.test(url)) {
        blocks.push({ type: 'image', source: { type: 'url', url } });
      }
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return blocks;
}

function toBlocks(c: string | AnthropicContentBlock[]): AnthropicContentBlock[] {
  return typeof c === 'string' ? [{ type: 'text', text: c }] : c;
}

/** Merge two same-role contents into one. Plain strings stay plain. */
function mergeContent(
  a: string | AnthropicContentBlock[],
  b: string | AnthropicContentBlock[]
): string | AnthropicContentBlock[] {
  if (typeof a === 'string' && typeof b === 'string') return a + '\n\n' + b;
  return [...toBlocks(a), ...toBlocks(b)];
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

  async healthCheck(model?: string): Promise<ProviderStatus> {
    const start = Date.now();
    try {
      // Free GET /v1/models — never a billable message request.
      const res = await requestUrl({
        url: `${this.baseUrl}/v1/models?limit=100`,
        method: 'GET',
        headers: this.headers(),
        throw: false,
      });

      if (res.status === 200) {
        const ids = ((res.json as { data?: Array<{ id: string }> } | null)?.data ?? []).map(m => m.id);
        const reported = model || ids[0] || 'unknown';
        const found = !model || ids.length === 0 || ids.includes(model);
        return { ok: true, model: reported, latencyMs: Date.now() - start, modelFound: found };
      }

      const errMsg = (res.json as { error?: { message?: string } } | null)?.error?.message || `HTTP ${res.status}`;
      throw new Error(errMsg);
    } catch (e) {
      throw new Error(`Anthropic connection failed: ${(e as Error).message}`);
    }
  }

  async listModels(): Promise<string[]> {
    // Anthropic doesn't expose a /models endpoint — return known models
    return [
      'claude-fable-5',
      'claude-mythos-5',
      'claude-opus-4-8',
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
    // Drop empty assistant turns, unanswered tool calls and UI-only fields first
    messages = sanitizeForApi(messages, options.toolCallingMode);

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
      // Anthropic accepts 0..1 only (other providers allow up to 2)
      temperature: Math.max(0, Math.min(1, options.temperature)),
      messages: anthropicMessages,
    };

    if (system) body.system = system;
    if (tools && tools.length > 0 && options.toolChoice !== 'none') {
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
          if (trimmed.startsWith('event:')) continue; // Skip event lines
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') break;

          try {
            const event = JSON.parse(payload) as AnthropicStreamEvent;
            
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
                  const idx = event.index !== undefined ? event.index : currentBlockIndex;
                  if (idx >= 0) {
                    if (!toolUseBlocks[idx]) {
                      toolUseBlocks[idx] = { id: '', name: '', args: '' };
                    }
                    toolUseBlocks[idx].args += event.delta.partial_json;
                  }
                }
                break;

              case 'message_delta':
                if (event.delta?.stop_reason) {
                  finishReason = event.delta.stop_reason;
                }
                break;

              case 'message_stop':
                finishReason = finishReason ?? 'end_turn';
                break;
            }
          } catch {
            // Ignore malformed JSON lines
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
          tool_use_id: msg.tool_call_id || `inj_fallback_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          content: typeof msg.content === 'string' ? msg.content : '',
        };

        // Merge into previous user message if possible
        const last = result[result.length - 1];
        if (last && last.role === 'user') {
          if (typeof last.content === 'string') {
            last.content = [{ type: 'text', text: last.content }, toolResult];
          } else {
            last.content.push(toolResult);
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
      // Strings stay strings; content-part arrays (text + images) become Anthropic blocks.
      // null becomes '' so Anthropic never sees an assistant turn without content.
      const content: string | AnthropicContentBlock[] =
        Array.isArray(msg.content) ? convertContentParts(msg.content) : (msg.content ?? '');

      // Merge consecutive same-role (Anthropic requires strict alternation)
      const last = result[result.length - 1];
      if (last && last.role === role) {
        last.content = mergeContent(last.content, content);
      } else {
        result.push({ role, content });
      }
    }

    // Ensure the first message is a user message (H-04)
    if (result.length > 0 && result[0].role !== 'user') {
      result.unshift({ role: 'user', content: '...' });
    }

    return result;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      // Required for direct requests from the Obsidian renderer (browser-like origin)
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }
}
