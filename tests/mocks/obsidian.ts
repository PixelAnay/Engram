/**
 * In-memory stand-in for the `obsidian` module, used by Vitest only.
 * Mirrors the subset of the API that Engram uses. Behaviour follows the real
 * API where it matters for correctness (create throws on existing path,
 * missing parent folder throws, events fire after operations).
 */

export function normalizePath(path: string): string {
  let p = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  return p;
}

export class TAbstractFile {
  path = '';
  name = '';
  parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
  extension = '';
  basename = '';
  stat = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class Notice {
  static messages: string[] = [];
  static reset(): void { Notice.messages = []; }
  constructor(message: string) {
    Notice.messages.push(message);
  }
}

export class Modal {
  app: unknown;
  contentEl: any = null;
  titleEl: any = { setText: () => {} };
  constructor(app: unknown) { this.app = app; }
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

export class Component {}
export class ItemView {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class WorkspaceLeaf {}
export class MarkdownRenderer {
  static render(): void {}
}
export function setIcon(): void {}
export function getAllTags(): string[] { return []; }
export type CachedMetadata = Record<string, unknown>;

export const requestUrl = async (_req: unknown): Promise<any> => ({ status: 200, json: {}, text: '' });

type Listener = (...args: any[]) => unknown;

class MockAdapter {
  files = new Map<string, string>();
  dirs = new Set<string>();

  async read(path: string): Promise<string> {
    const v = this.files.get(normalizePath(path));
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }
  async write(path: string, data: string): Promise<void> {
    const p = normalizePath(path);
    const idx = p.lastIndexOf('/');
    if (idx > 0) this.dirs.add(p.slice(0, idx));
    this.files.set(p, data);
  }
  async exists(path: string): Promise<boolean> {
    const p = normalizePath(path);
    return this.files.has(p) || this.dirs.has(p);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(normalizePath(path));
  }
  async mkdir(path: string): Promise<void> {
    this.dirs.add(normalizePath(path));
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const p = normalizePath(path);
    const prefix = p ? p + '/' : '';
    const files: string[] = [];
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) files.push(f);
    }
    return { files, folders: [] };
  }
}

export class Vault {
  private entries = new Map<string, TAbstractFile>();
  private contents = new Map<string, string>();
  private listeners = new Map<string, Listener[]>();
  private clock = 1000;
  root = new TFolder();
  adapter = new MockAdapter();

  constructor() {
    this.root.path = '/';
    this.root.name = '';
  }

  // ── Events ────────────────────────────────────────────────────────────────
  on(name: string, cb: Listener): { name: string; cb: Listener } {
    const list = this.listeners.get(name) ?? [];
    list.push(cb);
    this.listeners.set(name, list);
    return { name, cb };
  }
  offref(ref: { name: string; cb: Listener }): void {
    const list = this.listeners.get(ref.name) ?? [];
    this.listeners.set(ref.name, list.filter(l => l !== ref.cb));
  }
  trigger(name: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(name) ?? []) l(...args);
  }

