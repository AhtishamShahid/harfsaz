// File ▸ Import: bring PDF and InPage documents into Harfsaz.
//
// Both importers produce a fresh Harfsaz document (they never merge into the
// open one), guard unsaved changes like Open does, and report what they could
// and could not recover — import is lossy by nature and the user should know
// which kind of lossy.

import { open as openDialog, message } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { useDoc, DocFile, Page, TextFrame } from "./store";
import { isTauri, importInpage, type InpageDoc, type InpageSpan } from "./tauri";
import { ensureFontFace, getFont } from "./font";
import { escapeHtml } from "../editor/sanitize";
import { importPdfBytes } from "./importPdf";
import { pickFile } from "./download";

const A4 = { width: 794, height: 1123 };
const MARGIN = 40;

function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return (parts[parts.length - 1] || "Imported").replace(/\.[^.]+$/, "");
}

function confirmDiscard(): boolean {
  const { dirty } = useDoc.getState();
  return !dirty || confirm("Discard unsaved changes and import a new document?");
}

let seq = 0;
const nid = (p: string) => `${p}-imp-${++seq}`;

/** A page-filling text frame, matching the store's default writing frame. */
function pageFrame(text: string, lang: TextFrame["lang"], fontKey: string, fontSize: number): TextFrame {
  return {
    id: nid("frame"),
    kind: "text",
    x: MARGIN,
    y: MARGIN,
    width: A4.width - MARGIN * 2,
    height: A4.height - MARGIN * 2,
    text,
    html: "",
    fontSize,
    fontKey,
    lang,
    dir: lang === "en" ? "ltr" : "rtl",
    bold: false,
    italic: false,
    underline: false,
    align: lang === "en" ? "left" : "right",
    color: "#1a1714",
    lineHeight: 1.7,
    letterSpacing: 0,
    fill: "transparent",
    borderWidth: 0,
    borderColor: "#e3dccf",
    isPageFrame: true,
  };
}

/**
 * Split paragraphs into A4 pages by a character budget.
 *
 * Harfsaz has no page-to-page text flow yet, so a long text must be paginated
 * at import time. The budget is derived from the default frame geometry at the
 * given font size (≈ lines × chars-per-line for Nastaliq metrics); it is an
 * approximation — pages may run slightly short or long until real flow lands.
 */
export function paginate(paragraphs: string[], fontSize: number): string[] {
  const frameW = A4.width - MARGIN * 2;
  const frameH = A4.height - MARGIN * 2;
  const lines = Math.floor(frameH / (fontSize * 1.7));
  const charsPerLine = Math.floor(frameW / (fontSize * 0.55));
  const budget = Math.max(200, lines * charsPerLine);

  const pages: string[] = [];
  let cur: string[] = [];
  let used = 0;

  const flush = () => {
    if (cur.length) pages.push(cur.join("\n"));
    cur = [];
    used = 0;
  };

  for (const p of paragraphs) {
    // Each paragraph costs its characters plus a partial line for the break.
    let para = p;
    while (para.length > budget) {
      // Split an over-long paragraph at a sentence end (۔ . ؟ !) near the budget.
      const cut = findCut(para, budget - used > 200 ? budget - used : budget);
      const head = para.slice(0, cut).trim();
      if (head) cur.push(head);
      flush();
      para = para.slice(cut).trim();
    }
    const cost = para.length + charsPerLine / 2;
    if (used + cost > budget && cur.length) flush();
    cur.push(para);
    used += cost;
  }
  flush();
  return pages.length ? pages : [""];
}

function findCut(s: string, at: number): number {
  const window = s.slice(0, Math.min(s.length, at));
  const m = Math.max(window.lastIndexOf("۔"), window.lastIndexOf("."), window.lastIndexOf("؟"), window.lastIndexOf("!"));
  if (m > at * 0.5) return m + 1;
  const sp = window.lastIndexOf(" ");
  return sp > at * 0.5 ? sp + 1 : at;
}

function load(pages: Page[], name: string) {
  const doc: DocFile = { version: 1, pages };
  useDoc.getState().loadDocument(doc, null, name);
  // It is unsaved new content: treat it as dirty so the close guard protects it.
  useDoc.setState({ dirty: true });
}

// ── InPage ──────────────────────────────────────────────────────────────────

// Gulzar is a Lahori-style Nastaliq like InPage's Noori Nastaliq, so it keeps
// InPage documents compact. InPage itself uses 130% leading; Gulzar needs a
// little more (1.5) before tall letters touch the line below.
const INPAGE_FONT = "gulzar";
const INPAGE_LINE_HEIGHT = 1.5;
const PX_PER_PT = 96 / 72;

/** A word with its trailing space; bold can change inside a word. */
type Token = { text: string; bold: boolean }[];
interface StyledParagraph {
  tokens: Token[];
  /** Font size relative to the frame's base size (1 = base). */
  em: number;
}

