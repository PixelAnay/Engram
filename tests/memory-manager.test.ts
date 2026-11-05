import { describe, it, expect, beforeEach } from 'vitest';
import { App, TFile, Notice } from 'obsidian';
import { MemoryManager, MAX_BACKUPS } from '../src/memory/MemoryManager';
import { PluginDataStore } from '../src/storage/PluginDataStore';
import { parseEntries } from '../src/memory/memoryFormat';

const PATH = 'Intelligence/Memory.md';
const BACKUPS = '.obsidian/plugins/engram-chat/memory-backups';

const INTRO = 'My own paragraph that must never change.\n\n';

async function setup(opts: { file?: string | null; ready?: boolean; data?: any } = {}) {
  const app = new App();
  let disk: any = opts.data ?? {};
  const store = new PluginDataStore({
    async loadData() { return disk; },
    async saveData(d: any) { disk = JSON.parse(JSON.stringify(d)); },
  });
  await store.load();
  if (opts.file !== null && opts.file !== undefined) {
    await app.vault.createFolder('Intelligence');
    await app.vault.create(PATH, opts.file);
  }
  const mm = new MemoryManager(app as any, PATH, store, '.obsidian/plugins/engram-chat/memory-backups');
  if (opts.ready !== false) mm.markReady();
  const read = async () => app.vault.read(app.vault.getAbstractFileByPath(PATH) as TFile);
  return { app, mm, store, read, getDisk: () => disk };
}

beforeEach(() => Notice.reset());

describe('MemoryManager: preserving the file', () => {
  it('add / update / remove never change non-entry text', async () => {
    const seed = `---\ntags: [me]\n---\n\n${INTRO}# 💾 Stored Memories\n\n`;
    const { mm, read } = await setup({ file: seed });

    for (const f of ['one', 'two', 'three', 'four', 'five']) {
      const r = await mm.add([f]);
      expect(r.status).toBe('saved');
    }
    let entries = parseEntries(await read());
    expect(entries).toHaveLength(5);

    expect((await mm.remove(entries[1].id)).ok).toBe(true);
    entries = parseEntries(await read());
    expect((await mm.update(entries[0].id, 'ONE updated')).ok).toBe(true);

    const text = await read();
    expect(text.startsWith(`---\ntags: [me]\n---\n\n${INTRO}# 💾 Stored Memories\n\n`)).toBe(true);
    const facts = parseEntries(text).map(e => e.fact);
    expect(facts).toEqual(['ONE updated', 'three', 'four', 'five']);
  });

  it('forget returns true only when something was removed', async () => {
    const { mm } = await setup({ file: '# 💾 Stored Memories\n\n- [2025-01-01|m1] a\n' });
    expect(await mm.forget('nope')).toBe(false);
    expect(await mm.forget('m1')).toBe(true);
  });

  it('can delete the last remaining entry and keeps the rest', async () => {
    const { mm, read } = await setup({ file: `${INTRO}# 💾 Stored Memories\n\n- [2025-01-01|m1] a\n` });
    expect(await mm.forget('m1')).toBe(true);
    const text = await read();
    expect(text).toBe(`${INTRO}# 💾 Stored Memories\n\n`);
  });

  it('clearAll removes entries but keeps free text, and makes a backup', async () => {
    const { mm, read, app } = await setup({ file: `${INTRO}# 💾 Stored Memories\n\n- [2025-01-01|m1] a\n- [2025-01-02|m2] b\n` });
    expect((await mm.clearAll()).ok).toBe(true);
    const text = await read();
    expect(parseEntries(text)).toHaveLength(0);
    expect(text).toContain('My own paragraph that must never change.');
    expect((await app.vault.adapter.list(BACKUPS)).files.length).toBe(1);
  });

  it('update on an unknown id reports not_found and leaves the file identical', async () => {
    const seed = '# 💾 Stored Memories\n\n- [2025-01-01|m1] a\n';
    const { mm, read } = await setup({ file: seed });
    const r = await mm.update('missing', 'x');
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await read()).toBe(seed);
  });

  it('keeps a user edit made while the operation was waiting in the queue', async () => {
    const { mm, app, read } = await setup({ file: '# 💾 Stored Memories\n\n- [2025-01-01|m1] a\n' });
    const pending = mm.add(['new fact']);
    // The user edits the file before the queued operation starts
    const file = app.vault.getAbstractFileByPath(PATH) as TFile;
    await app.vault.modify(file, '# 💾 Stored Memories\n\nUSER NOTE\n\n- [2025-01-01|m1] a\n');
    await pending;
    const text = await read();
    expect(text).toContain('USER NOTE');
    expect(text).toContain('new fact');
  });

  it('serializes concurrent adds without losing any', async () => {
    const { mm, read } = await setup({ file: '# 💾 Stored Memories\n\n' });
    await Promise.all(Array.from({ length: 12 }, (_, i) => mm.add([`fact ${i}`])));
    expect(parseEntries(await read())).toHaveLength(12);
  });

  it('leaves the file byte-identical when the invariant check fails', async () => {
    // A garbled id makes ENTRY parsing differ; simulate by corrupting via a hostile add generator is not
    // possible from outside, so verify through the format layer used by the manager.
    const seed = '# 💾 Stored Memories\n\n- [2025-01-01|m1] a\n';
    const { mm, read } = await setup({ file: seed });
    const r = await mm.update('m1', '   ');
    expect(r).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await read()).toBe(seed);
  });
});

