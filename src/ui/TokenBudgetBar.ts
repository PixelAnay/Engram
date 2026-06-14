/**
 * ui/TokenBudgetBar.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Visual token-budget progress bar for the Engram Chat footer.
 *
 * Renders a thin horizontal bar that fills left-to-right as tokens are
 * consumed.  Colour changes at 70 % (orange) and 90 % (red) to give the user
 * an at-a-glance sense of how much context window remains.
 *
 * Usage:
 *   const bar = new TokenBudgetBar(footerEl, plugin.settings.contextWindowTokens);
 *   bar.update(estimateMessagesTokens(messages));
 *   // … later, when settings change:
 *   bar.setMax(newMax);
 *   // … when the view is closed:
 *   bar.destroy();
 */

import { estimateTokens, formatTokenCount } from '../utils/tokenEstimator';

// Re-export estimateTokens so callers who import this module can use it
// without a second import statement.
export { estimateTokens };

// ── Colour thresholds ─────────────────────────────────────────────────────────

/** Fill colour when usage is below the warning threshold (< 70 %). */
const COLOR_OK       = '#4ade80'; // green
/** Fill colour in the warning zone (70 – 90 %). */
const COLOR_WARNING  = '#f59e0b'; // amber / orange
/** Fill colour in the critical zone (> 90 %). */
const COLOR_CRITICAL = '#f87171'; // red

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Horizontal token-budget bar component.
 *
 * Appends itself to `container` on construction and exposes `update`,
 * `setMax`, and `destroy` methods for lifecycle management.
 */
export class TokenBudgetBar {
  /** Wrapping element — carries the `engram-token-bar` class. */
  private readonly el: HTMLElement;
  /** The coloured fill strip — carries the `engram-token-bar-fill` class. */
  private readonly fillEl: HTMLElement;
  /** Text label showing e.g. "4.2k / 32k tokens". */
  private readonly labelEl: HTMLElement;
  /** Maximum token budget (the full context window size). */
  private maxTokens: number;

  /**
   * @param container - Parent element to append the bar into.
   * @param maxTokens - Total context window size in tokens.
   */
  constructor(container: HTMLElement, maxTokens: number) {
    this.maxTokens = Math.max(1, maxTokens);

    // ── Wrapper ───────────────────────────────────────────────────────────
    this.el = document.createElement('div');
    this.el.className = 'engram-token-bar';
    container.appendChild(this.el);

    // ── Fill strip ────────────────────────────────────────────────────────
    this.fillEl = document.createElement('div');
    this.fillEl.className = 'engram-token-bar-fill';
    this.el.appendChild(this.fillEl);

    // ── Label ─────────────────────────────────────────────────────────────
    this.labelEl = document.createElement('span');
    this.labelEl.className = 'engram-token-bar-label';
    this.el.appendChild(this.labelEl);

    // Render initial empty state
    this.update(0);
  }

  /**
   * Refresh the bar for the given used-token count.
   *
   * @param usedTokens - Number of tokens consumed so far.
   */
  update(usedTokens: number): void {
    const safeUsed = Math.max(0, usedTokens);
    const pct      = Math.min(1, safeUsed / this.maxTokens);
    const pctPx    = Math.round(pct * 100);

    // Width
    this.fillEl.style.width = `${pctPx}%`;

    // Colour — driven by inline style so no additional CSS variables are needed.
    // The `data-budget` attribute is kept for CSS selector overrides.
    if (pct > 0.9) {
      this.fillEl.style.backgroundColor = COLOR_CRITICAL;
      this.fillEl.setAttribute('data-budget', 'critical');
    } else if (pct > 0.7) {
      this.fillEl.style.backgroundColor = COLOR_WARNING;
      this.fillEl.setAttribute('data-budget', 'warning');
    } else {
      this.fillEl.style.backgroundColor = COLOR_OK;
      this.fillEl.setAttribute('data-budget', 'ok');
    }

    // Label text
    const usedFmt = formatTokenCount(safeUsed);
    const maxFmt  = formatTokenCount(this.maxTokens);
    this.labelEl.textContent = `${usedFmt} / ${maxFmt} tokens`;

    // Tooltip for accessibility / hover
    this.el.title = `Context: ${usedFmt} of ${maxFmt} tokens used (${pctPx}%)`;
  }

  /**
   * Update the maximum token budget.
   * Useful when the user changes the context-window setting at runtime.
   *
   * @param maxTokens - New total context window size in tokens.
   */
  setMax(maxTokens: number): void {
    this.maxTokens = Math.max(1, maxTokens);
  }

  /**
   * Remove the bar element from the DOM.
   * Call this when the parent view is closed to avoid memory leaks.
   */
  destroy(): void {
    this.el.remove();
  }
}
