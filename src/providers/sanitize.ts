/**
 * providers/sanitize.ts
 *
 * Cleans a message history right before it is sent to a provider, so one bad
 * turn can never make every later request fail:
 *  - assistant messages with no text and no tool calls are dropped
 *  - UI-only fields (attachments, autoAttachedNotes) are stripped
 *  - tool calls that never got a result (e.g. after Stop), and tool results
 *    without a call, are dropped
 *  - outside native tool-calling mode, tool traffic is turned into plain text
 */

import type { ChatMessage, ToolCall, ToolCallingMode } from '../types';

function hasText(content: ChatMessage['content']): boolean {
  if (content === null || content === undefined) return false;
  if (typeof content === 'string') return content.trim().length > 0;
  return content.some(p => (p.type === 'text' ? !!p.text?.trim() : true));
}

function callsAsText(calls: ToolCall[]): string {
  return calls
    .map(tc => {
      let args: unknown = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* keep {} */ }
      return `<tool_call>\n${JSON.stringify({ name: tc.function.name, arguments: args })}\n</tool_call>`;
    })
    .join('\n');
}

export function sanitizeForApi(
  messages: ChatMessage[],
  toolMode: ToolCallingMode = 'native'
): ChatMessage[] {
  const native = toolMode === 'native';
  const out: ChatMessage[] = [];

  // Ids of tool results present anywhere after position i
  const resultIdsAfter = (i: number): Set<string> => {
    const ids = new Set<string>();
    for (let j = i + 1; j < messages.length; j++) {
      const m = messages[j];
      if (m.role === 'tool' && m.tool_call_id) ids.add(m.tool_call_id);
    }
    return ids;
  };
  // Ids of calls issued before position i
  const callIdsBefore = (i: number): Set<string> => {
    const ids = new Set<string>();
    for (let j = 0; j < i; j++) {
      for (const tc of messages[j].tool_calls ?? []) ids.add(tc.id);
    }
    return ids;
  };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    if (m.role === 'tool') {
      if (native) {
        // Keep only results that belong to an earlier call
        if (m.tool_call_id && callIdsBefore(i).has(m.tool_call_id)) {
          out.push({
            role: 'tool',
            tool_call_id: m.tool_call_id,
            ...(m.name ? { name: m.name } : {}),
            content: typeof m.content === 'string' ? m.content : '',
          });
        }
      } else {
        const text = typeof m.content === 'string' ? m.content : '';
        out.push({ role: 'user', content: `[Tool result: ${m.name ?? 'tool'}]\n${text}` });
      }
      continue;
    }

    if (m.role === 'assistant') {
      let calls = m.tool_calls ?? [];
      let content = m.content;

      if (calls.length > 0) {
        if (native) {
          const answered = resultIdsAfter(i);
          calls = calls.filter(tc => answered.has(tc.id));
        } else {
          // Show the model its own earlier call as text, the way it was asked to write it
          const asText = callsAsText(calls);
          const base = typeof content === 'string' ? content : '';
          content = [base, asText].filter(Boolean).join('\n');
          calls = [];
        }
      }

      if (!hasText(content) && calls.length === 0) continue;

      out.push({
        role: 'assistant',
        content: content ?? '',
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }

    // system / user: keep the API fields only
    out.push({ role: m.role, content: m.content ?? '' });
  }

  return out;
}
