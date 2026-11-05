import { describe, it, expect } from 'vitest';
import {
  parseEntries, addEntries, updateEntry, removeEntry, removeAllEntries,
  verifyOnlyTargetChanged, normalizeFact, buildTemplate, MAX_FACT_LENGTH,
} from '../src/memory/memoryFormat';

const DOC = [
  '---',
  'tags: [personal]',
  '---',
  '',
  'My own intro paragraph. Do not touch.',
  '',
  '# 💾 Stored Memories',
  '',
  '- [2025-01-01|mem_a] Likes tea',
  '- [2025-01-02|mem_b] Lives in Oslo',
  '',
  '## My notes',
  'Free text under another heading.',
  '',
].join('\n');

const fixedId = (() => { let n = 0; return () => `id${++n}`; })();

describe('parseEntries', () => {
  it('finds entries with line ranges', () => {
    const e = parseEntries(DOC);
    expect(e.map(x => x.id)).toEqual(['mem_a', 'mem_b']);
    expect(e[0]).toMatchObject({ date: '2025-01-01', fact: 'Likes tea', startLine: 8, endLine: 8 });
  });
  it('treats indented continuation lines as part of the entry', () => {
    const t = '- [2025-01-01|m1] first\n  second line\n  third\n- [2025-01-02|m2] other\n';
    const e = parseEntries(t);
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ fact: 'first\nsecond line\nthird', startLine: 0, endLine: 2 });
  });
});

describe('addEntries', () => {
  it('inserts after the last entry and preserves everything else', () => {
    const r = addEntries(DOC, ['Plays chess'], '2025-02-01', fixedId);
    const lines = r.text.split('\n');
    expect(lines[10]).toMatch(/^- \[2025-02-01\|id\d+\] Plays chess$/);
    expect(r.text.replace(lines[10] + '\n', '')).toBe(DOC);
    expect(verifyOnlyTargetChanged(DOC, r.text, { type: 'add', count: 1 })).toBe(true);
  });

  it('inserts after the heading when there are no entries', () => {
    const doc = 'Intro\n\n# 💾 Stored Memories\n\nTrailing note\n';
    const r = addEntries(doc, ['A fact'], '2025-02-01', fixedId);
    expect(r.text).toContain('Intro\n\n# 💾 Stored Memories\n\n- [2025-02-01|');
    expect(r.text).toContain('\nTrailing note\n');
    expect(verifyOnlyTargetChanged(doc, r.text, { type: 'add', count: 1 })).toBe(true);
  });

  it('appends the heading when the file has none', () => {
    const doc = 'Only my own text';
    const r = addEntries(doc, ['A fact'], '2025-02-01', fixedId);
    expect(r.text.startsWith('Only my own text\n\n# 💾 Stored Memories\n\n- [2025-02-01|')).toBe(true);
    expect(verifyOnlyTargetChanged(doc, r.text, { type: 'add', count: 1 })).toBe(true);
  });

  it('works on an empty file and on the template', () => {
    expect(addEntries('', ['x y'], '2025-02-01', fixedId).text).toContain('# 💾 Stored Memories');
    const r = addEntries(buildTemplate(), ['x y'], '2025-02-01', fixedId);
    expect(parseEntries(r.text)).toHaveLength(1);
  });

  it('generates unique ids even if the generator repeats', () => {
    const r = addEntries(DOC, ['one', 'two', 'three'], '2025-02-01', () => 'same');
    const ids = parseEntries(r.text).map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(5);
  });

  it('normalizes facts to one capped line and skips empty ones', () => {
    expect(normalizeFact('a\n b\r\nc')).toBe('a b c');
    expect(normalizeFact('x'.repeat(900))).toHaveLength(MAX_FACT_LENGTH);
    const r = addEntries(DOC, ['   ', '\n'], '2025-02-01', fixedId);
    expect(r.text).toBe(DOC);
    expect(r.added).toHaveLength(0);
  });

  it('keeps CRLF line endings', () => {
    const crlf = DOC.replace(/\n/g, '\r\n');
    const r = addEntries(crlf, ['Fact'], '2025-02-01', fixedId);
    expect(r.text.includes('\r\n')).toBe(true);
    expect(/[^\r]\n/.test(r.text)).toBe(false);
  });
});

