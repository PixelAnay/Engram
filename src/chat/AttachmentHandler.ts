/**
 * AttachmentHandler.ts
 * Handles file attachments in the chat input — images and PDF-to-image conversion.
 * Uses the bundled pdfjs-dist package instead of loading from CDN at runtime.
 */

import { Notice } from 'obsidian';

export interface Attachment {
  name: string;
  type: string;
  /** base64 data URL (image/jpeg or other) for images */
  dataUrl?: string;
  /** raw text content for text files */
  content?: string;
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
/** The slice of the pdfjs API this plugin uses. */
interface PdfPage {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
}

interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}

interface PdfJsLib {
  getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDocument> };
}

async function getPdfJs(): Promise<PdfJsLib> {
  // Dynamic import — esbuild will bundle these at build time
  const pdfjs = (await import('pdfjs-dist/build/pdf.mjs')) as PdfJsLib;
  const pdfjsWorker: unknown = await import('pdfjs-dist/build/pdf.worker.mjs');
  (window as unknown as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;
  return pdfjs;
}

async function renderPdfPageToDataUrl(pdfDoc: PdfDocument, pageNum: number): Promise<string> {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = createEl('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas context');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL('image/jpeg', 0.85);
}

// ── Page-range modal ──────────────────────────────────────────────────────────

function showPdfPageRangeModal(
  fileName: string,
  totalPages: number,
  onConfirm: (from: number, to: number) => void,
  onCancel: () => void
): void {
  const overlay = createDiv({ cls: 'engram-modal-overlay' });

  const modal = overlay.createDiv({ cls: 'engram-modal' });

  const title = modal.createDiv({ cls: 'engram-modal-title' });
  title.textContent = `📄 PDF: ${fileName}`;

  const subtitle = modal.createDiv({ cls: 'engram-modal-subtitle' });
  subtitle.textContent = `${totalPages} pages — select which pages to send`;

  const row = modal.createDiv({ cls: 'engram-modal-row' });

  const fromLabel = row.createEl('label');
  fromLabel.textContent = 'From page';
  const fromInput = row.createEl('input', { cls: 'engram-modal-input' });
  fromInput.type = 'number';
  fromInput.min = '1';
  fromInput.max = String(totalPages);
  fromInput.value = '1';

  const toLabel = row.createEl('label');
  toLabel.textContent = 'To page';
  const toInput = row.createEl('input', { cls: 'engram-modal-input' });
  toInput.type = 'number';
  toInput.min = '1';
  toInput.max = String(totalPages);
  toInput.value = String(Math.min(totalPages, 14));

  const warning = modal.createDiv({ cls: 'engram-modal-warning' });
  warning.textContent = '⚠️ Each page is sent as an image. More pages = larger context. Recommend ≤ 14.';

  const btns = modal.createDiv({ cls: 'engram-modal-btns' });

  const cancelBtn = btns.createEl('button', { cls: 'engram-modal-cancel' });
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => { overlay.remove(); onCancel(); });

  const confirmBtn = btns.createEl('button', { cls: 'engram-modal-confirm' });
  confirmBtn.textContent = 'Attach pages';
  confirmBtn.addEventListener('click', () => {
    const from = Math.max(1, Math.min(totalPages, parseInt(fromInput.value) || 1));
    const to = Math.max(from, Math.min(totalPages, parseInt(toInput.value) || totalPages));
    overlay.remove();
    onConfirm(from, to);
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { overlay.remove(); onCancel(); }
  });

  activeDocument.body.appendChild(overlay);
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
    const MAX_SIZE = 10 * 1024 * 1024; // 10MB limit (C-06)

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.size > MAX_SIZE) {
        new Notice(`File "${f.name}" exceeds the 10MB size limit.`);
        continue;
      }
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
        const renderPages = async (from: number, to: number): Promise<void> => {
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
              console.error(`[Engram] Failed to render PDF page ${p}:`, e);
            }
          }
          new Notice(`✅ Loaded ${to - from + 1} pages from ${file.name}`);
          resolve();
        };
        showPdfPageRangeModal(
          file.name,
          totalPages,
          (from, to) => { void renderPages(from, to); },
          () => resolve()
        );
      });
    } catch (err) {
      console.error('[Engram] PDF parsing error', err);
      new Notice('Failed to parse PDF pages into images.');
    }
    return result;
  }

  /** Read a generic file (image, text, etc.). Reads text files as plain text, others as base64 data URLs. */
  private async processGenericFile(file: File): Promise<Attachment | null> {
    if (this.isTextFile(file)) {
      return new Promise<Attachment | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          resolve({
            name: file.name,
            type: file.type || 'text/plain',
            content: reader.result as string,
          });
        };
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
      });
    }

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

  private isTextFile(file: File): boolean {
    if (file.type && (
      file.type.startsWith('text/') || 
      file.type === 'application/json' || 
      file.type === 'application/xml' || 
      file.type === 'application/javascript' ||
      file.type === 'application/x-javascript' ||
      file.type === 'application/typescript'
    )) {
      return true;
    }
    const textExtensions = [
      '.txt', '.md', '.markdown', '.json', '.js', '.ts', '.tsx', '.jsx',
      '.html', '.css', '.py', '.go', '.rs', '.c', '.cpp', '.h', '.sh',
      '.yml', '.yaml', '.ini', '.csv', '.log'
    ];
    const nameLower = file.name.toLowerCase();
    return textExtensions.some(ext => nameLower.endsWith(ext));
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

    // Prepend all text attachments to the main prompt text
    let enrichedText = text;
    const textAttachments = attachments.filter(att => att.content !== undefined);
    const imageAttachments = attachments.filter(att => att.content === undefined);

    if (textAttachments.length > 0) {
      const textBlocks = textAttachments.map(att => {
        return `[Attachment: ${att.name}]\n\`\`\`\n${att.content}\n\`\`\``;
      }).join('\n\n');
      enrichedText = textBlocks + (enrichedText ? `\n\n${enrichedText}` : '');
    }

    if (enrichedText) {
      parts.push({ type: 'text', text: enrichedText });
    }

    for (const att of imageAttachments) {
      if (forHistory) {
        // Store only a placeholder — do NOT persist blobs in saved history
        parts.push({ type: 'text', text: `[Attachment: ${att.name}]` });
      } else {
        if (att.dataUrl) {
          parts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
        }
      }
    }
    return parts;
  }
}
