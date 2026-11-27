// True vector PDF export.
//
// The raster path (see pdf.ts) screenshots each page with html2canvas and embeds
// a JPEG, which scales badly and bloats the file. This module instead describes
// the pages to the Rust side (pdf.rs), which lays the text out with the same
// shaper as print preview and writes the PDF itself, so the output is
// resolution-independent — what a printer or publisher actually needs.
//
// ── Why Rust writes the PDF ─────────────────────────────────────────────────
// For Nastaliq the PDF has to address the shaped GLYPH IDS (not the
// characters), because one character maps to a context-dependent glyph. jsPDF
// cannot express that, so text used to be drawn as glyph outlines one path at a
// time: seconds of work and 60–90 MB for an 18-page document. pdf.rs embeds the
// font once and writes each glyph by id, so the file is small and fast to make
// and print.

import { shapePaint, shapePath } from "../editor/shapeGeometry";
import { needsRichLayout } from "../editor/paragraphs";
import { renderPagesToPdfFile } from "./pdf";
import { renderVectorPdf, PrintItem } from "./tauri";
import { ensureShaperFont } from "./font";
import { useDoc, Page } from "./store";

/** Parse a CSS hex/rgb colour into 0-255 components; falls back to black. */
function parseColor(c: string | undefined): [number, number, number] {
  const channel = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  if (!c) return [0, 0, 0];
  const hex = c.trim();
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (m3) {
    return [
      parseInt(m3[1] + m3[1], 16),
      parseInt(m3[2] + m3[2], 16),
      parseInt(m3[3] + m3[3], 16),
    ];
  }
  const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (m6) {
    return [parseInt(m6[1], 16), parseInt(m6[2], 16), parseInt(m6[3], 16)];
  }
  const rgb = /rgba?\(([^)]+)\)/i.exec(hex);
  if (rgb) {
    const parts = rgb[1].split(",").map((p) => parseFloat(p.trim()));
    if (parts.length >= 3 && parts.every((p) => Number.isFinite(p))) {
      return [channel(parts[0]), channel(parts[1]), channel(parts[2])];
    }
  }
  return [0, 0, 0];
}

/**
 * An image frame's data as PNG or JPEG, which the PDF writer embeds. WebP is
 * converted to PNG; other formats are left out, as before.
 */
async function imageData(src: string | undefined): Promise<string | null> {
  if (!src) return null;
  if (/^data:image\/(png|jpe?g);base64,/i.test(src)) return src;
  if (!/^data:image\/webp/i.test(src)) return null;
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null; // a single bad image must not abort the whole export
  }
}

/** What a page draws, in document order. Text frames name their shaper font. */
async function pageItems(page: Page): Promise<PrintItem[]> {
  const items: PrintItem[] = [];
  for (const frame of page.frames) {
    const kind = frame.kind ?? "text";
    const { x, y, width, height } = frame;
    if (kind === "text") {
      // Frame background/border, for text frames that have one.
      const hasFill = !!frame.fill && frame.fill !== "transparent";
      const hasStroke = frame.borderWidth > 0;
      if (hasFill || hasStroke) {
        items.push({
          kind: "rect", x, y, width, height,
          fill: hasFill ? parseColor(frame.fill) : null,
          stroke: hasStroke ? parseColor(frame.borderColor) : null,
          lineWidth: frame.borderWidth,
        });
      }
      if (!frame.text.trim()) continue;
      items.push({
        kind: "text", x, y, width,
        fontKey: await ensureShaperFont(frame.fontKey),
        fontSize: frame.fontSize,
        align: frame.align ?? "right",
        lineHeight: frame.lineHeight ?? null,
        color: parseColor(frame.color),
        text: frame.text,
      });
    } else if (kind === "image") {
      const data = await imageData(frame.src);
      if (data) items.push({ kind: "image", x, y, width, height, data });
    } else if (kind === "shape") {
      const shape = frame.shape ?? "rect";
      const paint = shapePaint(shape, frame.fill, frame.borderWidth, frame.borderColor);
      const hasFill = paint.fill !== "none";
      const hasStroke = paint.strokeWidth > 0 && paint.stroke !== "transparent" && paint.stroke !== "none";
      if (!hasFill && !hasStroke) continue;
      items.push({
        kind: "path", x, y,
        d: shapePath(shape, width, height, paint.strokeWidth),
        fill: hasFill ? parseColor(paint.fill) : null,
        stroke: hasStroke ? parseColor(paint.stroke) : null,
        lineWidth: paint.strokeWidth,
      });
    }
  }
  return items;
}

/**
 * Render the whole document to a true-vector PDF and write it to a temp file.
 * Returns the absolute path.
 */
export async function renderPagesToVectorPdf(): Promise<string> {
  const { pages } = useDoc.getState();
  if (pages.length === 0) throw new Error("No pages to export.");

  const first = pages[0];
  // Preserve styled paragraphs/lists instead of flattening them into plain text.
  if (pages.some((page) => page.pageNumber || page.frames.some((frame) => needsRichLayout(frame.html)))) {
    return renderPagesToPdfFile({ pageWidthPx: first.width, pageHeightPx: first.height,
      orientation: first.width > first.height ? "landscape" : "portrait" });
  }
  const described = await Promise.all(
    pages.map(async (page) => ({ width: page.width, height: page.height, items: await pageItems(page) }))
  );
  return renderVectorPdf(described);
}