  // ── Lookup ────────────────────────────────────────────────────────────────
  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.entries.get(normalizePath(path)) ?? null;
  }
  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter(f => f.extension === 'md');
  }
  getFiles(): TFile[] {
    return [...this.entries.values()].filter((e): e is TFile => e instanceof TFile);
  }
  getAllLoadedFiles(): TAbstractFile[] {
    return [this.root, ...this.entries.values()];
  }

  // ── Mutations ─────────────────────────────────────────────────────────────
  private parentOf(path: string): TFolder {
    const idx = path.lastIndexOf('/');
    if (idx === -1) return this.root;
    const parent = this.entries.get(path.slice(0, idx));
    if (!(parent instanceof TFolder)) throw new Error(`ENOENT: parent folder missing for ${path}`);
    return parent;
  }

  private register<T extends TAbstractFile>(entry: T, path: string): T {
    const parent = this.parentOf(path);
    entry.path = path;
    entry.name = path.slice(path.lastIndexOf('/') + 1);
    entry.parent = parent;
    parent.children.push(entry);
    this.entries.set(path, entry);
    return entry;
  }

  private touch(file: TFile, data: string): void {
    file.stat.mtime = ++this.clock;
    file.stat.size = data.length;
  }

  async createFolder(path: string): Promise<TFolder> {
    const p = normalizePath(path);
    if (this.entries.has(p)) throw new Error('Folder already exists.');
    const folder = this.register(new TFolder(), p);
    this.trigger('create', folder);
    return folder;
  }

  async create(path: string, data: string): Promise<TFile> {
    const p = normalizePath(path);
    if (this.entries.has(p)) throw new Error('File already exists.');
    const file = new TFile();
    const name = p.slice(p.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    file.extension = dot === -1 ? '' : name.slice(dot + 1);
    file.basename = dot === -1 ? name : name.slice(0, dot);
    this.register(file, p);
    this.contents.set(p, data);
    file.stat.ctime = ++this.clock;
    this.touch(file, data);
    this.trigger('create', file);
    return file;
  }

  async read(file: TFile): Promise<string> {
    const v = this.contents.get(file.path);
    if (v === undefined) throw new Error(`ENOENT: ${file.path}`);
    return v;
  }
  async cachedRead(file: TFile): Promise<string> { return this.read(file); }

  async modify(file: TFile, data: string): Promise<void> {
    if (!this.contents.has(file.path)) throw new Error(`ENOENT: ${file.path}`);
    this.contents.set(file.path, data);
    this.touch(file, data);
    this.trigger('modify', file);
  }

  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const current = await this.read(file);
    const next = fn(current);
    if (next !== current) {
      this.contents.set(file.path, next);
      this.touch(file, next);
      this.trigger('modify', file);
    }
    return next;
  }

  private removeEntry(entry: TAbstractFile): void {
    if (entry instanceof TFolder) {
      for (const child of [...entry.children]) this.removeEntry(child);
    }
    entry.parent?.children.splice(entry.parent.children.indexOf(entry), 1);
    this.entries.delete(entry.path);
    this.contents.delete(entry.path);
    this.trigger('delete', entry);
  }

  async delete(entry: TAbstractFile, _force?: boolean): Promise<void> {
    this.removeEntry(entry);
  }
  async trash(entry: TAbstractFile, _system: boolean): Promise<void> {
    this.removeEntry(entry);
  }

  async rename(entry: TAbstractFile, newPath: string): Promise<void> {
    const p = normalizePath(newPath);
    if (this.entries.has(p)) throw new Error('Destination file already exists!');
    const oldPath = entry.path;
    const newParent = this.parentOf(p);
    const moveOne = (e: TAbstractFile, from: string, to: string) => {
      this.entries.delete(from);
      if (e instanceof TFile) {
        const c = this.contents.get(from);
        this.contents.delete(from);
        if (c !== undefined) this.contents.set(to, c);
      }
      e.path = to;
      e.name = to.slice(to.lastIndexOf('/') + 1);
      this.entries.set(to, e);
      if (e instanceof TFolder) {
        for (const child of e.children) moveOne(child, from + '/' + child.name, to + '/' + child.name);
      }
    };
    entry.parent?.children.splice(entry.parent.children.indexOf(entry), 1);
    moveOne(entry, oldPath, p);
    entry.parent = newParent;
    newParent.children.push(entry);
    if (entry instanceof TFile) {
      const name = entry.name;
      const dot = name.lastIndexOf('.');
      entry.extension = dot === -1 ? '' : name.slice(dot + 1);
      entry.basename = dot === -1 ? name : name.slice(0, dot);
    }
    this.trigger('rename', entry, oldPath);
  }
}

export class App {
  vault = new Vault();
  workspace = {
    layoutReady: true,
    onLayoutReady(cb: () => void): void { cb(); },
    getLeavesOfType: (_t: string): any[] => [],
    getLeaf: () => ({ openFile: async () => {} }),
    on: (_n: string, _cb: Listener) => ({}),
  };
  fileManager = {
    renameFile: async (file: TAbstractFile, newPath: string): Promise<void> => {
      await this.vault.rename(file, newPath);
    },
    trashFile: async (file: TAbstractFile): Promise<void> => {
      await this.vault.trash(file, false);
    },
  };
  metadataCache = {
    getFileCache: (_f: TFile): null => null,
  };
}