/** Most common point size by character count; 0 when none is set. */
function dominantSize(spans: InpageSpan[]): number {
  const weight = new Map<number, number>();
  for (const s of spans) if (s.size_pt > 0) weight.set(s.size_pt, (weight.get(s.size_pt) ?? 0) + s.text.length);
  let best = 0;
  let most = -1;
  for (const [size, n] of weight) if (n > most) [best, most] = [size, n];
  return best;
}

/** Split a paragraph into whole words, even where bold changes mid-word, so a
 *  page break can never fall inside a word. */
function wordTokens(spans: InpageSpan[]): Token[] {
  const chars = spans.flatMap((s) => Array.from(s.text, (c) => ({ c, bold: s.bold })));
  const text = chars.map((x) => x.c).join("");
  const tokens: Token[] = [];
  let at = 0;
  for (const word of text.match(/\S+\s*|\s+/g) ?? []) {
    const n = Array.from(word).length;
    const token: Token = [];
    for (const { c, bold } of chars.slice(at, at + n)) {
      const last = token[token.length - 1];
      if (last && last.bold === bold) last.text += c;
      else token.push({ text: c, bold });
    }
    tokens.push(token);
    at += n;
  }
  return tokens;
}

function paragraphHtml(p: StyledParagraph, from = 0, to = p.tokens.length): string {
  const parts: { text: string; bold: boolean }[] = [];
  for (const segment of p.tokens.slice(from, to).flat()) {
    const last = parts[parts.length - 1];
    if (last && last.bold === segment.bold) last.text += segment.text;
    else parts.push({ ...segment });
  }
  const inner = parts
    .map((x) => (x.bold ? `<span style="font-weight: 700;">${escapeHtml(x.text)}</span>` : escapeHtml(x.text)))
    .join("");
  const em = Math.round(p.em * 1000) / 1000;
  return `<div data-harfsaz-style="body" style="font-size: ${em}em; line-height: inherit; margin-block-start: 0px; margin-block-end: 0px;">${inner || "<br>"}</div>`;
}

/**
 * Lay an InPage document out on its own page size, keeping bold and paragraph
 * sizes. Pages are filled by MEASURING the text in a hidden copy of the page
 * frame (same width, font, size and leading), so they break where the editor
 * will actually wrap instead of by a character-count guess.
 */
async function formattedInpagePages(doc: InpageDoc): Promise<Page[] | null> {
  const page = doc.page!;
  const styled = doc.styled!;
  const base = dominantSize(styled.flat()) || 15;
  const fontSize = Math.round(base * PX_PER_PT);
  const width = Math.round(page.width_pt * PX_PER_PT);
  const height = Math.round(page.height_pt * PX_PER_PT);
  const frameX = Math.round(page.margin_left_pt * PX_PER_PT);
  const frameY = Math.round(page.margin_top_pt * PX_PER_PT);
  const frameW = width - frameX - Math.round(page.margin_right_pt * PX_PER_PT);
  const frameH = height - frameY - Math.round(page.margin_bottom_pt * PX_PER_PT);
  if (frameW < 100 || frameH < 100) return null;

  const paragraphs: StyledParagraph[] = styled.map((spans) => ({
    em: (dominantSize(spans) || base) / base,
    tokens: wordTokens(spans),
  }));

  try {
    await ensureFontFace(INPAGE_FONT);
    await (document as Document & { fonts: FontFaceSet }).fonts.ready;
  } catch {
    return null; // without the real font, measurement would be meaningless
  }

  // Mirror the editor: .text-frame-edit content styled like TextFrameView's textStyle.
  const probe = document.createElement("div");
  probe.className = "text-frame-edit";
  probe.dir = "rtl";
  Object.assign(probe.style, {
    position: "absolute", left: "-100000px", top: "0", visibility: "hidden",
    width: `${frameW}px`, fontSize: `${fontSize}px`, lineHeight: String(INPAGE_LINE_HEIGHT), textAlign: "right",
    fontFamily: `"${getFont(INPAGE_FONT).cssFamily}", serif`, paddingTop: "6px",
  });
  document.body.appendChild(probe);
  // The editor is pulled up by ~0.32em and pads 6px, and clips its content at
  // the frame's height measured from its own top (see editor/flow.ts).
  const limit = frameH;
  const fits = (html: string) => {
    probe.innerHTML = html;
    return probe.scrollHeight <= limit;
  };

  const pagesHtml: string[] = [];
  let current = "";
  try {
    for (const p of paragraphs) {
      let from = 0;
      while (from < p.tokens.length || (from === 0 && p.tokens.length === 0)) {
        const whole = paragraphHtml(p, from);
        if (fits(current + whole)) {
          current += whole;
          break;
        }
        // Largest number of words from `from` that still fits on this page.
        let lo = from, hi = p.tokens.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (fits(current + paragraphHtml(p, from, mid))) lo = mid;
          else hi = mid - 1;
        }
        if (lo > from) {
          current += paragraphHtml(p, from, lo);
          from = lo;
        } else if (!current) {
          // A single word taller/wider than the page: place it anyway.
          current = paragraphHtml(p, from, from + 1);
          from += 1;
        }
        pagesHtml.push(current);
        current = "";
      }
    }
    if (current || pagesHtml.length === 0) pagesHtml.push(current);
  } finally {
    probe.remove();
  }

  return pagesHtml.map((html) => {
    // One line per paragraph block, entities decoded (escapeHtml only emits these three).
    const text = html.replace(/<\/div>/g, "\n").replace(/<[^>]+>/g, "").replace(/\n$/, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return {
      id: nid("page"),
      width,
      height,
      frames: [{
        ...pageFrame(text, "ur", INPAGE_FONT, fontSize),
        x: frameX,
        y: frameY,
        width: frameW,
        height: frameH,
        html,
        lineHeight: INPAGE_LINE_HEIGHT,
      }],
    };
  });
}

