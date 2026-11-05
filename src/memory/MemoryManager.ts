/**
 * memory/MemoryManager.ts
 *
 * Manages the persistent memory file (Memory.md) in the vault.
 *
 * Safety rules (see PLAN-memory-chat-integrity.md):
 *  - The file is NEVER rebuilt. Every operation edits only its own lines, inside
 *    an atomic vault.process() call on the latest on-disk text (memoryFormat.ts).
 *  - Nothing is ever trimmed from the file. The token budget only limits what is
 *    sent to the model (see context.ts).
 *  - A missing file never means "start over": if the file existed before, new
 *    facts are queued in data.json and no blank file is created.
 *  - Every write is preceded by a local backup (plugin folder, last 20 kept).
 *  - After each edit an invariant check confirms only the target lines changed;
 *    if not, the original text is returned unchanged.
 *  - No write happens before the workspace layout is ready.
 */

import { TFile, Notice } from 'obsidian';
import type { App } from 'obsidian';
import type { PluginDataStore } from '../storage/PluginDataStore';
import {
  addEntries,
  updateEntry,
  removeEntry,
  removeAllEntries,
  parseEntries,
  verifyOnlyTargetChanged,
  normalizeFact,
  buildTemplate,
  type MemoryOp,
} from './memoryFormat';

export interface MemoryEntry {
  id: string;
  fact: string;
  date: string; // ISO date string YYYY-MM-DD
}

export interface ParsedMemory {
  entries: MemoryEntry[];
  raw: string;
}

export interface MemoryState {
  path: string;
  everExisted: boolean;
  lastEntryCount: number;
}

export type MemoryOpResult =
  | { ok: true; ids?: string[] }
  | { ok: false; reason: 'missing_file' | 'not_found' | 'invalid' | 'invariant' | 'error'; message?: string };

export type AddResult =
  | { status: 'saved'; ids: string[] }
  | { status: 'queued' }
  | { status: 'noop' }
  | { status: 'failed'; message: string };

export interface BackupInfo {
  name: string;
  path: string;
  /** Epoch ms parsed from the file name (0 if unparseable) */
  timestamp: number;
}

export const MAX_BACKUPS = 20;
const BACKUP_PREFIX = 'memory-';

export class MemoryManager {
  private app: App;
  private memoryPath: string;
  private dataStore: PluginDataStore;
  private backupDir: string;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private ready = false;
  private resolveReady!: () => void;
  private readyPromise: Promise<void>;
  private warnedLoss = false;

  constructor(app: App, memoryPath: string, dataStore: PluginDataStore, backupDir: string) {
    this.app = app;
    this.memoryPath = memoryPath;
    this.dataStore = dataStore;
    this.backupDir = backupDir.replace(/\/+$/, '');
    this.readyPromise = new Promise<void>(resolve => { this.resolveReady = resolve; });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Call once from workspace.onLayoutReady. Until then no memory write can run.
   * Also flushes facts that were queued while the file was missing.
   */
  markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.resolveReady();
    void this.flushPending();
  }

  /** The configured path may change in settings. Never touches the file. */
  updateConfig(memoryPath: string): void {
    this.memoryPath = memoryPath;
  }

  get path(): string {
    return this.memoryPath;
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = async () => {
      await this.readyPromise;
      return op();
    };
    const nextOp = this.writeQueue.then(run, run);
    this.writeQueue = nextOp.catch(() => {});
    return nextOp as Promise<T>;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  private getFile(): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(this.memoryPath);
    if (!f) return null;
    if (!(f instanceof TFile)) {
      throw new Error(`The memory path "${this.memoryPath}" is a folder. Choose a different path in settings.`);
    }
    return f;
  }

  /** Load the full memory file content as a string ('' if the file is missing). */
  async load(): Promise<string> {
    let file: TFile | null;
    try {
      file = this.getFile();
    } catch (e) {
      // The configured path is a folder: reading must not break the chat
      console.warn('[Engram]', (e as Error).message);
      return '';
    }
    if (!file) return '';
    return this.app.vault.read(file);
  }

  /** Parse the memory file into entries. Read-only. */
  async parse(): Promise<ParsedMemory> {
    const raw = await this.load();
    return { entries: parseEntries(raw).map(e => ({ id: e.id, fact: e.fact, date: e.date })), raw };
  }

  // ── State (data.json) ─────────────────────────────────────────────────────

