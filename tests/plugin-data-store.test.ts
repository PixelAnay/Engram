import { describe, it, expect } from 'vitest';
import { PluginDataStore } from '../src/storage/PluginDataStore';

function makePersistence(initial: any = {}) {
  let disk: any = JSON.parse(JSON.stringify(initial));
  const writes: any[] = [];
  return {
    writes,
    get disk() { return disk; },
    async loadData() { return disk; },
    async saveData(d: any) {
      // simulate slow disk so concurrency bugs would show
      await new Promise(r => setTimeout(r, 5));
      disk = JSON.parse(JSON.stringify(d));
      writes.push(disk);
    },
  };
}

describe('PluginDataStore', () => {
  it('loses no keys under concurrent updates', async () => {
    const p = makePersistence({ settings: { a: 1 } });
    const store = new PluginDataStore(p);
    await store.load();
    await Promise.all([
      store.update(d => { d.index = { n: 1 }; }),
      store.update(d => { d.settings = { a: 2 }; }),
      store.update(d => { d.embeddings = { e: 1 }; }),
      store.update(d => { d.memoryState = { path: 'x' }; }),
    ]);
    expect(p.disk).toEqual({
      settings: { a: 2 }, index: { n: 1 }, embeddings: { e: 1 }, memoryState: { path: 'x' },
    });
  });

  it('applies updates in call order', async () => {
    const p = makePersistence();
    const store = new PluginDataStore(p);
    await store.load();
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map(n => store.update(d => { order.push(n); d.last = n; })));
    expect(order).toEqual([1, 2, 3, 4]);
    expect(p.disk.last).toBe(4);
  });

  it('keeps working after a failed write', async () => {
    let fail = true;
    const store = new PluginDataStore({
      async loadData() { return {}; },
      async saveData() { if (fail) { fail = false; throw new Error('disk'); } },
    });
    await store.load();
    await expect(store.update(d => { d.a = 1; })).rejects.toThrow('disk');
    await expect(store.update(d => { d.b = 2; })).resolves.toBeUndefined();
    expect(store.get()).toEqual({ a: 1, b: 2 });
  });
});
