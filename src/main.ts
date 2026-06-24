import { Plugin, WorkspaceLeaf, TFile, Notice } from 'obsidian';
import { ENGRAM_VIEW_TYPE, ChatView } from './ChatView';
import { VaultIndexer } from './indexer';
import { EmbeddingIndex } from './embeddings';
import { ToolExecutor } from './tools';
import { ContextBuilder } from './context';
import { MemoryManager } from './memory/MemoryManager';
import { MemoryExtractor } from './memory/MemoryExtractor';
import { ProviderFactory } from './providers/ProviderFactory';
import { EngramSettingTab, DEFAULT_SETTINGS } from './settings';
import { ChatHistoryStore } from './chat/ChatHistoryStore';
import type { ChatSession, EngramSettings } from './types';
import type { EmbeddingIndexData } from './embeddings';

export default class EngramPlugin extends Plugin {
  settings!: EngramSettings;
  indexer!: VaultIndexer;
  embeddingIndex!: EmbeddingIndex;
  providerFactory!: ProviderFactory;
  toolExecutor!: ToolExecutor;
  contextBuilder!: ContextBuilder;
  memoryManager!: MemoryManager;
  memoryExtractor!: MemoryExtractor;
  chatHistoryStore!: ChatHistoryStore;
  chatSessions: ChatSession[] = [];

  private indexRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private chatPersistTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    await this.loadSettings();

    // Initialise vault-backed chat store (creates folder if needed)
    this.chatHistoryStore = new ChatHistoryStore(
      this.app,
      this.settings.chatHistoryPath
    );
    await this.chatHistoryStore.initialize();
    await this.loadChatSessions();

    this.initServices();

    // Register sidebar view
    this.registerView(ENGRAM_VIEW_TYPE, leaf => new ChatView(leaf, this));

    // Ribbon icon
    this.addRibbonIcon('brain', 'Open Engram', () => this.activateView());

    // Command palette
    this.addCommand({
      id: 'open-engram',
      name: 'Open Engram sidebar',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'engram-reindex-vault',
      name: 'Re-index vault',
      callback: () => this.rebuildIndex(),
    });

    this.addCommand({
      id: 'engram-open-memory',
      name: 'Open memory file',
      callback: () => this.openMemoryFile(),
    });

    this.addCommand({
      id: 'engram-sync-chats',
      name: 'Sync chat history from vault',
      callback: () => this.syncChatsFromVault(),
    });

    // Settings tab
    this.addSettingTab(new EngramSettingTab(this.app, this));

    // Build vault index (non-blocking)
    this.buildIndexInBackground();

