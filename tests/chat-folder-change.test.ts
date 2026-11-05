import { describe, it, expect, vi } from 'vitest';
import { App, Notice, TFile, TFolder } from 'obsidian';
import { ChatHistoryStore } from '../src/chat/ChatHistoryStore';
import { ChatSessionService } from '../src/chat/ChatSessionService';
import { OwnOpTracker } from '../src/chat/OwnOpTracker';
import { changeChatHistoryPath } from '../src/chat/chatPathChange';
import { commitOnBlurOrEnter } from '../src/utils/commitField';
import { makeSettings } from './helpers';

const OLD = 'Intelligence/Chats';

const session = (id: string, n = 2) => ({
  id, title: id, createdAt: 1, updatedAt: 1000 + n,
  messages: Array.from({ length: n }, (_, i) => ({ role: 'user' as const, content: `m${i}` })),
});

async function setup(count = 3, over: any = {}) {
  const app = new App();
  const tracker = new OwnOpTracker();
  const store = new ChatHistoryStore(app as any, OLD, tracker);
  await app.vault.createFolder('Intelligence');
  await store.initialize();
  const service = new ChatSessionService(store, tracker, { getActiveSessionIds: () => new Set(), onChanged: () => {} });
  for (let i = 0; i < count; i++) {
    const s = session(`chat-${i}`, i + 1);
    service.upsert(s);
  }
  await service.flushAll();
  service.sessions = [];
  const settings = makeSettings({ chatHistoryPath: OLD, ...over });
  const confirm = vi.fn(async () => true);
  const saveSettings = vi.fn(async () => {});
  const deps = { app: app as any, settings, store, service, confirm, saveSettings };
  return { app, store, service, settings, confirm, saveSettings, deps };
}

const files = (app: App, folder: string) =>
  (app.vault.getAbstractFileByPath(folder) as TFolder | null)?.children.map(c => c.name).sort() ?? null;

describe('changing the chat history folder', () => {
  it('moves every session and they are still loadable', async () => {
    const e = await setup(3);
    const r = await changeChatHistoryPath(e.deps, 'AI/Chats');
    expect(r).toEqual({ status: 'changed', moved: 3 });
    expect(files(e.app as any, 'AI/Chats')).toEqual(['chat-0.json', 'chat-1.json', 'chat-2.json']);
    expect(e.app.vault.getAbstractFileByPath(OLD)).toBeNull();      // empty old folder is cleaned up
    expect(e.settings.chatHistoryPath).toBe('AI/Chats');
    expect(e.saveSettings).toHaveBeenCalledTimes(1);
    expect(e.service.sessions.map(s => s.id).sort()).toEqual(['chat-0', 'chat-1', 'chat-2']);
    expect(e.store.path).toBe('AI/Chats');
  });

  it('flushes unsaved messages before moving, so nothing is left behind', async () => {
    const e = await setup(1);
    e.service.upsert(session('fresh', 4));          // pending, not yet on disk
    expect(files(e.app as any, OLD)).toEqual(['chat-0.json']);
    await changeChatHistoryPath(e.deps, 'AI/Chats');
    expect(files(e.app as any, 'AI/Chats')).toEqual(['chat-0.json', 'fresh.json']);
  });

  it('cancel leaves everything where it was', async () => {
    const e = await setup(2);
    e.confirm.mockResolvedValueOnce(false);
    const r = await changeChatHistoryPath(e.deps, 'AI/Chats');
    expect(r.status).toBe('cancelled');
    expect(e.settings.chatHistoryPath).toBe(OLD);
    expect(e.store.path).toBe(OLD);
    expect(e.app.vault.getAbstractFileByPath('AI')).toBeNull();
    expect(files(e.app as any, OLD)).toHaveLength(2);
    expect(e.saveSettings).not.toHaveBeenCalled();
  });

  it('moves safety copies along and removes the old folder', async () => {
    const e = await setup(1);
    e.service.upsert(session('chat-0', 5));         // second save creates chat-0.json.bak
    await e.service.flushAll();
    expect(files(e.app as any, OLD)).toContain('chat-0.json.bak');
    await changeChatHistoryPath(e.deps, 'AI/Chats');
    expect(files(e.app as any, 'AI/Chats')).toEqual(['chat-0.json', 'chat-0.json.bak']);
    expect(e.app.vault.getAbstractFileByPath(OLD)).toBeNull();
  });

  it('with no chats there is no prompt, and the new folder is created', async () => {
    const e = await setup(0);
    const r = await changeChatHistoryPath(e.deps, 'Brand/New');
    expect(r.status).toBe('changed');
    expect(e.confirm).not.toHaveBeenCalled();
    expect(e.app.vault.getAbstractFileByPath('Brand/New')).toBeInstanceOf(TFolder);
  });

  it.each(['', '../x', '/abs', '.obsidian/chats'])('rejects %j without side effects', async (bad) => {
    const e = await setup(1);
    expect((await changeChatHistoryPath(e.deps, bad)).status).toBe('invalid');
    expect(e.settings.chatHistoryPath).toBe(OLD);
    expect(e.saveSettings).not.toHaveBeenCalled();
  });

  it('refuses a folder that would contain the memory file, and an existing file', async () => {
    const e = await setup(1);
    expect((await changeChatHistoryPath(e.deps, 'Intelligence')).status).toBe('invalid');
    await e.app.vault.create('afile', 'x');
    expect((await changeChatHistoryPath(e.deps, 'afile')).status).toBe('invalid');
    expect(e.app.vault.getAbstractFileByPath('afile')).toBeInstanceOf(TFile);
  });

  it('an unchanged path does nothing', async () => {
    const e = await setup(1);
    expect((await changeChatHistoryPath(e.deps, 'intelligence/chats')).status).toBe('unchanged');
  });

  it('typing a path creates no folders until it is committed', async () => {
    const e = await setup(1);
    const before = e.app.vault.getAllLoadedFiles().length;
    const input = (() => {
      const h: Record<string, Array<(ev: any) => void>> = {};
      return {
        value: OLD,
        addEventListener(t: string, cb: (ev: any) => void) { (h[t] ??= []).push(cb); },
        fire(t: string, ev: any = {}) { (h[t] ?? []).forEach(f => f(ev)); },
      };
    })();
    commitOnBlurOrEnter(input, v => changeChatHistoryPath(e.deps, v).then(() => {}));
    for (const v of ['A', 'AI', 'AI/', 'AI/C', 'AI/Chats']) { input.value = v; input.fire('input'); }
    expect(e.app.vault.getAllLoadedFiles().length).toBe(before);
    expect(e.app.vault.getAbstractFileByPath('A')).toBeNull();
    input.fire('blur');
    await vi.waitFor(() => expect(e.settings.chatHistoryPath).toBe('AI/Chats'));
    Notice.reset();
  });
});
