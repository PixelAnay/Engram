/**
 * AttachmentHandler.ts
 * Handles file attachments in the chat input — images and PDF-to-image conversion.
 * Uses the bundled pdfjs-dist package instead of loading from CDN at runtime.
 */

import { Notice } from 'obsidian';

export interface Attachment {
  name: string;
  type: string;
  /** base64 data URL (image/jpeg or other) */
  dataUrl: string;
}

/** Lightweight reference stored in chat history — no blob, just metadata. */
export interface AttachmentRef {
  name: string;
  type: string;
  /** Placeholder marker so we know there was an attachment here */
  isRef: true;
}

// ── PDF rendering ─────────────────────────────────────────────────────────────

/**
 * Lazily load pdfjs-dist (bundled with the plugin).
 * pdfjs-dist v5.x ships ESM-only as build/pdf.mjs.
 * We disable the worker (fakeworker / main-thread mode) which is fine for
 * rendering a handful of pages in an Obsidian plugin context.
 */
async function getPdfJs(): Promise<any> {
  // Dynamic import — esbuild will bundle this at build time
  // Worker must be disabled for main-thread / bundled mode
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs' as any);
  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = '';
  }
  return pdfjs;
}

function renderPdfPageToDataUrl(pdfDoc: any, pageNum: number): Promise<string> {
  return new Promise(async (resolve, reject) => {
    try {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('No canvas context'));
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: ctx, viewport }).promise;
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    } catch (e) {
      reject(e);
    }
  });
}

// ── Page-range modal ──────────────────────────────────────────────────────────

function showPdfPageRangeModal(
  fileName: string,
  totalPages: number,
  onConfirm: (from: number, to: number) => void,
  onCancel: () => void
): void {
  const overlay = document.createElement('div');
  overlay.className = 'llama-modal-overlay';

  const modal = overlay.appendChild(document.createElement('div'));
  modal.className = 'llama-modal';

  const title = modal.appendChild(document.createElement('div'));
  title.className = 'llama-modal-title';
  title.textContent = `📄 PDF: ${fileName}`;

  const subtitle = modal.appendChild(document.createElement('div'));
  subtitle.className = 'llama-modal-subtitle';
  subtitle.textContent = `${totalPages} pages — select which pages to send`;

  const row = modal.appendChild(document.createElement('div'));
  row.className = 'llama-modal-row';

  const fromLabel = row.appendChild(document.createElement('label'));
  fromLabel.textContent = 'From page';
  const fromInput = row.appendChild(document.createElement('input'));
  fromInput.type = 'number';
  fromInput.min = '1';
  fromInput.max = String(totalPages);
  fromInput.value = '1';
  fromInput.className = 'llama-modal-input';

  const toLabel = row.appendChild(document.createElement('label'));
  toLabel.textContent = 'To page';
  const toInput = row.appendChild(document.createElement('input'));
  toInput.type = 'number';
  toInput.min = '1';
  toInput.max = String(totalPages);
  toInput.value = String(Math.min(totalPages, 14));
  toInput.className = 'llama-modal-input';

  const warning = modal.appendChild(document.createElement('div'));
  warning.className = 'llama-modal-warning';
  warning.textContent = '⚠️ Each page is sent as an image. More pages = larger context. Recommend ≤ 14.';

  const btns = modal.appendChild(document.createElement('div'));
  btns.className = 'llama-modal-btns';

  const cancelBtn = btns.appendChild(document.createElement('button'));
  cancelBtn.textContent = 'Cancel';
  cancelBtn.className = 'llama-modal-cancel';
  cancelBtn.addEventListener('click', () => { overlay.remove(); onCancel(); });

  const confirmBtn = btns.appendChild(document.createElement('button'));
  confirmBtn.textContent = 'Attach pages';
  confirmBtn.className = 'llama-modal-confirm';
  confirmBtn.addEventListener('click', () => {
    const from = Math.max(1, Math.min(totalPages, parseInt(fromInput.value) || 1));
    const to = Math.max(from, Math.min(totalPages, parseInt(toInput.value) || totalPages));
    overlay.remove();
    onConfirm(from, to);
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { overlay.remove(); onCancel(); }
  });

  document.body.appendChild(overlay);
  fromInput.focus();
}

// ── AttachmentHandler ─────────────────────────────────────────────────────────

export class AttachmentHandler {
  /**
   * Process a FileList from an <input type="file"> event.
   * Returns the list of processed attachments (images or PDF pages).
   */
  async processFiles(files: FileList): Promise<Attachment[]> {
    const result: Attachment[] = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.type === 'application/pdf') {
        const pages = await this.processPdf(f);
        result.push(...pages);
      } else {
        const att = await this.processGenericFile(f);
        if (att) result.push(att);
      }
    }

    return result;
  }

  /**
   * Convert a PDF file to per-page JPEG attachments.
   * Shows a page-range modal to let the user choose which pages to include.
   */
  private async processPdf(file: File): Promise<Attachment[]> {
    const result: Attachment[] = [];
    try {
      const pdfjsLib = await getPdfJs();
      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
      const totalPages = pdfDoc.numPages;

      await new Promise<void>((resolve) => {
        showPdfPageRangeModal(
          file.name,
          totalPages,
          async (from, to) => {
            new Notice(`Processing pages ${from}–${to} of ${file.name}…`);
            for (let p = from; p <= to; p++) {
              try {
                const dataUrl = await renderPdfPageToDataUrl(pdfDoc, p);
                result.push({
                  name: `${file.name} (Page ${p})`,
                  type: 'image/jpeg',
                  dataUrl,
                });
              } catch (e) {
                console.error(`[LLAMA Chat] Failed to render PDF page ${p}:`, e);
              }
            }
            new Notice(`✅ Loaded ${to - from + 1} pages from ${file.name}`);
            resolve();
          },
          () => resolve()
        );
      });
    } catch (err) {
      console.error('[LLAMA Chat] PDF parsing error', err);
      new Notice('Failed to parse PDF pages into images.');
    }
    return result;
  }

  /** Read a generic file (image, text, etc.) as a base64 data URL. */
  private async processGenericFile(file: File): Promise<Attachment | null> {
    return new Promise<Attachment | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve({
          name: file.name,
          type: file.type || 'application/octet-stream',
          dataUrl: reader.result as string,
        });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  /**
   * Build the content parts for a message that includes attachments.
   * Strips large base64 blobs when `forHistory` is true — stores only metadata.
   */
  static buildContentParts(
    text: string,
    attachments: Attachment[],
    forHistory = false
  ): Array<{ type: string; text?: string; image_url?: { url: string } }> {
    const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
    if (text) parts.push({ type: 'text', text });
    for (const att of attachments) {
      if (forHistory) {
        // Store only a placeholder — do NOT persist blobs in saved history
        parts.push({ type: 'text', text: `[Attachment: ${att.name}]` });
      } else {
        parts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
      }
    }
    return parts;
  }
}
