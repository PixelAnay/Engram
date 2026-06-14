/**
 * ChatView.ts
 * Slim orchestrator for the LLAMA Chat sidebar view.
 *
 * All heavy sub-concerns are delegated to:
 *  - SessionManager   — session CRUD & persistence
 *  - MessageRenderer  — bubble DOM, incremental append, streaming
 *  - AttachmentHandler — file/PDF processing
 *  - MentionAutocomplete — @-mention dropdown
 *  - TokenBudgetBar   — context window usage indicator
 */

import { ItemView, WorkspaceLeaf, Notice, setIcon } from 'obsidian';
import type LlamaPlugin from './main';
import type { ChatMessage, StreamChunk, MessageContentPart } from './types';
import { SessionManager } from './chat/SessionManager';
import { AttachmentHandler, type Attachment } from './chat/AttachmentHandler';
import { MentionAutocomplete } from './chat/MentionAutocomplete';
import { MessageRenderer, type DisplayMessage, type ToolEvent } from './ui/MessageRenderer';
import { TokenBudgetBar } from './ui/TokenBudgetBar';
import { estimateMessagesTokens } from './utils/tokenEstimator';

export const LLAMA_CHAT_VIEW_TYPE = 'llama-chat-view';

export class ChatView extends ItemView {
  private plugin: LlamaPlugin;

  // ── State ────────────────────────────────────────────────────────────────
  private messages: ChatMessage[] = [];
  private displayMessages: DisplayMessage[] = [];
  private isStreaming = false;
  private pendingAttachments: Attachment[] = [];

  // ── Sub-components ────────────────────────────────────────────────────────
  private sessionManager!: SessionManager;
  private attachmentHandler!: AttachmentHandler;
  private mentionAutocomplete!: MentionAutocomplete;
  private messageRenderer!: MessageRenderer;
  private tokenBudgetBar!: TokenBudgetBar;