  private async reconcileState(file: TFile | null): Promise<MemoryState> {
    const existing = this.dataStore.get().memoryState as MemoryState | undefined;
    if (existing && existing.path === this.memoryPath) {
      if (file && !existing.everExisted) {
        const next = { ...existing, everExisted: true };
        await this.dataStore.update(d => { d.memoryState = next; });
        return next;
      }
      return existing;
    }
    // First run, or the configured path changed: derive from what is on disk.
    // A legacy "<path>.bak" proves the file existed under an older plugin version.
    let everExisted = !!file;
    if (!everExisted) {
      const bak = this.app.vault.getAbstractFileByPath(this.memoryPath + '.bak');
      const bak2 = this.app.vault.getAbstractFileByPath(this.memoryPath.replace(/\.md$/, '') + '.md.bak');
      everExisted = !!bak || !!bak2;
    }
    const count = file ? parseEntries(await this.app.vault.read(file)).length : 0;
    const state: MemoryState = { path: this.memoryPath, everExisted, lastEntryCount: count };
    await this.dataStore.update(d => { d.memoryState = state; });
    return state;
  }

  private async saveState(patch: Partial<MemoryState>): Promise<void> {
    // Skip the (whole-file) data.json write when nothing changed
    const current = this.dataStore.get().memoryState as MemoryState | undefined;
    if (current && current.path === this.memoryPath &&
        (Object.keys(patch) as Array<keyof MemoryState>).every(k => current[k] === patch[k])) {
      return;
    }
    await this.dataStore.update(d => {
      const cur = (d.memoryState as MemoryState | undefined) ?? { path: this.memoryPath, everExisted: false, lastEntryCount: 0 };
      d.memoryState = { ...cur, path: this.memoryPath, ...patch };
    });
  }

  /** Facts waiting for the memory file to reappear. */
  get pendingFacts(): string[] {
    const p = this.dataStore.get().pendingMemoryFacts;
    return Array.isArray(p) ? [...p] : [];
  }

  private async queuePending(facts: string[]): Promise<void> {
    await this.dataStore.update(d => {
      const cur: string[] = Array.isArray(d.pendingMemoryFacts) ? d.pendingMemoryFacts : [];
      d.pendingMemoryFacts = [...cur, ...facts];
    });
  }

  // ── Write operations ──────────────────────────────────────────────────────

  /**
   * Add facts as new entries. If the file is missing but existed before, the
   * facts are queued instead and no file is created.
   */
  add(facts: string[]): Promise<AddResult> {
    return this.enqueue(async () => {
      try {
        const normalized = facts.map(normalizeFact).filter(Boolean);
        if (normalized.length === 0) return { status: 'noop' } as AddResult;
        return await this.addInternal(normalized);
      } catch (e) {
        return { status: 'failed', message: (e as Error).message } as AddResult;
      }
    });
  }

  private async addInternal(normalized: string[]): Promise<AddResult> {
    let file = this.getFile();
    const state = await this.reconcileState(file);

    if (!file) {
      if (state.everExisted) {
        await this.queuePending(normalized);
        new Notice(
          `🧠 Engram: memory file "${this.memoryPath}" is missing. ` +
          `${normalized.length} fact(s) were queued, nothing was overwritten. ` +
          'Run "Restore memory from backup" or recreate the file.'
        );
        return { status: 'queued' };
      }
      file = await this.createFromTemplate();
    }

    const res = await this.applyToFile(file, { type: 'add', count: normalized.length }, current => {
      const r = addEntries(current, normalized, new Date().toISOString().slice(0, 10));
      return { text: r.text, ids: r.added.map(a => a.id), count: r.added.length };
    });
    if (!res.ok) return { status: 'failed', message: res.message ?? res.reason };
    return { status: 'saved', ids: res.ids ?? [] };
  }

  /** Replace the text of exactly one entry. */
  update(id: string, fact: string): Promise<MemoryOpResult> {
    return this.enqueue(async () => {
      const normalized = normalizeFact(fact);
      if (!id || !normalized) return { ok: false, reason: 'invalid' } as MemoryOpResult;
      return this.editExisting({ type: 'update', id }, text => {
        const out = updateEntry(text, id, normalized);
        return out === null ? null : { text: out };
      });
    });
  }

  /** Remove exactly one entry. */
  remove(id: string): Promise<MemoryOpResult> {
    return this.enqueue(async () => {
      if (!id) return { ok: false, reason: 'invalid' } as MemoryOpResult;
      return this.editExisting({ type: 'remove', id }, text => {
        const out = removeEntry(text, id);
        return out === null ? null : { text: out };
      });
    });
  }

  /** True only if an entry was actually removed from the file. */
  async forget(entryId: string): Promise<boolean> {
    return (await this.remove(entryId)).ok;
  }

