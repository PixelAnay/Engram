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
import { ChatSessionService } from './chat/ChatSessionService';
import { OwnOpTracker } from './chat/OwnOpTracker';
import { PluginDataStore } from './storage/PluginDataStore';
import { scopeSignature, providerSignature } from './utils/settingsSignature';
import { migrateSettings } from './utils/settingsMigration';
import { showBackupPicker } from './ui/BackupPickerModal';
import { showConfirmDialog } from './ui/ConfirmDialog';
import type { ChatSession, EngramSettings } from './types';
import type { EmbeddingIndexData } from './embeddings';

export default class EngramPlugin extends Plugin {
  settings!: EngramSettings;
  dataStore: PluginDataStore = new PluginDataStore(this);
  indexer!: VaultIndexer;
  embeddingIndex!: EmbeddingIndex;
  providerFactory!: ProviderFactory;
  toolExecutor!: ToolExecutor;
  contextBuilder!: ContextBuilder;
  memoryManager!: MemoryManager;
  memoryExtractor!: MemoryExtractor;
  chatHistoryStore!: ChatHistoryStore;
  chatService!: ChatSessionService;
  /** Resolves once chat sessions are loaded (after the workspace layout is ready). */
  chatsReady: Promise<void> = new Promise<void>(resolve => { this.resolveChatsReady = resolve; });

  /** Current sessions, newest first. Owned by ChatSessionService. */
  get chatSessions(): ChatSession[] {
    return this.chatService ? this.chatService.sessions : [];
  }

  private resolveChatsReady!: () => void;
  private chatOwnOps = new OwnOpTracker();

  private indexRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private scopeRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingMigrationMessages: string[] = [];
  private lastScopeSig = '';
  private lastProviderSig = '';
  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    await this.loadSettings();

    // Vault-backed chat store. Nothing touches the vault until the layout is ready.
    this.chatHistoryStore = new ChatHistoryStore(
      this.app,
      this.settings.chatHistoryPath,
      this.chatOwnOps
    );
    this.chatService = new ChatSessionService(this.chatHistoryStore, this.chatOwnOps, {
      getActiveSessionIds: () => this.getOpenChatSessionIds(),
      onChanged: () => this.notifyChatViewsSessionsChanged(),
    });

    this.initServices();

    // Memory writes, chat loading, vault events and indexing wait until Obsidian
    // has finished loading the vault (sync may still be delivering files before that).
    this.app.workspace.onLayoutReady(() => { void this.onLayoutReadyInit(); });

