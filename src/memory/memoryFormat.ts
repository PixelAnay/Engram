/**
 * memory/memoryFormat.ts
 *
 * Pure, line-level operations on the memory file text. No Obsidian imports.
 *
 * Contract: every operation touches ONLY the lines it is asked to touch.
 * Headings, free text, frontmatter, blank lines and user formatting are
 * returned byte-for-byte unchanged. The file is never rebuilt from parsed data.
 */

export interface ParsedEntry {
  id: string;
  date: string;
  fact: string;
  /** 0-based index of the first line of the entry */
  startLine: number;
  /** 0-based index of the last line of the entry (inclusive) */
  endLine: number;
}

export type MemoryOp =
  | { type: 'add'; count: number }
  | { type: 'update'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'clear' };

export const MEMORY_HEADING = '# 💾 Stored Memories';
export const MAX_FACT_LENGTH = 500;

const ENTRY_RE = /^(\s*)-\s+\[(\d{4}-\d{2}-\d{2})\|([^\]]+)\]\s+(.+)$/;
const HEADING_RE = /^#{1,6}\s+(?:💾\s*)?Stored Memories\s*$/;

// ── helpers ─────────────────────────────────────────────────────────────────

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Collapse a fact to one trimmed line and cap its length. Returns '' if empty. */
export function normalizeFact(fact: string): string {
  return String(fact ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim()
    .slice(0, MAX_FACT_LENGTH)
    .trim();
}

export function generateMemoryId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function formatEntry(date: string, id: string, fact: string, indent = ''): string {
  return `${indent}- [${date}|${id}] ${fact}`;
}

// ── parsing ─────────────────────────────────────────────────────────────────

function parseLines(lines: string[]): Array<ParsedEntry & { indent: string }> {
  const entries: Array<ParsedEntry & { indent: string }> = [];
  let current: (ParsedEntry & { indent: string }) | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = ENTRY_RE.exec(line);
    if (m) {
      current = {
        indent: m[1],
        date: m[2],
        id: m[3],
        fact: m[4].trim(),
        startLine: i,
        endLine: i,
      };
      entries.push(current);
      continue;
    }
    // Old multi-line format: continuation lines are indented by 2+ spaces
    if (current && /^ {2,}\S/.test(line) && current.endLine === i - 1) {
      current.fact += '\n' + line.trim();
      current.endLine = i;
      continue;
    }
    current = null;
  }
  return entries;
}

export function parseEntries(text: string): ParsedEntry[] {
  return parseLines(splitLines(text)).map(({ indent: _i, ...e }) => e);
}

// ── operations ──────────────────────────────────────────────────────────────

/**
 * Insert new entries. They go directly after the last existing entry; if there
 * are none, after the "Stored Memories" heading; otherwise at the end of the
 * file under a freshly appended heading.
 */
export function addEntries(
  text: string,
  facts: string[],
  date: string,
  idGen: () => string = generateMemoryId
): { text: string; added: Array<{ id: string; fact: string }> } {
  const eol = detectEol(text);
  const lines = splitLines(text);
  const existingIds = new Set(parseLines(lines).map(e => e.id));

  const added: Array<{ id: string; fact: string }> = [];
  for (const raw of facts) {
    const fact = normalizeFact(raw);
    if (!fact) continue;
    let id = idGen();
    let guard = 0;
    while (existingIds.has(id)) id = `${idGen()}${guard++}`;
    existingIds.add(id);
    added.push({ id, fact });
  }
  if (added.length === 0) return { text, added };

  const newLines = added.map(a => formatEntry(date, a.id, a.fact));
  const entries = parseLines(lines);

  if (entries.length > 0) {
    const at = entries[entries.length - 1].endLine + 1;
    lines.splice(at, 0, ...newLines);
    return { text: lines.join(eol), added };
  }

  const headingIdx = lines.findIndex(l => HEADING_RE.test(l));
  if (headingIdx !== -1) {
    const afterHeading = headingIdx + 1;
    if (afterHeading < lines.length && lines[afterHeading].trim() === '') {
      // heading, blank, <entries>
      lines.splice(afterHeading + 1, 0, ...newLines);
    } else {
      lines.splice(afterHeading, 0, '', ...newLines);
    }
    return { text: lines.join(eol), added };
  }

  // No heading anywhere: append heading + entries after the existing content
  let base = text;
  if (base.length > 0 && !base.endsWith('\n')) base += eol;
  if (base.length > 0) base += eol;
  const body = [MEMORY_HEADING, '', ...newLines].join(eol) + eol;
  return { text: base + body, added };
}

