import { App, TFile, getAllTags, CachedMetadata } from 'obsidian';
import type { NoteMetadata, SearchResult, EngramSettings } from './types';
import { normalisePath } from './utils/pathUtils';

/** Local-only index shape — not exported from types.ts */
interface VaultIndex {
  version: number;
  buildTime: number;
  notes: Record<string, NoteMetadata>;
}

const INDEX_VERSION = 2;
const LRU_MAX = 100; // max full-content entries to keep in memory

/** Simple glob → regex (supports * and **) */
function globToRegex(pattern: string): RegExp {
  // 1. Escape all regex special chars except *
  // 2. Replace ** before * (order matters)
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<DS>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<DS>>>/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** Lightweight LRU cache for note full-text content */
class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private max: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

export class VaultIndexer {
  private index: VaultIndex = { version: INDEX_VERSION, buildTime: 0, notes: {} };
  private contentCache = new LRUCache<string, string>(LRU_MAX);
  private excludeRegexes: RegExp[] = [];
  private ready = false;

  // ── Caches invalidated by settings/index changes ──────────────────────────
  private _excludedCount: number | null = null;
  private _vaultMapCache: string | null = null;
  private _vaultMapNoteCount: number | null = null;

  constructor(private app: App, private settings: EngramSettings) {
    this.rebuildExcludeRegexes();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get isReady(): boolean {
    return this.ready;
  }

  get noteCount(): number {
    return Object.keys(this.index.notes).length;
  }

  /** Return all indexed note paths */
  getAllPaths(): string[] {
    return Object.keys(this.index.notes);
  }

  /**
   * Count of excluded markdown files. Cached — only recomputed when
   * exclusion patterns or the index changes.
   */
  get excludedCount(): number {
    if (this._excludedCount === null) {
      this._excludedCount = this.app.vault
        .getMarkdownFiles()
        .filter(f => this.isExcluded(f.path)).length;
    }
    return this._excludedCount;
  }

  /** Build the index on plugin startup */
  async build(savedData?: unknown | null): Promise<void> {
    // Cast the unknown saved data so we can safely access its fields
    const saved = savedData as VaultIndex | null | undefined;
    this.rebuildExcludeRegexes();

    const files = this.app.vault.getMarkdownFiles();
    const needsRebuild = !saved ||
      saved.version !== INDEX_VERSION ||
      // Check if any file has changed since the last index
      files.some(f => {
        const meta = saved.notes[f.path];
        return !meta || meta.mtime !== f.stat.mtime;
      });

    if (!needsRebuild && saved) {
      // Restore from cache but remove any deleted files
      this.index = saved;
      const currentPaths = new Set(files.map(f => f.path));
      for (const path of Object.keys(this.index.notes)) {
        if (!currentPaths.has(path)) delete this.index.notes[path];
      }
      this.ready = true;
      this.invalidateCaches();
      return;
    }

    // Batch-index all files in chunks to avoid blocking the UI
    this.index = { version: INDEX_VERSION, buildTime: Date.now(), notes: {} };
    const CHUNK = 50;
    for (let i = 0; i < files.length; i += CHUNK) {
      const chunk = files.slice(i, i + CHUNK);
      for (const file of chunk) {
        if (!this.isExcluded(file.path)) {
          this.index.notes[file.path] = await this.buildMeta(file);
        }
      }
      // Yield to the event loop between chunks
      await new Promise(r => setTimeout(r, 0));
    }
    this.ready = true;
    this.invalidateCaches();
  }

  /** Update a single file in the index */
  async updateFile(file: TFile): Promise<void> {
    if (this.isExcluded(file.path)) {
      delete this.index.notes[file.path];
    } else {
      this.index.notes[file.path] = await this.buildMeta(file);
    }
    this.contentCache.delete(file.path);
    this.invalidateCaches();
  }

  /** Remove a file from the index */
  removeFile(path: string): void {
    delete this.index.notes[path];
    this.contentCache.delete(path);
    this.invalidateCaches();
  }

  /** Rename a file in the index */
  async renameFile(file: TFile, oldPath: string): Promise<void> {
    this.removeFile(oldPath);
    await this.updateFile(file);
  }

  /** Get the serialisable index to persist */
  getSerializable(): VaultIndex {
    return this.index;
  }

  /** Update settings (e.g. exclusion patterns changed) */
  updateSettings(settings: EngramSettings): void {
    this.settings = settings;
    this.rebuildExcludeRegexes();
    this.invalidateCaches();
  }

  // ── Content Access ────────────────────────────────────────────────────────

  /** Read the full content of a note (with LRU cache) */
  async readNote(path: string): Promise<string | null> {
    const cached = this.contentCache.get(path);
    if (cached !== undefined) return cached;

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    if (this.isExcluded(path)) return null;

    const content = await this.app.vault.read(file);
    this.contentCache.set(path, content);
    return content;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * Search vault notes.
   * @param query   Free-text query (scored against title + tags + frontmatter)
   * @param tags    Optional tag filter (must match any)
   * @param limit   Max results to return
   */
  /**
   * Async overload for context.ts compatibility.
   * Delegates to the synchronous implementation.
   */
  async searchAsync(query: string, limit: number): Promise<Array<{path: string; score: number; title: string}>> {
    return this.search(query, undefined, limit);
  }

  search(query: string, tags?: string[], limit = 20): SearchResult[] {
    const q = query.toLowerCase().trim();
    const results: SearchResult[] = [];

    for (const [, meta] of Object.entries(this.index.notes)) {
      let score = 0;

      // Tag filter (hard constraint)
      if (tags && tags.length > 0) {
        const noteTags = meta.tags.map(t => t.toLowerCase());
        const match = tags.some(tag => noteTags.some(nt => nt.includes(tag.toLowerCase())));
        if (!match) continue;
        score += 5;
      }

      if (q) {
        const titleLower = meta.title.toLowerCase();
        const pathLower = meta.path.toLowerCase();

        // Exact title match → highest score
        if (titleLower === q) score += 100;
        else if (titleLower.startsWith(q)) score += 50;
        else if (titleLower.includes(q)) score += 20;

        // Path match
        if (pathLower.includes(q)) score += 10;

        // Tag match
        for (const tag of meta.tags) {
          if (tag.toLowerCase().includes(q)) score += 8;
        }

        // Frontmatter match
        const fmStr = JSON.stringify(meta.frontmatter).toLowerCase();
        if (fmStr.includes(q)) score += 3;

        // Token overlap: split query into words and score each match
        const words = q.split(/\s+/).filter(w => w.length > 2);
        for (const word of words) {
          if (titleLower.includes(word)) score += 5;
          if (pathLower.includes(word)) score += 2;
        }

        if (score === 0) continue;
      } else {
        // No query — return all (sorted by mtime)
        score = meta.mtime;
      }

      results.push({ path: meta.path, title: meta.title, tags: meta.tags, score });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Full-text search (reads file content — expensive).
   * Processed in small async chunks to avoid freezing the UI.
   */
  async fullTextSearch(query: string, limit = 10): Promise<SearchResult[]> {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    const candidates = Object.keys(this.index.notes);
    const results: SearchResult[] = [];
    const CHUNK = 20;

    for (let i = 0; i < candidates.length; i += CHUNK) {
      const batch = candidates.slice(i, i + CHUNK);
      for (const path of batch) {
        const content = await this.readNote(path);
        if (!content) continue;

        const lower = content.toLowerCase();
        const idx = lower.indexOf(q);
        if (idx === -1) continue;

        // Extract surrounding snippet
        const start = Math.max(0, idx - 60);
        const end = Math.min(content.length, idx + q.length + 60);
        const snippet = '...' + content.slice(start, end).replace(/\n/g, ' ').trim() + '...';

        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const occurrences = (lower.match(new RegExp(escaped, 'g')) ?? []).length;

        results.push({
          path,
          title: this.index.notes[path].title,
          tags: this.index.notes[path].tags,
          snippet,
          score: occurrences,
        });
      }
      // Yield between batches to keep UI responsive
      await new Promise(r => setTimeout(r, 0));
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Get all notes in a folder */
  listFolder(folderPath: string): NoteMetadata[] {
    const normalized = normalisePath(folderPath);
    return Object.values(this.index.notes).filter(meta => {
      const dir = meta.path.includes('/') ? meta.path.substring(0, meta.path.lastIndexOf('/')) : '';
      return normalized === '' ? !meta.path.includes('/') : dir === normalized || dir.startsWith(normalized + '/');
    });
  }

  /**
   * Get the compact vault map string for injection into system prompt.
   * Result is cached and invalidated only when the index changes.
   */
  getVaultMap(): string {
    const count = this.noteCount;
    // Return cached version if the note count hasn't changed
    if (this._vaultMapCache !== null && this._vaultMapNoteCount === count) {
      return this._vaultMapCache;
    }

    const notes = Object.values(this.index.notes);
    const lines = notes.map(meta => {
      const tags = meta.tags.length > 0 ? ` [${meta.tags.join(', ')}]` : '';
      return `- ${meta.path}${tags}`;
    });
    this._vaultMapCache = lines.join('\n');
    this._vaultMapNoteCount = count;
    return this._vaultMapCache;
  }

  /** Get top N notes ranked by relevance to a query (for auto-injection) */
  getTopNotes(query: string, n: number): NoteMetadata[] {
    const results = this.search(query, undefined, n);
    return results.map(r => this.index.notes[r.path]).filter(Boolean);
  }

  /** Get note metadata by path */
  getNoteMeta(path: string): NoteMetadata | null {
    return this.index.notes[path] ?? null;
  }

  /**
   * Return the top tags across the entire vault (for dynamic UI chips etc.)
   * Returns up to `limit` tags sorted by frequency.
   */
  getTopTags(limit = 10): string[] {
    const freq = new Map<string, number>();
    for (const meta of Object.values(this.index.notes)) {
      for (const tag of meta.tags) {
        freq.set(tag, (freq.get(tag) ?? 0) + 1);
      }
    }
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([tag]) => tag);
  }

  /**
   * Return the most recently modified notes.
   * Useful for generating context-aware welcome suggestions.
   */
  getRecentNotes(limit = 5): NoteMetadata[] {
    return Object.values(this.index.notes)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  private isExcluded(path: string): boolean {
    return this.excludeRegexes.some(re => re.test(path));
  }

  private rebuildExcludeRegexes(): void {
    this.excludeRegexes = this.settings.excludePatterns.map(globToRegex);
  }

  /** Invalidate computed caches that depend on index state. */
  private invalidateCaches(): void {
    this._excludedCount = null;
    this._vaultMapCache = null;
    this._vaultMapNoteCount = null;
  }

  private async buildMeta(file: TFile): Promise<NoteMetadata> {
    const cache: CachedMetadata | null = this.app.metadataCache.getFileCache(file);
    const tags: string[] = cache ? (getAllTags(cache) ?? []) : [];
    const frontmatter: Record<string, unknown> = cache?.frontmatter ?? {};

    // Estimate word count from file size (cheaper than reading content)
    const wordCount = Math.round(file.stat.size / 5);

    return {
      path: file.path,
      title: file.basename,
      tags,
      frontmatter,
      mtime: file.stat.mtime,
      wordCount,
      size: file.stat.size,
    };
  }
}
