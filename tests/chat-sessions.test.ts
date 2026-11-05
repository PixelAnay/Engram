import { describe, it, expect, vi } from 'vitest';
import { App, TFile } from 'obsidian';
import { ChatHistoryStore } from '../src/chat/ChatHistoryStore';
import { ChatSessionService } from '../src/chat/ChatSessionService';
import { OwnOpTracker } from '../src/chat/OwnOpTracker';
import { SessionManager } from '../src/chat/SessionManager';
import type { ChatSession } from '../src/types';

const FOLDER = 'Intelligence/Chats';

const mk = (id: string, n = 1, updatedAt = 1000): ChatSession => ({
  id, title: `Chat ${id}`, createdAt: 1, updatedAt,
  messages: Array.from({ length: n }, (_, i) => ({ role: 'user' as const, content: `m${i}` })),
});

async function setup() {
  const app = new App();
  let now = 1_000_000;
  const tracker = new OwnOpTracker(5000, () => now);
  const store = new ChatHistoryStore(app as any, FOLDER, tracker);
  await app.vault.createFolder('Intelligence');
  await store.initialize();

  const active = new Set<string>();
  let changed = 0;
  const service = new ChatSessionService(store, tracker, {
    getActiveSessionIds: () => active,
    onChanged: () => { changed++; },
  });

  // Same wiring as main.ts registerVaultEvents
  app.vault.on('create', async (f: any) => { if (f instanceof TFile) await service.onFileChanged(f); });
  app.vault.on('modify', async (f: any) => { if (f instanceof TFile) await service.onFileChanged(f); });
  app.vault.on('delete', (f: any) => { if (f instanceof TFile) service.onFileDeleted(f.path); });

  const plugin: any = {
    app,
    get chatSessions() { return service.sessions; },
    upsertChatSession: (s: ChatSession) => service.upsert(s),
    deleteChatSession: (id: string) => service.remove(id),
    flushChat: (id: string) => service.flush(id),
    flushAllChats: () => service.flushAll(),
  };
  const sm = new SessionManager(plugin);

  const settle = () => new Promise(r => setTimeout(r, 15));
  const filePath = (id: string) => `${FOLDER}/${id}.json`;
  const exists = (id: string) => app.vault.getAbstractFileByPath(filePath(id)) instanceof TFile;
  const readJson = async (id: string) =>
    JSON.parse(await app.vault.read(app.vault.getAbstractFileByPath(filePath(id)) as TFile));

  return {
    app, store, service, sm, tracker, active, settle, exists, readJson,
    advance: (ms: number) => { now += ms; },
    get changed() { return changed; },
  };
}

describe('/clear keeps the chat', () => {
  it('an emptied session stays in the list and stays active, even though its file is deleted', async () => {
    const env = await setup();
    env.service.sessions = [];
    const s = env.sm.createAndActivate();
    env.service.upsert({ ...s, messages: mk('x', 2).messages });
    await env.service.flushAll();
    await env.settle();
    expect(env.exists(s.id)).toBe(true);

    env.sm.clearCurrentMessages();
    await env.settle();

    expect(env.exists(s.id)).toBe(false);                       // no file for an empty chat
    expect(env.service.sessions.map(x => x.id)).toContain(s.id); // but still in memory / UI
    expect(env.sm.currentId).toBe(s.id);
    expect(env.sm.currentSession?.messages).toEqual([]);
    expect(env.sm.currentSession?.title).toBe('New chat');
  });
});

