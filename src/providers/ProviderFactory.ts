/**
 * providers/ProviderFactory.ts
 *
 * Creates the right AIProvider from settings.
 * Also owns the turn-running loop (tool calls, multi-depth) that was
 * previously in LLMClient, now decoupled from any one provider.
 */

import type { AIProvider, StreamOptions } from './types';
import type { ChatMessage, StreamChunk, ToolCall, EngramSettings } from '../types';
import type { ToolExecutor } from '../tools';
import { OpenAIProvider } from './OpenAIProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { PROVIDER_PRESETS } from '../settings';
import { TOOL_DEFINITIONS, TOOL_INJECTION_PROMPT } from '../tools';

export class ProviderFactory {
  private settings: EngramSettings;
  private abortController: AbortController | null = null;
  private _provider: AIProvider | null = null;

  constructor(settings: EngramSettings) {
    this.settings = settings;
  }

  updateSettings(settings: EngramSettings): void {
    this.settings = settings;
    this._provider = null; // invalidate cached provider
  }

  get provider(): AIProvider {
    if (!this._provider) {
      this._provider = this.create();
    }
    return this._provider;
  }

  private create(): AIProvider {
    const { providerType, providerBaseUrl, providerApiKey, activeProviderId } = this.settings;

    // Find the preset to get the correct base URL if not overridden
    const preset = PROVIDER_PRESETS.find(p => p.id === activeProviderId);
    const baseUrl = providerBaseUrl || preset?.baseUrl || 'http://localhost:8080';
    const apiKey = providerApiKey || '';

    if (providerType === 'anthropic') {
      return new AnthropicProvider(baseUrl, apiKey);
    }

    // Default: OpenAI-compatible
    const label = preset?.label ?? 'AI';
    return new OpenAIProvider(label, baseUrl, apiKey);
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  async healthCheck(): Promise<string> {
    const status = await this.provider.healthCheck(this.settings.model || undefined);
    return status.model;
  }

  /**
   * Run a full conversation turn, handling tool calls up to maxDepth.
   * Yields StreamChunk events via onChunk.
   * Returns the final message array (without system messages injected here).
   */
  async *runTurn(
    messages: ChatMessage[],
    toolExecutor: ToolExecutor,
    onChunk: (chunk: StreamChunk) => void
  ): AsyncGenerator<ChatMessage[]> {
    const workingMessages: ChatMessage[] = [...messages];
    let depth = 0;
    const maxDepth = this.settings.maxToolCallDepth;

    while (depth < maxDepth) {
      this.abortController = new AbortController();

      const useTools = this.settings.toolCallingMode !== 'disabled';
      const useNative = this.settings.toolCallingMode === 'native' && this.provider.supportsTools;

      const streamOptions: StreamOptions = {
        model: this.settings.model || '',
        temperature: this.settings.temperature,
        signal: this.abortController.signal,
        ...(useNative ? { tools: TOOL_DEFINITIONS as any, toolChoice: 'auto' } : {}),
      };

      // For Anthropic, max_tokens is required
      if (this.settings.providerType === 'anthropic') {
        streamOptions.maxTokens = Math.floor(this.settings.contextWindowTokens * 0.3);
      }

      let result: { toolCalls: ToolCall[]; text: string; finishReason: string | null };

      try {
        result = await this.provider.stream(workingMessages, streamOptions, onChunk);
      } catch (e) {
        onChunk({ type: 'error', error: `Unexpected error: ${(e as Error).message}` });
        onChunk({ type: 'done' });
        yield workingMessages;
        return;
      }

      let { toolCalls, text: assistantText, finishReason } = result;

      // Prompt-injection fallback: parse <tool_call> blocks from text
      if (
        this.settings.toolCallingMode === 'prompt_injection' &&
        assistantText &&
        toolCalls.length === 0
      ) {
        const injected = parseInjectionToolCalls(assistantText);
        if (injected.length > 0) {
          toolCalls = injected;
          assistantText = assistantText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
          finishReason = 'tool_calls';
        }
      }

      // Append assistant message
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: assistantText || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
      workingMessages.push(assistantMsg);

      // No tool calls → done
      if (toolCalls.length === 0 || finishReason === 'stop' || finishReason === 'end_turn') {
        onChunk({ type: 'done' });
        yield workingMessages;
        return;
      }

      if (finishReason === 'abort') {
        yield workingMessages;
        return;
      }

      // Execute tools
      for (const tc of toolCalls) {
        onChunk({ type: 'tool_start', toolName: tc.function.name, toolArgs: tc.function.arguments });
        const toolResult = await toolExecutor.execute(tc.function.name, tc.function.arguments);
        onChunk({ type: 'tool_end', toolName: tc.function.name, toolResult });

        workingMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: toolResult,
        });
      }

      depth++;
    }

    onChunk({
      type: 'error',
      error: `Max tool call depth (${maxDepth}) reached. Stopping.`,
    });
    onChunk({ type: 'done' });
    yield workingMessages;
  }
}

// ─── Prompt-injection parser (unchanged from old llm.ts) ─────────────────────

function parseInjectionToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as { name: string; arguments: Record<string, unknown> };
      if (parsed.name) {
        calls.push({
          id: `inj_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: JSON.stringify(parsed.arguments ?? {}),
          },
        });
      }
    } catch { /* skip malformed */ }
  }

  return calls;
}
