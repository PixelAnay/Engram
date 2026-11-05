import { describe, it, expect, beforeEach } from 'vitest';
import { Notice } from 'obsidian';
import { makeEnv, makeSettings } from './helpers';
import { ContextBuilder } from '../src/context';
import { parseEntries } from '../src/memory/memoryFormat';
import { TOOL_DEFINITIONS, TOOL_INJECTION_PROMPT } from '../src/tools';

const SEED =
  'Intro that stays.\n\n# 💾 Stored Memories\n\n' +
  '- [2025-01-01|m1] Lives in Oslo\n- [2025-01-02|m2] Likes tea\n- [2025-01-03|m3] Plays chess\n';

beforeEach(() => Notice.reset());

describe('memory tools', () => {
  it('update_memory changes exactly one line', async () => {
    const { tools, read } = await makeEnv({ files: { 'Intelligence/Memory.md': SEED } });
    const out = await tools.execute('update_memory', JSON.stringify({ id: 'm1', fact: 'Lives in Berlin' }));
    expect(out).toContain('✅');
    expect(await read('Intelligence/Memory.md')).toBe(SEED.replace('Lives in Oslo', 'Lives in Berlin'));
  });

  it('update_memory reports unknown ids without touching the file', async () => {
    const { tools, read } = await makeEnv({ files: { 'Intelligence/Memory.md': SEED } });
    const out = await tools.execute('update_memory', JSON.stringify({ id: 'zzz', fact: 'x' }));
    expect(out).toMatch(/^Error: No memory entry found/);
    expect(await read('Intelligence/Memory.md')).toBe(SEED);
  });

  it('delete_memory removes one entry; unknown id is an honest error', async () => {
    const { tools, read } = await makeEnv({ files: { 'Intelligence/Memory.md': SEED } });
    expect(await tools.execute('delete_memory', JSON.stringify({ id: 'm2' }))).toContain('✅');
    expect(await tools.execute('delete_memory', JSON.stringify({ id: 'm2' }))).toMatch(/^Error/);
    expect(parseEntries((await read('Intelligence/Memory.md'))!).map(e => e.id)).toEqual(['m1', 'm3']);
  });

  it('save_memory returns the new id and reports "queued" when the file is missing', async () => {
    const env = await makeEnv({ files: { 'Intelligence/Memory.md': SEED } });
    const saved = await env.tools.execute('save_memory', JSON.stringify({ fact: 'New fact here' }));
    expect(saved).toMatch(/id: mem_/);

    const missing = await makeEnv();
    await missing.store.update(d => { d.memoryState = { path: 'Intelligence/Memory.md', everExisted: true, lastEntryCount: 9 }; });
    const queued = await missing.tools.execute('save_memory', JSON.stringify({ fact: 'Queued fact' }));
    expect(queued).toContain('queued');
    expect(missing.app.vault.getAbstractFileByPath('Intelligence/Memory.md')).toBeNull();
  });

  it('exposes update_memory to both native and prompt-injection modes', () => {
    expect(TOOL_DEFINITIONS.some(t => t.function.name === 'update_memory')).toBe(true);
    expect(TOOL_INJECTION_PROMPT).toContain('update_memory(id, fact)');
  });
});

describe('context memory budget', () => {
  function builder(env: Awaited<ReturnType<typeof makeEnv>>, over: any = {}) {
    const settings = makeSettings({ maxMemoryTokens: 100, ...over });
    const indexer = { isReady: false } as any;
    return new ContextBuilder(env.app as any, settings, indexer, env.mm);
  }

  const bigMemory = () =>
    '# 💾 Stored Memories\n\n' +
    Array.from({ length: 60 }, (_, i) => `- [2025-01-01|e${i}] Fact number ${i} about the user and things`).join('\n') + '\n';

  it('cuts the oldest entries from the prompt but never from the file', async () => {
    const content = bigMemory();
    const env = await makeEnv({ files: { 'Intelligence/Memory.md': content } });
    const msgs = await builder(env).buildSystemMessage('hi');
    const sys = msgs[0].content as string;
    expect(sys).toContain('Fact number 59');
    expect(sys).not.toContain('Fact number 0 ');
    expect(await env.read('Intelligence/Memory.md')).toBe(content);
  });

  it('shows the truncation notice only once per session', async () => {
    const env = await makeEnv({ files: { 'Intelligence/Memory.md': bigMemory() } });
    const b = builder(env);
    await b.buildSystemMessage('one');
    await b.buildSystemMessage('two');
    await b.buildSystemMessage('three');
    expect(Notice.messages.filter(m => m.includes('token limit'))).toHaveLength(1);
  });

  it('sends everything when it fits the budget', async () => {
    const env = await makeEnv({ files: { 'Intelligence/Memory.md': SEED } });
    const msgs = await builder(env, { maxMemoryTokens: 4000 }).buildSystemMessage('hi');
    expect(msgs[0].content as string).toContain('Lives in Oslo');
    expect(Notice.messages).toHaveLength(0);
  });

  it('omits the Memory Rules section when tool calling is disabled', async () => {
    const env = await makeEnv({ files: { 'Intelligence/Memory.md': SEED } });
    const off = await builder(env, { maxMemoryTokens: 4000, toolCallingMode: 'disabled' }).buildSystemMessage('hi');
    expect(off[0].content as string).not.toContain('Memory Rules');
    const on = await builder(env, { maxMemoryTokens: 4000, toolCallingMode: 'native' }).buildSystemMessage('hi');
    expect(on[0].content as string).toContain('update_memory');
  });
});
