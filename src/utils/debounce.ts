/** Trailing-edge debouncer with explicit flush/cancel. */
export interface Debouncer {
  /** Schedule the function; resets the timer on each call. */
  call(): void;
  /** Run the function now if a call is pending. */
  flush(): void;
  /** Drop a pending call. */
  cancel(): void;
}

export function createDebouncer(fn: () => void | Promise<void>, ms: number): Debouncer {
  let timer: number | null = null;
  const run = () => {
    timer = null;
    void fn();
  };
  return {
    call() {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(run, ms);
    },
    flush() {
      if (timer === null) return;
      window.clearTimeout(timer);
      run();
    },
    cancel() {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    },
  };
}
