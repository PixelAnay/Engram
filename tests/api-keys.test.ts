import { describe, it, expect } from 'vitest';
import { migrateSettings, SETTINGS_VERSION } from '../src/utils/settingsMigration';
import { getProviderApiKey, setProviderApiKey, resolveOpenAIEmbedKey } from '../src/utils/apiKeys';
import { providerSignature } from '../src/utils/settingsSignature';
import { ProviderFactory } from '../src/providers/ProviderFactory';
import { DEFAULT_SETTINGS } from '../src/settings';
import { makeSettings } from './helpers';

describe('API key migration', () => {
  it('moves the single legacy key to the provider that was active', () => {
    const r = migrateSettings(
      { settingsVersion: 1, activeProviderId: 'openai', providerApiKey: 'sk-openai' },
      DEFAULT_SETTINGS
    );
    expect(r.settings.providerApiKeys).toEqual({ openai: 'sk-openai' });
    expect(r.settings.providerApiKey).toBe('');
    expect(r.settings.settingsVersion).toBe(SETTINGS_VERSION);
    expect(r.changed).toBe(true);
  });

  it('runs once: a second load changes nothing', () => {
    const first = migrateSettings({ activeProviderId: 'openai', providerApiKey: 'sk-1' }, DEFAULT_SETTINGS);
    const second = migrateSettings(first.settings, DEFAULT_SETTINGS);
    expect(second.changed).toBe(false);
    expect(second.settings.providerApiKeys).toEqual({ openai: 'sk-1' });
  });

  it('does not overwrite a per-provider key that already exists', () => {
    const r = migrateSettings(
      { settingsVersion: 1, activeProviderId: 'openai', providerApiKey: 'old', providerApiKeys: { openai: 'new' } },
      DEFAULT_SETTINGS
    );
    expect(r.settings.providerApiKeys).toEqual({ openai: 'new' });
  });

  it('handles an install with no key at all', () => {
    const r = migrateSettings({ settingsVersion: 1 }, DEFAULT_SETTINGS);
    expect(r.settings.providerApiKeys).toEqual({});
  });
});

describe('per-provider keys', () => {
  it('switching to another preset shows an empty key, switching back restores the first', () => {
    const s = makeSettings({ activeProviderId: 'openai' });
    setProviderApiKey(s, 'sk-openai');
    expect(getProviderApiKey(s)).toBe('sk-openai');

    s.activeProviderId = 'openrouter';
    expect(getProviderApiKey(s)).toBe('');          // what the settings field displays
    setProviderApiKey(s, 'sk-or-123');

    s.activeProviderId = 'openai';
    expect(getProviderApiKey(s)).toBe('sk-openai');
    expect(s.providerApiKeys).toEqual({ openai: 'sk-openai', openrouter: 'sk-or-123' });
  });

  it('the provider only ever receives its own key', () => {
    const s = makeSettings({ activeProviderId: 'openai', providerType: 'openai_compat', providerBaseUrl: 'https://api.openai.com/v1' });
    setProviderApiKey(s, 'sk-openai');
    const factory = new ProviderFactory(s);
    expect((factory.provider as any).apiKey).toBe('sk-openai');

    // switch to a provider without a key: nothing is carried over
    s.activeProviderId = 'deepseek';
    s.providerBaseUrl = 'https://api.deepseek.com';
    factory.updateSettings(s);
    expect((factory.provider as any).apiKey).toBe('');
  });

  it('a key change counts as a provider change (connection is re-checked)', () => {
    const a = makeSettings({ activeProviderId: 'openai' });
    const b = makeSettings({ activeProviderId: 'openai' });
    setProviderApiKey(b, 'sk-x');
    expect(providerSignature(a)).not.toBe(providerSignature(b));
  });
});

describe('OpenAI embeddings key', () => {
  it('prefers the dedicated embeddings key', () => {
    const s = makeSettings({ activeProviderId: 'anthropic', openaiEmbedApiKey: 'sk-embed' });
    setProviderApiKey(s, 'sk-ant');
    expect(resolveOpenAIEmbedKey(s)).toBe('sk-embed');
  });

  it('reuses the main key only when OpenAI is the active provider', () => {
    const s = makeSettings({ activeProviderId: 'openai', openaiEmbedApiKey: '' });
    setProviderApiKey(s, 'sk-openai');
    expect(resolveOpenAIEmbedKey(s)).toBe('sk-openai');
  });

  it('never sends another provider\'s key to OpenAI', () => {
    const s = makeSettings({ activeProviderId: 'anthropic', openaiEmbedApiKey: '' });
    setProviderApiKey(s, 'sk-ant-secret');
    expect(resolveOpenAIEmbedKey(s)).toBe('');
  });
});
