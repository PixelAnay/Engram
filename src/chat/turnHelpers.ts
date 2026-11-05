import type { ChatMessage } from '../types';

/**
 * Index of the user message that started the turn containing `sourceIndex`:
 * the nearest user message at or before it. One turn can hold several assistant
 * and tool messages (tool loops), so counting bubbles or roles is not reliable.
 * Returns -1 if there is none.
 */
export function findTurnUserIndex(messages: ChatMessage[], sourceIndex: number): number {
  for (let i = Math.min(sourceIndex, messages.length - 1); i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

/** Index of the last assistant message at or after `from`, or -1. */
export function lastAssistantIndexFrom(messages: ChatMessage[], from: number): number {
  for (let i = messages.length - 1; i >= from; i--) {
    if (messages[i].role === 'assistant') return i;
  }
  return -1;
}
