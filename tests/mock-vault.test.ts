import { describe, it, expect } from 'vitest';
import { App, TFile } from 'obsidian';

describe('mock vault', () => {
  it('creates, reads, processes and renames', async () => {
    const app = new App();
    await app.vault.createFolder('A');
    const f = await app.vault.create('A/x.md', 'hello');
    expect(await app.vault.read(f)).toBe('hello');
    await app.vault.process(f, d => d + ' world');
    expect(await app.vault.read(f)).toBe('hello world');
    await app.vault.rename(f, 'A/y.md');
    const moved = app.vault.getAbstractFileByPath('A/y.md');
    expect(moved).toBeInstanceOf(TFile);
    expect(app.vault.getAbstractFileByPath('A/x.md')).toBeNull();
  });

  it('fires events', async () => {
    const app = new App();
    const seen: string[] = [];
    app.vault.on('create', (f: TFile) => seen.push('c:' + f.path));
    app.vault.on('delete', (f: TFile) => seen.push('d:' + f.path));
    const f = await app.vault.create('a.md', '');
    await app.vault.delete(f);
    expect(seen).toEqual(['c:a.md', 'd:a.md']);
  });
});