  // ── DOM refs ──────────────────────────────────────────────────────────────
  private statusDot!: HTMLElement;
  private statusLabel!: HTMLElement;
  private messagesContainer!: HTMLElement;
  private inputArea!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private noteCountEl!: HTMLElement;
  private chatSelectEl!: HTMLSelectElement;
  private deleteChatBtn!: HTMLButtonElement;
  private attachInput!: HTMLInputElement;
  private attachmentPreviewEl!: HTMLElement;
  private permBadge!: HTMLElement;
  private contextStatusEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: LlamaPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return LLAMA_CHAT_VIEW_TYPE; }
  getDisplayText(): string { return 'LLAMA Chat'; }
  getIcon(): string { return 'message-circle'; }

  async onOpen(): Promise<void> {
    this.buildUI();

    // Initialize sub-components
    this.sessionManager = new SessionManager(this.plugin);
    this.attachmentHandler = new AttachmentHandler();
    this.messageRenderer = new MessageRenderer(
      this.app,
      this.messagesContainer,
      this,
      (content) => navigator.clipboard.writeText(content),
      (msg) => this.editMessage(msg),
      (path) => this.openNotes([path])
    );

    // Wire ToolExecutor callback for open_note tool
    this.plugin.toolExecutor.onOpenNotes = (paths: string[]) => this.openNotes(paths);

    // Initialize session
    const session = this.sessionManager.initialize();
    this.messages = [...session.messages];
    this.displayMessages = MessageRenderer.buildDisplayMessages(this.messages);

    // Mention autocomplete (needs input + container)
    this.mentionAutocomplete = new MentionAutocomplete(
      this.inputArea,
      this.inputArea.parentElement!,
      this.plugin.indexer,
      () => { /* note selected — no extra action needed */ }
    );

    this.renderMessages();
    this.refreshSessionControls();
    await this.checkConnection();
  }

  async onClose(): Promise<void> {
    this.plugin.llmClient.abort();
    this.tokenBudgetBar?.destroy();
  }

  // ── UI Construction ────────────────────────────────────────────────────────

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('llama-chat-root');
    root.style.padding = '0';

    // ── Header ──────────────────────────────────────────────────────────────
    const header = root.createDiv('llama-header');

    const titleRow = header.createDiv('llama-header-title-row');
    titleRow.createSpan('llama-header-icon').textContent = '🦙';
    titleRow.createSpan('llama-header-title').textContent = 'LLAMA Chat';

    const statusRow = header.createDiv('llama-header-status-row');
    this.statusDot = statusRow.createSpan('llama-status-dot');
    this.statusLabel = statusRow.createSpan('llama-status-label');
    this.statusLabel.textContent = 'Connecting…';
    this.noteCountEl = statusRow.createSpan('llama-note-count');

    const sessionControls = header.createDiv('llama-chat-session-controls');
    this.chatSelectEl = sessionControls.createEl('select', { cls: 'llama-chat-select' });
    this.chatSelectEl.addEventListener('change', () => {
      if (this.isStreaming) { this.chatSelectEl.value = this.sessionManager.currentId; return; }
      this.switchToSession(this.chatSelectEl.value);
    });

    const newChatBtn = sessionControls.createEl('button', {
      cls: 'llama-session-btn',
      text: 'New chat',
      title: 'Start new chat',
    });
    newChatBtn.addEventListener('click', () => this.startNewChat());

    this.deleteChatBtn = sessionControls.createEl('button', {
      cls: 'llama-icon-btn',
      title: 'Delete current chat',
    });
    setIcon(this.deleteChatBtn, 'trash-2');
    this.deleteChatBtn.addEventListener('click', () => this.deleteCurrentChat());

    const headerActions = header.createDiv('llama-header-actions');

    const refreshBtn = headerActions.createEl('button', { cls: 'llama-icon-btn', title: 'Check connection' });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.checkConnection());

    const clearBtn = headerActions.createEl('button', { cls: 'llama-icon-btn', title: 'Clear current chat' });
    setIcon(clearBtn, 'eraser');
    clearBtn.addEventListener('click', () => this.clearChat());

    const undoBtn = headerActions.createEl('button', { cls: 'llama-icon-btn', title: 'Undo last AI edit' });
    setIcon(undoBtn, 'rotate-ccw');
    undoBtn.addEventListener('click', () => this.showUndoPanel());

    const settingsBtn = headerActions.createEl('button', { cls: 'llama-icon-btn', title: 'Plugin settings' });
    setIcon(settingsBtn, 'settings');
    settingsBtn.addEventListener('click', () => {
      (this.app as any).setting?.open();
      (this.app as any).setting?.openTabById('obsidian-llama-chat');
    });

    // ── Context status (shows "Loading 3 notes…" during context build) ──────
    this.contextStatusEl = header.createDiv('llama-context-status');
    this.contextStatusEl.style.display = 'none';

    // ── Messages ──────────────────────────────────────────────────────────────
    this.messagesContainer = root.createDiv('llama-messages');

    // ── Input Bar ──────────────────────────────────────────────────────────────
    const inputBar = root.createDiv('llama-input-bar');
    this.attachmentPreviewEl = inputBar.createDiv('llama-input-attachments');

    this.inputArea = inputBar.createEl('textarea', {
      cls: 'llama-input',
      attr: { placeholder: 'Ask anything about your vault…', rows: '1' },
    });

    this.inputArea.addEventListener('input', () => {
      this.inputArea.style.height = 'auto';
      this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 160) + 'px';
      this.mentionAutocomplete?.handleInput();
    });

    this.inputArea.addEventListener('keydown', (e: KeyboardEvent) => {
      if (this.mentionAutocomplete?.handleKeydown(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!this.isStreaming) this.sendMessage();
      }
    });

    this.inputArea.addEventListener('blur', () => {
      setTimeout(() => this.mentionAutocomplete?.hide(), 150);
    });

    const btnGroup = inputBar.createDiv('llama-btn-group');

    const attachBtn = btnGroup.createEl('button', { cls: 'llama-attach-btn', title: 'Attach files' });
    setIcon(attachBtn, 'paperclip');

    this.attachInput = btnGroup.createEl('input', {
      attr: { type: 'file', multiple: 'true', style: 'display:none' },
    });
    attachBtn.addEventListener('click', () => this.attachInput.click());

    this.attachInput.addEventListener('change', async (e: Event) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;
      const newAtts = await this.attachmentHandler.processFiles(files);
      this.pendingAttachments.push(...newAtts);
      this.renderAttachmentPreviews();
      (e.target as HTMLInputElement).value = '';
    });

    btnGroup.createDiv('llama-btn-spacer');

    this.sendBtn = btnGroup.createEl('button', { cls: 'llama-send-btn', text: 'Send' });
    setIcon(this.sendBtn, 'send');
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    this.stopBtn = btnGroup.createEl('button', { cls: 'llama-stop-btn', text: 'Stop' });
    setIcon(this.stopBtn, 'square');
    this.stopBtn.style.display = 'none';
    this.stopBtn.addEventListener('click', () => {
      this.plugin.llmClient.abort();
      this.setStreaming(false);
    });

    // ── Footer ────────────────────────────────────────────────────────────────
    const footer = root.createDiv('llama-footer');

    this.permBadge = footer.createSpan('llama-perm-badge');
    this.updatePermBadge();

    const modelBadge = footer.createSpan('llama-model-badge');
    modelBadge.textContent = this.plugin.settings.model || 'auto model';

    // Token budget bar (Phase 5.1)
    this.tokenBudgetBar = new TokenBudgetBar(footer, this.plugin.settings.contextWindowTokens);
  }

  // ── Connection Check ───────────────────────────────────────────────────────

  async checkConnection(): Promise<void> {
    this.setStatus('connecting');
    try {
      const model = await this.plugin.llmClient.healthCheck();
      this.setStatus('connected', model);
    } catch (e) {
      this.setStatus('error', (e as Error).message);
    }

    if (this.plugin.indexer.isReady) {
      this.noteCountEl.textContent = `${this.plugin.indexer.noteCount} notes indexed`;
    } else {
      this.noteCountEl.textContent = 'Indexing…';
    }
  }

  private setStatus(state: 'connecting' | 'connected' | 'error', info?: string): void {
    this.statusDot.className = `llama-status-dot llama-status-${state}`;
    if (state === 'connected') {
      this.statusLabel.textContent = info ? `Connected · ${info}` : 'Connected';
    } else if (state === 'error') {
      this.statusLabel.textContent = `Offline · ${info ?? ''}`;
    } else {
      this.statusLabel.textContent = 'Connecting…';
    }
  }

  /** Update the permission badge text (called on open + settings change). */
  private updatePermBadge(): void {
    const icons: Record<string, string> = {
      read_only: '🔍 Read only',
      read_append: '✏️ Read + Append',
      full_edit: '⚠️ Full edit',
    };
    this.permBadge.textContent = icons[this.plugin.settings.editPermission] ?? '?';
    this.permBadge.title = 'Vault edit permission level — change in settings';
  }

  // ── Session Management ─────────────────────────────────────────────────────

  private switchToSession(id: string): void {
    const session = this.sessionManager.switchTo(id);
    if (!session) return;
    this.messages = [...session.messages];
    this.displayMessages = MessageRenderer.buildDisplayMessages(this.messages);
    this.pendingAttachments = [];
    this.renderAttachmentPreviews();
    this.renderMessages();
    this.refreshSessionControls();
    this.updateTokenBar();
  }

  private startNewChat(): void {
    if (this.isStreaming) return;
    const session = this.sessionManager.createAndActivate();
    this.messages = [];
    this.displayMessages = [];
    this.pendingAttachments = [];
    this.renderAttachmentPreviews();
    this.renderMessages();
    this.refreshSessionControls();
    this.updateTokenBar();
    this.inputArea.focus();
  }

  private deleteCurrentChat(): void {
    if (this.isStreaming) return;
    const session = this.sessionManager.currentSession;
    if (!session) return;
    const ok = window.confirm(`Delete chat "${session.title}"?`);
    if (!ok) return;
    const next = this.sessionManager.delete(session.id);
    this.messages = [...next.messages];
    this.displayMessages = MessageRenderer.buildDisplayMessages(this.messages);
    this.pendingAttachments = [];
    this.renderMessages();
    this.refreshSessionControls();
    this.updateTokenBar();
  }

  private clearChat(): void {
    if (this.isStreaming) return;
    this.messages = [];
    this.displayMessages = [];
    this.sessionManager.clearCurrentMessages();
    this.renderMessages();
    this.updateTokenBar();
  }

  private refreshSessionControls(): void {
    if (!this.chatSelectEl) return;
    this.chatSelectEl.empty();
    for (const session of this.sessionManager.allSessions) {
      const option = this.chatSelectEl.createEl('option');
      option.value = session.id;
      option.textContent = session.title;
    }
    this.chatSelectEl.value = this.sessionManager.currentId;
    const hasSessions = this.sessionManager.allSessions.length > 0;
    this.chatSelectEl.disabled = !hasSessions || this.isStreaming;
    this.deleteChatBtn.disabled = !hasSessions || this.isStreaming;
  }

  // ── Sending Messages ───────────────────────────────────────────────────────

  private async sendMessage(): Promise<void> {
    const text = this.inputArea.value.trim();
    const hasAttachments = this.pendingAttachments.length > 0;
    if ((!text && !hasAttachments) || this.isStreaming) return;

    this.inputArea.value = '';
    this.inputArea.style.height = 'auto';

    const attachmentsForSend = [...this.pendingAttachments];
    this.pendingAttachments = [];
    this.renderAttachmentPreviews();

    // Build the API content (with blobs for the LLM call)
    let apiContent: string | MessageContentPart[] = text;
    if (attachmentsForSend.length > 0) {
      const parts = AttachmentHandler.buildContentParts(text, attachmentsForSend, false);
      apiContent = parts as MessageContentPart[];
    }

    // Build the history content (without blobs — stored as text refs)
    let historyContent: string | MessageContentPart[] = text;
    if (attachmentsForSend.length > 0) {
      const parts = AttachmentHandler.buildContentParts(text, attachmentsForSend, true);
      historyContent = parts as MessageContentPart[];
    }

    // Add to display (show attachments visually)
    const userDisplayMsg: DisplayMessage = {
      role: 'user',
      content: text,
      attachments: attachmentsForSend,
    };
    this.displayMessages.push(userDisplayMsg);

    // Add to canonical history (blob-free for persistence)
    this.messages.push({ role: 'user', content: historyContent, attachments: [] });
    this.sessionManager.updateTitleFromPrompt(text);
    this.sessionManager.save(this.messages);

    this.messageRenderer.appendBubble(userDisplayMsg);
    this.scrollToBottom();
    this.setStreaming(true);

    // Show context-build status
    this.showContextStatus('Building context…');

    // Build context-enriched messages
    const enrichedMessages = await this.plugin.contextBuilder.prependSystemMessage(
      this.messages.slice(0, -1),
      text || 'See attachment(s)',
      (status) => this.showContextStatus(status)
    );
    // Append the API-content user message (with blobs for this request)
    enrichedMessages.push({ role: 'user', content: apiContent });
    this.hideContextStatus();

    // Add streaming assistant bubble
    const assistantDisplay: DisplayMessage = {
      role: 'assistant',
      content: '',
      streaming: true,
      toolEvents: [],
    };
    this.displayMessages.push(assistantDisplay);
    this.messageRenderer.appendBubble(assistantDisplay);

    let finalMessages: ChatMessage[] = enrichedMessages;

    const onChunk = (chunk: StreamChunk) => {
      if (chunk.type === 'token' && chunk.content) {
        assistantDisplay.content += chunk.content;
        this.messageRenderer.patchStreamingContent(assistantDisplay);
      } else if (chunk.type === 'tool_start') {
        assistantDisplay.toolEvents!.push({ type: 'start', name: chunk.toolName! });
        this.messageRenderer.patchStreamingContent(assistantDisplay);
      } else if (chunk.type === 'tool_end') {
        const evList = assistantDisplay.toolEvents!;
        let last: ToolEvent | undefined;
        for (let i = evList.length - 1; i >= 0; i--) {
          if (evList[i].name === chunk.toolName && evList[i].type === 'start') {
            last = evList[i]; break;
          }
        }
        if (!last && evList.length > 0) last = evList[evList.length - 1];
        if (last) { last.type = 'end'; last.result = chunk.toolResult; }
        this.messageRenderer.patchStreamingContent(assistantDisplay);
      } else if (chunk.type === 'error' && chunk.error) {
        assistantDisplay.content = chunk.error;
        assistantDisplay.role = 'error' as any;
        this.messageRenderer.patchStreamingContent(assistantDisplay);
      } else if (chunk.type === 'done') {
        assistantDisplay.streaming = false;
        this.messageRenderer.finalizeStreamingBubble(assistantDisplay);
      }
      this.scrollToBottom();
    };

    try {
      const gen = this.plugin.llmClient.runTurn(enrichedMessages, this.plugin.toolExecutor, onChunk);
      for await (const msgs of gen) {
        finalMessages = msgs;
      }
    } catch (e) {
      assistantDisplay.content = `Error: ${(e as Error).message}`;
      assistantDisplay.role = 'error' as any;
      assistantDisplay.streaming = false;
      this.messageRenderer.finalizeStreamingBubble(assistantDisplay);
    }

    // Persist final message state (system messages excluded)
    this.messages = finalMessages.filter(m => m.role !== 'system');
    this.sessionManager.save(this.messages);
    this.updateTokenBar();

    this.setStreaming(false);
    this.scrollToBottom();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private renderMessages(): void {
    this.messagesContainer.empty();
    if (this.displayMessages.length === 0) {
      this.renderWelcome();
      return;
    }
    this.messageRenderer.renderAll(this.displayMessages);
    this.scrollToBottom();
  }

  private renderWelcome(): void {
    const welcome = this.messagesContainer.createDiv('llama-welcome');
    welcome.createEl('div', { cls: 'llama-welcome-emoji', text: '🦙' });
    welcome.createEl('div', { cls: 'llama-welcome-title', text: 'LLAMA Chat' });
    welcome.createEl('div', {
      cls: 'llama-welcome-subtitle',
      text: 'Your local AI assistant with full vault access',
    });

    // Phase 5.2: Dynamic welcome chips from actual vault tags + recent notes
    const chips = welcome.createDiv('llama-welcome-chips');

    // Static fallbacks if vault isn't indexed yet
    const staticExamples = [
      '🔍 Search my notes on machine learning',
      '📝 Summarize my recent todos',
      '✏️ Add a section to my README',
      '📁 List what\'s in my Projects folder',
    ];

    const dynamicChips: string[] = [];

    if (this.plugin.indexer.isReady) {
      // Top tags → "What are my notes about [tag]?"
      const topTags = this.plugin.indexer.getTopTags(3);
      for (const tag of topTags) {
        dynamicChips.push(`🔍 Search notes tagged ${tag}`);
      }

      // Recent notes → "Summarize [note name]"
      const recent = this.plugin.indexer.getRecentNotes(2);
      for (const note of recent) {
        dynamicChips.push(`📖 Summarize ${note.title}`);
      }
    }

    const examples = dynamicChips.length >= 3 ? dynamicChips : staticExamples;

    for (const ex of examples) {
      const chip = chips.createEl('button', { cls: 'llama-example-chip', text: ex });
      chip.addEventListener('click', () => {
        this.inputArea.value = ex.replace(/^[^\s]+\s/, '').trim();
        this.inputArea.focus();
      });
    }
  }

  private editMessage(msg: DisplayMessage): void {
    const idx = this.displayMessages.indexOf(msg);
    if (idx === -1) return;

    // Count user messages before this one
    let userCount = 0;
    for (let i = 0; i < idx; i++) {
      if (this.displayMessages[i].role === 'user') userCount++;
    }

    // Find corresponding message in canonical history
    let mIdx = -1;
    let mUserCount = 0;
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i].role === 'user') {
        if (mUserCount === userCount) { mIdx = i; break; }
        mUserCount++;
      }
    }

    if (mIdx !== -1) this.messages = this.messages.slice(0, mIdx);
    this.displayMessages = this.displayMessages.slice(0, idx);

    this.inputArea.value = msg.content;
    this.inputArea.focus();
    this.inputArea.style.height = 'auto';
    this.inputArea.style.height = this.inputArea.scrollHeight + 'px';

    if (msg.attachments) {
      this.pendingAttachments = [...msg.attachments];
      this.renderAttachmentPreviews();
    }

    this.renderMessages();
    this.sessionManager.save(this.messages);
  }

  // ── Undo Panel (Phase 5.3) ────────────────────────────────────────────────

  private showUndoPanel(): void {
    const history = this.plugin.toolExecutor.undoHistory;

    if (history.length === 0) {
      new Notice('Nothing to undo');
      return;
    }

    // Remove any existing panel
    document.querySelectorAll('.llama-undo-panel-overlay').forEach(el => el.remove());

    const overlay = document.createElement('div');
    overlay.className = 'llama-modal-overlay llama-undo-panel-overlay';

    const panel = overlay.appendChild(document.createElement('div'));
    panel.className = 'llama-modal llama-undo-panel';

    const title = panel.appendChild(document.createElement('div'));
    title.className = 'llama-modal-title';
    title.textContent = '↩️ Undo History';

    const subtitle = panel.appendChild(document.createElement('div'));
    subtitle.className = 'llama-modal-subtitle';
    subtitle.textContent = 'Click an entry to undo that specific operation.';

    const list = panel.appendChild(document.createElement('div'));
    list.className = 'llama-undo-list';

    // Show newest first
    const reversed = [...history].reverse();
    reversed.forEach((entry, reversedIdx) => {
      const actualIdx = history.length - 1 - reversedIdx;
      const item = list.appendChild(document.createElement('div'));
      item.className = 'llama-undo-item';

      const desc = item.appendChild(document.createElement('span'));
      desc.className = 'llama-undo-desc';
      desc.textContent = entry.description;

      const time = item.appendChild(document.createElement('span'));
      time.className = 'llama-undo-time';
      const ago = Math.round((Date.now() - entry.timestamp) / 1000);
      time.textContent = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;

      item.addEventListener('click', async () => {
        overlay.remove();
        const path = await this.plugin.toolExecutor.undoAt(actualIdx);
        if (path) {
          new Notice(`↩️ Undid: "${entry.description}"`);
        } else {
          new Notice('Could not undo — file may have been moved or deleted');
        }
      });
    });

    const closeBtn = panel.appendChild(document.createElement('button'));
    closeBtn.className = 'llama-modal-cancel';
    closeBtn.textContent = 'Close';
    closeBtn.style.marginTop = '8px';
    closeBtn.addEventListener('click', () => overlay.remove());

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
  }

  // ── Notes ─────────────────────────────────────────────────────────────────

  private async openNotes(paths: string[]): Promise<void> {
    const { workspace } = this.app;
    for (let i = 0; i < paths.length; i++) {
      const file = this.app.vault.getAbstractFileByPath(paths[i]);
      if (file) {
        const leaf = workspace.getLeaf('tab');
        await leaf.openFile(file as any, { active: i === 0 });
      }
    }
  }

  // ── Context Status ────────────────────────────────────────────────────────

  private showContextStatus(status: string): void {
    this.contextStatusEl.textContent = status;
    this.contextStatusEl.style.display = 'block';
  }

  private hideContextStatus(): void {
    this.contextStatusEl.style.display = 'none';
    this.contextStatusEl.textContent = '';
  }

  // ── Token Bar ────────────────────────────────────────────────────────────

  private updateTokenBar(): void {
    const used = estimateMessagesTokens(this.messages);
    this.tokenBudgetBar?.setMax(this.plugin.settings.contextWindowTokens);
    this.tokenBudgetBar?.update(used);
  }

  // ── Streaming State ───────────────────────────────────────────────────────

  private setStreaming(streaming: boolean): void {
    this.isStreaming = streaming;
    this.sendBtn.style.display = streaming ? 'none' : 'flex';
    this.stopBtn.style.display = streaming ? 'flex' : 'none';
    this.inputArea.disabled = streaming;
    this.refreshSessionControls();
    if (!streaming) {
      this.inputArea.focus();
      this.updatePermBadge();
    }
  }

  // ── Attachments ───────────────────────────────────────────────────────────

  private renderAttachmentPreviews(): void {
    this.attachmentPreviewEl.empty();
    for (let i = 0; i < this.pendingAttachments.length; i++) {
      const att = this.pendingAttachments[i];
      const chip = this.attachmentPreviewEl.createDiv('llama-attachment-chip');
      chip.createSpan('llama-attachment-name').textContent = att.name;
      const removeBtn = chip.createSpan('llama-attachment-remove');
      setIcon(removeBtn, 'x');
      removeBtn.addEventListener('click', () => {
        this.pendingAttachments.splice(i, 1);
        this.renderAttachmentPreviews();
      });
    }
  }

  // ── Scroll ────────────────────────────────────────────────────────────────

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    });
  }

  private async undoLastEdit(): Promise<void> {
    const path = await this.plugin.toolExecutor.undoLast();
    if (path) {
      new Notice(`↩️ Undid last AI edit to "${path}"`);
    } else {
      new Notice('Nothing to undo');
    }
  }
}
