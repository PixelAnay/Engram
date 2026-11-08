/**
 * storage/PluginDataStore.ts
 *
 * The ONLY reader/writer of the plugin's data.json. Keeps an in-memory copy and
 * applies every change through a single queue, so concurrent callers can never
 * overwrite each other's keys (the old code did independent load → modify → save).
 */

export interface DataPersistence {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export type PluginData = Record<string, unknown>;

export class PluginDataStore {
  private data: PluginData = {};
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private persistence: DataPersistence) {}

  /** Read data.json from disk into memory. Call once at startup. */
  async load(): Promise<void> {
    const loaded = await this.persistence.loadData();
    this.data = loaded && typeof loaded === 'object' ? (loaded as PluginData) : {};
  }

  /** Current in-memory data. Treat as read-only; change it through update(). */
  get(): Readonly<PluginData> {
    return this.data;
  }

  /**
   * Apply `mutator` to the data and persist the result. Calls run strictly in
   * the order they were made. The returned promise resolves once written.
   */
  update(mutator: (data: PluginData) => void): Promise<void> {
    const run = async (): Promise<void> => {
      mutator(this.data);
      await this.persistence.saveData(this.data);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => { /* keep the queue alive after a failed write */ });
    return next;
  }

  /** Resolves when all queued updates have been written. */
  async flush(): Promise<void> {
    await this.queue;
  }
}
