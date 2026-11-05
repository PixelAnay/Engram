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
import { getProviderApiKey } from '../utils/apiKeys';

/** What runTurn yields: the working message list, plus an error if the turn failed. */
export interface TurnResult {
  messages: ChatMessage[];
  /** Set when the turn ended because of an error. The failed reply is NOT in `messages`. */
  error?: string;
}

export class ProviderFactory {
  private settings: EngramSettings;
  /** Controller of the turn that is running right now (null when idle). */
  private abortController: AbortController | null = null;
  private _provider: AIProvider | null = null;

  constructor(settings: EngramSettings) {
    this.settings = settings;
  }

  updateSettings(settings: EngramSettings): void {
    this.settings = settings;
    this._provider = null; // invalidate cached provider
  }

  get activeSettings(): EngramSettings {
    return this.settings;
  }

  get provider(): AIProvider {
    if (!this._provider) {
      this._provider = this.create();
    }
    return this._provider;
  }

  private create(): AIProvider {
    const { providerType, providerBaseUrl, activeProviderId } = this.settings;

    // Find the preset to get the correct base URL if not overridden
    const preset = PROVIDER_PRESETS.find(p => p.id === activeProviderId);
    const baseUrl = providerBaseUrl || preset?.baseUrl || 'http://localhost:8080';
    // Only the key stored for THIS provider is ever used
    const apiKey = getProviderApiKey(this.settings);

    if (providerType === 'anthropic') {
      return new AnthropicProvider(baseUrl, apiKey);
    }

    // Default: OpenAI-compatible
    const label = preset?.label ?? 'AI';
    return new OpenAIProvider(label, baseUrl, apiKey);
  }

  /** Abort the turn that is currently running (no effect when idle). */
  abort(): void {
    this.abortController?.abort();
  }

  async healthCheck(): Promise<string> {
    const status = await this.provider.healthCheck(this.settings.model || undefined);
    return status.modelFound === false ? `${status.model} (not in server's model list)` : status.model;
  }

  /**
   * Run a full conversation turn, handling tool calls up to maxDepth.
   * Yields the working message list when the turn ends. A turn that fails
   * yields `error` and never includes an empty assistant message.
   */
  async *runTurn(
    messages: ChatMessage[],
    toolExecutor: ToolExecutor,
    onChunk: (chunk: StreamChunk) => void
  ): AsyncGenerator<TurnResult> {
    const workingMessages: ChatMessage[] = [...messages];
    let depth = 0;
    const maxDepth = this.settings.maxToolCallDepth;

    // Inject the tool prompt if using prompt injection (H-02)
    if (this.settings.toolCallingMode === 'prompt_injection') {
      const sysIdx = workingMessages.findIndex(m => m.role === 'system');
      if (sysIdx >= 0) {
        const sysMsg = workingMessages[sysIdx];
        if (typeof sysMsg.content === 'string' && !sysMsg.content.includes('Available tools:')) {
          workingMessages[sysIdx] = {
            ...sysMsg,
            content: sysMsg.content + '\n\n' + TOOL_INJECTION_PROMPT,
          };
        }
      }
    }

    // Each turn owns its controller. A late-finishing old turn can never clear or
    // abort the controller of a newer turn.
    const controller = new AbortController();
    this.abortController = controller;

    let lastError = '';
    const tap = (chunk: StreamChunk) => {
      if (chunk.type === 'error') lastError = chunk.error ?? 'Unknown error';
      onChunk(chunk);
    };

    try {
      while (depth < maxDepth) {
        if (controller.signal.aborted) {
          onChunk({ type: 'done' });
          yield { messages: workingMessages };
          return;
        }

        const useNative = this.settings.toolCallingMode === 'native' && this.provider.supportsTools;

        const streamOptions: StreamOptions = {
          model: this.settings.model || '',
          temperature: this.settings.temperature,
          signal: controller.signal,
          toolCallingMode: this.settings.toolCallingMode,
          ...(useNative ? { tools: TOOL_DEFINITIONS as any, toolChoice: 'auto' } : {}),
        };

        // One explicit reply limit for every provider (required by Anthropic).
        // Not derived from the context window: that is the INPUT size.
        const configured = Math.floor(Number(this.settings.maxOutputTokens));
        streamOptions.maxTokens = configured > 0 ? configured : 4096;

        let result: { toolCalls: ToolCall[]; text: string; finishReason: string | null };

        try {
          result = await this.provider.stream(workingMessages, streamOptions, tap);
        } catch (e) {
          const error = `Unexpected error: ${(e as Error).message}`;
          onChunk({ type: 'error', error });
          onChunk({ type: 'done' });
          yield { messages: workingMessages, error };
          return;
        }

        let { toolCalls, text: assistantText, finishReason } = result;

        // The provider already reported the details through the error chunk.
        // Do NOT store an assistant message for a failed request.
        if (finishReason === 'error') {
          onChunk({ type: 'done' });
          yield { messages: workingMessages, error: lastError || 'The request failed.' };
          return;
        }

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

        const aborted = finishReason === 'abort' || controller.signal.aborted;

        // A reply with neither text nor tool calls is a failure, not a message
        if (!aborted && !assistantText.trim() && toolCalls.length === 0) {
          const error = 'The model returned an empty reply. Try again, or pick a different model.';
          onChunk({ type: 'error', error });
          onChunk({ type: 'done' });
          yield { messages: workingMessages, error };
          return;
        }

        // Keep partial text from a stopped reply; never store an empty assistant message
        if (assistantText.trim() || (!aborted && toolCalls.length > 0)) {
          const assistantMsg: ChatMessage = {
            role: 'assistant',
            content: assistantText || '',
            ...(!aborted && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          };
          workingMessages.push(assistantMsg);
        }

        // No tool calls, or stopped by the user → done
        if (aborted || toolCalls.length === 0) {
          onChunk({ type: 'done' });
          yield { messages: workingMessages };
          return;
        }

        // Execute tools
        for (const tc of toolCalls) {
          // Check aborted during tool calls execution
          if (controller.signal.aborted) {
            // Give every remaining call an answer so the history stays valid
            workingMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              name: tc.function.name,
              content: 'Cancelled: the user stopped this turn before the tool ran.',
            });
            continue;
          }

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

        if (controller.signal.aborted) {
          onChunk({ type: 'done' });
          yield { messages: workingMessages };
          return;
        }

        depth++;
      }

      const error = `Max tool call depth (${maxDepth}) reached. Stopping.`;
      onChunk({ type: 'error', error });
      onChunk({ type: 'done' });
      yield { messages: workingMessages, error };
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }
}

// ─── Prompt-injection parser (unchanged from old llm.ts) ─────────────────────

export function parseInjectionToolCalls(text: string): ToolCall[] {
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
