/**
 * memory/MemoryManager.ts
 *
 * Manages the persistent memory file (memory.md) in the vault.
 * Memory is structured into named sections with timestamped entries.
 * New facts are appended; old entries are auto-summarised when the file
 * exceeds maxMemoryTokens.
 */

import type { App, TFile } from 'obsidian';
import { estimateTokens } from '../utils/tokenEstimator';

export const MEMORY_SECTIONS = [
  { key: 'identity',   emoji: '👤', title: 'Core Identity' },
  { key: 'goals',      emoji: '🎯', title: 'Goals & Aspirations' },
  { key: 'beliefs',    emoji: '🧠', title: 'Beliefs & Opinions' },
  { key: 'habits',     emoji: '💡', title: 'Habits & Preferences' },
  { key: 'projects',   emoji: '🚧', title: 'Ongoing Projects' },
  { key: 'learnings',  emoji: '📚', title: 'Learnings & Insights' },
] as const;

export type SectionKey = typeof MEMORY_SECTIONS[number]['key'];

export interface MemoryEntry {
  id: string;
  fact: string;
  date: string; // ISO date string YYYY-MM-DD
}

export interface ParsedMemory {
  sections: Record<SectionKey, MemoryEntry[]>;
  raw: string;
}

export class MemoryManager {
  private app: App;
  private memoryPath: string;
  private maxTokens: number;

  constructor(app: App, memoryPath: string, maxTokens: number) {
    this.app = app;
    this.memoryPath = memoryPath;
    this.maxTokens = maxTokens;
  }

  updateConfig(memoryPath: string, maxTokens: number): void {
    this.memoryPath = memoryPath;
    this.maxTokens = maxTokens;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /** Load the full memory file content as a string for context injection. */
  async load(): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(this.memoryPath) as TFile | null;
    if (!file) return '';
    return this.app.vault.read(file);
  }

  /** Parse memory.md into structured sections. */
  async parse(): Promise<ParsedMemory> {
    const raw = await this.load();
    return { sections: this.parseRaw(raw), raw };
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Append new facts to the memory file.
   * Creates the file (and parent folders) if it doesn't exist.
   */
  async append(facts: Array<{ section: SectionKey; fact: string }>): Promise<void> {
    if (facts.length === 0) return;

    const parsed = await this.parse();
    const today = new Date().toISOString().slice(0, 10);

    for (const { section, fact } of facts) {
      const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      if (!parsed.sections[section]) parsed.sections[section] = [];
      parsed.sections[section].push({ id, fact, date: today });
    }

    await this.writeBack(parsed.sections);
    await this.trimIfNeeded();
  }

  /**
   * Delete a specific memory entry by its ID.
   */
  async forget(entryId: string): Promise<boolean> {
    const parsed = await this.parse();
    let found = false;

    for (const key of Object.keys(parsed.sections) as SectionKey[]) {
      const before = parsed.sections[key].length;
      parsed.sections[key] = parsed.sections[key].filter(e => e.id !== entryId);
      if (parsed.sections[key].length < before) found = true;
    }

    if (found) await this.writeBack(parsed.sections);
    return found;
  }

  /** Clear all memory entries. */
  async clearAll(): Promise<void> {
    const empty = {} as Record<SectionKey, MemoryEntry[]>;
    for (const s of MEMORY_SECTIONS) empty[s.key] = [];
    await this.writeBack(empty);
  }

  // ── File management ───────────────────────────────────────────────────────

  async openInEditor(): Promise<void> {
    const file = await this.ensureFile();
    // eslint-disable-next-line obsidianmd/no-unsupported-api
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.openFile(file, { active: true });
  }

  private async ensureFile(): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(this.memoryPath);
    if (existing) return existing as TFile;

    // Create parent folders
    const parentPath = this.memoryPath.substring(0, this.memoryPath.lastIndexOf('/'));
    if (parentPath) {
      // eslint-disable-next-line obsidianmd/no-unsupported-api
      try { await this.app.vault.createFolder(parentPath); } catch { /* exists */ }
    }

    // Create with template
    const template = this.buildTemplate();
    return this.app.vault.create(this.memoryPath, template);
  }

  // ── Trim ──────────────────────────────────────────────────────────────────

  /**
   * If memory exceeds maxTokens, drop the oldest entries in each section
   * until we're under budget. (AI-powered summarisation would need an extra
   * API call — for now we use a deterministic oldest-first trim.)
   */
  private async trimIfNeeded(): Promise<void> {
    const content = await this.load();
    if (estimateTokens(content) <= this.maxTokens) return;

    const parsed = this.parseRaw(content);

    // Remove 20% of oldest entries per section until under budget
    let trimmed = false;
    while (estimateTokens(this.buildContent(parsed)) > this.maxTokens) {
      let removedAny = false;
      for (const key of Object.keys(parsed) as SectionKey[]) {
        if (parsed[key].length > 1) {
          parsed[key].shift(); // remove oldest
          removedAny = true;
          trimmed = true;
        }
      }
      if (!removedAny) break;
    }

    if (trimmed) await this.writeBack(parsed);
  }

  // ── Serialisation ─────────────────────────────────────────────────────────

  private parseRaw(raw: string): Record<SectionKey, MemoryEntry[]> {
    const result = {} as Record<SectionKey, MemoryEntry[]>;
    for (const s of MEMORY_SECTIONS) result[s.key] = [];

    // Parse lines like: - [2025-06-14|mem_xxx] fact text
    const lineRegex = /^-\s+\[(\d{4}-\d{2}-\d{2})\|([^\]]+)\]\s+(.+)$/;
    let currentSection: SectionKey | null = null;

    for (const line of raw.split('\n')) {
      // Detect section headers like: ## 🎯 Goals & Aspirations
      for (const s of MEMORY_SECTIONS) {
        if (line.startsWith(`## ${s.emoji}`) || line.includes(s.title)) {
          currentSection = s.key;
          break;
        }
      }

      if (!currentSection) continue;
      const match = lineRegex.exec(line.trim());
      if (match) {
        result[currentSection].push({
          date: match[1],
          id: match[2],
          fact: match[3],
        });
      }
    }

    return result;
  }

  private buildContent(sections: Record<SectionKey, MemoryEntry[]>): string {
    const lines: string[] = [
      '---',
      `last_updated: ${new Date().toISOString().slice(0, 10)}`,
      '---',
      '',
    ];

    for (const s of MEMORY_SECTIONS) {
      lines.push(`## ${s.emoji} ${s.title}`);
      const entries = sections[s.key] ?? [];
      if (entries.length === 0) {
        lines.push('');
      } else {
        for (const e of entries) {
          lines.push(`- [${e.date}|${e.id}] ${e.fact}`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private buildTemplate(): string {
    const empty = {} as Record<SectionKey, MemoryEntry[]>;
    for (const s of MEMORY_SECTIONS) empty[s.key] = [];
    return this.buildContent(empty);
  }

  private async writeBack(sections: Record<SectionKey, MemoryEntry[]>): Promise<void> {
    const content = this.buildContent(sections);
    const file = await this.ensureFile();
    await this.app.vault.modify(file, content);
  }
}
