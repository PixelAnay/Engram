/**
 * Commit a text field only when the user is done typing: on blur or Enter,
 * never per keystroke. Used for path settings, where a half-typed value
 * ("Intelli") must never be acted on.
 */
export interface CommitInput {
  value: string;
  addEventListener(type: string, listener: (e: any) => void): void;
}

export function commitOnBlurOrEnter(
  input: CommitInput,
  commit: (value: string) => void | Promise<void>
): void {
  let committed = input.value.trim();
  let busy = false;

  const run = async () => {
    if (busy) return;
    const value = input.value.trim();
    if (value === committed) return;
    busy = true;
    try {
      await commit(value);
    } finally {
      // The commit may have reset the field (e.g. invalid input); track what is shown now
      committed = input.value.trim();
      busy = false;
    }
  };

  input.addEventListener('blur', () => { void run(); });
  input.addEventListener('keydown', (e: { key?: string; preventDefault?: () => void }) => {
    if (e.key === 'Enter') {
      e.preventDefault?.();
      void run();
    }
  });
}