describe('saving', () => {
  it('writes after the debounce delay', async () => {
    vi.useFakeTimers();
    try {
      const env = await setup();
      env.service.upsert(mk('a'));
      expect(env.exists('a')).toBe(false);
      await vi.advanceTimersByTimeAsync(900);
      expect(env.exists('a')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('flushAll (unload / quit / view close) writes pending changes immediately', async () => {
    const env = await setup();
    env.service.upsert(mk('a', 3));
    expect(env.exists('a')).toBe(false);
    expect(env.service.hasPending('a')).toBe(true);
    await env.service.flushAll();
    expect(env.exists('a')).toBe(true);
    expect((await env.readJson('a')).messages).toHaveLength(3);
    expect(env.service.hasPending()).toBe(false);
  });

  it('switching chats flushes the chat being left', async () => {
    const env = await setup();
    const a = env.sm.createAndActivate();
    env.service.upsert({ ...a, messages: mk('a', 2).messages });
    const b = mk('b');
    env.service.upsert(b);
    expect(env.exists(a.id)).toBe(false);
    env.sm.switchTo('b');
    await env.settle();
    expect(env.exists(a.id)).toBe(true);
  });
});

describe('outside changes vs our own', () => {
  it('an outside delete removes the session', async () => {
    const env = await setup();
    env.service.upsert(mk('a'));
    await env.service.flushAll();
    env.advance(6000); // past the own-write window
    const before = env.changed;
    await env.app.vault.delete(env.app.vault.getAbstractFileByPath(`${FOLDER}/a.json`) as TFile);
    await env.settle();
    expect(env.service.sessions.find(s => s.id === 'a')).toBeUndefined();
    expect(env.changed).toBeGreaterThan(before);
  });

  it('our own delete does not remove an empty session from the UI', async () => {
    const env = await setup();
    env.service.upsert(mk('a'));
    await env.service.flushAll();
    env.service.upsert({ ...mk('a'), messages: [] });
    await env.settle();
    expect(env.service.sessions.find(s => s.id === 'a')).toBeDefined();
  });

  it('a new outside file is picked up', async () => {
    const env = await setup();
    const incoming = mk('remote', 2, 5000);
    await env.app.vault.create(`${FOLDER}/remote.json`, JSON.stringify({ schemaVersion: 1, ...incoming }));
    await env.settle();
    expect(env.service.sessions.find(s => s.id === 'remote')?.messages).toHaveLength(2);
  });

  it('an outside modify with a newer updatedAt replaces the in-memory copy; an older one does not', async () => {
    const env = await setup();
    env.service.upsert(mk('a', 1, 2000));
    await env.service.flushAll();
    env.advance(6000);

    const file = env.app.vault.getAbstractFileByPath(`${FOLDER}/a.json`) as TFile;
    await env.app.vault.modify(file, JSON.stringify({ schemaVersion: 1, ...mk('a', 4, 9000) }));
    await env.settle();
    expect(env.service.sessions.find(s => s.id === 'a')?.messages).toHaveLength(4);

    await env.app.vault.modify(file, JSON.stringify({ schemaVersion: 1, ...mk('a', 1, 100) }));
    await env.settle();
    expect(env.service.sessions.find(s => s.id === 'a')?.messages).toHaveLength(4);
  });

  it('events from our own writes are ignored', async () => {
    const env = await setup();
    env.service.upsert(mk('a', 2, 3000));
    await env.service.flushAll();
    await env.settle();
    // Even though the file is "newer-or-equal", no reload happened
    expect(env.changed).toBe(0);
  });

  it('an outside delete never drops unsaved local changes', async () => {
    const env = await setup();
    env.service.upsert(mk('a'));
    await env.service.flushAll();
    env.advance(6000);
    env.service.upsert(mk('a', 3, 4000)); // unsaved edit
    await env.app.vault.delete(env.app.vault.getAbstractFileByPath(`${FOLDER}/a.json`) as TFile);
    await env.settle();
    expect(env.service.sessions.find(s => s.id === 'a')?.messages).toHaveLength(3);
    await env.service.flushAll();
    expect(env.exists('a')).toBe(true);
  });
});

describe('syncFromVault', () => {
  it('keeps unsaved chats and empty chats that are open in a view', async () => {
    const env = await setup();
    const open = env.sm.createAndActivate();
    env.active.add(open.id);
    env.service.upsert(mk('unsaved', 2));
    await env.app.vault.create(`${FOLDER}/disk.json`, JSON.stringify({ schemaVersion: 1, ...mk('disk') }));
    await env.service.syncFromVault();
    const ids = env.service.sessions.map(s => s.id).sort();
    expect(ids).toEqual([open.id, 'disk', 'unsaved'].sort());
  });
});

describe('deleting chats', () => {
  it('deleting a NON-active chat keeps the current one', async () => {
    const env = await setup();
    env.service.sessions = [mk('a', 1, 3000), mk('b', 1, 2000)];
    env.sm.switchTo('a');
    expect(env.sm.delete('b')).toBeNull();
    expect(env.sm.currentId).toBe('a');
    expect(env.service.sessions.map(s => s.id)).toEqual(['a']);
  });

  it('deleting the active chat returns the next one to show', async () => {
    const env = await setup();
    env.service.sessions = [mk('a', 1, 3000), mk('b', 1, 2000)];
    env.sm.switchTo('a');
    const next = env.sm.delete('a');
    expect(next?.id).toBe('b');
    expect(env.sm.currentId).toBe('b');
  });

  it('deleting the only chat creates a fresh one', async () => {
    const env = await setup();
    env.service.sessions = [mk('a')];
    env.sm.switchTo('a');
    const next = env.sm.delete('a');
    expect(next).not.toBeNull();
    expect(next!.id).not.toBe('a');
    expect(next!.messages).toEqual([]);
  });
});
