import { App, TFile } from 'obsidian';
import type { EngramSettings } from './types';
import { isPathAllowed } from './utils/pathUtils';

// ── Cosine similarity ──────────────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EmbeddingEntry {
  path: string;
  mtime: number;
  vector: number[];
}

export interface EmbeddingIndexData {
  version: number;
  model: string;
  entries: EmbeddingEntry[];
}

const EMBED_INDEX_VERSION = 1;

// ── EmbeddingIndex ────────────────────────────────────────────────────────────

export class EmbeddingIndex {
  private entries: EmbeddingEntry[] = [];
  private ready = false;

  constructor(
    private app: App,
    private settings: EngramSettings
  ) {}

  get isReady(): boolean {
    const provider = this.settings.embedProvider || 'none';
    return this.ready && provider !== 'none' && this.getEmbedModel() !== '';
  }

  get entryCount(): number { return this.entries.length; }

  getEmbedModel(): string {
    const provider = this.settings.embedProvider || 'none';
    if (provider === 'ollama') return this.settings.ollamaEmbedModel || 'nomic-embed-text';
    if (provider === 'openai') return this.settings.openaiEmbedModel || 'text-embedding-3-small';
    if (provider === 'custom') return this.settings.customEmbedModel || '';
    return '';
  }

  updateSettings(settings: EngramSettings): void {
    this.settings = settings;
    // Strip any entries that are now excluded
    this.entries = this.entries.filter(e => isPathAllowed(e.path, this.settings));
  }

  /** Load saved index data on startup without calling any API */
  load(savedData: EmbeddingIndexData | null): void {
    const model = this.getEmbedModel();
    const provider = this.settings.embedProvider || 'none';
    if (provider === 'none' || !model) {
      this.entries = [];
      this.ready = false;
      return;
    }

    if (savedData && savedData.version === EMBED_INDEX_VERSION && savedData.model === model) {
      this.entries = savedData.entries.filter(e => isPathAllowed(e.path, this.settings));
      this.ready = true;
    } else {
      this.entries = [];
      this.ready = true; // Mark as ready so they can build it
    }
  }

  /** Load saved index and incrementally update changed files */
  async build(
    getContent: (path: string) => Promise<string | null>
  ): Promise<void> {
    const model = this.getEmbedModel();
    const provider = this.settings.embedProvider || 'none';
    if (provider === 'none' || !model) {
      this.entries = [];
      this.ready = false;
      return;
    }

    const files = this.app.vault.getMarkdownFiles();

    // Map existing entries for fast lookup
    const existing: Map<string, EmbeddingEntry> = new Map();
    for (const e of this.entries) {
      existing.set(e.path, e);
    }

    const result: EmbeddingEntry[] = [];

    for (const file of files) {
      if (!isPathAllowed(file.path, this.settings)) continue;
      const exist = existing.get(file.path);
      if (exist && exist.mtime === file.stat.mtime) {
        // Not changed — reuse
        result.push(exist);
      } else {
        // Changed or new — embed
        const content = await getContent(file.path);
        if (!content) continue;

        // Truncate to ~4000 chars (embedding models have short windows)
        const text = `${file.basename}\n\n${content}`.slice(0, 4000);
        const vector = await this.fetchEmbedding(text);
        if (vector) {
          result.push({ path: file.path, mtime: file.stat.mtime, vector });
        } else {
          throw new Error(`Failed to generate embedding for "${file.path}".`);
        }
      }
    }

    this.entries = result;
    this.ready = true;
  }

  /** Embed a single file */
  async embedFile(file: TFile, content: string): Promise<void> {
    const model = this.getEmbedModel();
    const provider = this.settings.embedProvider || 'none';
    if (provider === 'none' || !model) return;
    if (!isPathAllowed(file.path, this.settings)) return;
    try {
      const text = `${file.basename}\n\n${content}`.slice(0, 4000);
      const vector = await this.fetchEmbedding(text);
      if (!vector) return;

      const existingIndex = this.entries.findIndex(e => e.path === file.path);
      const entry: EmbeddingEntry = { path: file.path, mtime: file.stat.mtime, vector };
      if (existingIndex >= 0) {
        this.entries[existingIndex] = entry;
      } else {
        this.entries.push(entry);
      }
    } catch {
      // Silently ignore
    }
  }

