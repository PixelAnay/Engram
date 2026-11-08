/**
 * MessageRenderer.ts
 * Handles efficient DOM rendering of chat bubbles.
 *
 * Key improvements over the original ChatView approach:
 * - Incremental append: new bubbles are only added, not the entire list re-rendered
 * - Streaming: text content is updated by patching a single text node, not via MarkdownRenderer
 *   on every token. Markdown is re-rendered only when streaming ends.
 * - Debounced Markdown renders during streaming (at most every 200ms)
 */

import { App, Component, MarkdownRenderer, setIcon } from 'obsidian';
import type { VaultIndexer } from '../indexer';
import type { ChatMessage } from '../types';

export interface DisplayMessage {
  role: 'user' | 'assistant' | 'error';
  content: string;
  attachments?: { name: string; type: string; dataUrl?: string; content?: string }[];
  autoAttachedNotes?: string[];
  toolEvents?: ToolEvent[];
  streaming?: boolean;
  /** Index of the ChatMessage this bubble shows in the conversation history (undefined for transient bubbles such as errors). */
  sourceIndex?: number;
}

export interface ToolEvent {
  type: 'start' | 'end';
  name: string;
  result?: string;
}

/** Strips unsafe HTML tags and inline events to prevent arbitrary code execution (C-20) */
function sanitizeMarkdownSource(source: string): string {
  // Strip <script>...</script> tags case-insensitively
  let clean = source.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  
  // Strip inline event handlers like onload, onerror, onclick, etc.
  clean = clean.replace(/\bon[a-zA-Z]+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi, '');
  
  // Strip javascript: URIs in href/src
  clean = clean.replace(/href\s*=\s*(?:'javascript:[^']*'|"javascript:[^"]*"|javascript:[^\s>]+)/gi, '');
  clean = clean.replace(/src\s*=\s*(?:'javascript:[^']*'|"javascript:[^"]*"|javascript:[^\s>]+)/gi, '');
  
  return clean;
}

/** Render Markdown safely across Obsidian versions */
function renderMarkdownCompat(
  app: App,
  source: string,
  el: HTMLElement,
  component: Component
): void {
  const sanitized = sanitizeMarkdownSource(source);
  try {
    void MarkdownRenderer.render(app, sanitized, el, '', component);
  } catch {
    // Older Obsidian versions only provide renderMarkdown
    const legacy = MarkdownRenderer as unknown as {
      renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> | void;
    };
    void legacy.renderMarkdown(sanitized, el, '', component);
  }
}

const TOOL_ICONS: Record<string, string> = {
  search_vault: '🔍', read_note: '📖', list_folder: '📁',
  append_to_note: '✏️', edit_note: '✏️', create_note: '📄',
  open_note: '🔗', move_note: '📦', rename_note: '✏️',
  copy_note: '📋', delete_note: '🗑️', create_folder: '📁',
  save_memory: '🧠', update_memory: '🧠', delete_memory: '🧠',
};

export class MessageRenderer {
  /** Map from DisplayMessage identity → rendered wrapper element */
  private renderedBubbles = new Map<DisplayMessage, HTMLElement>();

  /** Timer for debounced Markdown re-renders during streaming */
  private mdDebounceTimer: number | null = null;

  /** Ref to the streaming bubble's raw text node (for fast token patching) */
  private streamingTextNode: Text | null = null;

  /** Cache for resolved note paths to speed up text node resolving (H-21) */
  private resolvedPathCache = new Map<string, string | null>();

  constructor(
    private app: App,
    private container: HTMLElement,
    private component: Component,
    private onCopyMessage: (content: string) => void,
    private onEditMessage: (msg: DisplayMessage) => void,
    private onRegenerateMessage: (msg: DisplayMessage) => void,
    private onNoteClick: (path: string) => void,
    private indexer?: VaultIndexer
  ) {}

  /**
   * Full re-render of all messages (used on session switch or initial load).
   * Clears all existing DOM and rebuilds.
   */
  renderAll(messages: DisplayMessage[]): void {
    if (this.mdDebounceTimer !== null) {
      window.clearTimeout(this.mdDebounceTimer);
      this.mdDebounceTimer = null;
    }
    this.container.empty();
    this.renderedBubbles.clear();
    this.streamingTextNode = null;
    this.resolvedPathCache.clear();

    for (const msg of messages) {
      const el = this.renderBubble(msg);
      this.renderedBubbles.set(msg, el);
      this.container.appendChild(el);
    }
  }

  /**
   * Append a new bubble to the bottom. Does NOT re-render existing ones.
   */
  appendBubble(msg: DisplayMessage): HTMLElement {
    const el = this.renderBubble(msg);
    this.renderedBubbles.set(msg, el);
    this.container.appendChild(el);
    return el;
  }

  /**
   * Fast path for streaming token updates.
   * Patches only the raw text content node — no Markdown parsing.
   * Triggers a debounced full Markdown render (every 200ms).
   */
  patchStreamingContent(msg: DisplayMessage): void {
    const wrapper = this.renderedBubbles.get(msg);
    if (!wrapper) return;

    // Update or create the raw text node inside the content div
    const contentEl = wrapper.querySelector<HTMLElement>('.engram-bubble-content');
    if (!contentEl) return;

    if (this.streamingTextNode && contentEl.contains(this.streamingTextNode)) {
      this.streamingTextNode.textContent = msg.content;
    } else {
      contentEl.empty();
      this.streamingTextNode = activeDocument.createTextNode(msg.content);
      contentEl.appendChild(this.streamingTextNode);
    }

    // Update cursor visibility
    const cursor = wrapper.querySelector('.engram-cursor');
    if (cursor) cursor.setAttribute('style', msg.streaming ? '' : 'display:none');

    // Update tool events (cheap DOM update)
    this.updateToolEventsEl(wrapper, msg.toolEvents ?? []);

    // Schedule a proper Markdown render (debounced)
    this.scheduleMdRender(msg, contentEl);
  }

  /**
   * Finalize a streaming bubble — force immediate Markdown render, add action buttons.
   */
  finalizeStreamingBubble(msg: DisplayMessage): void {
    if (this.mdDebounceTimer !== null) {
      window.clearTimeout(this.mdDebounceTimer);
      this.mdDebounceTimer = null;
    }
    this.streamingTextNode = null;

    const wrapper = this.renderedBubbles.get(msg);
    if (!wrapper) return;

    // Full re-render of this bubble
    const newEl = this.renderBubble(msg);
    wrapper.replaceWith(newEl);
    this.renderedBubbles.set(msg, newEl);
  }

  // ── Private rendering ─────────────────────────────────────────────────────

  private renderBubble(msg: DisplayMessage): HTMLElement {
    const wrapper = createDiv({ cls: `engram-msg-wrapper engram-msg-${msg.role}` });

    const bubble = wrapper.createDiv({ cls: 'engram-bubble' });

    // Tool events
    if (msg.toolEvents && msg.toolEvents.length > 0) {
      const toolsEl = bubble.createDiv({ cls: 'engram-tool-events' });
      this.renderToolEvents(toolsEl, msg.toolEvents);
    }

    // Attachments
    if (msg.attachments && msg.attachments.length > 0) {
      const attContainer = bubble.createDiv({ cls: 'engram-input-attachments' });
      attContainer.style.marginBottom = msg.content ? '8px' : '0';
      for (const att of msg.attachments) {
        if (att.type.startsWith('image/')) {
          const img = attContainer.createEl('img');
          img.src = att.dataUrl || '';
          img.alt = att.name;
          img.setCssStyles({ maxWidth: '100%', borderRadius: 'var(--radius-s)', maxHeight: '200px', objectFit: 'contain' });
        } else {
          const chip = attContainer.createDiv({ cls: 'engram-attachment-chip' });
          chip.createSpan({ cls: 'engram-attachment-name', text: att.name });
        }
      }
    }

    // Content
    const contentEl = bubble.createDiv({ cls: 'engram-bubble-content' });

    if (msg.content) {
      if (msg.streaming) {
        // During streaming: plain text node (fast)
        this.streamingTextNode = activeDocument.createTextNode(msg.content);
        contentEl.appendChild(this.streamingTextNode);
      } else {
        renderMarkdownCompat(this.app, msg.content, contentEl, this.component);
        if (msg.role === 'assistant') {
          this.makeNoteLinksClickable(contentEl);
        }
      }
    }

    // Auto-attached notes (semantic context)
    if (msg.autoAttachedNotes && msg.autoAttachedNotes.length > 0) {
      const autoAttachedContainer = bubble.createDiv({ cls: 'engram-auto-attached-container' });

      const header = autoAttachedContainer.createDiv({ cls: 'engram-auto-attached-header' });
      header.textContent = `🧠 Auto-attached ${msg.autoAttachedNotes.length} note${msg.autoAttachedNotes.length > 1 ? 's' : ''}`;

      const list = autoAttachedContainer.createDiv({ cls: 'engram-auto-attached-list' });

      for (const path of msg.autoAttachedNotes) {
        const fileChip = list.createDiv({ cls: 'engram-auto-attached-chip' });
        const basename = path.split('/').pop() || path;
        fileChip.textContent = basename;
        fileChip.title = path;
        fileChip.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.onNoteClick(path);
        });
      }
    }

    // Thinking indicator (empty streaming bubble)
    const hasText = msg.content.trim().length > 0;
    if (msg.streaming && !hasText) {
      const thinkingEl = contentEl.createDiv({ cls: 'engram-thinking' });
      thinkingEl.createSpan({ text: 'Thinking' });
      thinkingEl.createSpan({ cls: 'engram-thinking-dots', text: '...' });
    }

    // Streaming cursor
    if (msg.streaming) {
      const cursor = bubble.createSpan({ cls: 'engram-cursor' });
      cursor.textContent = '▋';
    }

    // Action buttons (Copy, Edit)
    if (!msg.streaming && msg.role !== 'error') {
      const actions = wrapper.createDiv({ cls: 'engram-msg-actions' });

      const copyBtn = actions.createEl('button', { cls: 'engram-msg-action-btn' });
      copyBtn.title = 'Copy';
      setIcon(copyBtn, 'copy');
      copyBtn.addEventListener('click', () => {
        this.onCopyMessage(msg.content);
        void navigator.clipboard.writeText(msg.content);
        setIcon(copyBtn, 'check');
        window.setTimeout(() => setIcon(copyBtn, 'copy'), 2000);
      });

      if (msg.role === 'user') {
        const editBtn = actions.createEl('button', { cls: 'engram-msg-action-btn' });
        editBtn.title = 'Edit & Resend';
        setIcon(editBtn, 'pencil');
        // The bubble carries its own message (and sourceIndex): no DOM-position guessing
        editBtn.addEventListener('click', () => this.onEditMessage(msg));
      }

      if (msg.role === 'assistant') {
        const regenBtn = actions.createEl('button', { cls: 'engram-msg-action-btn' });
        regenBtn.title = 'Regenerate response';
        setIcon(regenBtn, 'refresh-cw');
        regenBtn.addEventListener('click', () => this.onRegenerateMessage(msg));
      }
    }

    return wrapper;
  }

  private renderToolEvents(container: HTMLElement, events: ToolEvent[]): void {
    container.empty();
    for (const ev of events) {
      const evEl = container.createDiv({ cls: `engram-tool-event engram-tool-${ev.type}` });
      const icon = TOOL_ICONS[ev.name] ?? '🛠️';
      if (ev.type === 'start') {
        evEl.textContent = `${icon} ${ev.name.replace(/_/g, ' ')}…`;
      } else {
        const summary = ev.result
          ? ev.result.length > 80 ? ev.result.slice(0, 80) + '…' : ev.result
          : 'done';
        evEl.textContent = `${icon} ${ev.name.replace(/_/g, ' ')}: ${summary}`;
      }
    }
  }

  private updateToolEventsEl(wrapper: HTMLElement, events: ToolEvent[]): void {
    const toolsEl = wrapper.querySelector<HTMLElement>('.engram-tool-events');
    if (!toolsEl && events.length === 0) return;

    if (!toolsEl) {
      const bubble = wrapper.querySelector<HTMLElement>('.engram-bubble');
      if (!bubble) return;
      const newToolsEl = createDiv({ cls: 'engram-tool-events' });
      bubble.insertBefore(newToolsEl, bubble.firstChild);
      this.renderToolEvents(newToolsEl, events);
    } else {
      this.renderToolEvents(toolsEl, events);
    }
  }

  /** Debounce Markdown render during streaming (max once per 200ms). */
  private scheduleMdRender(msg: DisplayMessage, contentEl: HTMLElement): void {
    if (this.mdDebounceTimer !== null) window.clearTimeout(this.mdDebounceTimer);
    this.mdDebounceTimer = window.setTimeout(() => {
      this.mdDebounceTimer = null;
      if (!msg.streaming) return; // already finalized
      contentEl.empty();
      this.streamingTextNode = null;
      if (msg.content) {
        renderMarkdownCompat(this.app, msg.content, contentEl, this.component);
      }
    }, 200);
  }

  // ── Note link clickability ─────────────────────────────────────────────────

  private makeNoteLinksClickable(el: HTMLElement): void {
    const makeHandler = (path: string) => (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.onNoteClick(path);
    };

    const toAnchor = (path: string): HTMLAnchorElement => {
      const a = createEl('a', { cls: 'engram-note-link' });
      a.textContent = path;
      a.title = `Open "${path}" in a new tab`;
      a.href = '#';
      a.addEventListener('click', makeHandler(path));
      return a;
    };

    // Inline code blocks ending in .md
    for (const codeEl of Array.from(el.querySelectorAll('code'))) {
      if (codeEl.closest('pre')) continue;
      const raw = (codeEl.textContent ?? '').trim();
      if (!raw || !/\.md(?:#.*)?$/i.test(raw)) continue;
      const pathOnly = raw.replace(/^\.?\//, '').replace(/#.*$/, '');
      const file = this.resolveFile(pathOnly);
      if (file) codeEl.replaceWith(toAnchor(file));
    }

    // Existing markdown links
    for (const anchor of Array.from(el.querySelectorAll('a'))) {
      const href = anchor.getAttribute('href') ?? '';
      const decoded = href ? decodeURIComponent(href) : '';
      const raw = decoded || anchor.textContent || href;
      if (!raw || !/\.md(?:#.*)?$/i.test(raw.trim())) continue;
      const pathOnly = raw.replace(/^\.?\//, '').replace(/#.*$/, '');
      const file = this.resolveFile(pathOnly);
      if (!file) continue;
      anchor.classList.add('engram-note-link');
      anchor.setAttribute('title', `Open "${file}" in a new tab`);
      anchor.addEventListener('click', makeHandler(file));
    }

    // Plain text paths ending in .md
    const NOTE_PATH_RE = /(?:[^/\n\r"*<>|?[\]()]+\/)*[^/\n\r"*<>|?[\]()]+\.md/gu;
    const walkTextNodes = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? '';
        const matches = [...text.matchAll(NOTE_PATH_RE)];
        if (matches.length === 0) return;
        const frag = createFragment();
        let lastIdx = 0;
        for (const match of matches) {
          const start = match.index!;
          const end = start + match[0].length;
          const file = this.resolveFile(match[0].trim());
          if (!file) continue;
          if (start > lastIdx) frag.appendChild(activeDocument.createTextNode(text.slice(lastIdx, start)));
          frag.appendChild(toAnchor(file));
          lastIdx = end;
        }
        if (lastIdx > 0) {
          if (lastIdx < text.length) frag.appendChild(activeDocument.createTextNode(text.slice(lastIdx)));
          node.parentNode?.replaceChild(frag, node);
        }
      } else if (node.nodeType === Node.ELEMENT_NODE && !['A', 'CODE', 'PRE'].includes((node as Element).tagName)) {
        for (const child of Array.from(node.childNodes)) walkTextNodes(child);
      }
    };
    walkTextNodes(el);
  }

  /**
   * Resolve a raw path string to a vault-relative path using fuzzy matching.
   * Returns the resolved path string or null.
   */
  private resolveFile(rawPath: string): string | null {
    const cached = this.resolvedPathCache.get(rawPath);
    if (cached !== undefined) return cached;

    const result = this.doResolveFile(rawPath);
    this.resolvedPathCache.set(rawPath, result);
    return result;
  }

  private doResolveFile(rawPath: string): string | null {
    // We access the Obsidian vault via the app instance
    const vault = this.app.vault;
    if (!vault) return null;

    const trimmed = (rawPath ?? '').trim();
    if (!trimmed) return null;

    const candidates = new Set<string>();
    const add = (v: string) => {
      const s = v.trim();
      if (s) {
        candidates.add(s);
        candidates.add(s.normalize('NFC'));
      }
    };

    add(trimmed.replace(/\\/g, '/'));
    add(trimmed.replace(/[""]/g, '"').replace(/['']/g, "'"));
    add(trimmed.replace(/[\][\](){}<>'"`,;:!?]+$/g, ''));
    try { add(decodeURIComponent(trimmed)); } catch { /* ignore */ }

    for (const c of candidates) {
      const f = vault.getAbstractFileByPath(c);
      if (f) return f.path;
    }

    const toKey = (v: string) => v.replace(/\\/g, '/').normalize('NFC').toLowerCase();
    const toLoose = (v: string) => v.normalize('NFC').toLowerCase().replace(/[^a-z0-9]/g, '');
    const cKeys = new Set(Array.from(candidates).map(toKey));

    // O(1) optimization using indexer note paths if available (H-21)
    const files = this.indexer
      ? this.indexer.getAllPaths().map(p => ({ path: p, name: p.split('/').pop() ?? p }))
      : vault.getMarkdownFiles();

    for (const f of files) if (cKeys.has(toKey(f.path))) return f.path;

    for (const c of candidates) {
      const cK = toKey(c);
      const cL = toLoose(c);
      for (const f of files) {
        const fK = toKey(f.path);
        const fL = toLoose(f.path);
        if (fK.endsWith(cK) || cK.endsWith(fK)) return f.path;
        if (fL === cL) return f.path;
      }
    }

    const baseCandidates = Array.from(candidates)
      .map(c => c.split('/').pop() ?? c)
      .filter(Boolean)
      .map(toLoose);
    for (const base of baseCandidates) {
      const matches = files.filter(f => toLoose(f.name) === base);
      if (matches.length === 1) return matches[0].path;
    }

    return null;
  }

  /**
   * Build DisplayMessage objects from a raw ChatMessage history.
   * Used when switching sessions.
   */
  static buildDisplayMessages(messages: ChatMessage[]): DisplayMessage[] {
    const result: DisplayMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;

      const content = MessageRenderer.toDisplayText(msg.content);
      let toolEvents: ToolEvent[] | undefined;

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        toolEvents = [];
        for (const call of msg.tool_calls) {
          let resultText = 'done';
          for (let j = i + 1; j < messages.length && j <= i + 5; j++) {
            const next = messages[j];
            if (next.role === 'tool' && next.tool_call_id === call.id) {
              resultText = MessageRenderer.toDisplayText(next.content);
              break;
            }
          }
          toolEvents.push({ type: 'end', name: call.function.name, result: resultText });
        }
      }

      if (!content.trim() && (!msg.attachments || msg.attachments.length === 0) && (!toolEvents || toolEvents.length === 0)) {
        continue;
      }

      result.push({ role: msg.role, content, attachments: msg.attachments, autoAttachedNotes: msg.autoAttachedNotes, toolEvents, sourceIndex: i });
    }

    return result;
  }

  static toDisplayText(content: ChatMessage['content']): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter(p => p && p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text as string)
      .join('\n');
  }
}
