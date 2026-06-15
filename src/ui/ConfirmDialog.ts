/**
 * ui/ConfirmDialog.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight DOM-based confirmation modal for destructive vault operations.
  * existing `engram-modal-*` CSS classes already defined in styles.css.
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
   * When `true` the confirm button receives the `engram-modal-confirm-danger`
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
    // Let's ensure Enter is only handled if target is not cancel button, but standard behavior is fine.
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
    overlay.className = 'engram-modal-overlay';
    overlay.addEventListener('click', (evt) => {
      // Only close when the backdrop itself is clicked, not the modal card.
      if (evt.target === overlay) close(false);
    });

    // ── Modal card ────────────────────────────────────────────────────────
    const modal = document.createElement('div');
    modal.className = 'engram-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'engram-confirm-title');
    modal.setAttribute('aria-describedby', 'engram-confirm-msg');
    // Stop clicks inside the card from bubbling up to the overlay listener.
    modal.addEventListener('click', (evt) => evt.stopPropagation());
    overlay.appendChild(modal);

    // Title
    const titleEl = document.createElement('div');
    titleEl.id        = 'engram-confirm-title';
    titleEl.className = 'engram-modal-title';
    titleEl.textContent = title;
    modal.appendChild(titleEl);

    // Message / subtitle
    const msgEl = document.createElement('div');
    msgEl.id        = 'engram-confirm-msg';
    msgEl.className = 'engram-modal-subtitle';
    msgEl.textContent = message;
    modal.appendChild(msgEl);

    // ── Buttons ───────────────────────────────────────────────────────────
    const btns = document.createElement('div');
    btns.className = 'engram-modal-btns';
    modal.appendChild(btns);

    // Cancel button
    const cancelBtn = document.createElement('button');
    cancelBtn.type        = 'button';
    cancelBtn.className   = 'engram-modal-cancel';
    cancelBtn.textContent = cancelLabel;
    cancelBtn.addEventListener('click', () => close(false));
    btns.appendChild(cancelBtn);

    // Confirm button — danger variant applies red styling via CSS
    const confirmBtn = document.createElement('button');
    confirmBtn.type      = 'button';
    confirmBtn.className = danger
      ? 'engram-modal-confirm engram-modal-confirm-danger'
      : 'engram-modal-confirm';
    confirmBtn.textContent = confirmLabel;
    confirmBtn.addEventListener('click', () => close(true));
    btns.appendChild(confirmBtn);

    // ── Mount & focus ─────────────────────────────────────────────────────
    document.body.appendChild(overlay);

    // Focus the confirm button so Enter/Escape work immediately without an
    // extra Tab press.
    confirmBtn.focus();
  });
}

/** Configuration options for prompt input dialog. */
export interface PromptOptions {
  title: string;
  message: string;
  placeholder?: string;
  value?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

/**
 * Show a modal prompt input dialog built from plain DOM elements.
 */
export function showPromptDialog(options: PromptOptions): Promise<string | null> {
  const {
    title,
    message,
    placeholder = '',
    value = '',
    confirmLabel = 'Save',
    cancelLabel = 'Cancel',
  } = options;

  return new Promise<string | null>((resolve) => {
    let settled = false;

    function close(result: string | null): void {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      resolve(result);
    }

    function onKeyDown(evt: KeyboardEvent): void {
      if (evt.key === 'Escape') {
        evt.preventDefault();
        close(null);
      } else if (evt.key === 'Enter') {
        evt.preventDefault();
        close(inputEl.value);
      }
    }
    document.addEventListener('keydown', onKeyDown);

    // Backdrop
    const overlay = document.createElement('div');
    overlay.className = 'engram-modal-overlay';
    overlay.addEventListener('click', (evt) => {
      if (evt.target === overlay) close(null);
    });

    // Modal
    const modal = document.createElement('div');
    modal.className = 'engram-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.addEventListener('click', (evt) => evt.stopPropagation());
    overlay.appendChild(modal);

    // Title
    const titleEl = document.createElement('div');
    titleEl.className = 'engram-modal-title';
    titleEl.textContent = title;
    modal.appendChild(titleEl);

    // Message
    const msgEl = document.createElement('div');
    msgEl.className = 'engram-modal-subtitle';
    msgEl.textContent = message;
    modal.appendChild(msgEl);

    // Input container & element
    const inputContainer = document.createElement('div');
    inputContainer.className = 'engram-modal-input-container';
    inputContainer.style.margin = '16px 0';
    inputContainer.style.width = '100%';
    modal.appendChild(inputContainer);

    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.placeholder = placeholder;
    inputEl.value = value;
    inputEl.className = 'engram-modal-input';
    inputEl.style.width = '100%';
    inputEl.style.padding = '8px 12px';
    inputEl.style.border = '1px solid var(--engram-border)';
    inputEl.style.borderRadius = 'var(--engram-radius-sm)';
    inputEl.style.background = 'var(--engram-bg)';
    inputEl.style.color = 'var(--engram-text)';
    inputEl.style.fontSize = '14px';
    inputContainer.appendChild(inputEl);

    // Buttons
    const btns = document.createElement('div');
    btns.className = 'engram-modal-btns';
    modal.appendChild(btns);

    // Cancel button
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'engram-modal-cancel';
    cancelBtn.textContent = cancelLabel;
    cancelBtn.addEventListener('click', () => close(null));
    btns.appendChild(cancelBtn);

    // Confirm button
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'engram-modal-confirm';
    confirmBtn.textContent = confirmLabel;
    confirmBtn.addEventListener('click', () => close(inputEl.value));
    btns.appendChild(confirmBtn);

    document.body.appendChild(overlay);

    inputEl.focus();
    inputEl.select();
  });
}
