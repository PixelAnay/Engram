/**
 * memory/MemoryManager.ts
 *
 * Manages the persistent memory file (memory.md) in the vault as a flat list.
 * Memory is structured as a flat bullet-point list under "# 💾 Stored Memories".
 * New facts are appended; old entries are trimmed when the file exceeds maxMemoryTokens.
 */

import type { App, TFile } from 'obsidian';
import { estimateTokens } from '../utils/tokenEstimator';

export interface MemoryEntry {
  id: string;
  fact: string;
  date: string; // ISO date string YYYY-MM-DD
}

export interface ParsedMemory {
  entries: MemoryEntry[];
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

  /** Parse memory.md into a flat list of entries. */
  async parse(): Promise<ParsedMemory> {
    const raw = await this.load();
    return { entries: this.parseRaw(raw), raw };
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Append new facts to the memory file.
   * Creates the file (and parent folders) if it doesn't exist.
   */
  async append(facts: Array<{ fact: string }>): Promise<void> {
    if (facts.length === 0) return;

    const parsed = await this.parse();
    const today = new Date().toISOString().slice(0, 10);

    for (const { fact } of facts) {
      const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      parsed.entries.push({ id, fact, date: today });
    }

    await this.writeBack(parsed.entries);
    await this.trimIfNeeded();
  }

  /**
   * Delete a specific memory entry by its ID.
   */
  async forget(entryId: string): Promise<boolean> {
    const parsed = await this.parse();
    const before = parsed.entries.length;
    parsed.entries = parsed.entries.filter(e => e.id !== entryId);

    if (parsed.entries.length < before) {
      await this.writeBack(parsed.entries);
      return true;
    }
    return false;
  }

  /** Clear all memory entries. */
  async clearAll(): Promise<void> {
    await this.writeBack([]);
  }

  // ── File management ───────────────────────────────────────────────────────

  async openInEditor(): Promise<void> {
    const file = await this.ensureFile();
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.openFile(file, { active: true });
  }

  private async ensureFile(): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(this.memoryPath);
    if (existing) return existing as TFile;

    // Create parent folders
    const parentPath = this.memoryPath.substring(0, this.memoryPath.lastIndexOf('/'));
    if (parentPath) {
      try { await this.app.vault.createFolder(parentPath); } catch { /* exists */ }
    }

    // Create with template
    const template = this.buildTemplate();
    return this.app.vault.create(this.memoryPath, template);
  }

  // ── Trim ──────────────────────────────────────────────────────────────────

  /**
   * If memory exceeds maxTokens, drop the oldest entries in the flat list
   * until we're under budget.
   */
  private async trimIfNeeded(): Promise<void> {
    const content = await this.load();
    if (estimateTokens(content) <= this.maxTokens) return;

    const entries = this.parseRaw(content);
    let trimmed = false;
    while (estimateTokens(this.buildContent(entries)) > this.maxTokens && entries.length > 0) {
      entries.shift(); // drop oldest entry from the start
      trimmed = true;
    }

    if (trimmed) await this.writeBack(entries);
  }

  // ── Serialisation ─────────────────────────────────────────────────────────

  private parseRaw(raw: string): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    // Parse lines like: - [2025-06-14|mem_xxx] fact text
    const lineRegex = /^-\s+\[(\d{4}-\d{2}-\d{2})\|([^\]]+)\]\s+(.+)$/;

    for (const line of raw.split('\n')) {
      const match = lineRegex.exec(line.trim());
      if (match) {
        result.push({
          date: match[1],
          id: match[2],
          fact: match[3],
        });
      }
    }

    return result;
  }

  private buildContent(entries: MemoryEntry[]): string {
    const lines: string[] = [
      '---',
      `last_updated: ${new Date().toISOString().slice(0, 10)}`,
      '---',
      '',
      '# 💾 Stored Memories',
      '',
    ];

    if (entries.length === 0) {
      lines.push('');
    } else {
      for (const e of entries) {
        lines.push(`- [${e.date}|${e.id}] ${e.fact}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private buildTemplate(): string {
    return this.buildContent([]);
  }

  private async writeBack(entries: MemoryEntry[]): Promise<void> {
    const content = this.buildContent(entries);
    const file = await this.ensureFile();
    await this.app.vault.modify(file, content);
  }
}