    // Watch vault for changes (index + chat sync)
    this.registerVaultEvents();
  }

  onunload(): void {
    // this.app.workspace.detachLeavesOfType(ENGRAM_VIEW_TYPE);
    if (this.indexRebuildTimer) window.clearTimeout(this.indexRebuildTimer);
    for (const timer of this.chatPersistTimers.values()) {
      window.clearTimeout(timer);
    }
    this.chatPersistTimers.clear();
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? {});

    // Migrate old LlamaPluginSettings format if present
    if ((this.settings as any).endpoint && !(this.settings as any).providerBaseUrl) {
      (this.settings as any).providerBaseUrl = (this.settings as any).endpoint;
    }
    if (!(this.settings as any).personas || !(this.settings as any).personas.length) {
      this.settings.personas = DEFAULT_SETTINGS.personas;
    }
    if (!(this.settings as any).activePersonaId) {
      this.settings.activePersonaId = 'default';
    }

    // Migrate old scopeMode values
    if ((this.settings.scopeMode as string) === 'allow') {
      this.settings.scopeMode = 'allowlist';
    } else if ((this.settings.scopeMode as string) === 'block') {
      this.settings.scopeMode = 'denylist';
    }

    // Migrate old embedding model/endpoint settings to new provider structure
    if (!this.settings.embedProvider) {
      if (this.settings.embeddingModel) {
        this.settings.embedProvider = 'ollama';
        this.settings.ollamaEmbedModel = this.settings.embeddingModel;
      } else {
        this.settings.embedProvider = 'none';
      }
    }
    if (this.settings.ollamaEmbedEndpoint && !this.settings.ollamaEmbedUrl) {
      this.settings.ollamaEmbedUrl = this.settings.ollamaEmbedEndpoint;
    }
  }

  async saveSettings(): Promise<void> {
    const existing = (await this.loadData()) ?? {};
    await this.saveData({ ...existing, settings: this.settings });

    // Propagate to all services
    this.providerFactory?.updateSettings(this.settings);
    this.toolExecutor?.updateSettings(this.settings);
    this.contextBuilder?.updateSettings(this.settings);
    this.indexer?.updateSettings(this.settings);
    this.memoryManager?.updateConfig(this.settings.memoryPath, this.settings.maxMemoryTokens);

    // Update chat history store path (creates new folder if needed)
    this.chatHistoryStore?.setFolderPath(this.settings.chatHistoryPath);
    this.chatHistoryStore?.initialize().catch(console.error);

    // Run silent background build to immediately enforce rules on index
    this.buildIndexInBackground();

    // Propagate to active views
    const leaves = this.app.workspace.getLeavesOfType(ENGRAM_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof ChatView) {
        leaf.view.onSettingsUpdate();
      }
    }
  }

  // ── Connection test (called from settings UI) ────────────────────────────────

  async testConnection(): Promise<string> {
    try {
      this.providerFactory.updateSettings(this.settings);
      const model = await this.providerFactory.healthCheck();
      return `✅ Connected — model: ${model}`;
    } catch (e) {
      return `❌ ${(e as Error).message}`;
    }
  }

  // ── Memory helpers ───────────────────────────────────────────────────────────

  async openMemoryFile(): Promise<void> {
    await this.memoryManager.openInEditor();
  }

  // ── Chat Sessions ────────────────────────────────────────────────────────────

  /**
   * Load chat sessions at startup.
   *
   * Priority order:
   *   1. Vault files (.engram/chats/<id>.json) — the source of truth after v5.1
   *   2. Legacy data.json chatSessions — migrated automatically on first run
   *
   * After a successful migration the `chatSessions` key is removed from data.json
   * to avoid stale duplicates.
   */
  async loadChatSessions(): Promise<void> {
    // 1. Load from vault files
    const vaultSessions = await this.chatHistoryStore.loadAll();
    const vaultIds = new Set(vaultSessions.map(s => s.id));

    // 2. Load legacy sessions from data.json (backward compat / migration)
    const data = await this.loadData();
    const legacySessions: ChatSession[] = Array.isArray(data?.chatSessions)
      ? (data.chatSessions as any[])
          .filter((s: any) => s && typeof s.id === 'string' && Array.isArray(s.messages))
          .map((s: any): ChatSession => ({
            schemaVersion: 1,
            id: s.id,
            title: typeof s.title === 'string' && s.title.trim() ? s.title : 'New chat',
            createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
            updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
            messages: s.messages,
          }))
      : [];

    // 3. Migrate legacy sessions not yet in vault
    const toMigrate = legacySessions.filter(s => !vaultIds.has(s.id));
    if (toMigrate.length > 0) {
      console.log(`[Engram] Migrating ${toMigrate.length} chat session(s) from data.json → vault files`);
      for (const session of toMigrate) {
        await this.chatHistoryStore.save(session);
      }

      // Remove the now-migrated chatSessions key from data.json
      const existing = (await this.loadData()) ?? {};
      const { chatSessions: _removed, ...rest } = existing as any;
      await this.saveData(rest);
      console.log('[Engram] Migration complete — chat sessions removed from data.json');
    }

    // 4. Merge and sort all sessions
    const merged = [...vaultSessions, ...toMigrate];
    this.chatSessions = merged.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Upsert a session in memory and schedule a debounced write to its vault file.
   * Each session has its own independent debounce timer (800 ms).
   *
   * Empty sessions (no messages) are kept in memory for the UI but are NOT
   * written to disk — the folder only contains real conversations.
   */
  upsertChatSession(session: ChatSession): void {
    const withTouch = { ...session, updatedAt: session.updatedAt || Date.now() };
    const idx = this.chatSessions.findIndex(s => s.id === session.id);
    if (idx >= 0) this.chatSessions[idx] = withTouch;
    else this.chatSessions.push(withTouch);
    this.chatSessions.sort((a, b) => b.updatedAt - a.updatedAt);

    // Only persist sessions that have at least one message
    if (!withTouch.messages || withTouch.messages.length === 0) return;

    // Debounce per-session write
    const existing = this.chatPersistTimers.get(session.id);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.chatPersistTimers.delete(session.id);
      this.chatHistoryStore.save(withTouch).catch(e =>
        console.error(`[Engram] Failed to save session "${session.id}":`, e)
      );
    }, 800) as any;
    this.chatPersistTimers.set(session.id, timer);
  }

  /** Delete a session from memory and permanently remove its vault file. */
  deleteChatSession(id: string): void {
    // Cancel any pending write for this session first
    const timer = this.chatPersistTimers.get(id);
    if (timer) {
      window.clearTimeout(timer);
      this.chatPersistTimers.delete(id);
    }
    this.chatSessions = this.chatSessions.filter(s => s.id !== id);
    // force:true permanently removes the file (no OS trash) so the folder
    // stays in sync with what the UI shows.
    this.chatHistoryStore.delete(id, true).catch(e =>
      console.error(`[Engram] Failed to delete session "${id}":`, e)
    );
  }

  /**
   * Re-import sessions from vault files (folder is single source of truth).
   * Discards in-memory-only sessions (empty chats with no file) and rebuilds
   * from disk. The current active session is preserved if it exists on disk.
   */
  async syncChatsFromVault(): Promise<void> {
    const vaultSessions = await this.chatHistoryStore.loadAll();
    this.chatSessions = vaultSessions.sort((a, b) => b.updatedAt - a.updatedAt);
    this.notifyChatViewsSessionsChanged();
    new Notice(`🧠 Engram: ${vaultSessions.length} chat session(s) loaded from vault`);
    console.log(`[Engram] syncChatsFromVault: loaded ${vaultSessions.length} session(s)`);
  }

  // ── Services ─────────────────────────────────────────────────────────────────

  private initServices(): void {
    this.indexer = new VaultIndexer(this.app, this.settings);
    this.embeddingIndex = new EmbeddingIndex(this.app, this.settings);
    this.providerFactory = new ProviderFactory(this.settings);
    this.toolExecutor = new ToolExecutor(this.app, this.indexer, this.settings, this.embeddingIndex);
    this.memoryManager = new MemoryManager(
      this.app,
      this.settings.memoryPath,
      this.settings.maxMemoryTokens
    );
    // Wire MemoryManager into ToolExecutor so memory path-guards and
    // save_memory / delete_memory tools are operational.
    this.toolExecutor.setMemoryManager(this.memoryManager);
    this.contextBuilder = new ContextBuilder(
      this.app,
      this.settings,
      this.indexer,
      this.memoryManager,
      this.embeddingIndex
    );
    this.memoryExtractor = new MemoryExtractor(this.providerFactory, this.memoryManager);
  }

  // ── Vault Indexing ────────────────────────────────────────────────────────────

  private async buildIndexInBackground(): Promise<void> {
    const data = await this.loadData();
    const savedIndex = data?.index ?? null;
    const savedEmbeds: EmbeddingIndexData | null = data?.embeddings ?? null;

    try {
      await this.indexer.build(savedIndex);
      console.log(`[Engram] Vault indexed: ${this.indexer.noteCount} notes`);

      this.embeddingIndex.load(savedEmbeds);
      console.log(`[Engram] Embeddings loaded: ${this.embeddingIndex.entryCount} notes in index`);

      await this.persistIndex();
    } catch (e) {
      console.error('[Engram] Indexing error:', e);
    }
  }

  private async persistIndex(): Promise<void> {
    const existing = (await this.loadData()) ?? {};
    const update: Record<string, unknown> = {
      ...existing,
      index: this.indexer.getSerializable(),
    };
    if (this.embeddingIndex.isReady) {
      update.embeddings = this.embeddingIndex.toJSON();
    }
    await this.saveData(update);
  }

  private async rebuildIndex(): Promise<void> {
    new Notice('🧠 Engram: Re-indexing vault…');
    await this.indexer.build(null);
    await this.persistIndex();
    new Notice(`🧠 Engram: ${this.indexer.noteCount} notes indexed`);
  }

  // ── Vault Events ──────────────────────────────────────────────────────────────

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on('create', async file => {
        if (!(file instanceof TFile)) return;

        // Chat sync: a new chat file arrived (e.g. from external vault sync)
        if (this.chatHistoryStore.isOwnedPath(file.path)) {
          await this.onChatFileChanged(file);
          return;
        }

        if (file.extension === 'md') {
          await this.indexer.updateFile(file);
          this.schedulePersist();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('modify', async file => {
        if (!(file instanceof TFile)) return;

        // Chat sync: a chat file was modified externally
        if (this.chatHistoryStore.isOwnedPath(file.path)) {
          await this.onChatFileChanged(file);
          return;
        }

        if (file.extension === 'md') {
          await this.indexer.updateFile(file);
          this.schedulePersist();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', file => {
        if (!(file instanceof TFile)) return;

        // Chat sync: a chat file was deleted externally
        if (this.chatHistoryStore.isOwnedPath(file.path)) {
          const id = this.chatHistoryStore.idFromPath(file.path);
          if (id) {
            this.chatSessions = this.chatSessions.filter(s => s.id !== id);
            this.notifyChatViewsSessionsChanged();
          }
          return;
        }

        if (file.extension === 'md') {
          this.indexer.removeFile(file.path);
          this.embeddingIndex.removeFile(file.path);
          this.schedulePersist();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', async (file, oldPath) => {
        if (file instanceof TFile && file.extension === 'md') {
          await this.indexer.renameFile(file, oldPath);
          this.embeddingIndex.renameFile(oldPath, file.path, file.stat.mtime);
          this.schedulePersist();
        }
      })
    );
  }

  /**
   * Called when a chat JSON file is created or modified by the vault file system
   * (i.e., synced from another device). Merges the session into memory and
   * refreshes any open chat views.
   */
  private async onChatFileChanged(file: TFile): Promise<void> {
    const id = this.chatHistoryStore.idFromPath(file.path);
    if (!id) return;

    // Skip if this write was initiated by us (the pending timer is a reliable signal)
    if (this.chatPersistTimers.has(id)) return;

    const session = await this.chatHistoryStore.loadOne(id);
    if (!session) return;

    const idx = this.chatSessions.findIndex(s => s.id === id);
    if (idx >= 0) {
      // Only overwrite in-memory copy if the file is newer
      if (session.updatedAt >= this.chatSessions[idx].updatedAt) {
        this.chatSessions[idx] = session;
      }
    } else {
      this.chatSessions.push(session);
    }
    this.chatSessions.sort((a, b) => b.updatedAt - a.updatedAt);

    this.notifyChatViewsSessionsChanged();
    console.log(`[Engram] Chat session synced from vault: "${session.title}" (${id})`);
  }

  private schedulePersist(): void {
    if (this.indexRebuildTimer) window.clearTimeout(this.indexRebuildTimer);
    this.indexRebuildTimer = window.setTimeout(() => this.persistIndex(), 5000) as any;
  }

  /**
   * Notify all open ChatView instances that the session list has changed.
   * Views will refresh their session sidebar without disturbing the active chat.
   */
  notifyChatViewsSessionsChanged(): void {
    const leaves = this.app.workspace.getLeavesOfType(ENGRAM_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof ChatView) {
        leaf.view.onExternalSessionsChanged();
      }
    }
  }

  // ── View ──────────────────────────────────────────────────────────────────────

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(ENGRAM_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: ENGRAM_VIEW_TYPE, active: true });
    }

    if (leaf) workspace.revealLeaf(leaf);
  }
}

