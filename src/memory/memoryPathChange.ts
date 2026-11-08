/**
 * memory/memoryPathChange.ts
 *
 * Changing the memory file path must never orphan the existing file or create
 * a stray blank one. This runs only when the user commits the field.
 */

import { Notice, TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import type { EngramSettings } from '../types';
import type { PluginDataStore } from '../storage/PluginDataStore';
import { validateVaultPath, normalisePath } from '../utils/pathUtils';

export type PathChangeStatus = 'unchanged' | 'invalid' | 'cancelled' | 'moved' | 'switched';

export interface PathChangeDeps {
  app: App;
  settings: EngramSettings;
  dataStore: PluginDataStore;
  confirm(opts: { title: string; message: string; confirmLabel: string; cancelLabel: string }): Promise<boolean>;
  saveSettings(): Promise<void>;
}

export async function changeMemoryPath(
  deps: PathChangeDeps,
  rawNewPath: string
): Promise<{ status: PathChangeStatus }> {
  const { app, settings, dataStore } = deps;
  const oldPath = settings.memoryPath;

  const newPath = validateVaultPath(rawNewPath);
  if (!newPath || !newPath.toLowerCase().endsWith('.md')) {
    new Notice('Memory path must be a vault-relative path ending in .md (for example Intelligence/Memory.md).');
    return { status: 'invalid' };
  }
  if (newPath.toLowerCase() === normalisePath(oldPath).toLowerCase()) return { status: 'unchanged' };

  const chatFolder = normalisePath(settings.chatHistoryPath ?? '').toLowerCase();
  if (chatFolder && (newPath.toLowerCase() === chatFolder || newPath.toLowerCase().startsWith(chatFolder + '/'))) {
    new Notice('The memory file cannot be placed inside the chat history folder.');
    return { status: 'invalid' };
  }

  const target = app.vault.getAbstractFileByPath(newPath);
  if (target instanceof TFolder) {
    new Notice(`"${newPath}" is a folder. Choose a file path.`);
    return { status: 'invalid' };
  }

  const oldFile = app.vault.getAbstractFileByPath(oldPath);
  const hasOld = oldFile instanceof TFile;

  if (hasOld && !target) {
    const ok = await deps.confirm({
      title: 'Move memory file?',
      message: `Move your existing memory file from "${oldPath}" to "${newPath}"? All its content is kept.`,
      confirmLabel: 'Move',
      cancelLabel: 'Cancel',
    });
    if (!ok) return { status: 'cancelled' };

    await ensureParentFolders(app, newPath);
    await app.fileManager.renameFile(oldFile, newPath);
    settings.memoryPath = newPath;
    await dataStore.update(d => {
      const prev = d.memoryState as { lastEntryCount?: number } | undefined;
      d.memoryState = { path: newPath, everExisted: true, lastEntryCount: prev?.lastEntryCount ?? 0 };
    });
    await deps.saveSettings();
    new Notice(`Memory file moved to ${newPath}`);
    return { status: 'moved' };
  }

  if (hasOld && target instanceof TFile) {
    const ok = await deps.confirm({
      title: 'Use a different memory file?',
      message: `A file already exists at "${newPath}". Engram will use it from now on. ` +
        `Your previous memory file at "${oldPath}" is left untouched.`,
      confirmLabel: 'Use that file',
      cancelLabel: 'Cancel',
    });
    if (!ok) return { status: 'cancelled' };
  }

  // Old file does not exist (nothing to move), or user chose to switch to an existing file
  settings.memoryPath = newPath;
  await deps.saveSettings();
  return { status: 'switched' };
}

async function ensureParentFolders(app: App, filePath: string): Promise<void> {
  const idx = filePath.lastIndexOf('/');
  if (idx === -1) return;
  let current = '';
  for (const segment of filePath.slice(0, idx).split('/')) {
    if (!segment) continue;
    current = current ? `${current}/${segment}` : segment;
    if (!app.vault.getAbstractFileByPath(current)) {
      try { await app.vault.createFolder(current); } catch { /* created concurrently */ }
    }
  }
}
