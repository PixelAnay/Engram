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
  chatSessions: ChatSession[] = [];

  private indexRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private chatPersistTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    await this.loadSettings();
    const applied = await this.checkForSyncedData();
    if (applied) {
      await this.loadSettings();
    }
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

    // Settings tab
    this.addSettingTab(new EngramSettingTab(this.app, this));

    // Build vault index (non-blocking)
    this.buildIndexInBackground();

    // Watch vault for changes
    this.registerVaultEvents();
  }

  onunload(): void {
    // this.app.workspace.detachLeavesOfType(ENGRAM_VIEW_TYPE);
    if (this.indexRebuildTimer) clearTimeout(this.indexRebuildTimer);
    if (this.chatPersistTimer) clearTimeout(this.chatPersistTimer);
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
    const now = Date.now();
    
    // If sync was just enabled, check if we should first pull from an existing sync file
    if (this.settings.enableVaultSync) {
      const adapter = this.app.vault.adapter;
      const syncPath = this.getSyncFilePath();
      if (await adapter.exists(syncPath)) {
        try {
          const content = await adapter.read(syncPath);
          const syncData = JSON.parse(content);
          if (syncData && syncData.settings) {
            console.log('[Engram] Pulling existing sync data on enable…');
            // Merge sync settings but keep enableVaultSync as true
            this.settings = {
              ...syncData.settings,
              enableVaultSync: true,
            };
            
            // Update other local data
            const localData = (await this.loadData()) ?? {};
            const newLocalData = {
              ...localData,
              settings: this.settings,
              index: syncData.index || localData.index,
              embeddings: syncData.embeddings || localData.embeddings,
              chatSessions: syncData.chatSessions || localData.chatSessions,
              syncUpdatedAt: syncData.updatedAt || now,
            };
            await this.saveData(newLocalData);
            
            // Reload services and UI
            this.providerFactory?.updateSettings(this.settings);
            this.toolExecutor?.updateSettings(this.settings);
            this.contextBuilder?.updateSettings(this.settings);
            this.indexer?.updateSettings(this.settings);
            this.memoryManager?.updateConfig(this.settings.memoryPath, this.settings.maxMemoryTokens);
            
            if (syncData.embeddings) {
              this.embeddingIndex.load(syncData.embeddings);
            }
            if (syncData.index) {
              await this.indexer.build(syncData.index);
            }
            await this.loadChatSessions();
            
            // Reload active views
            const leaves = this.app.workspace.getLeavesOfType(ENGRAM_VIEW_TYPE);
            for (const leaf of leaves) {
              if (leaf.view instanceof ChatView) {
                leaf.view.onSettingsUpdate();
                leaf.view.reloadActiveSession();
              }
            }
            
            new Notice('🔄 Engram: Synced settings, chat history, and index from vault!');
            return;
          }
        } catch (e) {
          console.error('[Engram] Error pulling sync data on enable:', e);
        }
      }
    }

    const existing = (await this.loadData()) ?? {};
    await this.saveData({ ...existing, settings: this.settings, syncUpdatedAt: now });
    await this.writeToSyncFile(now);

    // Propagate to all services
    this.providerFactory?.updateSettings(this.settings);
    this.toolExecutor?.updateSettings(this.settings);
    this.contextBuilder?.updateSettings(this.settings);
    this.indexer?.updateSettings(this.settings);
    this.memoryManager?.updateConfig(this.settings.memoryPath, this.settings.maxMemoryTokens);

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

  async loadChatSessions(): Promise<void> {
    const data = await this.loadData();
    const sessions = Array.isArray(data?.chatSessions) ? data.chatSessions : [];
    this.chatSessions = sessions
      .filter((s: any) => s && typeof s.id === 'string' && Array.isArray(s.messages))
      .map((s: any) => ({
        id: s.id,
        title: typeof s.title === 'string' && s.title.trim() ? s.title : 'New chat',
        createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
        updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
        messages: s.messages,
      }))
      .sort((a: ChatSession, b: ChatSession) => b.updatedAt - a.updatedAt);
  }

  async saveChatSessions(): Promise<void> {
    const existing = (await this.loadData()) ?? {};
    const now = Date.now();
    await this.saveData({ ...existing, chatSessions: this.chatSessions, syncUpdatedAt: now });
    await this.writeToSyncFile(now);
  }

  scheduleSaveChatSessions(): void {
    if (this.chatPersistTimer) clearTimeout(this.chatPersistTimer);
    this.chatPersistTimer = setTimeout(() => this.saveChatSessions(), 800);
  }

  upsertChatSession(session: ChatSession): void {
    const idx = this.chatSessions.findIndex(s => s.id === session.id);
    const withTouch = { ...session, updatedAt: session.updatedAt || Date.now() };
    if (idx >= 0) this.chatSessions[idx] = withTouch;
    else this.chatSessions.push(withTouch);
    this.chatSessions.sort((a, b) => b.updatedAt - a.updatedAt);
    this.scheduleSaveChatSessions();
  }

  deleteChatSession(id: string): void {
    this.chatSessions = this.chatSessions.filter(s => s.id !== id);
    this.scheduleSaveChatSessions();
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
    const now = Date.now();
    const update: Record<string, unknown> = {
      ...existing,
      index: this.indexer.getSerializable(),
      syncUpdatedAt: now,
    };
    if (this.embeddingIndex.isReady) {
      update.embeddings = this.embeddingIndex.toJSON();
    }
    await this.saveData(update);
    await this.writeToSyncFile(now);
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
        if (file.path === this.getSyncFilePath()) {
          await this.applySyncUpdate();
          return;
        }
        if (file instanceof TFile && file.extension === 'md') {
          await this.indexer.updateFile(file);
          this.schedulePersist();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('modify', async file => {
        if (file.path === this.getSyncFilePath()) {
          await this.applySyncUpdate();
          return;
        }
        if (file instanceof TFile && file.extension === 'md') {
          await this.indexer.updateFile(file);
          this.schedulePersist();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', file => {
        if (file instanceof TFile && file.extension === 'md') {
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
    if (this.indexRebuildTimer) clearTimeout(this.indexRebuildTimer);
    this.indexRebuildTimer = setTimeout(() => this.persistIndex(), 5000);
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

  // ── Sync helpers ─────────────────────────────────────────────────────────────

  private async checkForSyncedData(): Promise<boolean> {
    if (!this.settings?.enableVaultSync) return false;
    try {
      const adapter = this.app.vault.adapter;
      const syncPath = this.getSyncFilePath();
      if (await adapter.exists(syncPath)) {
        const content = await adapter.read(syncPath);
        if (!content || !content.trim()) return false;
        const syncData = JSON.parse(content);
        
        if (syncData && typeof syncData.updatedAt === 'number') {
          const localData = await this.loadData();
          const localUpdatedAt = localData?.syncUpdatedAt ?? 0;
          
          if (syncData.updatedAt > localUpdatedAt) {
            console.log(`[Engram] Synced data is newer than local data. Applying sync from ${syncPath}…`);
            const newLocalData = {
              ...localData,
              settings: syncData.settings || localData?.settings,
              index: syncData.index || localData?.index,
              embeddings: syncData.embeddings || localData?.embeddings,
              chatSessions: syncData.chatSessions || localData?.chatSessions,
              syncUpdatedAt: syncData.updatedAt,
            };
            await this.saveData(newLocalData);
            return true;
          }
        }
      }
    } catch (e) {
      console.error('[Engram] Error checking for synced data:', e);
    }
    return false;
  }

  private async applySyncUpdate(): Promise<void> {
    if (!this.settings?.enableVaultSync) return;
    const applied = await this.checkForSyncedData();
    if (applied) {
      await this.loadSettings();
      await this.loadChatSessions();
      
      const data = await this.loadData();
      if (data?.embeddings) {
        this.embeddingIndex.load(data.embeddings);
      }
      if (data?.index) {
        await this.indexer.build(data.index);
      }
      
      const leaves = this.app.workspace.getLeavesOfType(ENGRAM_VIEW_TYPE);
      for (const leaf of leaves) {
        if (leaf.view instanceof ChatView) {
          leaf.view.onSettingsUpdate();
          leaf.view.reloadActiveSession();
        }
      }
      new Notice('🔄 Engram: Settings, chat history, and semantic index synced from other device');
    }
  }

  async writeToSyncFile(timestamp: number): Promise<void> {
    if (!this.settings?.enableVaultSync) return;
    try {
      const syncPath = this.getSyncFilePath();
      
      // Ensure parent folder exists
      const lastSlash = syncPath.lastIndexOf('/');
      if (lastSlash >= 0) {
        const parentDir = syncPath.substring(0, lastSlash);
        if (!(await this.app.vault.adapter.exists(parentDir))) {
          await this.app.vault.createFolder(parentDir).catch(() => {});
        }
      }

      const syncData = {
        updatedAt: timestamp,
        settings: this.settings,
        index: this.indexer.getSerializable(),
        embeddings: this.embeddingIndex.isReady ? this.embeddingIndex.toJSON() : null,
        chatSessions: this.chatSessions,
      };
      await this.app.vault.adapter.write(syncPath, JSON.stringify(syncData));
      console.log(`[Engram] Saved sync data to vault (${syncPath})`);
    } catch (e) {
      console.error('[Engram] Failed to write sync data:', e);
    }
  }

  getSyncFilePath(): string {
    const memPath = this.settings?.memoryPath || 'Intelligence/Memory.md';
    const lastSlash = memPath.lastIndexOf('/');
    if (lastSlash >= 0) {
      const parentDir = memPath.substring(0, lastSlash);
      return `${parentDir}/.engram-sync.json`;
    }
    return '.engram-sync.json';
  }
}

