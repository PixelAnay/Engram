/**
 * memory/MemoryExtractor.ts
 *
 * Uses the active AI provider to silently extract memorable facts
 * from recent conversation turns and save them to memory.md as a flat list.
 */

import type { ProviderFactory } from '../providers/ProviderFactory';
import type { MemoryManager } from './MemoryManager';
import type { ChatMessage } from '../types';

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system. Your ONLY job is to extract new facts worth remembering long-term about the USER from a recent conversation.

Rules:
- Extract ONLY biographical facts, preferences, goals, insights, relationships, or background details about the USER.
- Be CONSERVATIVE — if in doubt, do not extract.
- DO NOT extract any facts that are already in the "Existing Memories" list (even if worded slightly differently). Avoid duplicates and redundant details.
- Do NOT extract: greetings, casual remarks, one-off questions, temporary context.
- Each fact must be a single, standalone sentence (no pronouns that need context, e.g. use "The user wants..." instead of "I want...").
- Return ONLY a JSON array of strings, e.g.: ["Fact 1", "Fact 2"]
- If nothing new is worth saving, return: []`;

export interface ExtractedFact {
  fact: string;
}

export class MemoryExtractor {
  private providerFactory: ProviderFactory;
  private memoryManager: MemoryManager;

  constructor(providerFactory: ProviderFactory, memoryManager: MemoryManager) {
    this.providerFactory = providerFactory;
    this.memoryManager = memoryManager;
  }

  /**
   * Extract and save facts from the last few messages of a conversation.
   * Runs silently — errors are swallowed so they never disrupt the chat.
   * Returns the number of facts saved.
   */
  async extractAndSave(
    recentMessages: ChatMessage[],
    onSaved?: (count: number) => void
  ): Promise<number> {
    try {
      const facts = await this.extract(recentMessages);
      if (facts.length === 0) return 0;

      await this.memoryManager.append(facts);
      onSaved?.(facts.length);
      return facts.length;
    } catch {
      // Silent failure — memory extraction must never crash the chat
      return 0;
    }
  }

  private async extract(recentMessages: ChatMessage[]): Promise<ExtractedFact[]> {
    // Only look at the last 6 messages (last 3 turns)
    const relevant = recentMessages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-6);

    if (relevant.length < 2) return []; // Not enough context

    // Build a compact conversation summary for extraction
    const conversationText = relevant
      .map(m => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        const content = typeof m.content === 'string' ? m.content : '[attachment]';
        return `${role}: ${content.slice(0, 500)}`; // cap per-message length
      })
      .join('\n\n');

    // Quick check — skip extraction for very short exchanges
    if (conversationText.length < 100) return [];

    const existingMemory = await this.memoryManager.load();

    const messages: ChatMessage[] = [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Existing Memories:\n\`\`\`markdown\n${existingMemory || 'No existing memories.'}\n\`\`\`\n\nRecent Conversation:\n\n${conversationText}\n\nExtract new, memorable facts from this recent conversation. DO NOT extract any fact that is already present in the "Existing Memories" list (even if worded differently). If a fact is already known, redundant, or similar to an existing one, ignore it. Return a JSON array of new facts as strings. Return [] if nothing new or worth saving is found.`,
      },
    ];

    let responseText = '';

    // Use a simple non-streaming call via the provider
    const { text } = await this.providerFactory.provider.stream(
      messages,
      {
        model: this.providerFactory['settings'].model || '',
        temperature: 0.1, // Low temperature for deterministic extraction
        maxTokens: 500,
      },
      () => { /* no-op — we don't stream extraction output */ }
    );
    responseText = text;

    return this.parse(responseText, existingMemory);
  }

  private parse(raw: string, existingMemory: string): ExtractedFact[] {
    // Strip markdown code fences if present
    const cleaned = raw
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();

    // Find JSON array
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrayMatch) return [];

    try {
      const parsed = JSON.parse(arrayMatch[0]) as unknown;
      if (!Array.isArray(parsed)) return [];

      const existingLower = existingMemory.toLowerCase();
      const facts: ExtractedFact[] = [];
      for (const item of parsed) {
        if (typeof item === 'string' && item.trim().length > 5) {
          const cleanFact = item.trim();
          // Skip if already exists in memory (fallback exact check)
          if (existingLower.includes(cleanFact.toLowerCase())) {
            continue;
          }
          facts.push({
            fact: cleanFact,
          });
        }
      }

      return facts.slice(0, 5); // Cap at 5 facts per turn
    } catch {
      return [];
    }
  }
}
