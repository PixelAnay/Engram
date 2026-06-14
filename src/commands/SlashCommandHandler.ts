/**
 * commands/SlashCommandHandler.ts
 *
 * Handles slash commands typed in the chat input (/memory, /forget, etc.)
 * Intercepts keystrokes, shows a dropdown, and executes commands.
 */

import type { MemoryManager } from '../memory/MemoryManager';

export interface SlashCommand {
  name: string;       // e.g. "memory"
  label: string;      // e.g. "/memory"
  desc: string;
  icon: string;
  /** If true, command takes an argument after the command name */
  hasArg?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'memory',
    label: '/memory',
    desc: 'Save important facts from this conversation to memory',
    icon: '🧠',
  },
  {
    name: 'forget',
    label: '/forget',
    desc: 'Open memory file to review and delete entries',
    icon: '🗑️',
  },
  {
    name: 'persona',
    label: '/persona',
    desc: 'Switch active persona',
    icon: '🎭',
    hasArg: true,
  },
  {
    name: 'export',
    label: '/export',
    desc: 'Export this conversation to a vault note',
    icon: '📝',
  },
  {
    name: 'clear',
    label: '/clear',
    desc: 'Clear current chat session',
    icon: '🧹',
  },
  {
    name: 'scope',
    label: '/scope',
    desc: 'Show current vault access scope',
    icon: '📁',
  },
];

export type SlashCommandCallback = {
  onMemory: () => Promise<void>;
  onForget: () => Promise<void>;
  onPersona: (name: string) => void;
  onExport: () => Promise<void>;
  onClear: () => void;
  onScope: () => void;
};

export class SlashCommandHandler {
  private inputEl: HTMLTextAreaElement;
  private containerEl: HTMLElement;
  private callbacks: SlashCommandCallback;

  private dropdownEl: HTMLElement | null = null;
  private activeIndex = 0;
  private visibleCommands: SlashCommand[] = [];
  private active = false;

  constructor(
    inputEl: HTMLTextAreaElement,
    containerEl: HTMLElement,
    callbacks: SlashCommandCallback
  ) {
    this.inputEl = inputEl;
    this.containerEl = containerEl;
    this.callbacks = callbacks;
  }

  // ── Input handling ────────────────────────────────────────────────────────

  handleInput(): boolean {
    const val = this.inputEl.value;

    if (!val.startsWith('/')) {
      this.hide();
      return false;
    }

    const query = val.slice(1).toLowerCase();
    this.visibleCommands = SLASH_COMMANDS.filter(
      c => c.name.startsWith(query) || c.label.includes(query)
    );

    if (this.visibleCommands.length === 0) {
      this.hide();
      return false;
    }

    this.activeIndex = 0;
    this.show();
    return true;
  }

  /** Returns true if the keydown was consumed by the slash handler. */
  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.active) return false;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.activeIndex = (this.activeIndex + 1) % this.visibleCommands.length;
      this.renderItems();
      return true;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.activeIndex = (this.activeIndex - 1 + this.visibleCommands.length) % this.visibleCommands.length;
      this.renderItems();
      return true;
    }

    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      this.selectActive();
      return true;
    }

    if (e.key === 'Escape') {
      this.hide();
      return true;
    }

    return false;
  }

  hide(): void {
    this.active = false;
    this.dropdownEl?.remove();
    this.dropdownEl = null;
  }

  // ── Dropdown rendering ────────────────────────────────────────────────────

  private show(): void {
    this.active = true;

    if (!this.dropdownEl) {
      this.dropdownEl = this.containerEl.createDiv('engram-slash-dropdown');
    }

    this.renderItems();
  }

  private renderItems(): void {
    if (!this.dropdownEl) return;
    this.dropdownEl.empty();

    this.visibleCommands.forEach((cmd, i) => {
      const item = this.dropdownEl!.createDiv('engram-slash-item');
      if (i === this.activeIndex) item.addClass('active');

      item.createSpan('engram-slash-icon').textContent = cmd.icon;
      const text = item.createDiv('engram-slash-item-text');
      text.createSpan('engram-slash-item-name').textContent = cmd.label;
      text.createSpan('engram-slash-item-desc').textContent = cmd.desc;

      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.activeIndex = i;
        this.selectActive();
      });
    });
  }

  private selectActive(): void {
    const cmd = this.visibleCommands[this.activeIndex];
    if (!cmd) return;

    this.inputEl.value = '';
    this.hide();

    this.execute(cmd);
  }

  // ── Execution ─────────────────────────────────────────────────────────────

  private execute(cmd: SlashCommand): void {
    switch (cmd.name) {
      case 'memory':  this.callbacks.onMemory();  break;
      case 'forget':  this.callbacks.onForget();  break;
      case 'persona': this.callbacks.onPersona(''); break;
      case 'export':  this.callbacks.onExport();  break;
      case 'clear':   this.callbacks.onClear();   break;
      case 'scope':   this.callbacks.onScope();   break;
    }
  }
}