/** Import an InPage .inp file into a new document. */
export async function importInpageDocument(): Promise<boolean> {
  if (!isTauri()) {
    alert("InPage (.inp) import runs in the desktop app — its Rust decoder reads the InPage record format. Download it from harfsaz.com/download.");
    return false;
  }
  if (!confirmDiscard()) return false;

  const picked = await openDialog({
    filters: [{ name: "InPage Document", extensions: ["inp"] }],
    multiple: false,
  });
  if (!picked || Array.isArray(picked)) return false;

  let result: InpageDoc;
  try {
    result = await importInpage(picked);
  } catch (e) {
    await message(String(e), { title: "Could not import InPage file", kind: "error" });
    return false;
  }

  const formatted = result.styled && result.page ? await formattedInpagePages(result) : null;
  let pages: Page[];
  if (formatted) {
    pages = formatted;
  } else {
    const fontSize = 28;
    pages = paginate(result.paragraphs, fontSize).map((t) => ({
      id: nid("page"),
      width: A4.width,
      height: A4.height,
      frames: [pageFrame(t, "ur", INPAGE_FONT, fontSize)],
    }));
  }
  load(pages, baseName(picked));

  const words = result.paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
  await message(
    `Imported ${result.paragraphs.length} paragraphs (${words.toLocaleString()} words) onto ${pages.length} pages.\n\n` +
      (formatted
        ? "Page size, margins, bold and paragraph font sizes were imported from the InPage file. Fonts, borders, text boxes and images are not imported yet, and mixed sizes within one line use the paragraph's main size."
        : result.legacy_format
          ? "Text was recovered from the InPage record format. Fonts, frames and page layout are not stored in a readable form and were not imported — the text has been paginated onto A4 pages."
          : "This file uses the newer InPage format, which can only be read heuristically; check the text carefully for missing passages."),
    { title: "InPage import", kind: "info" }
  );
  return true;
}

// ── PDF ─────────────────────────────────────────────────────────────────────

/** Import a PDF into a new document (text layer → positioned frames). */
export async function importPdfDocument(
  onProgress?: (done: number, total: number) => void
): Promise<boolean> {
  if (!confirmDiscard()) return false;

  let picked: string;
  let bytes: Uint8Array;
  if (isTauri()) {
    const chosen = await openDialog({
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      multiple: false,
    });
    if (!chosen || Array.isArray(chosen)) return false;
    picked = chosen;
    try {
      bytes = await readFile(picked);
    } catch (e) {
      await notify(`Could not read that file.\n\n${e}`, "Import PDF", "error");
      return false;
    }
  } else {
    // Browser: pdf.js runs client-side, so PDF import works in the web editor too.
    const file = await pickFile("application/pdf,.pdf");
    if (!file) return false;
    picked = file.name;
    bytes = new Uint8Array(await file.arrayBuffer());
  }

  let res;
  try {
    res = await importPdfBytes(bytes, { onProgress });
  } catch (e) {
    await notify(`Could not parse this PDF.\n\n${e}`, "Import PDF", "error");
    return false;
  }
  if (res.pages.length === 0) {
    await notify("The PDF has no pages.", "Import PDF", "warning");
    return false;
  }

  load(res.pages, baseName(picked));

  const parts = [`Imported ${res.pages.length} pages.`];
  if (res.textPages) parts.push(`${res.textPages} pages had a text layer and were placed as editable frames.`);
  if (res.scannedPages)
    parts.push(
      `${res.scannedPages} pages had no text (scanned images). They were placed as images — use Scan handwriting (OCR) on those pages to make the text editable.`
    );
  parts.push("Images and vector graphics inside text pages are not imported yet; fonts are approximated by script.");
  await notify(parts.join("\n\n"), "PDF import", "info");
  return true;
}

/** Native message box on desktop; alert() in the browser. */
async function notify(text: string, title: string, kind: "info" | "warning" | "error"): Promise<void> {
  if (isTauri()) await message(text, { title, kind });
  else alert(`${title}\n\n${text}`);
}
