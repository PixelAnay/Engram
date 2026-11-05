import { describe, it, expect, vi } from 'vitest';
import { migrateSettings, SETTINGS_VERSION } from '../src/utils/settingsMigration';
import { DEFAULT_SETTINGS } from '../src/settings';
import { collectSelectedFacts } from '../src/ui/MemoryReviewModal';
import { MemoryExtractor } from '../src/memory/MemoryExtractor';
import { makeEnv } from './helpers';
import { parseEntries } from '../src/memory/memoryFormat';

describe('settings migration', () => {
  it('turns auto-extract off once for existing users and explains why', () => {
    const stored = { autoExtractMemory: true, model: 'x' };
    const first = migrateSettings(stored, DEFAULT_SETTINGS);
    expect(first.settings.autoExtractMemory).toBe(false);
    expect(first.settings.settingsVersion).toBe(SETTINGS_VERSION);
    expect(first.messages).toHaveLength(1);
    expect(first.changed).toBe(true);

    // The user turns it back on later; the migration must NOT run again
    const second = migrateSettings({ ...first.settings, autoExtractMemory: true }, DEFAULT_SETTINGS);
    expect(second.settings.autoExtractMemory).toBe(true);
    expect(second.messages).toHaveLength(0);
    expect(second.changed).toBe(false);
  });

  it('new installs default to off with nothing to report', () => {
    const r = migrateSettings(undefined, DEFAULT_SETTINGS);
    expect(r.settings.autoExtractMemory).toBe(false);
    expect(r.messages).toHaveLength(0);
    expect(r.settings.settingsVersion).toBe(SETTINGS_VERSION);
  });

  it('legacy embedding settings are migrated (they were hidden by defaults before)', () => {
    const r = migrateSettings({ embeddingModel: 'nomic', ollamaEmbedEndpoint: 'http://h:1' }, DEFAULT_SETTINGS);
    expect(r.settings.embedProvider).toBe('ollama');
    expect(r.settings.ollamaEmbedModel).toBe('nomic');
    expect(r.settings.ollamaEmbedUrl).toBe('http://h:1');
  });

  it('does not share default arrays between loads', () => {
    const a = migrateSettings({}, DEFAULT_SETTINGS).settings;
    a.personas.push({ id: 'z', name: 'z', systemPrompt: '' });
    expect(DEFAULT_SETTINGS.personas.some(p => p.id === 'z')).toBe(false);
  });
});

describe('review selection', () => {
  it('keeps only checked, non-empty, de-duplicated facts', () => {
    expect(collectSelectedFacts([
      { text: 'Likes tea', checked: true },
      { text: 'Hates rain', checked: false },
      { text: '  likes TEA ', checked: true },
      { text: '   ', checked: true },
      { text: 'Edited\nfact', checked: true },
    ])).toEqual(['Likes tea', 'Edited fact']);
  });
});

describe('MemoryExtractor', () => {
  const convo = [
    { role: 'user' as const, content: 'I moved to Berlin last month and I work as a nurse at the city hospital.' },
    { role: 'assistant' as const, content: 'That sounds like a big change, how are you finding Berlin so far overall?' },
  ];

  function extractorWith(env: Awaited<ReturnType<typeof makeEnv>>, reply: string, error?: string) {
    const factory: any = {
      activeSettings: { model: 'm' },
      provider: {
        stream: vi.fn(async (_m: any, _o: any, onChunk: (c: any) => void) => {
          if (error) onChunk({ type: 'error', error });
          return { text: reply, toolCalls: [], finishReason: 'stop' };
        }),
      },
    };
    return new MemoryExtractor(factory, env.mm);
  }

  it('extractCandidates returns facts and writes nothing', async () => {
    const seed = '# 💾 Stored Memories\n\n';
    const env = await makeEnv({ files: { 'Intelligence/Memory.md': seed } });
    const ex = extractorWith(env, '["The user lives in Berlin.", "The user is a nurse."]');
    const c = await ex.extractCandidates(convo);
    expect(c).toEqual(['The user lives in Berlin.', 'The user is a nurse.']);
    expect(await env.read('Intelligence/Memory.md')).toBe(seed);
  });

  it('a provider error is surfaced instead of looking like "nothing found"', async () => {
    const env = await makeEnv({ files: { 'Intelligence/Memory.md': '# 💾 Stored Memories\n\n' } });
    const ex = extractorWith(env, '', 'Provider error 401');
    await expect(ex.extractCandidates(convo)).rejects.toThrow('401');
  });

  it('extractAndSave (opt-in auto mode) still saves', async () => {
    const env = await makeEnv({ files: { 'Intelligence/Memory.md': '# 💾 Stored Memories\n\n' } });
    const ex = extractorWith(env, '["The user lives in Berlin."]');
    expect(await ex.extractAndSave(convo)).toBe(1);
    expect(parseEntries((await env.read('Intelligence/Memory.md'))!)).toHaveLength(1);
  });
});
