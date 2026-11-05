import { describe, it, expect, vi } from 'vitest';

// Simulate a buggy edit that rebuilds the file from scratch.
vi.mock('../src/memory/memoryFormat', async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    addEntries: () => ({
      text: '# 💾 Stored Memories\n\n- [2025-01-01|zz] only this\n',
      added: [{ id: 'zz', fact: 'only this' }],
    }),
  };
});

import { App, TFile, Notice } from 'obsidian';
import { MemoryManager } from '../src/memory/MemoryManager';
import { PluginDataStore } from '../src/storage/PluginDataStore';

describe('invariant guard', () => {
  it('leaves the file byte-identical when an edit would rewrite other content', async () => {
    const app = new App();
    const store = new PluginDataStore({ async loadData() { return {}; }, async saveData() {} });
    await store.load();
    const seed = 'Precious intro\n\n# 💾 Stored Memories\n\n- [2024-01-01|a] one\n- [2024-01-02|b] two\n';
    await app.vault.createFolder('Intelligence');
    const file = await app.vault.create('Intelligence/Memory.md', seed);
    const mm = new MemoryManager(app as any, 'Intelligence/Memory.md', store, 'bk');
    mm.markReady();

    Notice.reset();
    const r = await mm.add(['new fact']);
    expect(r.status).toBe('failed');
    expect(await app.vault.read(file as TFile)).toBe(seed);
    expect(Notice.messages.some(m => m.includes('blocked'))).toBe(true);
  });
});