describe('updateEntry', () => {
  it('replaces only the targeted entry', () => {
    const out = updateEntry(DOC, 'mem_b', 'Lives in Berlin')!;
    expect(out).toBe(DOC.replace('Lives in Oslo', 'Lives in Berlin'));
    expect(verifyOnlyTargetChanged(DOC, out, { type: 'update', id: 'mem_b' })).toBe(true);
  });
  it('collapses an old multi-line entry into one line', () => {
    const t = 'x\n- [2025-01-01|m1] first\n  second\ny\n';
    expect(updateEntry(t, 'm1', 'new')).toBe('x\n- [2025-01-01|m1] new\ny\n');
  });
  it('returns null for an unknown id', () => {
    expect(updateEntry(DOC, 'nope', 'x')).toBeNull();
  });
});

describe('removeEntry', () => {
  it('removes only the targeted entry', () => {
    const out = removeEntry(DOC, 'mem_a')!;
    expect(out).toBe(DOC.replace('- [2025-01-01|mem_a] Likes tea\n', ''));
    expect(verifyOnlyTargetChanged(DOC, out, { type: 'remove', id: 'mem_a' })).toBe(true);
  });
  it('removes a multi-line entry as a whole', () => {
    const t = '- [2025-01-01|m1] first\n  second\n- [2025-01-02|m2] other\n';
    expect(removeEntry(t, 'm1')).toBe('- [2025-01-02|m2] other\n');
  });
  it('removing the last entry leaves the rest as-is', () => {
    const one = removeEntry(DOC, 'mem_a')!;
    const none = removeEntry(one, 'mem_b')!;
    expect(parseEntries(none)).toHaveLength(0);
    expect(none).toContain('My own intro paragraph. Do not touch.');
    expect(none).toContain('# 💾 Stored Memories');
    expect(none).toContain('Free text under another heading.');
  });
  it('returns null for an unknown id', () => {
    expect(removeEntry(DOC, 'nope')).toBeNull();
  });
});

describe('removeAllEntries', () => {
  it('leaves non-entry text', () => {
    const out = removeAllEntries(DOC);
    expect(parseEntries(out)).toHaveLength(0);
    expect(out).toContain('My own intro paragraph. Do not touch.');
    expect(out).toContain('Free text under another heading.');
    expect(verifyOnlyTargetChanged(DOC, out, { type: 'clear' })).toBe(true);
  });
});

describe('verifyOnlyTargetChanged', () => {
  it('rejects a rewritten file', () => {
    const rebuilt = '# 💾 Stored Memories\n\n- [2025-01-01|mem_a] Likes tea\n';
    expect(verifyOnlyTargetChanged(DOC, rebuilt, { type: 'add', count: 0 })).toBe(false);
  });
  it('rejects an edit to a non-target line', () => {
    const out = DOC.replace('Do not touch', 'Touched');
    expect(verifyOnlyTargetChanged(DOC, out, { type: 'update', id: 'mem_a' })).toBe(false);
  });
  it('rejects an update that also changes another entry', () => {
    const out = updateEntry(DOC, 'mem_a', 'New')!.replace('Oslo', 'Rome');
    expect(verifyOnlyTargetChanged(DOC, out, { type: 'update', id: 'mem_a' })).toBe(false);
  });
  it('rejects a remove that deleted extra lines', () => {
    const out = removeEntry(DOC, 'mem_a')!.replace('Free text under another heading.\n', '');
    expect(verifyOnlyTargetChanged(DOC, out, { type: 'remove', id: 'mem_a' })).toBe(false);
  });
  it('rejects an add with the wrong entry count', () => {
    const r = addEntries(DOC, ['one', 'two'], '2025-02-01', fixedId);
    expect(verifyOnlyTargetChanged(DOC, r.text, { type: 'add', count: 1 })).toBe(false);
  });
  it('rejects an unknown target', () => {
    expect(verifyOnlyTargetChanged(DOC, DOC, { type: 'remove', id: 'missing' })).toBe(false);
  });
});