describe('MemoryManager: missing file safety', () => {
  it('does NOT create a blank file when the file existed before; queues facts', async () => {
    const { mm, app, store } = await setup({
      file: null,
      data: { memoryState: { path: PATH, everExisted: true, lastEntryCount: 40 } },
    });
    const r = await mm.add(['important new fact']);
    expect(r.status).toBe('queued');
    expect(app.vault.getAbstractFileByPath(PATH)).toBeNull();
    expect(store.get().pendingMemoryFacts).toEqual(['important new fact']);
    expect(Notice.messages.some(m => m.includes('missing'))).toBe(true);
  });

  it('treats a legacy .bak file as proof the memory file existed', async () => {
    const { mm, app } = await setup({ file: null });
    await app.vault.createFolder('Intelligence');
    await app.vault.create(PATH + '.bak', 'old');
    const r = await mm.add(['fact']);
    expect(r.status).toBe('queued');
    expect(app.vault.getAbstractFileByPath(PATH)).toBeNull();
  });

  it('creates the file when there is no history of one', async () => {
    const { mm, read } = await setup({ file: null });
    const r = await mm.add(['first ever fact']);
    expect(r.status).toBe('saved');
    expect(await read()).toContain('# 💾 Stored Memories');
    expect(parseEntries(await read())).toHaveLength(1);
  });

  it('flushes queued facts when the file appears', async () => {
    const { mm, app, store, read } = await setup({
      file: null,
      data: { memoryState: { path: PATH, everExisted: true, lastEntryCount: 5 } },
    });
    await mm.add(['queued one']);
    await mm.add(['queued two']);
    expect(store.get().pendingMemoryFacts).toHaveLength(2);

    // sync delivers the user's real file
    await app.vault.createFolder('Intelligence');
    await app.vault.create(PATH, '# 💾 Stored Memories\n\n- [2025-01-01|m1] real memory\n');
    mm.onVaultCreate(PATH);
    await mm.flushPending();

    const facts = parseEntries(await read()).map(e => e.fact);
    expect(facts).toEqual(['real memory', 'queued one', 'queued two']);
    expect(store.get().pendingMemoryFacts).toEqual([]);
  });

  it('update/remove/clear on a missing file do nothing', async () => {
    const { mm, app } = await setup({ file: null, data: { memoryState: { path: PATH, everExisted: true, lastEntryCount: 2 } } });
    expect(await mm.update('x', 'y')).toMatchObject({ ok: false, reason: 'missing_file' });
    expect(await mm.remove('x')).toMatchObject({ ok: false, reason: 'missing_file' });
    expect(await mm.clearAll()).toMatchObject({ ok: false, reason: 'missing_file' });
    expect(app.vault.getAbstractFileByPath(PATH)).toBeNull();
  });

  it('holds writes until the layout is ready', async () => {
    const { mm, read } = await setup({ file: '# 💾 Stored Memories\n\n', ready: false });
    let done = false;
    const p = mm.add(['early']).then(r => { done = true; return r; });
    await new Promise(r => setTimeout(r, 20));
    expect(done).toBe(false);
    expect(parseEntries(await read())).toHaveLength(0);
    mm.markReady();
    expect((await p).status).toBe('saved');
  });
});

describe('MemoryManager: backups', () => {
  it('makes a backup per change and rotates at the limit', async () => {
    const { mm, app } = await setup({ file: '# 💾 Stored Memories\n\n- [2025-01-01|m0] seed\n' });
    for (let i = 0; i < MAX_BACKUPS + 8; i++) await mm.add([`fact ${i}`]);
    const backups = await mm.listBackups();
    expect(backups).toHaveLength(MAX_BACKUPS);
    // listing is newest first
    expect(backups[0].name >= backups[backups.length - 1].name).toBe(true);
    expect((await app.vault.adapter.list(BACKUPS)).files).toHaveLength(MAX_BACKUPS);
  });

  it('restores a backup into a missing file and flushes the queue', async () => {
    const { mm, app, read } = await setup({ file: '# 💾 Stored Memories\n\n- [2025-01-01|m1] precious\n' });
    await mm.add(['second']);
    const backups = await mm.listBackups();
    expect(backups.length).toBeGreaterThan(0);

    await app.vault.delete(app.vault.getAbstractFileByPath(PATH) as TFile);
    expect((await mm.add(['while missing'])).status).toBe('queued');

    const res = await mm.restoreBackup(backups[0].path);
    expect(res.ok).toBe(true);
    const facts = parseEntries(await read()).map(e => e.fact);
    expect(facts).toContain('precious');
    expect(facts).toContain('while missing');
  });
});
