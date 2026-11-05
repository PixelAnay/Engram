import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Notice, TFile } from 'obsidian';
import { makeEnv } from './helpers';
import { commitOnBlurOrEnter } from '../src/utils/commitField';
import { changeMemoryPath } from '../src/memory/memoryPathChange';
import { parseEntries } from '../src/memory/memoryFormat';

beforeEach(() => Notice.reset());

function fakeInput(initial: string) {
  const handlers: Record<string, Array<(e: any) => void>> = {};
  return {
    value: initial,
    addEventListener(type: string, cb: (e: any) => void) { (handlers[type] ??= []).push(cb); },
    fire(type: string, e: any = {}) { (handlers[type] ?? []).forEach(h => h(e)); },
  };
}

describe('commitOnBlurOrEnter', () => {
  it('typing does not commit; blur does, once', async () => {
    const input = fakeInput('Intelligence/Memory.md');
    const commit = vi.fn();
    commitOnBlurOrEnter(input, commit);
    for (const v of ['B', 'Br', 'Bra', 'Brain/Memory.md']) { input.value = v; input.fire('input'); }
    expect(commit).not.toHaveBeenCalled();
    input.fire('blur');
    await Promise.resolve();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('Brain/Memory.md');
    input.fire('blur');
    await Promise.resolve();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('Enter commits and an unchanged value does not', async () => {
    const input = fakeInput('a.md');
    const commit = vi.fn();
    commitOnBlurOrEnter(input, commit);
    input.fire('keydown', { key: 'Enter', preventDefault() {} });
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();
    input.value = 'b.md';
    input.fire('keydown', { key: 'Enter', preventDefault() {} });
    await Promise.resolve();
    expect(commit).toHaveBeenCalledWith('b.md');
  });
});

describe('changeMemoryPath', () => {
  const SEED = 'Intro I wrote.\n\n# 💾 Stored Memories\n\n- [2025-01-01|m1] keep me\n';

  async function env() {
    const e = await makeEnv({ files: { 'Intelligence/Memory.md': SEED } });
    const saveSettings = vi.fn(async () => { e.mm.updateConfig(e.settings.memoryPath); });
    const confirm = vi.fn(async () => true);
    const deps = { app: e.app as any, settings: e.settings, dataStore: e.store, confirm, saveSettings };
    return { ...e, deps, saveSettings, confirm };
  }

  it('moves the existing file with all content intact', async () => {
    const e = await env();
    const r = await changeMemoryPath(e.deps, 'Brain/Memory.md');
    expect(r.status).toBe('moved');
    expect(e.app.vault.getAbstractFileByPath('Intelligence/Memory.md')).toBeNull();
    expect(await e.read('Brain/Memory.md')).toBe(SEED);
    expect(e.settings.memoryPath).toBe('Brain/Memory.md');
    expect(e.store.get().memoryState).toMatchObject({ path: 'Brain/Memory.md', everExisted: true });
    // the manager keeps working at the new path without recreating anything
    expect((await e.mm.add(['after move'])).status).toBe('saved');
    expect(parseEntries((await e.read('Brain/Memory.md'))!)).toHaveLength(2);
  });

  it('cancel leaves everything as it was', async () => {
    const e = await env();
    e.confirm.mockResolvedValueOnce(false);
    const r = await changeMemoryPath(e.deps, 'Brain/Memory.md');
    expect(r.status).toBe('cancelled');
    expect(e.settings.memoryPath).toBe('Intelligence/Memory.md');
    expect(await e.read('Intelligence/Memory.md')).toBe(SEED);
    expect(e.app.vault.getAbstractFileByPath('Brain')).toBeNull();
    expect(e.saveSettings).not.toHaveBeenCalled();
  });

  it.each(['notes.txt', '../Memory.md', '/abs/Memory.md', '', '.obsidian/Memory.md'])('rejects %j', async (bad) => {
    const e = await env();
    expect((await changeMemoryPath(e.deps, bad)).status).toBe('invalid');
    expect(e.settings.memoryPath).toBe('Intelligence/Memory.md');
    expect(e.saveSettings).not.toHaveBeenCalled();
  });

  it('refuses a path inside the chat history folder', async () => {
    const e = await env();
    expect((await changeMemoryPath(e.deps, 'Intelligence/Chats/Memory.md')).status).toBe('invalid');
  });

  it('an unchanged path does nothing', async () => {
    const e = await env();
    expect((await changeMemoryPath(e.deps, 'intelligence/memory.md')).status).toBe('unchanged');
  });

  it('switching to an already-existing file leaves the old one untouched', async () => {
    const e = await env();
    await e.app.vault.createFolder('Other');
    await e.app.vault.create('Other/Mem.md', '# 💾 Stored Memories\n\n');
    const r = await changeMemoryPath(e.deps, 'Other/Mem.md');
    expect(r.status).toBe('switched');
    expect(await e.read('Intelligence/Memory.md')).toBe(SEED);
  });
});

describe('Clear all memory', () => {
  it('keeps free text and creates a backup', async () => {
    const SEED = 'Intro I wrote.\n\n# 💾 Stored Memories\n\n- [2025-01-01|m1] a\n- [2025-01-02|m2] b\n\n## My notes\nStay.\n';
    const e = await makeEnv({ files: { 'Intelligence/Memory.md': SEED } });
    expect((await e.mm.clearAll()).ok).toBe(true);
    const text = (await e.read('Intelligence/Memory.md'))!;
    expect(parseEntries(text)).toHaveLength(0);
    expect(text).toContain('Intro I wrote.');
    expect(text).toContain('## My notes\nStay.');
    const backups = await e.mm.describeBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0].entryCount).toBe(2);
    expect(e.app.vault.getAbstractFileByPath('Intelligence/Memory.md')).toBeInstanceOf(TFile);
  });
});