  /** Remove every entry line. Headings, free text and frontmatter stay. */
  clearAll(): Promise<MemoryOpResult> {
    return this.enqueue(async () =>
      this.editExisting({ type: 'clear' }, text => ({ text: removeAllEntries(text) }))
    );
  }

  private async editExisting(
    op: MemoryOp,
    transform: (text: string) => { text: string } | null
  ): Promise<MemoryOpResult> {
    try {
      const file = this.getFile();
      await this.reconcileState(file);
      if (!file) return { ok: false, reason: 'missing_file' };
      return await this.applyToFile(file, op, current => {
        const r = transform(current);
        return r === null ? null : { text: r.text };
      });
    } catch (e) {
      return { ok: false, reason: 'error', message: (e as Error).message };
    }
  }

  /**
   * Backup, then apply `transform` to the latest on-disk text inside
   * vault.process, verifying the invariant before accepting the result.
   */
  private async applyToFile(
    file: TFile,
    op: MemoryOp,
    transform: (current: string) => { text: string; ids?: string[]; count?: number } | null
  ): Promise<MemoryOpResult> {
    await this.backup(file);

    let outcome: MemoryOpResult = { ok: false, reason: 'not_found' };
    let finalText: string | null = null;

    await this.app.vault.process(file, current => {
      this.warnIfEntriesVanished(current);
      const r = transform(current);
      if (r === null) { outcome = { ok: false, reason: 'not_found' }; return current; }
      if (r.text === current) {
        outcome = op.type === 'add' ? { ok: false, reason: 'invalid' } : { ok: true };
        return current;
      }
      const checkOp: MemoryOp = op.type === 'add' ? { type: 'add', count: r.count ?? 0 } : op;
      if (!verifyOnlyTargetChanged(current, r.text, checkOp)) {
        console.error('[Engram] Memory edit rejected: it would have changed lines outside the target.');
        new Notice('🧠 Engram: a memory edit was blocked because it would have changed other content. Your file was not modified.');
        outcome = { ok: false, reason: 'invariant' };
        return current;
      }
      outcome = { ok: true, ids: r.ids };
      finalText = r.text;
      return r.text;
    });

    if (finalText !== null) {
      await this.saveState({ everExisted: true, lastEntryCount: parseEntries(finalText).length });
    }
    return outcome;
  }

  private warnIfEntriesVanished(current: string): void {
    const state = this.dataStore.get().memoryState as MemoryState | undefined;
    if (!state || this.warnedLoss) return;
    if (state.lastEntryCount >= 3 && parseEntries(current).length === 0) {
      this.warnedLoss = true;
      console.warn(`[Engram] Memory file has no entries but previously had ${state.lastEntryCount}.`);
      new Notice(
        `🧠 Engram: your memory file now has no entries (it had ${state.lastEntryCount}). ` +
        'If this was not intended, use "Restore memory from backup".'
      );
    }
  }

  // ── Pending facts ─────────────────────────────────────────────────────────

  /** Called from the vault 'create' event. Flushes queued facts if the memory file appeared. */
  onVaultCreate(path: string): void {
    if (path.toLowerCase() === this.memoryPath.toLowerCase()) void this.flushPending();
  }

  /** Write queued facts into the memory file, if it exists now. */
  flushPending(): Promise<void> {
    return this.enqueue(async () => {
      const pending = this.pendingFacts;
      if (pending.length === 0) return;
      try {
        const file = this.getFile();
        if (!file) return;
        await this.reconcileState(file);
        const res = await this.applyToFile(file, { type: 'add', count: pending.length }, current => {
          const r = addEntries(current, pending, new Date().toISOString().slice(0, 10));
          return { text: r.text, ids: r.added.map(a => a.id), count: r.added.length };
        });
        if (res.ok) {
          await this.dataStore.update(d => { d.pendingMemoryFacts = []; });
          new Notice(`🧠 Engram: ${pending.length} queued memory fact(s) were added.`);
        }
      } catch (e) {
        console.warn('[Engram] Could not flush queued memory facts:', e);
      }
    });
  }

  // ── File management ───────────────────────────────────────────────────────

  async openInEditor(): Promise<void> {
    const file = await this.ensureFileForOpen();
    if (!file) return;
    let leaf;
    try {
      leaf = this.app.workspace.getLeaf('tab');
    } catch {
      leaf = this.app.workspace.getLeaf(true);
    }
    await leaf.openFile(file, { active: true });
  }