    // Make sure unsaved chat messages reach disk when Obsidian quits
    this.registerEvent(
      (this.app.workspace as any).on('quit', (tasks?: { add?: (fn: () => Promise<unknown>) => void }) => {
        if (tasks?.add) tasks.add(() => this.flushAllChats());
        else void this.flushAllChats();
      })
    );

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
      id: 'engram-restore-memory',
      name: 'Restore memory from backup',
      callback: () => this.restoreMemoryFromBackup(),
    });

    this.addCommand({
      id: 'engram-sync-chats',
      name: 'Sync chat history from vault',
      callback: () => this.syncChatsFromVault(),
    });

    // Settings tab
    this.addSettingTab(new EngramSettingTab(this.app, this));

  }

  /** Runs once, after the workspace layout (and with it the vault) is ready. */
  private async onLayoutReadyInit(): Promise<void> {
    this.memoryManager.markReady();
    for (const message of this.pendingMigrationMessages) new Notice(message, 15000);
    this.pendingMigrationMessages = [];

    try {
      await this.chatHistoryStore.initialize();
      await this.loadChatSessions();
    } catch (e) {
      console.error('[Engram] Failed to load chat sessions:', e);
    } finally {
      this.resolveChatsReady();
    }

    // Watch vault for changes (index + chat sync)
    this.registerVaultEvents();

    // Build vault index (non-blocking)
    void this.buildIndexInBackground();
  }

  onunload(): void {
    if (this.indexRebuildTimer) window.clearTimeout(this.indexRebuildTimer);
    if (this.scopeRebuildTimer) window.clearTimeout(this.scopeRebuildTimer);
    // Write any unsaved chat messages instead of discarding them
    void this.flushAllChats();
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    await this.dataStore.load();
    const data = this.dataStore.get();
    const migration = migrateSettings(data?.settings, DEFAULT_SETTINGS);
    this.settings = migration.settings;
    this.pendingMigrationMessages = migration.messages;

    // Persist the migration result so one-time steps never run twice
    if (migration.changed || !data?.settings) {
      await this.dataStore.update(d => { d.settings = this.settings; });
    }

    this.lastScopeSig = scopeSignature(this.settings);
    this.lastProviderSig = providerSignature(this.settings);
  }
  async saveSettings(): Promise<void> {
    await this.dataStore.update(d => { d.settings = this.settings; });

    // Propagate to all services
    this.providerFactory?.updateSettings(this.settings);
    this.toolExecutor?.updateSettings(this.settings);
    this.contextBuilder?.updateSettings(this.settings);
    this.indexer?.updateSettings(this.settings);
    this.memoryManager?.updateConfig(this.settings.memoryPath);

    // The chat history folder is changed only through changeChatHistoryPath
    // (commit on blur, confirm, move existing chats). Nothing here touches it.

    // Rebuild the index only when scope/exclusion rules changed (debounced)
    const scopeSig = scopeSignature(this.settings);
    if (scopeSig !== this.lastScopeSig) {
      this.lastScopeSig = scopeSig;
      this.scheduleIndexRebuild();
    }

    // Only re-check the connection when provider-related settings changed
    const providerSig = providerSignature(this.settings);
    const providerChanged = providerSig !== this.lastProviderSig;
    this.lastProviderSig = providerSig;

    // Propagate to active views
    const leaves = this.app.workspace.getLeavesOfType(ENGRAM_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof ChatView) {
        leaf.view.onSettingsUpdate(providerChanged);
      }
    }
  }

  /** Debounced (2 s) background index build used after scope settings change. */
  private scheduleIndexRebuild(): void {
    if (this.scopeRebuildTimer) window.clearTimeout(this.scopeRebuildTimer);
    this.scopeRebuildTimer = window.setTimeout(() => {
      this.scopeRebuildTimer = null;
      void this.buildIndexInBackground();
    }, 2000) as any;
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

  /** Pick a local backup and put it back as the memory file (current content is backed up first). */
  async restoreMemoryFromBackup(): Promise<void> {
    const backups = await this.memoryManager.describeBackups();
    if (backups.length === 0) {
      new Notice('🧠 Engram: no memory backups exist yet.');
      return;
    }
    const picked = await showBackupPicker(
      this.app,
      backups.map(b => ({
        path: b.path,
        label: `${b.timestamp ? new Date(b.timestamp).toLocaleString() : b.name} · ${b.entryCount} memories`,
      }))
    );
    if (!picked) return;

    const ok = await showConfirmDialog(this.app, {
      title: 'Restore memory?',
      message: 'Replace the current memory file with this backup? The current content is backed up first.',
      confirmLabel: 'Restore',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;

    const result = await this.memoryManager.restoreBackup(picked);
    new Notice(result.ok
      ? '🧠 Engram: memory restored from backup.'
      : `🧠 Engram: restore failed: ${result.message ?? result.reason}`);
  }

  /** Remove every memory entry (free text in the file stays). Asks first; a backup is taken. */
  async clearAllMemory(): Promise<void> {
    const ok = await showConfirmDialog(this.app, {
      title: 'Clear all memory?',
      message: 'This removes every memory entry from the memory file. Your own notes in that file stay, and a backup is saved so you can restore it.',
      confirmLabel: 'Clear all',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    const result = await this.memoryManager.clearAll();
    if (result.ok) new Notice('🧠 Engram: memory cleared (backup saved).');
    else if (result.reason === 'missing_file') new Notice('🧠 Engram: the memory file is missing, nothing to clear.');
    else new Notice(`🧠 Engram: could not clear memory: ${result.message ?? result.reason}`);
  }

  // ── Chat Sessions ────────────────────────────────────────────────────────────

  /**
   * Load chat sessions at startup.
   *
   * Migration priority (in order):
   *   1. One-time folder migration: .engram/chats → Intelligence/Chats (v5.0.47 → v5.0.49)
   *   2. One-time data.json migration: legacy chatSessions key → vault files (pre-v5.0.47)
   *   3. Load from vault files (Intelligence/Chats/) — the source of truth
   *
   * After each migration step the stale source is cleaned up.
   */
  async loadChatSessions(): Promise<void> {
    // 0. One-time folder migration: .engram/chats → current path (Intelligence/Chats)
    //    Runs only if the old hidden folder still exists.
    const OLD_HIDDEN_PATH = '.engram/chats';
    if (this.settings.chatHistoryPath !== OLD_HIDDEN_PATH) {
      const moved = await this.chatHistoryStore.migrateFrom(OLD_HIDDEN_PATH);
      if (moved > 0) {
        console.log(`[Engram] Moved ${moved} chat file(s) from ${OLD_HIDDEN_PATH} → ${this.settings.chatHistoryPath}`);
        new Notice(`🧠 Engram: Moved ${moved} chat(s) to ${this.settings.chatHistoryPath}`);
      }
    }

    // 1. Load from vault files
    const vaultSessions = await this.chatHistoryStore.loadAll();
    const vaultIds = new Set(vaultSessions.map(s => s.id));

    // 2. Load legacy sessions from data.json (backward compat / migration)
    const data = this.dataStore.get();
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
      await this.dataStore.update(d => { delete d.chatSessions; });
      console.log('[Engram] Migration complete — chat sessions removed from data.json');
    }

    // 4. Merge and sort all sessions
    const merged = [...vaultSessions, ...toMigrate];
    this.chatService.sessions = merged.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Upsert a session in memory and schedule a debounced write to its vault file.
   * Empty sessions (no messages) are kept in memory for the UI but have no file.
   */
  upsertChatSession(session: ChatSession): void {
    this.chatService.upsert(session);
  }

  /** Delete a session from memory and permanently remove its vault file. */
  deleteChatSession(id: string): void {
    this.chatService.remove(id);
  }

  /** Write one chat's unsaved changes to disk now (e.g. when switching chats). */
  flushChat(id: string): Promise<void> {
    return this.chatService.flush(id);
  }

  /** Write all unsaved chat changes to disk now (view close, quit, unload). */
  flushAllChats(): Promise<void> {
    return this.chatService.flushAll();
  }

  /**
   * Re-import sessions from vault files. Sessions with unsaved local changes and
   * empty chats that are open in a view are kept.
   */
  async syncChatsFromVault(): Promise<void> {
    const count = await this.chatService.syncFromVault();
    new Notice(`🧠 Engram: ${count} chat session(s) loaded from vault`);
    console.log(`[Engram] syncChatsFromVault: loaded ${count} session(s)`);
  }

  /** Ids of the chat sessions currently displayed in open Engram views. */
  private getOpenChatSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const leaf of this.app.workspace.getLeavesOfType(ENGRAM_VIEW_TYPE)) {
      if (leaf.view instanceof ChatView) {
        const id = leaf.view.getActiveSessionId();
        if (id) ids.add(id);
      }
    }
    return ids;
  }
  // ── Services ─────────────────────────────────────────────────────────────────

  private initServices(): void {
    this.indexer = new VaultIndexer(this.app, this.settings);
    this.embeddingIndex = new EmbeddingIndex(this.app, this.settings);
    this.providerFactory = new ProviderFactory(this.settings);
    this.toolExecutor = new ToolExecutor(this.app, this.indexer, this.settings, this.embeddingIndex);
    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    this.memoryManager = new MemoryManager(
      this.app,
      this.settings.memoryPath,
      this.dataStore,
      `${pluginDir}/memory-backups`
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
    const data = this.dataStore.get();
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
    const index = this.indexer.getSerializable();
    const embeddings = this.embeddingIndex.isReady ? this.embeddingIndex.toJSON() : undefined;
    await this.dataStore.update(d => {
      d.index = index;
      if (embeddings) d.embeddings = embeddings;
    });
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

        // The memory file (re)appeared, e.g. delivered by sync: flush queued facts
        this.memoryManager.onVaultCreate(file.path);

        // Chat sync: a new chat file arrived (e.g. from external vault sync).
        // Events caused by our own writes are ignored inside the service.
        if (await this.chatService.onFileChanged(file)) return;

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
        if (await this.chatService.onFileChanged(file)) return;

        if (file.extension === 'md') {
          await this.indexer.updateFile(file);
          this.schedulePersist();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', file => {
        if (!(file instanceof TFile)) return;

        // Chat sync: a chat file was deleted externally (our own deletes are ignored)
        if (this.chatService.onFileDeleted(file.path)) return;

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

