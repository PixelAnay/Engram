/**
 * chat/ChatSessionService.ts
 *
 * Owns the in-memory list of chat sessions and keeps it consistent with the
 * JSON files in the vault:
 *  - debounced per-session saves, with flush on switch / close / quit / unload
 *  - empty sessions stay in memory (and in the UI) but have no file
 *  - events caused by our own writes/deletes are ignored (OwnOpTracker)
 *  - genuine outside changes (sync, other tools) are merged in
 */

import type { TFile } from 'obsidian';
import type { ChatSession } from '../types';
import type { ChatHistoryStore } from './ChatHistoryStore';
import type { OwnOpTracker } from './OwnOpTracker';

export interface ChatSessionServiceOptions {
  debounceMs?: number;
  /** Session ids currently shown in an open chat view (never auto-removed while empty). */
  getActiveSessionIds: () => Set<string>;
  /** Called when the session list changed for reasons other than the active view's own edits. */
  onChanged: () => void;
}

export class ChatSessionService {
  sessions: ChatSession[] = [];

  private timers = new Map<string, number>();
  private pending = new Map<string, ChatSession>();
  private debounceMs: number;

  constructor(
    private store: ChatHistoryStore,
    private tracker: OwnOpTracker,
    private opts: ChatSessionServiceOptions
  ) {
    this.debounceMs = opts.debounceMs ?? 800;
  }

  private sort(): void {
    this.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ── Writes from the UI ────────────────────────────────────────────────────

  /**
   * Upsert a session in memory and schedule a debounced write to its vault file.
   * Empty sessions (no messages) are kept in memory for the UI but have no file.
   */
  upsert(session: ChatSession): void {
    const withTouch = { ...session, updatedAt: session.updatedAt || Date.now() };
    const idx = this.sessions.findIndex(s => s.id === session.id);
    if (idx >= 0) this.sessions[idx] = withTouch;
    else this.sessions.push(withTouch);
    this.sort();

    if (!withTouch.messages || withTouch.messages.length === 0) {
      this.cancelPending(session.id);
      // Our own delete: tracked, so the delete event cannot remove the session from the UI
      this.store.delete(session.id).catch(() => {});
      return;
    }

    this.pending.set(session.id, withTouch);
    const existing = this.timers.get(session.id);
    if (existing) window.clearTimeout(existing);
    this.timers.set(session.id, window.setTimeout(() => { void this.persist(session.id); }, this.debounceMs));
  }

  /** Remove a session from memory and permanently delete its file. */
  remove(id: string): void {
    this.cancelPending(id);
    this.sessions = this.sessions.filter(s => s.id !== id);
    this.store.delete(id)
      .catch(e => console.error(`[Engram] Failed to delete session "${id}":`, e));
    this.opts.onChanged();
  }

  private cancelPending(id: string): void {
    const timer = this.timers.get(id);
    if (timer) window.clearTimeout(timer);
    this.timers.delete(id);
    this.pending.delete(id);
  }

  private async persist(id: string): Promise<void> {
    const timer = this.timers.get(id);
    if (timer) window.clearTimeout(timer);
    this.timers.delete(id);
    const session = this.pending.get(id);
    if (!session) return;
    this.pending.delete(id);
    try {
      await this.store.save(session);
    } catch (e) {
      console.error(`[Engram] Failed to save session "${id}":`, e);
    }
  }

  /** Write one session's pending changes right now. */
  flush(id: string): Promise<void> {
    return this.persist(id);
  }

  /** Write every pending change right now (view close, quit, unload). */
  async flushAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map(id => this.persist(id)));
  }

  hasPending(id?: string): boolean {
    return id === undefined ? this.pending.size > 0 : this.pending.has(id);
  }

  // ── Reads / sync ──────────────────────────────────────────────────────────

  /**
   * Re-import from vault files. Sessions with unsaved local changes and empty
   * sessions open in a view are kept.
   */
  async syncFromVault(): Promise<number> {
    const fromDisk = await this.store.loadAll();
    const merged = new Map<string, ChatSession>();
    for (const s of fromDisk) merged.set(s.id, s);

    for (const [id, local] of this.pending) merged.set(id, local);

    const active = this.opts.getActiveSessionIds();
    for (const s of this.sessions) {
      const empty = !s.messages || s.messages.length === 0;
      if (empty && active.has(s.id) && !merged.has(s.id)) merged.set(s.id, s);
    }

    this.sessions = [...merged.values()];
    this.sort();
    this.opts.onChanged();
    return fromDisk.length;
  }

  // ── Vault events ──────────────────────────────────────────────────────────

  /** A chat file was created or modified. Returns true if the path belongs to the chat folder. */
  async onFileChanged(file: TFile): Promise<boolean> {
    if (!this.store.isOwnedPath(file.path)) return false;
    if (this.tracker.isOwn(file.path)) return true;

    const id = this.store.idFromPath(file.path);
    if (!id) return true;
    // Local edits are about to be written; they win over the outside copy
    if (this.pending.has(id)) return true;

    const session = await this.store.loadOne(id);
    if (!session) return true;

    const idx = this.sessions.findIndex(s => s.id === id);
    if (idx >= 0) {
      if (session.updatedAt > this.sessions[idx].updatedAt) this.sessions[idx] = session;
      else return true;
    } else {
      this.sessions.push(session);
    }
    this.sort();
    this.opts.onChanged();
    return true;
  }

  /** A chat file was deleted. Returns true if the path belongs to the chat folder. */
  onFileDeleted(path: string): boolean {
    if (!this.store.isOwnedPath(path)) return false;
    if (this.tracker.isOwn(path)) return true;

    const id = this.store.idFromPath(path);
    if (!id) return true;
    // Unsaved local changes are kept; the next save recreates the file
    if (this.pending.has(id)) return true;
    if (!this.sessions.some(x => x.id === id)) return true;
    this.sessions = this.sessions.filter(x => x.id !== id);
    this.opts.onChanged();
    return true;
  }
}