  private async ensureFileForOpen(): Promise<TFile | null> {
    return this.enqueue(async () => {
      const existing = this.getFile();
      if (existing) return existing;
      const state = await this.reconcileState(null);
      if (state.everExisted) {
        new Notice(
          `🧠 Engram: memory file "${this.memoryPath}" is missing. ` +
          'It was not recreated. Use "Restore memory from backup" to recover it.'
        );
        return null;
      }
      return this.createFromTemplate();
    });
  }

  private async ensureParentFolder(filePath: string): Promise<void> {
    const lastSlash = filePath.lastIndexOf('/');
    if (lastSlash === -1) return;
    const folderPath = filePath.substring(0, lastSlash);
    if (!folderPath) return;

    let currentPath = '';
    for (const segment of folderPath.split('/')) {
      if (!segment) continue;
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (!this.app.vault.getAbstractFileByPath(currentPath)) {
        try {
          await this.app.vault.createFolder(currentPath);
        } catch {
          // Folder might have been created concurrently
        }
      }
    }
  }

  /** Create the file from the template. Only used when it has never existed. */
  private async createFromTemplate(): Promise<TFile> {
    await this.ensureParentFolder(this.memoryPath);
    const file = await this.app.vault.create(this.memoryPath, buildTemplate());
    await this.saveState({ everExisted: true, lastEntryCount: 0 });
    return file;
  }

  // ── Backups ───────────────────────────────────────────────────────────────

  private async backup(file: TFile): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      const content = await this.app.vault.read(file);
      if (!content.trim()) return;

      const existing = await this.listBackups();
      if (existing.length > 0) {
        const latest = await adapter.read(existing[0].path).catch(() => null);
        if (latest === content) return; // nothing new to preserve
      }

      if (!(await adapter.exists(this.backupDir))) await adapter.mkdir(this.backupDir);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      let name = `${BACKUP_PREFIX}${stamp}.md`;
      let n = 1;
      while (await adapter.exists(`${this.backupDir}/${name}`)) {
        name = `${BACKUP_PREFIX}${stamp}-${n++}.md`;
      }
      await adapter.write(`${this.backupDir}/${name}`, content);

      const all = await this.listBackups();
      for (const old of all.slice(MAX_BACKUPS)) {
        await adapter.remove(old.path);
      }
    } catch (err) {
      // A failed backup must never block or corrupt the main write
      console.warn('[Engram] Failed to create memory backup:', err);
    }
  }

  /** Backups, newest first. */
  async listBackups(): Promise<BackupInfo[]> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.backupDir))) return [];
    const listing = await adapter.list(this.backupDir);
    const infos: BackupInfo[] = listing.files
      .map(p => p.replace(/\\/g, '/'))
      .filter(p => {
        const name = p.slice(p.lastIndexOf('/') + 1);
        return name.startsWith(BACKUP_PREFIX) && name.endsWith('.md');
      })
      .map(p => {
        const name = p.slice(p.lastIndexOf('/') + 1);
        const m = /^memory-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
        const ts = m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : 0;
        return { name, path: p, timestamp: ts || 0 };
      });
    infos.sort((a, b) => (b.timestamp - a.timestamp) || b.name.localeCompare(a.name));
    return infos;
  }

  /** Backups (newest first) with the number of memories each one holds. */
  async describeBackups(): Promise<Array<BackupInfo & { entryCount: number }>> {
    const backups = await this.listBackups();
    const out: Array<BackupInfo & { entryCount: number }> = [];
    for (const b of backups) {
      let entryCount = 0;
      try {
        entryCount = parseEntries(await this.app.vault.adapter.read(b.path)).length;
      } catch { /* unreadable backup: show 0 */ }
      out.push({ ...b, entryCount });
    }
    return out;
  }

  /**
   * Replace the memory file with a backup. This is an explicit user action, so
   * it is not subject to the line-level invariant. The current content is
   * backed up first. Creates the file if it is missing.
   */
  restoreBackup(backupPath: string): Promise<MemoryOpResult> {
    return this.enqueue(async () => {
      try {
        const content = await this.app.vault.adapter.read(backupPath);
        const file = this.getFile();
        if (file) {
          await this.backup(file);
          await this.app.vault.process(file, () => content);
        } else {
          await this.ensureParentFolder(this.memoryPath);
          await this.app.vault.create(this.memoryPath, content);
        }
        await this.saveState({ everExisted: true, lastEntryCount: parseEntries(content).length });
        return { ok: true } as MemoryOpResult;
      } catch (e) {
        return { ok: false, reason: 'error', message: (e as Error).message } as MemoryOpResult;
      }
    }).then(async res => {
      if (res.ok) await this.flushPending();
      return res;
    });
  }
}
