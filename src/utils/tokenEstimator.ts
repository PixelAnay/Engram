// ─── Token Estimation Utilities ──────────────────────────────────────────────

import type { ChatMessage, MessageContentPart } from '../types';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Per-character token-cost lookup using Unicode code-point ranges.
 * This avoids allocating regex objects per call and is measurably faster
 * when processing large message arrays.
 *
 * Cost table (mirrors spec):
 * | Class                       | Cost  |
 * |-----------------------------|-------|
 * | ASCII whitespace            | 0.25  |
 * | ASCII word char (a–z/A–Z/0–9/_) | 0.25 |
 * | CJK / wide Unicode          | 0.5   |
 * | Everything else             | 1.0   |
 */
function charCost(cp: number): number {
  // Common whitespace: SPACE, TAB, LF, CR
  if (cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d) return 0.25;

  // ASCII word chars: A-Z, a-z, 0-9, _
  if (
    (cp >= 0x41 && cp <= 0x5a) || // A–Z
    (cp >= 0x61 && cp <= 0x7a) || // a–z
    (cp >= 0x30 && cp <= 0x39) || // 0–9
    cp === 0x5f                    // _
  ) {
    return 0.25;
  }

  // CJK Unified Ideographs, Katakana/Hiragana, Hangul, CJK Compatibility
  // Ranges: U+3000–U+9FFF, U+AC00–U+D7AF, U+F900–U+FAFF
  // Also includes supplementary CJK (code point > 0xFFFF, i.e. surrogate pairs)
  if (
    (cp >= 0x3000 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    cp > 0xffff
  ) {
    return 0.5;
  }

  // Punctuation, symbols, other non-ASCII, emoji (BMP) → ~1 token each
  return 1.0;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Estimate the number of tokens in a string.
 *
 * Uses an improved heuristic compared to the naïve `length / 4` approach.
 * Each character is classified and charged a fractional token cost:
 * - Whitespace-only chars cost **0.25** tokens each
 * - ASCII word chars (a–z, A–Z, 0–9, _) cost **0.25** tokens each (4 chars ≈ 1 token)
 * - CJK / wide Unicode characters cost **0.5** tokens each
 * - Punctuation, symbols, and other chars cost **1.0** token each
 *
 * The result is rounded up to the nearest integer.
 *
 * @param text - The string to estimate.
 * @returns Estimated token count (always ≥ 0).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let cost = 0;
  // Iterate by code point to handle surrogate pairs (emoji, CJK Ext-B…) correctly.
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    cost += charCost(cp);
    // Surrogate pairs consume two UTF-16 code units.
    i += cp > 0xffff ? 2 : 1;
  }

  return Math.ceil(cost);
}

/**
 * Estimate the total number of tokens consumed by an array of {@link ChatMessage}s.
 *
 * Accounts for:
 * - A fixed **4-token** per-message overhead (role framing)
 * - `role` field tokens
 * - `name` field tokens (present on tool result messages)
 * - String `content` fields
 * - `MessageContentPart[]` content arrays:
 *   - `text` parts counted normally
 *   - `image_url` parts charged a fixed **85-token** overhead (low-detail baseline)
 * - `tool_calls` arrays: function name + arguments JSON
 *
 * @param messages - The conversation history to measure.
 * @returns Total estimated token count across all messages.
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  /** Role-framing tokens added per message. */
  const PER_MESSAGE_OVERHEAD = 4;
  /** Fixed token overhead for an image_url part (low-detail, OpenAI baseline). */
  const IMAGE_TOKEN_COST = 85;

  let total = 0;

  for (const msg of messages) {
    total += PER_MESSAGE_OVERHEAD;

    // role (e.g. "user", "assistant", "system", "tool")
    total += estimateTokens(msg.role);

    // optional name — present on tool result messages
    if (msg.name) {
      total += estimateTokens(msg.name);
    }

    // content: string, MessageContentPart[], or null
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as MessageContentPart[]) {
        if (part.type === 'text' && typeof part.text === 'string') {
          total += estimateTokens(part.text);
        } else if (part.type === 'image_url') {
          // Vision: fixed overhead for low-detail mode; actual cost depends on
          // image resolution which we cannot know statically.
          total += IMAGE_TOKEN_COST;
        }
      }
    }

    // tool_calls: sum name + arguments for each call
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        total += estimateTokens(tc.function.name);
        total += estimateTokens(tc.function.arguments);
      }
    }
  }

  return total;
}

/**
 * Format a token count for compact human-readable display.
 *
 * | Range           | Format      | Example |
 * |-----------------|-------------|---------|
 * | 0 – 999         | integer     | `"842"` |
 * | 1 000 – 9 999   | `N.Nk`      | `"1.2k"` |
 * | ≥ 10 000        | `Nk`        | `"12k"` |
 *
 * @param count - Token count to format (should be ≥ 0).
 * @returns Formatted string representation.
 */
export function formatTokenCount(count: number): string {
  if (count < 1_000) {
    return String(Math.round(count));
  }
  if (count < 10_000) {
    // e.g. 1 234 → "1.2k"
    return `${(count / 1_000).toFixed(1)}k`;
  }
  // e.g. 12 345 → "12k"
  return `${Math.round(count / 1_000)}k`;
}
