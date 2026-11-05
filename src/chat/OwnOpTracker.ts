/**
 * chat/OwnOpTracker.ts
 *
 * Remembers paths the plugin itself is writing or deleting, for a short time.
 * Vault event handlers use it to ignore the events our own operations cause,
 * so they are never mistaken for changes made by another device or tool.
 */

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();

export class OwnOpTracker {
  private marks = new Map<string, number>();

  constructor(
    private ttlMs = 5000,
    private now: () => number = () => Date.now()
  ) {}

  /** Call right BEFORE writing/deleting `path`. */
  mark(path: string): void {
    const t = this.now();
    for (const [key, expires] of this.marks) {
      if (expires <= t) this.marks.delete(key);
    }
    this.marks.set(norm(path), t + this.ttlMs);
  }

  /** True while an event for `path` should be attributed to the plugin itself. */
  isOwn(path: string): boolean {
    const key = norm(path);
    const expires = this.marks.get(key);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.marks.delete(key);
      return false;
    }
    return true;
  }
}
