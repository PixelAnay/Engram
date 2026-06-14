/**
 * providers/types.ts
 * Unified interface all AI provider adapters must implement.
 */

import type { ChatMessage, StreamChunk, ToolCall } from '../types';

// Re-export for convenience
export type { ChatMessage, StreamChunk, ToolCall };

export interface StreamOptions {
  model: string;
  temperature: number;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none';
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ProviderStatus {
  ok: boolean;
  model: string;
  latencyMs: number;
}

/**
 * The unified interface every provider adapter implements.
 * Callers only see StreamChunk events \u2014 provider details are hidden.
 */
export interface AIProvider {
  /** Human-readable name shown in the UI */
  readonly name: string;
  /** Whether this provider supports native function/tool calling */
  readonly supportsTools: boolean;

  /**
   * Stream a chat completion.
   * Yields StreamChunk events; the final chunk always has type 'done'.
   */
  stream(
    messages: ChatMessage[],
    options: StreamOptions,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<{ toolCalls: ToolCall[]; text: string; finishReason: string | null }>;

  /** Quick connectivity + model name check. */
  healthCheck(): Promise<ProviderStatus>;

  /** List available models (best-effort, may return [] if not supported). */
  listModels(): Promise<string[]>;
}
