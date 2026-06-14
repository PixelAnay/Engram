/**
 * MentionAutocomplete.ts
 * Extracted from ChatView — handles the @-mention note autocomplete dropdown.
 */

import type { VaultIndexer } from '../indexer';

export class MentionAutocomplete {
  private dropdownEl: HTMLElement;
  private mentionStart = -1;

  constructor(
    private inputEl: HTMLTextAreaElement,
    private container: HTMLElement,
    private indexer: VaultIndexer,
    private onSelect: (notePath: string) => void
  ) {
    this.dropdownEl = container.createDiv('llama-mention-dropdown');
    this.dropdownEl.style.display = 'none';
  }

  /** Call this from the textarea's 'input' event handler. */
  handleInput(): void {
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart ?? val.length;

    // Find the last '@' before cursor with no spaces breaking it
    const before = val.slice(0, pos);
    const atMatch = before.match(/@([^\s@]*)$/);

    if (!atMatch) {
      this.hide();
      return;
    }

    const query = atMatch[1].toLowerCase();
    this.mentionStart = before.lastIndexOf('@');

    // Search indexer for matching notes
    const allNotes = this.indexer.search(query || '', undefined, 30);
    const filtered = query
      ? allNotes.filter(n =>
          n.path.toLowerCase().includes(query) || n.title.toLowerCase().includes(query)
        ).slice(0, 8)
      : allNotes.slice(0, 8);

    if (filtered.length === 0) {
      this.hide();
      return;
    }

    this.dropdownEl.empty();
    this.dropdownEl.style.display = 'block';

    for (let i = 0; i < filtered.length; i++) {
      const note = filtered[i];
      const item = this.dropdownEl.createDiv('llama-mention-item');
      if (i === 0) item.classList.add('active');

      item.createSpan('llama-mention-name').textContent = note.title;
      item.createSpan('llama-mention-path').textContent = note.path;

      item.addEventListener('mousedown', (e: MouseEvent) => {
        e.preventDefault();
        this.select(note.path);
      });
    }
  }

  /** Handle keydown events on the textarea while the dropdown is open. */
  handleKeydown(e: KeyboardEvent): boolean {
    if (this.dropdownEl.style.display === 'none') return false;

    const items = Array.from(
      this.dropdownEl.querySelectorAll('.llama-mention-item')
    ) as HTMLElement[];
    const active = this.dropdownEl.querySelector('.llama-mention-item.active') as HTMLElement | null;
    const idx = active ? items.indexOf(active) : -1;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = items[(idx + 1) % items.length];
      if (active) active.classList.remove('active');
      next?.classList.add('active');
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = items[(idx - 1 + items.length) % items.length];
      if (active) active.classList.remove('active');
      prev?.classList.add('active');
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const sel = active || items[0];
      if (sel) {
        e.preventDefault();
        sel.click();
        return true;
      }
    }
    if (e.key === 'Escape') {
      this.hide();
      return true;
    }

    return false;
  }

  /** Whether the dropdown is currently visible. */
  get isVisible(): boolean {
    return this.dropdownEl.style.display !== 'none';
  }

  hide(): void {
    this.dropdownEl.style.display = 'none';
    this.mentionStart = -1;
  }

  private select(notePath: string): void {
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart ?? val.length;
    const before = val.slice(0, this.mentionStart);
    const after = val.slice(pos);
    const inserted = `[[${notePath}]]`;
    this.inputEl.value = before + inserted + after;
    const newCursor = before.length + inserted.length;
    this.inputEl.setSelectionRange(newCursor, newCursor);
    this.hide();
    this.inputEl.focus();
    this.onSelect(notePath);
  }
}
