// Obsidian runs in a browser; plugin code uses window.setTimeout etc. for popout-window support.
(globalThis as unknown as { window: unknown }).window = globalThis;
