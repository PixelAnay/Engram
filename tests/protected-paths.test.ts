import { describe, it, expect } from 'vitest';
import { makeEnv, makeSettings } from './helpers';
import { isProtectedPath } from '../src/utils/pathUtils';

const MEMORY = 'Intelligence/Memory.md';
const CHAT_FILE = 'Intelligence/Chats/chat-1.json';
const PROTECTED = [MEMORY, 'Intelligence', 'Intelligence/Chats', CHAT_FILE];

const FILES = {
  [MEMORY]: '# 💾 Stored Memories\n\n- [2025-01-01|m1] keep me\n',
  [CHAT_FILE]: '{"id":"chat-1","messages":[]}',
  'Note.md': 'plain note',
};

type Row = { tool: string; args: (p: string) => Record<string, unknown> };
const ROWS: Row[] = [
  { tool: 'append_to_note', args: p => ({ path: p, content: 'x' }) },
  { tool: 'edit_note', args: p => ({ path: p, mode: 'replace_block', old_text: 'keep', new_text: 'gone' }) },
  { tool: 'edit_note', args: p => ({ path: p, mode: 'full_overwrite', new_content: 'gone' }) },
  { tool: 'create_note', args: p => ({ path: p, content: 'x', overwrite: true }) },
  { tool: 'move_note', args: p => ({ source: p, destination: 'Elsewhere/x.md' }) },
  { tool: 'move_note', args: p => ({ source: 'Note.md', destination: p }) },
  { tool: 'rename_note', args: p => ({ path: p, new_name: 'x.md' }) },
  { tool: 'copy_note', args: p => ({ source: p, destination: 'Copy.md' }) },
  { tool: 'copy_note', args: p => ({ source: 'Note.md', destination: p }) },
  { tool: 'delete_note', args: p => ({ path: p, confirm: true }) },
  { tool: 'create_folder', args: p => ({ path: p }) },
];

describe('isProtectedPath', () => {
  const s = makeSettings();
  it.each([
    [MEMORY, true], ['intelligence/memory.md', true], ['Intelligence', true],
    ['Intelligence/Chats', true], [CHAT_FILE, true], ['Intelligence/Chats/sub/a.json', true],
    ['Note.md', false], ['Intelligence/Other.md', false], ['Intelligence2', false], ['Projects/Memory.md', false],
  ])('%s -> %s', (p, expected) => {
    expect(isProtectedPath(p as string, s)).toBe(expected);
  });
  it('read mode never protects', () => {
    expect(isProtectedPath(MEMORY, s, 'read')).toBe(false);
  });
});

describe.each([true, false])('write tools vs protected paths (memoryEnabled=%s)', (memoryEnabled) => {
  for (const row of ROWS) {
    for (const target of PROTECTED) {
      it(`${row.tool} ${JSON.stringify(row.args(target))} is refused`, async () => {
        const env = await makeEnv({
          settings: { editPermission: 'full_edit', memoryEnabled },
          files: FILES,
          folders: ['Elsewhere'],
        });
        const before = {
          memory: await env.read(MEMORY),
          chat: await env.read(CHAT_FILE),
        };
        const out = await env.tools.execute(row.tool, JSON.stringify(row.args(target)));
        expect(out).toMatch(/^Error/);
        expect(await env.read(MEMORY)).toBe(before.memory);
        expect(await env.read(CHAT_FILE)).toBe(before.chat);
        expect(env.app.vault.getAbstractFileByPath(MEMORY)).not.toBeNull();
        expect(env.app.vault.getAbstractFileByPath(CHAT_FILE)).not.toBeNull();
        expect(env.app.vault.getAbstractFileByPath('Intelligence/Chats')).not.toBeNull();
      });
    }
  }
});

describe('rename_note new_name validation', () => {
  it.each(['../x.md', 'sub/x.md', 'a\\b.md', '..', '.'])('rejects %s', async (name) => {
    const env = await makeEnv({ settings: { editPermission: 'full_edit' }, files: FILES });
    const out = await env.tools.execute('rename_note', JSON.stringify({ path: 'Note.md', new_name: name }));
    expect(out).toMatch(/^Error/);
    expect(env.app.vault.getAbstractFileByPath('Note.md')).not.toBeNull();
  });

  it('renames within the folder and keeps the .md extension', async () => {
    const env = await makeEnv({ settings: { editPermission: 'full_edit' }, files: FILES });
    const out = await env.tools.execute('rename_note', JSON.stringify({ path: 'Note.md', new_name: 'Renamed' }));
    expect(out).toContain('✅');
    expect(env.app.vault.getAbstractFileByPath('Renamed.md')).not.toBeNull();
  });
});

describe('permission levels', () => {
  it('read_append allows append only', async () => {
    const env = await makeEnv({ settings: { editPermission: 'read_append' }, files: FILES });
    expect(await env.tools.execute('append_to_note', JSON.stringify({ path: 'Note.md', content: 'more' })))
      .toContain('✅');
    const edit = await env.tools.execute('edit_note', JSON.stringify({
      path: 'Note.md', mode: 'replace_block', old_text: 'plain', new_text: 'changed',
    }));
    expect(edit).toMatch(/^Error.*full_edit/);
    expect(await env.read('Note.md')).toBe('plain note\n\nmore');
    expect(await env.tools.execute('create_folder', JSON.stringify({ path: 'NewFolder' }))).toMatch(/^Error/);
    expect(env.app.vault.getAbstractFileByPath('NewFolder')).toBeNull();
  });

  it('full_edit allows editing normal notes', async () => {
    const env = await makeEnv({ settings: { editPermission: 'full_edit' }, files: FILES });
    const out = await env.tools.execute('edit_note', JSON.stringify({
      path: 'Note.md', mode: 'replace_block', old_text: 'plain', new_text: 'changed',
    }));
    expect(out).toContain('✅');
    expect(await env.read('Note.md')).toBe('changed note');
  });
});

describe('undo cannot reach protected paths', () => {
  it('refuses to undo an entry that targets the memory file', async () => {
    const env = await makeEnv({ settings: { editPermission: 'full_edit' }, files: FILES });
    (env.tools as any).pushUndo(MEMORY, 'EVIL OVERWRITE', 'forged');
    expect(await env.tools.undoLast()).toBeNull();
    expect(await env.read(MEMORY)).toBe(FILES[MEMORY]);
  });
});
