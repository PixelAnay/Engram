/**
 * memory/MemoryExtractor.ts
 *
 * Uses the active AI provider to silently extract memorable facts
 * from recent conversation turns and save them to memory.md.
 *
 * The extraction is conservative by design:
 *  - Only biographical facts, preferences, goals, and insights qualify
 *  - Casual remarks, questions, and one-off comments are ignored
 *  - A single extraction call is made after each AI response
 *  - If the AI returns nothing, nothing is saved (zero noise)
 */

import type { ProviderFactory } from '../providers/ProviderFactory';
import type { MemoryManager, SectionKey } from './MemoryManager';
import type { ChatMessage } from '../types';

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system. Your ONLY job is to extract facts worth remembering long-term about the USER from a conversation.

Rules:
- Extract ONLY facts about the USER (not about the AI, not generic facts)
- Only extract genuinely useful: biographical info, preferences, goals, ongoing projects, beliefs/opinions, or meaningful insights the user expressed
- Be CONSERVATIVE — if in doubt, do not extract
- Do NOT extract: greetings, casual remarks, one-off questions, temporary context
- Each fact must be a single, standalone sentence (no pronouns that need context)
- Return ONLY valid JSON, nothing else

Valid sections: identity, goals, beliefs, habits, projects, learnings

Example good extractions:
{"section":"goals","fact":"Wants to build a personal AI workflow integrated with Obsidian"}
{"section":"habits","fact":"Prefers concise bullet-point answers over long prose"}
{"section":"projects","fact":"Currently building an Obsidian plugin called Engram"}

If nothing is worth saving, return: []`;

export interface ExtractedFact {
  section: SectionKey;
  fact: string;
}

const VALID_SECTIONS = new Set<string>(['identity', 'goals', 'beliefs', 'habits', 'projects', 'learnings']);

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

    const messages: ChatMessage[] = [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Extract memorable facts from this conversation:\n\n${conversationText}\n\nReturn a JSON array of {section, fact} objects. Return [] if nothing is worth saving.`,
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

    return this.parse(responseText);
  }

  private parse(raw: string): ExtractedFact[] {
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

      const facts: ExtractedFact[] = [];
      for (const item of parsed) {
        if (
          typeof item === 'object' &&
          item !== null &&
          typeof (item as any).section === 'string' &&
          typeof (item as any).fact === 'string' &&
          VALID_SECTIONS.has((item as any).section) &&
          (item as any).fact.length > 5
        ) {
          facts.push({
            section: (item as any).section as SectionKey,
            fact: (item as any).fact.trim(),
          });
        }
      }

      return facts.slice(0, 5); // Cap at 5 facts per turn
    } catch {
      return [];
    }
  }
}
