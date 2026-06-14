// ─── Path Validation & Sanitisation Utilities ────────────────────────────────

/**
 * Normalise a path: convert all backslashes to forward slashes, collapse
 * consecutive duplicate slashes into a single slash, and strip any trailing
 * slash.
 *
 * @param path - Raw path string to normalise.
 * @returns The normalised path string.
 */
export function normalisePath(path: string): string {
  return path
    .replace(/\\/g, '/')    // backslash → forward slash
    .replace(/\/+/g, '/')   // collapse consecutive slashes
    .replace(/\/$/, '')     // trim trailing slash
    .trim();
}

/**
 * Check whether a path is inside the .obsidian internal directory.
 *
 * Matches any path that begins with ".obsidian" as the first segment,
 * covering both the directory itself and anything nested inside it.
 * The comparison is case-insensitive to handle platforms that normalise case.
 *
 * @param path - A forward-slash normalised, vault-relative path.
 * @returns `true` if the path targets `.obsidian` or any of its children.
 */
export function isObsidianInternal(path: string): boolean {
  const p = normalisePath(path).toLowerCase();
  return p === '.obsidian' || p.startsWith('.obsidian/');
}

/**
 * Validate and sanitise a vault-relative path provided by the LLM.
 * Returns the cleaned path or `null` if the path is rejected.
 *
 * **Blocks:**
 * - Non-string values
 * - Empty / whitespace-only strings
 * - Null bytes (`\0`) — before and after URL-decoding
 * - Absolute paths starting with `/`
 * - Windows-style absolute paths matching `/^[A-Za-z]:[/\\]/`
 * - UNC paths starting with `//`
 * - Path traversal via `..` segments (including URL-encoded variants such as
 *   `%2e%2e%2f`, `%2e%2e/`, `..%2f`, `%2E%2E` etc.)
 * - Paths targeting `.obsidian/` internals
 *
 * The function decodes URL-percent-encoding before performing all checks so
 * that an attacker cannot bypass traversal detection with encoded sequences.
 *
 * @param raw - The untrusted value received from the LLM arguments.
 * @returns The normalised vault-relative path, or `null` when rejected.
 */
export function validateVaultPath(raw: unknown): string | null {
  // ── 1. Type check ────────────────────────────────────────────────────────
  if (typeof raw !== 'string') return null;

  // ── 2. Null-byte check (before URL-decoding) ─────────────────────────────
  if (raw.includes('\0')) return null;

  // ── 3. Empty / whitespace-only check on raw input ────────────────────────
  if (!raw.trim()) return null;

  // ── 4. Decode URL-percent-encoding ───────────────────────────────────────
  //    Catches evasions like %2e%2e%2f → ../  or  %00 → \0
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Not valid percent-encoding — use the raw value as-is.
    decoded = raw;
  }

  // ── 5. Null-byte check again (could arrive as %00) ───────────────────────
  if (decoded.includes('\0')) return null;

  // ── 6. Empty / whitespace-only check after decoding ──────────────────────
  if (!decoded.trim()) return null;

  // ── 7. Reject absolute paths starting with / ─────────────────────────────
  if (decoded.startsWith('/')) return null;

  // ── 8. Reject Windows-style absolute paths (e.g. C:\ or C:/) ────────────
  if (/^[A-Za-z]:[/\\]/.test(decoded)) return null;

  // ── 9. Normalise (backslash → /, collapse duplicates, trim trailing /) ───
  const normalised = normalisePath(decoded);

  // ── 10. Reject UNC-style paths that start with // after normalisation ────
  if (normalised.startsWith('//')) return null;

  // ── 11. Reject path traversal via ".." segments ──────────────────────────
  //    Splitting on "/" and checking each segment rejects ".." anywhere in
  //    the path, regardless of surrounding context.
  const segments = normalised.split('/');
  for (const segment of segments) {
    if (segment === '..') return null;
  }

  // ── 12. Reject .obsidian internals ───────────────────────────────────────
  if (isObsidianInternal(normalised)) return null;

  // ── 13. Final empty guard after normalisation ─────────────────────────────
  return normalised || null;
}
