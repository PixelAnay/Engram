import { App, PluginSettingTab, Setting, Notice, TFolder } from 'obsidian';
import type { EngramSettings } from './types';
import { normalisePath } from './utils/pathUtils';
import { showPromptDialog, showConfirmDialog } from './ui/ConfirmDialog';

// ── Provider Presets ────────────────────────────────────────────────────────

export const PROVIDER_PRESETS = [
  { id: 'local_llamacpp',  label: 'Local — llama.cpp',       type: 'openai_compat', baseUrl: 'http://localhost:8080',                                       isLocal: true,  defaultModel: '' },
  { id: 'local_ollama',    label: 'Local — Ollama',           type: 'openai_compat', baseUrl: 'http://localhost:11434/v1',                                   isLocal: true,  defaultModel: 'llama3' },
  { id: 'local_lmstudio',  label: 'Local — LM Studio',        type: 'openai_compat', baseUrl: 'http://localhost:1234/v1',                                    isLocal: true,  defaultModel: '' },
  { id: 'openai',          label: 'OpenAI',                   type: 'openai_compat', baseUrl: 'https://api.openai.com/v1',                                   isLocal: false, defaultModel: 'gpt-4o-mini' },
  { id: 'anthropic',       label: 'Anthropic (Claude)',        type: 'anthropic',     baseUrl: 'https://api.anthropic.com',                                   isLocal: false, defaultModel: 'claude-3-5-sonnet-20241022' },
  { id: 'deepseek',        label: 'DeepSeek',                 type: 'openai_compat', baseUrl: 'https://api.deepseek.com',                                    isLocal: false, defaultModel: 'deepseek-chat' },
  { id: 'gemini',          label: 'Google Gemini',            type: 'openai_compat', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',    isLocal: false, defaultModel: 'gemini-1.5-flash' },
  { id: 'groq',            label: 'Groq',                     type: 'openai_compat', baseUrl: 'https://api.groq.com/openai/v1',                              isLocal: false, defaultModel: 'llama-3.1-70b-versatile' },
  { id: 'mistral',         label: 'Mistral',                  type: 'openai_compat', baseUrl: 'https://api.mistral.ai/v1',                                   isLocal: false, defaultModel: 'mistral-large-latest' },
  { id: 'xai',             label: 'xAI (Grok)',               type: 'openai_compat', baseUrl: 'https://api.x.ai/v1',                                         isLocal: false, defaultModel: 'grok-beta' },
  { id: 'openrouter',      label: 'OpenRouter ⭐',            type: 'openai_compat', baseUrl: 'https://openrouter.ai/api/v1',                                isLocal: false, defaultModel: 'google/gemini-flash-1.5' },
  { id: 'custom',          label: 'Custom...',                type: 'openai_compat', baseUrl: '',                                                             isLocal: false, defaultModel: '' },
];

// ── Default Settings ────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: EngramSettings = {
  // Active provider
  activeProviderId: 'local_llamacpp',
  providerType: 'openai_compat',
  providerBaseUrl: 'http://localhost:8080',
  providerApiKey: '',   // stored in data.json — do not sync to public git repos
  model: '',
  temperature: 0.7,

  // Persona
  activePersonaId: 'default',
  personas: [
    {
      id: 'default',
      name: 'Default',
      systemPrompt:
        "You are Engram, a personal intelligence assistant embedded in the user's Obsidian vault. " +
        "You have access to their notes, journals, and memories. You are thoughtful, direct, and deeply " +
        "familiar with who they are. You help them think, create, and grow.",
    },
    {
      id: 'deep_work',
      name: 'Deep Work',
      systemPrompt:
        "You are in Deep Work mode. Be concise, task-oriented, and eliminate all fluff. " +
        "Help the user focus. No small talk. Short answers unless depth is explicitly needed.",
    },
    {
      id: 'journaling',
      name: 'Journaling',
      systemPrompt:
        "You are in Journaling mode. Be reflective, warm, and curious. Ask follow-up questions. " +
        "Help the user process their thoughts and emotions. Be a thoughtful sounding board.",
    },
    {
      id: 'brainstorm',
      name: 'Brainstorm',
      systemPrompt:
        "You are in Brainstorm mode. Be expansive, creative, and generative. Challenge assumptions. " +
        "Play devil's advocate. Explore wild ideas. Help the user think bigger.",
    },
  ],

  // Memory
  memoryPath: 'Intelligence/Memory.md',
  memoryEnabled: true,
  maxMemoryTokens: 4000,
  autoExtractMemory: true,

  // Vault scope
  scopeMode: 'all',
  scopeFolders: [],
  editPermission: 'read_append',
  excludePatterns: ['Private/**', '*.secret.md'],

  // Context
  contextWindowTokens: 32768,
  maxRecentMessages: 20,
  autoInjectNotes: 0,
  toolCallingMode: 'native',
  maxToolCallDepth: 8,

  // Embeddings
  ollamaEmbedEndpoint: 'http://localhost:11434',
  embeddingModel: '',

  // Edit safety
  showDiffPreview: true,
  diffPreviewThreshold: 200,
  showAdvancedSettings: false,
};

