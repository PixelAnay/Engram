/**
 * SessionManager.ts
 * Extracted from ChatView — owns all chat session CRUD and persistence logic.
 */

import type EngramPlugin from '../main';
import type { ChatSession, ChatMessage } from '../types';

export class SessionManager {
  private currentChatId = '';

  constructor(private plugin: EngramPlugin) {}

  get currentId(): string {
    return this.currentChatId;
  }

  get allSessions(): ChatSession[] {
    return this.plugin.chatSessions;
  }

  get currentSession(): ChatSession | undefined {
    return this.plugin.chatSessions.find(s => s.id === this.currentChatId);
  }

  /** Initialize: load most recent session or create a fresh one. */
  initialize(): ChatSession {
    this.cleanEmptySessions();
    const first = this.plugin.chatSessions[0];
    if (first) {
      this.currentChatId = first.id;
      return first;
    }
    return this.createAndActivate();
  }

  /** Create a brand-new session and make it active. */
  createAndActivate(title = 'New chat'): ChatSession {
    this.cleanEmptySessions();
    const session = this.buildNewSession(title);
    this.plugin.upsertChatSession(session);
    this.currentChatId = session.id;
    return session;
  }

  /** Switch the active session to `id`. Returns the session if found. */
  switchTo(id: string): ChatSession | null {
    this.cleanEmptySessions();
    const session = this.plugin.chatSessions.find(s => s.id === id);
    if (!session) return null;
    this.currentChatId = session.id;
    return session;
  }

  /** Delete the given session. Returns the next session to display. */
  delete(id: string): ChatSession {
    this.plugin.deleteChatSession(id);
    if (this.plugin.chatSessions.length === 0) {
      return this.createAndActivate();
    }
    const next = this.plugin.chatSessions[0];
    this.currentChatId = next.id;
    return next;
  }

  cleanEmptySessions(): void {
    const activeIds = new Set<string>();
    this.plugin.app.workspace.getLeavesOfType('engram-view').forEach(leaf => {
      const view = leaf.view as any;
      if (view && view.sessionManager && view.sessionManager.currentChatId) {
        activeIds.add(view.sessionManager.currentChatId);
      }
    });
    if (this.currentChatId) activeIds.add(this.currentChatId);

    const toDelete = this.plugin.chatSessions.filter(
      s => !activeIds.has(s.id) && (!s.messages || s.messages.length === 0)
    );
    for (const session of toDelete) {
      this.plugin.deleteChatSession(session.id);
    }
  }

  /**
   * Persist current messages to the active session with debouncing.
   * Does not block — queues a save 800ms after the last call.
   */
  save(messages: ChatMessage[]): void {
    if (!this.currentChatId) return;

    const existing = this.currentSession;
    const title = existing?.title ?? 'New chat';
    const now = Date.now();

    this.plugin.upsertChatSession({
      id: this.currentChatId,
      title,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messages: [...messages],
    });
  }

  /**
   * Update the session title from the first user message if it is still "New chat".
   */
  updateTitleFromPrompt(prompt: string): void {
    if (!prompt.trim() || !this.currentChatId) return;

    const session = this.currentSession;
    if (!session || session.title !== 'New chat' || session.messages.length > 1) return;

    const normalized = prompt.replace(/\s+/g, ' ').trim();
    const chars = [...normalized];
    session.title = chars.length > 48 ? `${chars.slice(0, 48).join('')}…` : normalized;
    session.updatedAt = Date.now();
    this.plugin.upsertChatSession(session);
  }

  /**
   * Clear messages in the current session and reset its title.
   */
  clearCurrentMessages(): void {
    const session = this.currentSession;
    if (session) {
      session.title = 'New chat';
      session.messages = [];
      session.updatedAt = Date.now();
      this.plugin.upsertChatSession(session);
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private buildNewSession(title = 'New chat'): ChatSession {
    const now = Date.now();
    const rand = Math.random().toString(36).slice(2, 9);
    return {
      id: `chat-${now}-${rand}`,
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }
}
