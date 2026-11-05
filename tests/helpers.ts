import { App, TFile } from 'obsidian';
import { PluginDataStore } from '../src/storage/PluginDataStore';
import { MemoryManager } from '../src/memory/MemoryManager';
import { ToolExecutor } from '../src/tools';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { EngramSettings } from '../src/types';

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export function makeSettings(over: Partial<EngramSettings> = {}): EngramSettings {
  return { ...clone(DEFAULT_SETTINGS), ...over } as EngramSettings;
}

export function makeStore(initial: any = {}) {
  let disk: any = clone(initial);
  const store = new PluginDataStore({
    async loadData() { return disk; },
    async saveData(d: any) { disk = clone(d); },
  });
  return { store, getDisk: () => disk };
}

/** Minimal indexer stub: the tools only need these calls for write operations. */
export function makeIndexerStub() {
  return {
    updateFile: async () => {},
    removeFile: () => {},
    renameFile: async () => {},
    readNote: async () => null,
    search: () => [],
    listFolder: () => [],
    getNoteMeta: () => null,
    fullTextSearch: async () => [],
  } as any;
}

export async function makeEnv(opts: {
  settings?: Partial<EngramSettings>;
  files?: Record<string, string>;
  folders?: string[];
  ready?: boolean;
} = {}) {
  const app = new App();
  const settings = makeSettings(opts.settings);
  const { store } = makeStore();
  await store.load();

  for (const f of opts.folders ?? []) {
    if (!app.vault.getAbstractFileByPath(f)) await app.vault.createFolder(f);
  }
  for (const [path, content] of Object.entries(opts.files ?? {})) {
    const parts = path.split('/');
    parts.pop();
    let cur = '';
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur);
    }
    await app.vault.create(path, content);
  }

  const mm = new MemoryManager(app as any, settings.memoryPath, store, '.obsidian/plugins/engram-chat/memory-backups');
  if (opts.ready !== false) mm.markReady();
  const tools = new ToolExecutor(app as any, makeIndexerStub(), settings);
  tools.setMemoryManager(mm);
  const read = async (p: string) => {
    const f = app.vault.getAbstractFileByPath(p);
    return f instanceof TFile ? app.vault.read(f) : null;
  };
  return { app, settings, store, mm, tools, read };
}
