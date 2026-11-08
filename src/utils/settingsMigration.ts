import type { EngramSettings } from '../types';

/** Bump when a new one-time migration step is added below. */
export const SETTINGS_VERSION = 2;

export interface MigrationResult {
  settings: EngramSettings;
  /** User-facing explanations of behaviour changes. Show once. */
  messages: string[];
  /** True when the stored version was older, so the result should be saved. */
  changed: boolean;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Turn whatever is stored in data.json into current settings.
 * Legacy-format fixes run on the RAW stored values, before defaults are merged
 * in. (Merging first hid them: defaults filled the very fields they checked.)
 */
export function migrateSettings(stored: unknown, defaults: EngramSettings): MigrationResult {
  const messages: string[] = [];
  const raw: Record<string, unknown> | null =
    stored && typeof stored === 'object' ? { ...(stored as Record<string, unknown>) } : null;

  if (raw) {
    // Old LlamaPluginSettings format
    if (raw.endpoint && !raw.providerBaseUrl) raw.providerBaseUrl = raw.endpoint;

    // Old scopeMode values
    if (raw.scopeMode === 'allow') raw.scopeMode = 'allowlist';
    else if (raw.scopeMode === 'block') raw.scopeMode = 'denylist';

    // Old embedding model/endpoint settings -> provider structure
    if (!raw.embedProvider) {
      if (raw.embeddingModel) {
        raw.embedProvider = 'ollama';
        if (!raw.ollamaEmbedModel) raw.ollamaEmbedModel = raw.embeddingModel;
      } else {
        raw.embedProvider = 'none';
      }
    }
    if (raw.ollamaEmbedEndpoint && !raw.ollamaEmbedUrl) raw.ollamaEmbedUrl = raw.ollamaEmbedEndpoint;
  }

  const settings: EngramSettings = { ...clone(defaults), ...(raw ?? {}) };

  if (!Array.isArray(settings.personas) || settings.personas.length === 0) {
    settings.personas = clone(defaults.personas);
  }
  if (!settings.activePersonaId) settings.activePersonaId = 'default';
  if (!Array.isArray(settings.scopeFolders)) settings.scopeFolders = [];
  if (!Array.isArray(settings.excludePatterns)) settings.excludePatterns = clone(defaults.excludePatterns);

  // Brand-new install: nothing to migrate
  if (!raw) {
    settings.settingsVersion = SETTINGS_VERSION;
    return { settings, messages, changed: false };
  }

  const from = typeof raw.settingsVersion === 'number' ? raw.settingsVersion : 0;

  // v1: automatic memory extraction is now opt-in
  if (from < 1) {
    if (raw.autoExtractMemory === true || raw.autoExtractMemory === undefined) {
      messages.push(
        'Engram: automatic memory extraction is now off by default. ' +
        'Use /memory to review and save facts, or turn it back on in Advanced settings.'
      );
    }
    settings.autoExtractMemory = false;
  }

  // v2: one API key per provider. The old single key belongs to the provider
  // that was active when it was entered; it must not follow later provider switches.
  if (from < 2) {
    const keys: Record<string, string> = { ...(settings.providerApiKeys ?? {}) };
    const legacy = typeof raw.providerApiKey === 'string' ? raw.providerApiKey.trim() : '';
    if (legacy && !keys[settings.activeProviderId]) keys[settings.activeProviderId] = legacy;
    settings.providerApiKeys = keys;
    settings.providerApiKey = '';
  }

  settings.settingsVersion = SETTINGS_VERSION;
  return { settings, messages, changed: from < SETTINGS_VERSION };
}