// ── Settings Tab ────────────────────────────────────────────────────────────

export class EngramSettingTab extends PluginSettingTab {
  // Using `any` to avoid circular import with main.ts
  plugin: any;

  constructor(app: App, plugin: any) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Convenience: save + optional re-render trigger */
  private async save(): Promise<void> {
    await this.plugin.saveSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('engram-settings');

    new Setting(containerEl).setName('🧠 Engram').setHeading();

    const advancedSetting = new Setting(containerEl)
      .setName('Advanced settings')
      .setDesc('Reveal configuration for context size, token limits, semantic search, and diff previews')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.showAdvancedSettings ?? false)
          .onChange(async value => {
            this.plugin.settings.showAdvancedSettings = value;
            await this.save();
            applyVisibility();
          })
      );

    // ── 1. AI Provider ──────────────────────────────────────────────────────
    new Setting(containerEl).setName('🤖 AI Provider').setHeading();

    // Provider preset dropdown
    const providerSetting = new Setting(containerEl)
      .setName('Provider')
      .setDesc('Select your AI provider or endpoint');

    // Custom URL row — shown/hidden depending on selection
    const customUrlSetting = new Setting(containerEl)
      .setName('Base URL')
      .setDesc('Full base URL for the custom provider endpoint (no trailing slash)');

    // Custom API Format / Type row — shown/hidden depending on selection
    const customTypeSetting = new Setting(containerEl)
      .setName('API Format')
      .setDesc('The API format / protocol expected by the custom provider');

    // API key row — shown for non-local providers
    const apiKeySetting = new Setting(containerEl)
      .setName('API Key')
      .setDesc('⚠️ Stored in data.json — do not sync to public git repos');

    let customTypeDropdown: any = null;
    customTypeSetting.addDropdown(drop => {
      customTypeDropdown = drop;
      drop.addOption('openai_compat', 'OpenAI-compatible');
      drop.addOption('anthropic', 'Anthropic (Claude)');
      drop
        .setValue(this.plugin.settings.providerType)
        .onChange(async value => {
          this.plugin.settings.providerType = value as 'openai_compat' | 'anthropic';
          await this.save();
        });
    });

    let modelInputEl: HTMLInputElement | null = null;

    providerSetting.addDropdown(drop => {
      for (const p of PROVIDER_PRESETS) drop.addOption(p.id, p.label);
      drop
        .setValue(this.plugin.settings.activeProviderId)
        .onChange(async value => {
          this.plugin.settings.activeProviderId = value;
          const preset = PROVIDER_PRESETS.find(p => p.id === value);
          if (preset && value !== 'custom') {
            this.plugin.settings.providerType    = preset.type;
            this.plugin.settings.providerBaseUrl = preset.baseUrl;
            // Prefill model name
            if (preset.defaultModel !== undefined) {
              this.plugin.settings.model = preset.defaultModel;
              if (modelInputEl) modelInputEl.value = preset.defaultModel;
            }
          } else if (value === 'custom' && customTypeDropdown) {
            customTypeDropdown.setValue(this.plugin.settings.providerType);
          }
          applyVisibility();
          await this.save();
        });
    });

    customUrlSetting.addText(text =>
      text
        .setPlaceholder('http://localhost:8080')
        .setValue(this.plugin.settings.providerBaseUrl)
        .onChange(async value => {
          this.plugin.settings.providerBaseUrl = value.replace(/\/$/, '');
          await this.save();
        })
    );

    apiKeySetting.addText(text => {
      text
        .setPlaceholder('sk-...')
        .setValue(this.plugin.settings.providerApiKey)
        .onChange(async value => {
          this.plugin.settings.providerApiKey = value.trim();
          await this.save();
        });
      text.inputEl.type = 'password';
    });

    // Model name
    const modelSetting = new Setting(containerEl)
      .setName('Model')
      .setDesc('Model identifier to request (leave blank to auto-detect from server)')
      .addText(text => {
        modelInputEl = text.inputEl;
        text
          .setPlaceholder('auto-detect')
          .setValue(this.plugin.settings.model)
          .onChange(async value => {
            this.plugin.settings.model = value.trim();
            await this.save();
          });
      });

    // Temperature
    const tempSetting = new Setting(containerEl)
      .setName('Temperature')
      .setDesc('Sampling temperature (0 = deterministic, 1 = creative, 2 = chaotic)')
      .addText(text =>
        text
          .setPlaceholder('0.7')
          .setValue(String(this.plugin.settings.temperature))
          .onChange(async value => {
            const parsed = Number.parseFloat(value.trim());
            if (!Number.isNaN(parsed)) {
              this.plugin.settings.temperature = Math.max(0, Math.min(2, parsed));
              await this.save();
            }
          })
      );

    // Test connection button
    const testSetting = new Setting(containerEl)
      .setName('Connection test')
      .setDesc('Verify that Engram can reach the configured provider');

    let testResultEl: HTMLElement | null = null;

    testSetting.addButton(btn => {
      btn.setButtonText('Test connection').setCta().onClick(async () => {
        btn.setButtonText('Testing…').setDisabled(true);
        if (testResultEl) testResultEl.remove();
        try {
          const result = await (this.plugin as any).testConnection();
          testResultEl = testSetting.settingEl.createEl('p', {
            text: result ?? '✅ Connection successful',
            cls: 'engram-test-result engram-test-ok',
          });
        } catch (err: any) {
          testResultEl = testSetting.settingEl.createEl('p', {
            text: `❌ ${err?.message ?? 'Connection failed'}`,
            cls: 'engram-test-result engram-test-err',
          });
        } finally {
          btn.setButtonText('Test connection').setDisabled(false);
        }
      });
    });

    // ── 2. Persona ──────────────────────────────────────────────────────────
    new Setting(containerEl).setName('🧠 Persona').setHeading();

    const getActivePersona = () =>
      this.plugin.settings.personas.find(
        (p: any) => p.id === this.plugin.settings.activePersonaId
      ) ?? this.plugin.settings.personas[0];

    // Active persona dropdown
    const personaDropSetting = new Setting(containerEl)
      .setName('Active persona')
      .setDesc('Choose the personality and system prompt for Engram');

    // System prompt textarea — re-rendered when persona changes
    const promptSetting = new Setting(containerEl)
      .setName('System prompt')
      .setDesc('Edit the system prompt for the currently selected persona. Changes save automatically.');

    let promptTextArea: HTMLTextAreaElement | null = null;

    const refreshPromptArea = () => {
      const persona = getActivePersona();
      if (promptTextArea) promptTextArea.value = persona.systemPrompt;
    };

    const buildPersonaDropdown = (drop: any) => {
      drop.selectEl.innerHTML = '';
      for (const p of this.plugin.settings.personas) {
        drop.addOption(p.id, p.name);
      }
      drop
        .setValue(this.plugin.settings.activePersonaId)
        .onChange(async (value: string) => {
          this.plugin.settings.activePersonaId = value;
          await this.save();
          refreshPromptArea();
        });
    };

    let personaDrop: any = null;
    personaDropSetting.addDropdown(drop => {
      personaDrop = drop;
      buildPersonaDropdown(drop);
    });

    promptSetting.addTextArea(ta => {
      promptTextArea = ta.inputEl;
      ta.inputEl.rows = 6;
      ta.inputEl.addClass('engram-persona-prompt');
      ta
        .setValue(getActivePersona().systemPrompt)
        .onChange(async value => {
          const persona = getActivePersona();
          persona.systemPrompt = value;
          await this.save();
        });
    });

    // Persona action buttons: Save as new preset / Delete
    const personaBtnSetting = new Setting(containerEl);

    personaBtnSetting.addButton(btn =>
      btn.setButtonText('Save as new preset').onClick(async () => {
        const name = await showPromptDialog(this.app, {
          title: 'Save Persona Preset',
          message: 'Enter a name for the new persona preset:',
          placeholder: 'e.g. Code Reviewer'
        });
        if (!name || !name.trim()) return;

        const id = name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        const systemPrompt = promptTextArea?.value ?? getActivePersona().systemPrompt;
        this.plugin.settings.personas.push({ id, name: name.trim(), systemPrompt });
        this.plugin.settings.activePersonaId = id;
        await this.save();
        // Rebuild dropdown with new option selected
        buildPersonaDropdown(personaDrop);
        new Notice(`Persona "${name.trim()}" saved.`);
      })
    );

    personaBtnSetting.addButton(btn =>
      btn.setButtonText('Delete this preset').setWarning().onClick(async () => {
        const persona = getActivePersona();
        if (persona.id === 'default') {
          new Notice('Cannot delete the Default persona.');
          return;
        }

        const confirmed = await showConfirmDialog(this.app, {
          title: 'Delete Persona',
          message: `Are you sure you want to delete the persona "${persona.name}"?`,
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
          danger: true
        });
        if (!confirmed) return;

        this.plugin.settings.personas = this.plugin.settings.personas.filter(
          (p: any) => p.id !== persona.id
        );
        this.plugin.settings.activePersonaId = 'default';
        await this.save();
        buildPersonaDropdown(personaDrop);
        refreshPromptArea();
      })
    );

    // ── 3. Memory ───────────────────────────────────────────────────────────
    const memoryHeaderSetting = new Setting(containerEl).setName('💾 Memory').setHeading();

    const memoryEnabledSetting = new Setting(containerEl)
      .setName('Enable memory system')
      .setDesc('Engram maintains a persistent memory file summarising important facts about you')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.memoryEnabled)
          .onChange(async value => {
            this.plugin.settings.memoryEnabled = value;
            await this.save();
          })
      );

    const memoryPathSetting = new Setting(containerEl)
      .setName('Memory file path')
      .setDesc('Vault-relative path to the memory markdown file')
      .addText(text =>
        text
          .setPlaceholder('Intelligence/Memory.md')
          .setValue(this.plugin.settings.memoryPath)
          .onChange(async value => {
            this.plugin.settings.memoryPath = value.trim();
            await this.save();
          })
      )
      .addButton(btn =>
        btn.setButtonText('Open').setTooltip('Open memory file in Obsidian').onClick(() => {
          (this.plugin as any).openMemoryFile();
        })
      );

    const memoryAutoExtractSetting = new Setting(containerEl)
      .setName('Auto-extract memories')
      .setDesc('Automatically extract and save memorable facts at the end of each conversation')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.autoExtractMemory)
          .onChange(async value => {
            this.plugin.settings.autoExtractMemory = value;
            await this.save();
          })
      );

    const memoryMaxTokensSetting = new Setting(containerEl)
      .setName('Max memory tokens')
      .setDesc('Maximum token budget reserved for injecting memory context')
      .addText(text =>
        text
          .setPlaceholder('4000')
          .setValue(String(this.plugin.settings.maxMemoryTokens))
          .onChange(async value => {
            const parsed = Number.parseInt(value.trim(), 10);
            if (!Number.isNaN(parsed)) {
              this.plugin.settings.maxMemoryTokens = Math.max(100, parsed);
              await this.save();
            }
          })
      );

    const memoryClearSetting = new Setting(containerEl)
      .setName('Clear all memory')
      .setDesc('Permanently erase all stored memories — this cannot be undone')
      .addButton(btn =>
        btn
          .setButtonText('Clear all memory')
          .setWarning()
          .onClick(async () => {
            if (!confirm('Clear ALL memories? This cannot be undone.')) return;
            try {
              const vault = this.app.vault;
              const file  = vault.getAbstractFileByPath(this.plugin.settings.memoryPath);
              if (file) await vault.modify(file as any, '');
              new Notice('Memory cleared.');
            } catch {
              new Notice('Could not clear memory file.');
            }
          })
      );

    // ── 4. Vault Access ─────────────────────────────────────────────────────
    new Setting(containerEl).setName('🔒 Vault Access').setHeading();

    // Scope mode dropdown
    const scopeSetting = new Setting(containerEl)
      .setName('Knowledge scope')
      .setDesc('Which folders Engram is allowed to read');

    // Container for the structured folder selection UI
    const folderSelectorContainer = containerEl.createDiv({ cls: 'engram-folder-list-container' });

    const applyScopeVisibility = () => {
      const isAll = this.plugin.settings.scopeMode === 'all';
      folderSelectorContainer.style.display = isAll ? 'none' : 'flex';
    };

    scopeSetting.addDropdown(drop =>
      drop
        .addOption('all',       'All folders')
        .addOption('allowlist', 'Allow these folders only')
        .addOption('denylist',  'Block these folders')
        .setValue(this.plugin.settings.scopeMode)
        .onChange(async value => {
          this.plugin.settings.scopeMode = value as EngramSettings['scopeMode'];
          applyScopeVisibility();
          await this.save();
          renderFolderSelector();
        })
    );

    const renderFolderSelector = () => {
      folderSelectorContainer.empty();

      // Description label
      folderSelectorContainer.createEl('div', {
        text: this.plugin.settings.scopeMode === 'allowlist'
          ? 'Select folders to ALLOW access to (and their subfolders):'
          : 'Select folders to BLOCK access to (and their subfolders):',
        cls: 'setting-item-description'
      });

      // Search bar
      const searchContainer = folderSelectorContainer.createDiv({ cls: 'engram-folder-search-container' });
      const searchInput = searchContainer.createEl('input', {
        type: 'text',
        placeholder: 'Search folders...',
        cls: 'engram-folder-search'
      });

      const stopProp = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') {
          e.stopPropagation();
        }
      };
      searchInput.addEventListener('keydown', stopProp);
      searchInput.addEventListener('keypress', stopProp);
      searchInput.addEventListener('keyup', stopProp);

      // Scroll box
      const scrollBox = folderSelectorContainer.createDiv({ cls: 'engram-folder-scrollbox' });

      // Gather folders
      const folders = this.app.vault.getAllLoadedFiles()
        .filter((f): f is TFolder => f instanceof TFolder)
        .filter(f => f.path !== '/' && f.path !== '');

      folders.sort((a, b) => a.path.localeCompare(b.path));

      const renderList = (filterText: string = '') => {
        scrollBox.empty();

        const query = filterText.toLowerCase().trim();
        const filteredFolders = folders.filter(f => f.path.toLowerCase().includes(query));

        if (filteredFolders.length === 0) {
          scrollBox.createDiv({ text: 'No folders found', cls: 'engram-no-folders-msg' });
          return;
        }

        for (const folder of filteredFolders) {
          const path = folder.path;
          const segments = path.split('/');
          const name = segments[segments.length - 1];
          const depth = segments.length - 1;

          // Check explicit and inherited status
          const isExplicit = this.plugin.settings.scopeFolders.includes(path);
          const isInherited = this.plugin.settings.scopeFolders.some((sf: string) =>
            path.startsWith(sf + '/')
          );

          const itemEl = scrollBox.createDiv({
            cls: 'engram-folder-item' + (isInherited ? ' is-inherited' : '')
          });

          // Indentation spacer
          for (let d = 0; d < depth; d++) {
            itemEl.createDiv({ cls: 'engram-folder-indent' });
          }

          // Checkbox
          const checkbox = itemEl.createEl('input', {
            type: 'checkbox',
            cls: 'engram-folder-checkbox'
          });
          checkbox.checked = isExplicit || isInherited;

          if (isInherited) {
            checkbox.disabled = true;
          }

          // Icon and label
          itemEl.createEl('span', { text: '📁 ', cls: 'engram-folder-icon' });
          const nameEl = itemEl.createEl('span', { text: name, cls: 'engram-folder-name' });
          nameEl.title = path;

          // Inherited badge
          if (isInherited) {
            itemEl.createEl('span', { text: 'Inherited', cls: 'engram-folder-badge' });
          }

          // Toggle event
          if (!isInherited) {
            const toggleFolder = async () => {
              const checked = checkbox.checked;
              if (checked) {
                // User checked it -> add to list
                if (!this.plugin.settings.scopeFolders.includes(path)) {
                  this.plugin.settings.scopeFolders.push(path);
                }
              } else {
                // User unchecked it -> remove from list
                this.plugin.settings.scopeFolders = this.plugin.settings.scopeFolders.filter((sf: string) => sf !== path);
              }
              await this.save();
              renderFolderSelector(); // Re-render to cascade states
            };

            checkbox.addEventListener('change', async (e) => {
              e.stopPropagation();
              await toggleFolder();
            });

            itemEl.style.cursor = 'pointer';
            itemEl.addEventListener('click', async (e) => {
              if (e.target !== checkbox) {
                checkbox.checked = !checkbox.checked;
                await toggleFolder();
              }
            });
          }
        }
      };

      searchInput.addEventListener('input', () => {
        renderList(searchInput.value);
      });

      renderList();
    };

    renderFolderSelector();
    applyScopeVisibility();

    // Edit permission level
    new Setting(containerEl)
      .setName('Edit permission level')
      .setDesc('Controls what Engram is allowed to do in your vault')
      .addDropdown(drop =>
        drop
          .addOption('read_only',   '🔍 Read only — search & read notes')
          .addOption('read_append', '✏️ Read + Append — add content to notes')
          .addOption('full_edit',   '⚠️ Full edit — create, modify, overwrite')
          .setValue(this.plugin.settings.editPermission)
          .onChange(async value => {
            this.plugin.settings.editPermission = value as EngramSettings['editPermission'];
            await this.save();
          })
      );

    // Exclude patterns
    const excludePatternsSetting = new Setting(containerEl)
      .setName('Exclude patterns')
      .setDesc('Glob patterns for notes/folders hidden from Engram (comma-separated)')
      .addTextArea(text =>
        text
          .setPlaceholder('Private/**, Diary/**, *.secret.md')
          .setValue(this.plugin.settings.excludePatterns.join(', '))
          .onChange(async value => {
            this.plugin.settings.excludePatterns = value
              .split(',')
              .map(p => p.trim())
              .filter(Boolean);
            await this.save();
          })
      );

    // Show diff preview toggle
    const diffPreviewSetting = new Setting(containerEl)
      .setName('Show diff preview before edits')
      .setDesc('Display a change preview in chat before any vault modification is applied')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.showDiffPreview)
          .onChange(async value => {
            this.plugin.settings.showDiffPreview = value;
            applyVisibility();
            await this.save();
          })
      );

    // Diff preview threshold input
    const diffThresholdSetting = new Setting(containerEl)
      .setName('Diff preview threshold (chars)')
      .setDesc('Only show diff preview when the edit changes more than this many characters')
      .addText(text =>
        text
          .setPlaceholder('200')
          .setValue(String(this.plugin.settings.diffPreviewThreshold))
          .onChange(async value => {
            const parsed = Number.parseInt(value.trim(), 10);
            if (!Number.isNaN(parsed)) {
              this.plugin.settings.diffPreviewThreshold = Math.max(0, parsed);
              await this.save();
            }
          })
      );

    // ── 5. Context & Performance ────────────────────────────────────────────
    const contextHeaderSetting = new Setting(containerEl).setName('💬 Context & Performance').setHeading();

    const contextWindowSetting = new Setting(containerEl)
      .setName('Context window (tokens)')
      .setDesc("Max tokens allocated to context. Match your model's native context size.")
      .addText(text =>
        text
          .setPlaceholder('32768')
          .setValue(String(this.plugin.settings.contextWindowTokens))
          .onChange(async value => {
            const parsed = Number.parseInt(value.trim(), 10);
            if (!Number.isNaN(parsed)) {
              this.plugin.settings.contextWindowTokens = Math.max(512, parsed);
              await this.save();
            }
          })
      );

    const maxRecentMessagesSetting = new Setting(containerEl)
      .setName('Max recent messages in context')
      .setDesc('How many of the most recent chat turns to include in each request')
      .addText(text =>
        text
          .setPlaceholder('20')
          .setValue(String(this.plugin.settings.maxRecentMessages))
          .onChange(async value => {
            const parsed = Number.parseInt(value.trim(), 10);
            if (!Number.isNaN(parsed)) {
              this.plugin.settings.maxRecentMessages = Math.max(1, parsed);
              await this.save();
            }
          })
      );

    const autoInjectNotesSetting = new Setting(containerEl)
      .setName('Auto-inject notes count')
      .setDesc('Top-ranked notes auto-injected into each message (0 recommended for cloud APIs)')
      .addText(text =>
        text
          .setPlaceholder('0')
          .setValue(String(this.plugin.settings.autoInjectNotes))
          .onChange(async value => {
            const parsed = Number.parseInt(value.trim(), 10);
            if (Number.isNaN(parsed)) return;
            this.plugin.settings.autoInjectNotes = Math.max(0, parsed);
            await this.save();
          })
      );

    const toolCallingSetting = new Setting(containerEl)
      .setName('Tool calling mode')
      .setDesc(
        'Native: OpenAI-style function calling (requires a compatible model). ' +
        'Prompt injection: works with any model. Disabled: no vault tools.'
      )
      .addDropdown(drop =>
        drop
          .addOption('native',           '⚡ Native function calling')
          .addOption('prompt_injection',  '📝 Prompt injection (universal)')
          .addOption('disabled',         '🚫 Disabled')
          .setValue(this.plugin.settings.toolCallingMode)
          .onChange(async value => {
            this.plugin.settings.toolCallingMode = value as EngramSettings['toolCallingMode'];
            await this.save();
          })
      );

    const toolCallDepthSetting = new Setting(containerEl)
      .setName('Max tool call depth')
      .setDesc('Maximum consecutive tool calls per turn (prevents infinite loops)')
      .addText(text =>
        text
          .setPlaceholder('8')
          .setValue(String(this.plugin.settings.maxToolCallDepth))
          .onChange(async value => {
            const parsed = Number.parseInt(value.trim(), 10);
            if (!Number.isNaN(parsed)) {
              this.plugin.settings.maxToolCallDepth = Math.max(1, parsed);
              await this.save();
            }
          })
      );

    // ── 6. Semantic Search ──────────────────────────────────────────────────
    const semanticHeaderSetting = new Setting(containerEl).setName('🔍 Semantic Search (optional)').setHeading();

    const semanticDescEl = containerEl.createEl('p', {
      text:
        'When configured, notes are embedded using Ollama and vector similarity search replaces ' +
        'keyword-only ranking — scaling gracefully to 500+ note vaults. Requires Ollama running ' +
        "locally with a text-embedding model (e.g. 'nomic-embed-text'). Leave the model blank to disable.",
      cls: 'engram-section-desc',
    });

    const ollamaEmbedUrlSetting = new Setting(containerEl)
      .setName('Ollama embeddings URL')
      .setDesc('Base URL of your Ollama instance')
      .addText(text =>
        text
          .setPlaceholder('http://localhost:11434')
          .setValue(this.plugin.settings.ollamaEmbedEndpoint)
          .onChange(async value => {
            this.plugin.settings.ollamaEmbedEndpoint =
              value.replace(/\/$/, '') || 'http://localhost:11434';
            await this.save();
            if (this.plugin.embeddingIndex?.updateSettings) {
              this.plugin.embeddingIndex.updateSettings(this.plugin.settings);
            }
          })
      );

    const embeddingModelSetting = new Setting(containerEl)
      .setName('Embedding model')
      .setDesc('Ollama model name for embeddings (leave blank to disable). e.g. nomic-embed-text')
      .addText(text =>
        text
          .setPlaceholder('nomic-embed-text')
          .setValue(this.plugin.settings.embeddingModel)
          .onChange(async value => {
            this.plugin.settings.embeddingModel = value.trim();
            await this.save();
            if (this.plugin.embeddingIndex?.updateSettings) {
              this.plugin.embeddingIndex.updateSettings(this.plugin.settings);
            }
          })
      );

    // ── Unified Visibility Handler ───────────────────────────────────────────
    const applyVisibility = () => {
      const advanced = this.plugin.settings.showAdvancedSettings ?? false;
      const activeProviderId = this.plugin.settings.activeProviderId;
      const preset = PROVIDER_PRESETS.find(p => p.id === activeProviderId);
      const isCustom = activeProviderId === 'custom';
      const isLocal = preset?.isLocal ?? false;

      // 1. AI Provider
      customUrlSetting.settingEl.style.display = isCustom ? '' : 'none';
      customTypeSetting.settingEl.style.display = isCustom ? '' : 'none';
      apiKeySetting.settingEl.style.display = (!isLocal || isCustom) ? '' : 'none';
      
      // Model input is shown if:
      // - advanced is true
      // - OR it's not local_llamacpp and not local_lmstudio (Ollama and Cloud models need model config)
      const needsModel = activeProviderId !== 'local_llamacpp' && activeProviderId !== 'local_lmstudio';
      modelSetting.settingEl.style.display = (advanced || needsModel) ? '' : 'none';
      
      // Temperature is advanced
      tempSetting.settingEl.style.display = advanced ? '' : 'none';

      // 3. Memory
      memoryAutoExtractSetting.settingEl.style.display = advanced ? '' : 'none';
      memoryMaxTokensSetting.settingEl.style.display = advanced ? '' : 'none';
      memoryClearSetting.settingEl.style.display = advanced ? '' : 'none';

      // 4. Vault Access
      excludePatternsSetting.settingEl.style.display = advanced ? '' : 'none';
      diffPreviewSetting.settingEl.style.display = advanced ? '' : 'none';
      diffThresholdSetting.settingEl.style.display = (advanced && this.plugin.settings.showDiffPreview) ? '' : 'none';

      // 5. Context & Performance
      contextHeaderSetting.settingEl.style.display = advanced ? '' : 'none';
      contextWindowSetting.settingEl.style.display = advanced ? '' : 'none';
      maxRecentMessagesSetting.settingEl.style.display = advanced ? '' : 'none';
      autoInjectNotesSetting.settingEl.style.display = advanced ? '' : 'none';
      toolCallingSetting.settingEl.style.display = advanced ? '' : 'none';
      toolCallDepthSetting.settingEl.style.display = advanced ? '' : 'none';

      // 6. Semantic Search
      semanticHeaderSetting.settingEl.style.display = advanced ? '' : 'none';
      semanticDescEl.style.display = advanced ? '' : 'none';
      ollamaEmbedUrlSetting.settingEl.style.display = advanced ? '' : 'none';
      embeddingModelSetting.settingEl.style.display = advanced ? '' : 'none';
    };

    applyVisibility();
  }
}
