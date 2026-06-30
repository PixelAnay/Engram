/**
 * ChatHistoryStore.ts
 *
 * Persists each chat session as an individual JSON file inside a visible folder
 * in the user's vault (default: `Intelligence/Chats/`).
 *
 * Why vault files instead of data.json?
 *   - Vault files are synced by iCloud, Obsidian Sync, Dropbox, Git, etc.
 *   - data.json lives inside .obsidian/plugins/ which most sync tools skip.
 *   - One file per session → only changed sessions cause sync conflicts.
 *   - A visible folder (not dot-prefixed) works reliably across all sync tools.
 */

import { App, TFile, TFolder, normalizePath } from 'obsidian';
import type { ChatSession, ChatMessage } from '../types';

/** Current on-disk schema version. Increment when the shape of ChatSession changes. */
const SCHEMA_VERSION = 1;

export class ChatHistoryStore {
  private app: App;
  private folderPath: string;

  constructor(app: App, folderPath: string) {
    this.app = app;
    this.folderPath = normalizePath(folderPath);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Ensure the storage folder exists. Call once on plugin load. */
  async initialize(): Promise<void> {
    await this.ensureFolder(this.folderPath);
  }

  /** Update the folder path (called after settings change). */
  setFolderPath(folderPath: string): void {
    this.folderPath = normalizePath(folderPath);
  }

  async loadAll(): Promise<ChatSession[]> {
    const folder = this.app.vault.getAbstractFileByPath(this.folderPath);
    if (!(folder instanceof TFolder)) return [];

    const sessions: ChatSession[] = [];

    for (const child of folder.children) {
      if (!(child instanceof TFile) || child.extension !== 'json') continue;

      try {
        let raw = '';
        try {
          raw = await this.app.vault.read(child);
          const parsed = JSON.parse(raw);
          const session = this.deserialize(parsed);
          if (session) {
            sessions.push(session);
            continue;
          }
        } catch (e) {
          console.warn(`[Engram] Primary file "${child.path}" corrupt, attempting recovery from .bak:`, e);
          const bakPath = child.path + '.bak';
          const bakFile = this.app.vault.getAbstractFileByPath(bakPath);
          if (bakFile instanceof TFile) {
            raw = await this.app.vault.read(bakFile);
            const parsed = JSON.parse(raw);
            const session = this.deserialize(parsed);
            if (session) {
              sessions.push(session);
              // Restore backup to primary location
              await this.app.vault.modify(child, raw);
              console.info(`[Engram] Successfully recovered session from backup for "${child.path}"`);
              continue;
            }
          }
          throw e; // rethrow if backup recovery also fails
        }
      } catch (e) {
        console.warn(`[Engram] ChatHistoryStore: skipping corrupt file "${child.path}":`, e);
      }
    }

    return sessions;
  }

  async save(session: ChatSession): Promise<void> {
    await this.ensureFolder(this.folderPath);
    const filePath = this.sessionPath(session.id);

    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      // Create backup copy of existing file before writing to protect against corruption
      try {
        const current = await this.app.vault.read(existing);
        if (current && current.trim().length > 0) {
          const bakPath = filePath + '.bak';
          const bakFile = this.app.vault.getAbstractFileByPath(bakPath);
          if (bakFile instanceof TFile) {
            await this.app.vault.modify(bakFile, current);
          } else {
            await this.app.vault.create(bakPath, current);
          }

          // Preserve original session createdAt timestamp if available (H-27)
          try {
            const parsed = JSON.parse(current);
            if (parsed && typeof parsed.createdAt === 'number') {
              session.createdAt = Math.min(session.createdAt, parsed.createdAt);
            }
          } catch {
            // Ignore parse errors
          }
        }
      } catch (err) {
        console.warn(`[Engram] Failed to create session backup for ${session.id}:`, err);
      }
      const content = JSON.stringify(this.serialize(session), null, 2);
      await this.app.vault.modify(existing, content);
    } else {
      const content = JSON.stringify(this.serialize(session), null, 2);
      try {
        await this.app.vault.create(filePath, content);
      } catch (err) {
        // If file already exists, it is a TOCTOU race. Retry modifying the existing file (M-09)
        const retryFile = this.app.vault.getAbstractFileByPath(filePath);
        if (retryFile instanceof TFile) {
          await this.app.vault.modify(retryFile, content);
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Delete the vault file for a session.
   * @param force  When true (default for UI-triggered deletes), permanently removes
   *               the file instead of moving it to OS trash. This keeps the folder
   *               contents in sync with what the plugin's UI shows.
   */
  async delete(id: string, force = false): Promise<void> {
    const filePath = this.sessionPath(id);
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) {
      await this.app.vault.delete(file, force);
    }
  }

  /** Load and parse a single session file by ID. Returns null if missing/corrupt. */
  async loadOne(id: string): Promise<ChatSession | null> {
    const filePath = this.sessionPath(id);
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return null;

    try {
      const raw = await this.app.vault.read(file);
      return this.deserialize(JSON.parse(raw));
    } catch (e) {
      console.warn(`[Engram] ChatHistoryStore: failed to load session "${id}":`, e);
      return null;
    }
  }

  /** Returns true if the vault file for the given ID exists. */
  exists(id: string): boolean {
    return this.app.vault.getAbstractFileByPath(this.sessionPath(id)) instanceof TFile;
  }

  /**
   * Returns true if the given vault file path belongs to this store's folder.
   * Use this in vault event handlers to filter relevant file changes.
   */
  isOwnedPath(filePath: string): boolean {
    const normalised = normalizePath(filePath);
    return normalised.startsWith(this.folderPath + '/') && normalised.endsWith('.json');
  }

  /**
   * Extract a session ID from a vault file path managed by this store.
   * Returns null if the path is not a valid store path.
   */
  idFromPath(filePath: string): string | null {
    if (!this.isOwnedPath(filePath)) return null;
    const fileName = filePath.split('/').pop() ?? '';
    return fileName.replace(/\.json$/, '') || null;
  }

  /**
   * Migrate all JSON files from `oldFolderPath` into the current folder.
   * Used for the one-time `.engram/chats` → `Intelligence/Chats` move.
   * After all files are moved, removes the old (now-empty) folder.
   * Returns the number of sessions migrated.
   */
  async migrateFrom(oldFolderPath: string): Promise<number> {
    const normOld = normalizePath(oldFolderPath);
    const oldFolder = this.app.vault.getAbstractFileByPath(normOld);
    if (!(oldFolder instanceof TFolder)) return 0;

    await this.ensureFolder(this.folderPath);
    let count = 0;

    for (const child of [...oldFolder.children]) {
      if (!(child instanceof TFile) || child.extension !== 'json') continue;
      try {
        const content = await this.app.vault.read(child);
        const newPath = normalizePath(`${this.folderPath}/${child.name}`);
        const existing = this.app.vault.getAbstractFileByPath(newPath);
        if (existing instanceof TFile) {
          // Already exists in new location — skip to avoid overwriting newer data
          await this.app.vault.delete(child, true);
        } else {
          await this.app.vault.rename(child, newPath);
          count++; // Only increment if actually migrated, not deleted as duplicate (M-11)
        }
      } catch (e) {
        console.warn(`[Engram] migrateFrom: could not move "${child.path}":`, e);
      }
    }

    // Delete old folder if now empty
    try {
      const refreshed = this.app.vault.getAbstractFileByPath(normOld);
      if (refreshed instanceof TFolder && refreshed.children.length === 0) {
        await this.app.vault.delete(refreshed, true);
      }
    } catch { /* best-effort */ }

    return count;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private sessionPath(id: string): string {
    return normalizePath(`${this.folderPath}/${id}.json`);
  }

  private async ensureFolder(path: string): Promise<void> {
    if (this.app.vault.getAbstractFileByPath(path) instanceof TFolder) return;
    try {
      await this.app.vault.createFolder(path);
    } catch {
      // Folder may have been created concurrently — that's fine.
    }
  }

  /** Serialize a session to a plain JSON-safe object with schema version. */
  private serialize(session: ChatSession): Record<string, unknown> {
    return {
      schemaVersion: SCHEMA_VERSION,
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages,
    };
  }

  /**
   * Deserialize and validate a raw parsed object into a `ChatSession`.
   * Returns null if the shape is invalid.
   */
  private deserialize(raw: any): ChatSession | null {
    if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.messages)) return null;

    // Validate and sanitize the messages structure to filter out nulls/malformed shapes (M-10)
    const sanitizedMessages: ChatMessage[] = [];
    for (const msg of raw.messages) {
      if (
        msg &&
        typeof msg === 'object' &&
        typeof msg.role === 'string' &&
        ['user', 'assistant', 'system', 'tool'].includes(msg.role)
      ) {
        sanitizedMessages.push({
          role: msg.role,
          content: msg.content ?? '',
          ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
          ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
          ...(msg.name ? { name: msg.name } : {}),
          ...(msg.attachments ? { attachments: msg.attachments } : {}),
          ...(msg.autoAttachedNotes ? { autoAttachedNotes: msg.autoAttachedNotes } : {}),
        });
      }
    }

    return {
      schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
      id: raw.id,
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'New chat',
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
      messages: sanitizedMessages,
    };
  }
}