/** Replace the text of one entry (all of its lines) with a single new line. */
export function updateEntry(text: string, id: string, fact: string): string | null {
  const normalized = normalizeFact(fact);
  if (!normalized) return null;
  const eol = detectEol(text);
  const lines = splitLines(text);
  const entry = parseLines(lines).find(e => e.id === id);
  if (!entry) return null;
  lines.splice(
    entry.startLine,
    entry.endLine - entry.startLine + 1,
    formatEntry(entry.date, entry.id, normalized, entry.indent)
  );
  return lines.join(eol);
}

/** Remove one entry (all of its lines). Returns null if the id is unknown. */
export function removeEntry(text: string, id: string): string | null {
  const eol = detectEol(text);
  const lines = splitLines(text);
  const entry = parseLines(lines).find(e => e.id === id);
  if (!entry) return null;
  lines.splice(entry.startLine, entry.endLine - entry.startLine + 1);
  return lines.join(eol);
}

/** Remove every entry line; all other text stays. */
export function removeAllEntries(text: string): string {
  const eol = detectEol(text);
  const lines = splitLines(text);
  const entries = parseLines(lines);
  for (let i = entries.length - 1; i >= 0; i--) {
    lines.splice(entries[i].startLine, entries[i].endLine - entries[i].startLine + 1);
  }
  return lines.join(eol);
}

// ── invariant ───────────────────────────────────────────────────────────────

/**
 * Check that going from `oldText` to `newText` changed only what `op` allows:
 *  - every old line outside the target entries still appears, unchanged and in order;
 *  - the only additional lines are the ones the operation is entitled to add.
 */
export function verifyOnlyTargetChanged(oldText: string, newText: string, op: MemoryOp): boolean {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const oldEntries = parseLines(oldLines);

  const targetRanges = oldEntries.filter(e => {
    if (op.type === 'add') return false;
    if (op.type === 'clear') return true;
    return e.id === op.id;
  });
  if ((op.type === 'update' || op.type === 'remove') && targetRanges.length === 0) return false;

  const targetIdx = new Set<number>();
  // Only the first entry with a given id is the target
  const ranges = op.type === 'clear' ? targetRanges : targetRanges.slice(0, 1);
  for (const r of ranges) for (let i = r.startLine; i <= r.endLine; i++) targetIdx.add(i);
  const kept = oldLines.filter((_, i) => !targetIdx.has(i));

  // kept must be an ordered subsequence of newLines
  const unmatched: string[] = [];
  let k = 0;
  for (const line of newLines) {
    if (k < kept.length && line === kept[k]) k++;
    else unmatched.push(line);
  }
  if (k !== kept.length) return false;

  switch (op.type) {
    case 'remove':
    case 'clear':
      return unmatched.length === 0;
    case 'update': {
      if (unmatched.length !== 1) return false;
      const m = ENTRY_RE.exec(unmatched[0]);
      return !!m && m[3] === op.id;
    }
    case 'add': {
      let entryLines = 0;
      for (const line of unmatched) {
        if (ENTRY_RE.test(line)) entryLines++;
        else if (line.trim() === '' || HEADING_RE.test(line)) continue;
        else return false;
      }
      return entryLines === op.count;
    }
  }
}

/** Template for a brand-new memory file (only used when none ever existed). */
export function buildTemplate(): string {
  return `${MEMORY_HEADING}\n\n`;
}
