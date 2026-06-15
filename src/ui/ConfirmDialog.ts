/**
 * ui/ConfirmDialog.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Native Obsidian-based modal wrappers for safe input and confirmation.
 */

import { App, Modal } from 'obsidian';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Configuration options for the confirmation dialog. */
export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
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

// ── Modals ────────────────────────────────────────────────────────────────────

class ConfirmModal extends Modal {
  private result = false;
  private onSubmit: (result: boolean) => void;
  private message: string;
  private confirmLabel: string;
  private cancelLabel: string;
  private danger: boolean;

  constructor(
    app: App,
    title: string,
    message: string,
    confirmLabel: string,
    cancelLabel: string,
    danger: boolean,
    onSubmit: (result: boolean) => void
  ) {
    super(app);
    this.titleEl.setText(title);
    this.message = message;
    this.confirmLabel = confirmLabel;
    this.cancelLabel = cancelLabel;
    this.danger = danger;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('p', { text: this.message, cls: 'engram-modal-subtitle' });

    const buttonContainer = contentEl.createDiv({ cls: 'engram-modal-btns' });
    buttonContainer.style.display = 'flex';
    buttonContainer.style.justifyContent = 'flex-end';
    buttonContainer.style.gap = '8px';
    buttonContainer.style.marginTop = '16px';

    const cancelBtn = buttonContainer.createEl('button', {
      text: this.cancelLabel,
      cls: 'engram-modal-cancel'
    });
    cancelBtn.addEventListener('click', () => {
      this.close();
    });

    const confirmBtn = buttonContainer.createEl('button', {
      text: this.confirmLabel,
      cls: this.danger
        ? 'engram-modal-confirm engram-modal-confirm-danger mod-warning'
        : 'engram-modal-confirm mod-cta'
    });
    confirmBtn.addEventListener('click', () => {
      this.result = true;
      this.close();
    });

    setTimeout(() => confirmBtn.focus(), 50);
  }

  onClose() {
    this.onSubmit(this.result);
  }
}

class PromptModal extends Modal {
  private result: string | null = null;
  private onSubmit: (result: string | null) => void;
  private placeholder: string;
  private message: string;
  private value: string;
  private confirmLabel: string;
  private cancelLabel: string;

  constructor(
    app: App,
    title: string,
    message: string,
    placeholder: string,
    value: string,
    confirmLabel: string,
    cancelLabel: string,
    onSubmit: (result: string | null) => void
  ) {
    super(app);
    this.titleEl.setText(title);
    this.message = message;
    this.placeholder = placeholder;
    this.value = value;
    this.confirmLabel = confirmLabel;
    this.cancelLabel = cancelLabel;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('p', { text: this.message, cls: 'engram-modal-subtitle' });

    const inputContainer = contentEl.createDiv({ cls: 'engram-modal-input-container' });
    inputContainer.style.margin = '16px 0';
    inputContainer.style.width = '100%';

    const inputEl = inputContainer.createEl('input', {
      type: 'text',
      placeholder: this.placeholder,
      value: this.value,
      cls: 'engram-modal-input'
    });
    inputEl.style.width = '100%';
    inputEl.style.padding = '8px 12px';
    inputEl.style.border = '1px solid var(--engram-border)';
    inputEl.style.borderRadius = 'var(--engram-radius-sm)';
    inputEl.style.background = 'var(--engram-bg)';
    inputEl.style.color = 'var(--engram-text)';
    inputEl.style.fontSize = '14px';

    const buttonContainer = contentEl.createDiv({ cls: 'engram-modal-btns' });
    buttonContainer.style.display = 'flex';
    buttonContainer.style.justifyContent = 'flex-end';
    buttonContainer.style.gap = '8px';

    const cancelBtn = buttonContainer.createEl('button', {
      text: this.cancelLabel,
      cls: 'engram-modal-cancel'
    });
    cancelBtn.addEventListener('click', () => {
      this.close();
    });

    const confirmBtn = buttonContainer.createEl('button', {
      text: this.confirmLabel,
      cls: 'engram-modal-confirm mod-cta'
    });
    confirmBtn.addEventListener('click', () => {
      this.result = inputEl.value;
      this.close();
    });

    const stopPropagation = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') {
        e.stopPropagation();
      }
    };

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return;
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.result = inputEl.value;
        this.close();
      }
    });
    inputEl.addEventListener('keypress', stopPropagation);
    inputEl.addEventListener('keyup', stopPropagation);

    // Focus immediately and also at timeouts to ensure focus is not stolen during modal transitions
    inputEl.focus();
    inputEl.select();
    setTimeout(() => {
      inputEl.focus();
      inputEl.select();
    }, 50);
    setTimeout(() => {
      inputEl.focus();
      inputEl.select();
    }, 150);
  }

  onClose() {
    this.onSubmit(this.result);
  }
}

// ── Exported API ──────────────────────────────────────────────────────────────

/**
 * Show a modal confirmation dialog using Obsidian's native Modal system.
 */
export function showConfirmDialog(app: App, options: ConfirmOptions): Promise<boolean> {
  const {
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false,
  } = options;

  return new Promise<boolean>((resolve) => {
    new ConfirmModal(app, title, message, confirmLabel, cancelLabel, danger, resolve).open();
  });
}

/**
 * Show a modal prompt input dialog using Obsidian's native Modal system.
 */
export function showPromptDialog(app: App, options: PromptOptions): Promise<string | null> {
  const {
    title,
    message,
    placeholder = '',
    value = '',
    confirmLabel = 'Save',
    cancelLabel = 'Cancel',
  } = options;

  return new Promise<string | null>((resolve) => {
    new PromptModal(app, title, message, placeholder, value, confirmLabel, cancelLabel, resolve).open();
  });
}