  /** Remove a file entry */
  removeFile(path: string): void {
    this.entries = this.entries.filter(e => e.path !== path);
  }

  /** Rename a file's path */
  renameFile(oldPath: string, newPath: string, newMtime: number): void {
    const entry = this.entries.find(e => e.path === oldPath);
    if (entry) {
      entry.path = newPath;
      entry.mtime = newMtime;
    }
  }

  /**
   * Semantic similarity search.
   * Returns the top-N paths ranked by cosine similarity to the query.
   */
  async search(query: string, limit: number): Promise<string[]> {
    if (!this.isReady || this.entries.length === 0) return [];
    try {
      const qVec = await this.fetchEmbedding(query.slice(0, 1000));
      if (!qVec) return [];

      const scored = this.entries.map(e => ({
        path: e.path,
        score: cosine(qVec, e.vector),
      }));

      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .filter(s => s.score > 0.25) // discard unrelated notes
        .map(s => s.path);
    } catch (err) {
      console.error('[Engram] Semantic search query embedding failed:', err);
      return [];
    }
  }

  /** Serialise for persistence */
  toJSON(): EmbeddingIndexData {
    return {
      version: EMBED_INDEX_VERSION,
      model: this.getEmbedModel(),
      entries: this.entries,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async fetchEmbedding(text: string): Promise<number[] | null> {
    const provider = this.settings.embedProvider || 'none';
    const model = this.getEmbedModel();
    if (provider === 'none' || !model) return null;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);

    try {
      let url = '';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      let body: any = {};

      if (provider === 'ollama') {
        const base = (this.settings.ollamaEmbedUrl || 'http://localhost:11434').replace(/\/$/, '');
        url = `${base}/api/embeddings`;
        body = { model, prompt: text };
      } else if (provider === 'openai') {
        url = 'https://api.openai.com/v1/embeddings';
        const apiKey = this.settings.openaiEmbedApiKey?.trim() || this.settings.providerApiKey?.trim();
        if (!apiKey) {
          throw new Error('API key is missing. Please configure your OpenAI API Key.');
        }
        headers['Authorization'] = `Bearer ${apiKey}`;
        body = { model, input: text };
      } else if (provider === 'custom') {
        url = this.settings.customEmbedUrl || '';
        if (!url) {
          throw new Error('Custom embeddings URL is not configured.');
        }
        const apiKey = this.settings.customEmbedApiKey?.trim();
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        body = { model, input: text };
      } else {
        clearTimeout(timer);
        return null;
      }

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e: any) {
        if (e.name === 'AbortError') {
          throw new Error(`Connection timed out (15s) at ${url}. Check if the server is running.`);
        }
        throw new Error(`Failed to connect to ${url}. Verify URL is correct and server is running. (${e.message || e})`);
      } finally {
        clearTimeout(timer);
      }

      if (!resp.ok) {
        let errorMsg = `Server returned status ${resp.status}`;
        try {
          const errData = await resp.json();
          if (errData?.error?.message) {
            errorMsg += `: ${errData.error.message}`;
          } else if (errData?.error) {
            errorMsg += `: ${JSON.stringify(errData.error)}`;
          }
        } catch {
          // ignore
        }
        throw new Error(`API error: ${errorMsg}`);
      }

      const data = await resp.json();

      if (provider === 'ollama') {
        if (!Array.isArray(data?.embedding)) {
          throw new Error("Invalid response format: 'embedding' field is missing or not an array.");
        }
        return data.embedding;
      } else {
        const embed = data?.data?.[0]?.embedding;
        if (!Array.isArray(embed)) {
          throw new Error("Invalid response format: 'data[0].embedding' field is missing or not an array.");
        }
        return embed;
      }
    } catch (err) {
      clearTimeout(timer);
      console.error('[Engram] Error fetching embedding:', err);
      throw err;
    }
  }
}
