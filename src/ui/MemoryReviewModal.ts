/**
 * ui/MemoryReviewModal.ts
 *
 * Shows facts proposed by /memory. The user ticks the ones to keep and can edit
 * the wording. Nothing is written until "Save selected" is pressed.
 */

import { App, Modal } from 'obsidian';
import { normalizeFact } from '../memory/memoryFormat';

export interface ReviewItem {
  text: string;
  checked: boolean;
}

/** The facts to save: checked, non-empty after normalising, without duplicates. */
export function collectSelectedFacts(items: ReviewItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!item.checked) continue;
    const fact = normalizeFact(item.text);
    const key = fact.toLowerCase();
    if (!fact || seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out;
}

class MemoryReviewModal extends Modal {
  private items: ReviewItem[];
  private result: string[] | null = null;
  private onSubmit: (result: string[] | null) => void;

  constructor(app: App, candidates: string[], onSubmit: (result: string[] | null) => void) {
    super(app);
    this.items = candidates.map(text => ({ text, checked: true }));
    this.onSubmit = onSubmit;
    this.titleEl.setText('🧠 Save to memory?');
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', {
      text: 'Untick anything you do not want remembered, and edit the wording if needed.',
      cls: 'engram-modal-subtitle',
    });

    const list = contentEl.createDiv({ cls: 'engram-memory-review-list' });
    for (const item of this.items) {
      const row = list.createDiv({ cls: 'engram-memory-review-row' });
      row.setCssStyles({ display: 'flex', gap: '8px', alignItems: 'flex-start', marginBottom: '8px' });

      const box = row.createEl('input', { type: 'checkbox' });
      box.checked = item.checked;
      box.addEventListener('change', () => { item.checked = box.checked; });

      const text = row.createEl('textarea', { cls: 'engram-memory-review-text' });
      text.value = item.text;
      text.rows = 2;
      text.setCssStyles({ flex: '1', resize: 'vertical' });
      text.addEventListener('input', () => { item.text = text.value; });
    }

    const buttons = contentEl.createDiv({ cls: 'engram-modal-btns' });
    buttons.setCssStyles({ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' });

    const cancel = buttons.createEl('button', { text: 'Cancel', cls: 'engram-modal-cancel' });
    cancel.addEventListener('click', () => this.close());

    const save = buttons.createEl('button', { text: 'Save selected', cls: 'engram-modal-confirm mod-cta' });
    save.addEventListener('click', () => {
      this.result = collectSelectedFacts(this.items);
      this.close();
    });
  }

  onClose(): void {
    this.onSubmit(this.result);
  }
}

/** Resolves to the facts the user chose to save, or null if they cancelled. */
export function showMemoryReviewDialog(app: App, candidates: string[]): Promise<string[] | null> {
  return new Promise(resolve => {
    new MemoryReviewModal(app, candidates, resolve).open();
  });
}
