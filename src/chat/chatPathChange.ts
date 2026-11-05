/**
 * chat/chatPathChange.ts
 *
 * Changing the chat history folder moves the existing chats instead of leaving
 * them behind. Runs only when the user commits the settings field (blur/Enter),
 * so half-typed paths never create folders.
 */

import { Notice, TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import type { EngramSettings } from '../types';
import type { ChatHistoryStore } from './ChatHistoryStore';
import type { ChatSessionService } from './ChatSessionService';
import { validateVaultPath, normalisePath } from '../utils/pathUtils';

export type ChatPathChangeStatus = 'unchanged' | 'invalid' | 'cancelled' | 'changed';

export interface ChatPathChangeDeps {
  app: App;
  settings: EngramSettings;
  store: ChatHistoryStore;
  service: ChatSessionService;
  confirm(opts: { title: string; message: string; confirmLabel: string; cancelLabel: string }): Promise<boolean>;
  saveSettings(): Promise<void>;
}

export async function changeChatHistoryPath(
  deps: ChatPathChangeDeps,
  rawNewPath: string
): Promise<{ status: ChatPathChangeStatus; moved: number }> {
  const { app, settings, store, service } = deps;
  const oldPath = normalisePath(settings.chatHistoryPath);

  const newPath = validateVaultPath(rawNewPath);
  if (!newPath) {
    new Notice('Chat history folder must be a vault-relative folder path (for example Intelligence/Chats).');
    return { status: 'invalid', moved: 0 };
  }
  if (newPath.toLowerCase() === oldPath.toLowerCase()) return { status: 'unchanged', moved: 0 };

  const target = app.vault.getAbstractFileByPath(newPath);
  if (target instanceof TFile) {
    new Notice(`"${newPath}" is a file. Choose a folder path.`);
    return { status: 'invalid', moved: 0 };
  }

  // The memory file must not end up inside the chat folder (that folder is protected from tools)
  const memory = normalisePath(settings.memoryPath ?? '').toLowerCase();
  if (memory && (memory === newPath.toLowerCase() || memory.startsWith(newPath.toLowerCase() + '/'))) {
    new Notice('The chat history folder cannot contain the memory file.');
    return { status: 'invalid', moved: 0 };
  }

  // Everything must be on disk at the OLD location before it is moved
  await service.flushAll();

  const oldFolder = app.vault.getAbstractFileByPath(oldPath);
  const toMove = oldFolder instanceof TFolder
    ? oldFolder.children.filter(c => c instanceof TFile && c.extension === 'json').length
    : 0;

  if (toMove > 0) {
    const ok = await deps.confirm({
      title: 'Move chat history?',
      message: `Move ${toMove} chat${toMove === 1 ? '' : 's'} from "${oldPath}" to "${newPath}"?`,
      confirmLabel: 'Move',
      cancelLabel: 'Cancel',
    });
    if (!ok) return { status: 'cancelled', moved: 0 };
  }

  store.setFolderPath(newPath);
  settings.chatHistoryPath = newPath;
  await store.initialize();

  let moved = 0;
  if (toMove > 0) moved = await store.migrateFrom(oldPath);

  await deps.saveSettings();

  // Reload from the new folder and refresh open views
  await service.syncFromVault();
  new Notice(moved > 0
    ? `Chat history moved to ${newPath} (${moved} chat${moved === 1 ? '' : 's'}).`
    : `Chat history folder is now ${newPath}.`);
  return { status: 'changed', moved };
}
