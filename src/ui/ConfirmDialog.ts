/**
 * ui/ConfirmDialog.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight DOM-based confirmation modal for destructive vault operations.
 *
 * Deliberately avoids importing Obsidian's `Modal` class so this module has
 * zero Obsidian API surface — it works with plain DOM APIs and reuses the
 * existing `llama-modal-*` CSS classes already defined in styles.css.
 *
 * Usage:
 *   const ok = await showConfirmDialog({
 *     title: 'Delete Note',
 *     message: 'Permanently delete "Projects/MyNote.md"?',
 *     danger: true,
 *   });
 *   if (ok) { ... }
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Configuration options for the confirmation dialog. */
export interface ConfirmOptions {
  /** Short heading shown at the top of the modal, e.g. "Delete Note". */
  title: string;
  /**
   * Explanatory body text shown beneath the title,
   * e.g. `Permanently delete "Projects/MyNote.md"?`
   */
  message: string;
  /**
   * Label for the affirmative action button.
   * @default "Confirm"
   */
  confirmLabel?: string;
  /**
   * Label for the dismissal button.
   * @default "Cancel"
   */
  cancelLabel?: string;
  /**
   * When `true` the confirm button receives the `llama-modal-confirm-danger`
   * CSS class (styled red) to visually signal a destructive action.
   * @default false
   */
  danger?: boolean;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Show a modal confirmation dialog built from plain DOM elements.
 *
 * The overlay is appended to `document.body` and completely removed when the
 * user either confirms, cancels, or clicks outside the modal box.
 *
 * @param options - Display and behaviour configuration.
 * @returns A `Promise<boolean>` that resolves to:
 *   - `true`  — user clicked the confirm button (or pressed Enter)
 *   - `false` — user clicked cancel, pressed Escape, or clicked the overlay
 */
export function showConfirmDialog(options: ConfirmOptions): Promise<boolean> {
  const {
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel  = 'Cancel',
    danger       = false,
  } = options;

  return new Promise<boolean>((resolve) => {
    // Guard so that the various close paths (overlay click, button click,
    // keyboard handler) cannot resolve the promise more than once.
    let settled = false;

    /** Tear down the overlay and resolve the promise exactly once. */
    function close(confirmed: boolean): void {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      resolve(confirmed);
    }

    // ── Keyboard handler ──────────────────────────────────────────────────
    // Escape always cancels; Enter confirms (matching native browser dialogs).
    function onKeyDown(evt: KeyboardEvent): void {
      if (evt.key === 'Escape') {
        evt.preventDefault();
        close(false);
      } else if (evt.key === 'Enter') {
        evt.preventDefault();
        close(true);
      }
    }
    document.addEventListener('keydown', onKeyDown);

    // ── DOM construction ──────────────────────────────────────────────────

    // Full-screen translucent backdrop — clicking it cancels the dialog.
    const overlay = document.createElement('div');
    overlay.className = 'llama-modal-overlay';
    overlay.addEventListener('click', (evt) => {
      // Only close when the backdrop itself is clicked, not the modal card.
      if (evt.target === overlay) close(false);
    });

    // ── Modal card ────────────────────────────────────────────────────────
    const modal = document.createElement('div');
    modal.className = 'llama-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'llama-confirm-title');
    modal.setAttribute('aria-describedby', 'llama-confirm-msg');
    // Stop clicks inside the card from bubbling up to the overlay listener.
    modal.addEventListener('click', (evt) => evt.stopPropagation());
    overlay.appendChild(modal);

    // Title
    const titleEl = document.createElement('div');
    titleEl.id        = 'llama-confirm-title';
    titleEl.className = 'llama-modal-title';
    titleEl.textContent = title;
    modal.appendChild(titleEl);

    // Message / subtitle
    const msgEl = document.createElement('div');
    msgEl.id        = 'llama-confirm-msg';
    msgEl.className = 'llama-modal-subtitle';
    msgEl.textContent = message;
    modal.appendChild(msgEl);

    // ── Buttons ───────────────────────────────────────────────────────────
    const btns = document.createElement('div');
    btns.className = 'llama-modal-btns';
    modal.appendChild(btns);

    // Cancel button
    const cancelBtn = document.createElement('button');
    cancelBtn.type        = 'button';
    cancelBtn.className   = 'llama-modal-cancel';
    cancelBtn.textContent = cancelLabel;
    cancelBtn.addEventListener('click', () => close(false));
    btns.appendChild(cancelBtn);

    // Confirm button — danger variant applies red styling via CSS
    const confirmBtn = document.createElement('button');
    confirmBtn.type      = 'button';
    confirmBtn.className = danger
      ? 'llama-modal-confirm llama-modal-confirm-danger'
      : 'llama-modal-confirm';
    confirmBtn.textContent = confirmLabel;
    confirmBtn.addEventListener('click', () => close(true));
    btns.appendChild(confirmBtn);

    // ── Mount & focus ─────────────────────────────────────────────────────
    document.body.appendChild(overlay);

    // Focus the confirm button so Enter/Escape work immediately without an
    // extra Tab press.  For danger operations callers may prefer to focus
    // cancelBtn instead — that decision is left to the caller via CSS or a
    // future `defaultFocus` option.
    confirmBtn.focus();
  });
}
