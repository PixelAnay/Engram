/**
 * ui/BackupPickerModal.ts
 * Lists memory backups (newest first) and resolves to the chosen backup path.
 */

import { App, Modal } from 'obsidian';

export interface BackupChoice {
  path: string;
  label: string;
}

class BackupPickerModal extends Modal {
  private result: string | null = null;

  constructor(
    app: App,
    private choices: BackupChoice[],
    private onSubmit: (path: string | null) => void
  ) {
    super(app);
    this.titleEl.setText('Restore memory from backup');
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', {
      text: 'Pick a backup. Your current memory file (if any) is backed up first.',
      cls: 'engram-modal-subtitle',
    });
    const list = contentEl.createDiv({ cls: 'engram-undo-list' });
    for (const choice of this.choices) {
      const item = list.createDiv({ cls: 'engram-undo-item' });
      item.createSpan({ text: choice.label, cls: 'engram-undo-desc' });
      item.addEventListener('click', () => {
        this.result = choice.path;
        this.close();
      });
    }
    const cancel = contentEl.createEl('button', { text: 'Cancel', cls: 'engram-modal-cancel' });
    cancel.setCssStyles({ marginTop: '8px' });
    cancel.addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.onSubmit(this.result);
  }
}

export function showBackupPicker(app: App, choices: BackupChoice[]): Promise<string | null> {
  return new Promise(resolve => new BackupPickerModal(app, choices, resolve).open());
}
