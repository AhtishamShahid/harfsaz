// Text flow between pages.
//
// Every page has one main writing frame (isPageFrame). Together those frames
// form one story: when a page's text no longer fits, the lines that do not fit
// move to the start of the next page (a new page is added at the end when
// needed), and when a page has room, lines move back from the next page.
//
// A page the user added (Insert ▸ Page) starts fresh, like after a page break
// in a word processor (TextFrame.pageBreak): text is never pulled up from it or
// pushed into it, and overflow from the page before it goes onto a new page
// inserted in between. Every other page continues the previous one.
//
// The editors are uncontrolled contentEditables, so flow works on their live
// DOM (that is the only place the real line breaks exist) and then writes the
// resulting HTML back to the store in one go.
//
// A paragraph split across a page break keeps both parts as separate blocks;
// the later part carries `data-harfsaz-cont` so the two are joined again when
// the text flows back, and so caret positions can be counted the same way
// before and after a pass.
import { useEffect } from "react";
import { useDoc, type Page, type TextFrame } from "../lib/store";
import { useUi } from "../lib/ui";
import { ensureFontFace } from "../lib/font";
import { plainText, shownInPage } from "./sanitize";

export const CONT = "data-harfsaz-cont";
const BLOCK_TAGS = new Set(["DIV", "P", "OL", "UL", "TABLE", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"]);
/** Blocks whose lines can be split between pages. Lists and tables move whole. */
const SPLITTABLE = new Set(["DIV", "P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"]);
const INLINE_WRAPPERS = new Set(["SPAN", "B", "STRONG", "EM", "I", "U", "S", "STRIKE", "SUP", "SUB"]);

export interface Link {
  pageIndex: number;
  page: Page;
  frame: TextFrame;
  el: HTMLElement;
  /** Usable height of the editor in page px (see TextFrameView's textStyle). */
  limit: number;
}

function mainFrame(page: Page): TextFrame | undefined {
  return page.frames.find((f) => f.isPageFrame && (f.kind ?? "text") === "text");
}

function editorFor(frameId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.text-frame-edit[data-frame-id="${CSS.escape(frameId)}"]`);
}

/** The page frames in page order. A page whose editor is not showing (it is
 *  displaying review suggestions) ends the chain, so text never jumps over it. */
export function buildChain(pages: Page[]): Link[] {
  const links: Link[] = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const frame = mainFrame(page);
    if (!frame) continue;
    const el = editorFor(frame.id);
    if (!el || !el.isContentEditable) break;
    // The editor is pulled up by 0.32em (TextFrameView) but keeps the frame's
    // height and clips at its own bottom, so text measured from the editor's
    // top must end within frame.height. Allowing the extra 0.32em let a line
    // hang below the page, cut in half.
    links.push({ pageIndex, page, frame, el, limit: frame.height });
  }
  return links;
}

// ── measuring ────────────────────────────────────────────────────────────────

/** Page-px per screen px for this editor (the canvas is zoomed with a transform). */
function scaleOf(el: HTMLElement): number {
  const h = el.offsetHeight;
  return h > 0 ? el.getBoundingClientRect().height / h : 1;
}

function blocks(el: HTMLElement): HTMLElement[] {
  return Array.from(el.children) as HTMLElement[];
}

/** Height the text actually uses, in page px from the editor's top. */
function used(el: HTMLElement): number {
  const last = el.lastElementChild;
  if (!last) return 0;
  return (last.getBoundingClientRect().bottom - el.getBoundingClientRect().top) / scaleOf(el);
}

function lineHeightOf(block: HTMLElement): number {
  const cs = getComputedStyle(block);
  const lh = parseFloat(cs.lineHeight);
  return Number.isFinite(lh) ? lh : parseFloat(cs.fontSize) * 1.2;
}

function isEmptyBlock(b: Element): boolean {
  return (b.textContent ?? "") === "" && !b.querySelector("img,table,ol,ul");
}

/** No text at all (a fresh page shows one empty line, which is not content). */
function isEmpty(el: HTMLElement): boolean {
  const bs = blocks(el);
  return bs.length === 0 || (bs.length === 1 && isEmptyBlock(bs[0]));
}

function overflows(link: Link): boolean {
  return used(link.el) > link.limit + 0.5;
}

/** Whether the first line of `next` would fit at the end of `link`. */
function canPull(link: Link, next: HTMLElement): boolean {
  const first = next.firstElementChild as HTMLElement | null;
  if (!first) return false;
  return link.limit - used(link.el) >= lineHeightOf(first) - 0.5;
}

interface LineStart {
  node: Text;
  offset: number;
  /** Bottom of the line, in page px from the editor's top. */
  bottom: number;
  /** Vertical middle of the line's first letter, in page px from the editor's top. */
  center: number;
}

/** A visual line of a block: its middle and bottom, page px from the editor's top. */
interface Line {
  center: number;
  bottom: number;
  /** The first text node with letters on this line. */
  node: Text;
}

/** Combining marks and the second half of surrogate pairs: never a line start. */
const ATTACHED = /[\uDC00-\uDFFF\u0300-\u036F\u064B-\u065F\u0670\u06D6-\u06ED]/;

/**
 * The visual lines of a block, read from one rectangle query per text node.
 * Where a line starts in the text is only looked up when asked (`startOf`),
 * for the few lines a page break falls on. That lookup measures single
 * letters, and in a long run of letters without spaces WebKit re-measures the
 * whole run for each one (about 7 ms a letter): measuring every letter of
 * every line up front froze the editor for minutes on such a document.
 */
function blockLines(el: HTMLElement, block: HTMLElement): { lines: Line[]; startOf: (k: number) => LineStart | null } {
  const elTop = el.getBoundingClientRect().top;
  const scale = scaleOf(el);
  const half = lineHeightOf(block) / 2;
  const lines: Line[] = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (!node.data.trim()) continue;
    range.selectNodeContents(node);
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.height <= 0 || rect.width <= 0) continue;
      const center = ((rect.top + rect.bottom) / 2 - elTop) / scale;
      const last = lines[lines.length - 1];
      if (!last || center > last.center + half) lines.push({ center, bottom: center + half, node });
    }
  }
  /** Middle of letter `i` of `node`, or null when it takes no room (a joiner). */
  const centerOf = (node: Text, i: number): number | null => {
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const rect = range.getBoundingClientRect();
    return rect.height > 0 ? ((rect.top + rect.bottom) / 2 - elTop) / scale : null;
  };
  const startOf = (k: number): LineStart | null => {
    if (k <= 0 || k >= lines.length) return null;
    const { node, center, bottom } = lines[k];
    const text = node.data;
    const above = lines[k - 1].center + half;
    // Whether the first measurable letter from `i` on sits below line k-1.
    // Lines follow the text, so this flips once along the node: bisect for it.
    const below = (i: number): boolean => {
      for (let j = i; j < text.length && j < i + 8; j++) {
        const c = centerOf(node, j);
        if (c !== null) return c > above;
      }
      return true;
    };
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (below(mid)) hi = mid;
      else lo = mid + 1;
    }
    let i = lo;
    while (i < text.length && /\s/.test(text[i])) i++;
    while (i > 0 && i < text.length && ATTACHED.test(text[i])) i--;
    return i < text.length ? { node, offset: i, bottom, center } : null;
  };
  return { lines, startOf };
}

// ── DOM edits ────────────────────────────────────────────────────────────────

/** Put stray top-level text and inline nodes into paragraph blocks. */
function prepare(el: HTMLElement) {
  let run: HTMLElement | null = null;
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((node as Element).tagName)) {
      run = null;
    } else if (!run && node.nodeType === Node.TEXT_NODE && (node as Text).data.trim() === "") {
      node.remove(); // whitespace between blocks
    } else {
      if (!run) {
        run = document.createElement("div");
        el.insertBefore(run, node);
      }
      run.appendChild(node);
    }
  }
}

function sameShallow(a: Element, b: Element): boolean {
  if (a.tagName !== b.tagName || a.attributes.length !== b.attributes.length) return false;
  for (const attr of Array.from(a.attributes)) if (b.getAttribute(attr.name) !== attr.value) return false;
  return true;
}

/** Tidy a block after a split or join so the same text always gives the same HTML. */
function clean(block: HTMLElement) {
  for (const inline of Array.from(block.querySelectorAll("*")).reverse()) {
    if (INLINE_WRAPPERS.has(inline.tagName) && (inline.textContent ?? "") === "" && !inline.querySelector("br,img")) inline.remove();
  }
  const mergeSiblings = (parent: Element) => {
    let child = parent.firstChild;
    while (child) {
      const next = child.nextSibling;
      if (next && child.nodeType === Node.ELEMENT_NODE && next.nodeType === Node.ELEMENT_NODE &&
          INLINE_WRAPPERS.has((child as Element).tagName) && sameShallow(child as Element, next as Element)) {
        while (next.firstChild) child.appendChild(next.firstChild);
        next.remove();
        continue;
      }
      if (child.nodeType === Node.ELEMENT_NODE) mergeSiblings(child as Element);
      child = next;
    }
  };
  mergeSiblings(block);
  block.normalize();
  if ((block.textContent ?? "") !== "") {
    for (const br of Array.from(block.querySelectorAll(":scope > br"))) if (!br.nextSibling || !br.previousSibling) br.remove();
  }
  if (!block.firstChild) block.appendChild(document.createElement("br"));
}

/** Append `from`'s content to the end of `to` (rejoining a split paragraph). */
function join(to: HTMLElement, from: HTMLElement) {
  if (isEmptyBlock(to)) to.replaceChildren();
  if (!isEmptyBlock(from)) while (from.firstChild) to.appendChild(from.firstChild);
  from.remove();
  clean(to);
}

/** Split `block` before (node, offset); the returned later part is marked as a continuation. */
function split(block: HTMLElement, node: Text, offset: number): HTMLElement {
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(block, block.childNodes.length);
  const tail = block.cloneNode(false) as HTMLElement;
  tail.appendChild(range.extractContents());
  tail.setAttribute(CONT, "");
  clean(block);
  clean(tail);
  return tail;
}

/** Put `moving` (in order) at the start of `target`, joining the last of them
 *  with its continuation there. */
function prependAll(target: HTMLElement, moving: HTMLElement[]) {
  if (!moving.length) return;
  if (isEmpty(target)) target.replaceChildren();
  const first = target.firstElementChild as HTMLElement | null;
  const fragment = document.createDocumentFragment();
  for (const b of moving) fragment.appendChild(b);
  target.insertBefore(fragment, first);
  if (first?.hasAttribute(CONT)) join(moving[moving.length - 1], first);
}

/**
 * Move what does not fit on `link` to the start of `target`, working from ONE
 * layout: every block after the first one that crosses the page bottom, plus
 * that block's lines below the bottom. Returns false when nothing can move (a
 * page always keeps its first line).
 *
 * Reading layout after each small move forced the browser to lay the Nastaliq
 * text out again every time (~45 ms per read on a long document); measuring
 * first and then moving everything keeps it to one layout per page.
 */
function pushOverflow(link: Link, target: HTMLElement): boolean {
  const all = blocks(link.el);
  if (!all.length) return false;
  const top = link.el.getBoundingClientRect().top;
  const scale = scaleOf(link.el);
  let k = all.findIndex((b) => (b.getBoundingClientRect().bottom - top) / scale > link.limit + 0.5);
  if (k === -1) k = all.length - 1;
  const block = all[k];
  const { lines, startOf } = SPLITTABLE.has(block.tagName) ? blockLines(link.el, block) : { lines: [], startOf: () => null };
  // The line to split the block at (moving it and the rest), or all / none of it.
  let at: number | "all" | "none" = "all";
  if (lines.length) {
    const firstOut = lines.findIndex((l) => l.bottom > link.limit + 0.5);
    if (firstOut > 0) at = firstOut;
    // The estimate says every line fits but the block still overflows: move its last line.
    else if (firstOut === -1) at = lines.length > 1 ? lines.length - 1 : "all";
  }
  // Never empty a page: keep the first line of its first block.
  if (k === 0 && at === "all") at = lines.length > 1 ? 1 : "none";
  const start = typeof at === "number" ? startOf(at) : null;
  if (typeof at === "number" && !start) at = k === 0 ? "none" : "all";
  const moving: HTMLElement[] = [];
  if (at === "all") moving.push(block);
  else if (start) moving.push(split(block, start.node, start.offset));
  moving.push(...all.slice(k + 1));
  if (!moving.length) return false;
  prependAll(target, moving);
  return true;
}

/**
 * Move as much of the start of `source` as fits into the room left on `link`,
 * from ONE layout of both pages: whole blocks while they fit, then the lines of
 * the next block that fit. Heights measured on `source` are used for `link`
 * (pages share a width); the check after each round catches any difference.
 */
function pullFit(link: Link, source: HTMLElement): boolean {
  const src = blocks(source);
  if (!src.length || isEmpty(source)) return false;
  let free = link.limit - used(link.el);
  const scale = scaleOf(source);
  const sourceTop = source.getBoundingClientRect().top;
  const moving: HTMLElement[] = [];
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    const r = b.getBoundingClientRect();
    const nextTop = src[i + 1]?.getBoundingClientRect().top;
    const h = (Math.max(nextTop ?? r.bottom, r.bottom) - r.top) / scale;
    if (h <= free + 0.5) {
      moving.push(b);
      free -= h;
      continue;
    }
    if (SPLITTABLE.has(b.tagName)) {
      const { lines, startOf } = blockLines(source, b);
      const blockTop = (r.top - sourceTop) / scale;
      let m = 0;
      while (m < lines.length && lines[m].bottom - blockTop <= free + 0.5) m++;
      const start = m >= 1 && m < lines.length ? startOf(m) : null;
      if (start) {
        b.after(split(b, start.node, start.offset)); // the rest stays, as a continuation
        moving.push(b);
      }
    }
    break;
  }
  if (!moving.length) return false;
  moving.forEach((b, n) => {
    const last = link.el.lastElementChild as HTMLElement | null;
    if (n === 0 && isEmpty(link.el)) link.el.replaceChildren(b);
    else if (n === 0 && last && b.hasAttribute(CONT)) join(last, b);
    else link.el.appendChild(b);
  });
  if (!source.firstElementChild) source.appendChild(Object.assign(document.createElement("div"), { innerHTML: "<br>" }));
  return true;
}

/**
 * Lay the blocks in `holder` out as pages shaped like `link`'s, in a hidden
 * copy of its editor, and return each page's HTML. New pages used to be added
 * one per pass, each pass rendering and re-measuring all the remaining text.
 */
function paginate(link: Link, holder: HTMLElement): string[] {
  const probe = link.el.cloneNode(false) as HTMLElement;
  for (const attr of ["contenteditable", "data-frame-id", "role", "aria-label", "aria-multiline"]) probe.removeAttribute(attr);
  Object.assign(probe.style, { position: "absolute", left: "0", top: "0", visibility: "hidden", pointerEvents: "none" });
  link.el.parentElement!.appendChild(probe);
  const probeLink: Link = { ...link, el: probe };
  const pages: string[] = [];
  try {
    for (let guard = 0; guard < 2000 && holder.firstElementChild && !isEmpty(holder); guard++) {
      // Fill in batches (each check lays out at most about a page) until it overflows.
      while (holder.firstElementChild && !overflows(probeLink)) {
        for (let n = 0; n < 12 && holder.firstElementChild; n++) probe.appendChild(holder.firstElementChild);
      }
      if (overflows(probeLink)) pushOverflow(probeLink, holder);
      pages.push(probe.innerHTML);
      probe.replaceChildren();
    }
  } finally {
    probe.remove();
  }
  return pages;
}

// ── repagination ─────────────────────────────────────────────────────────────
// A change across many pages (a new size or font on every page, opening a
// document) reflows them all. Moving text page by page re-laid the Nastaliq
// text out after every move (seconds on a long document), so instead every
// line of every page is measured from the ONE layout the browser has to do
// anyway, the page breaks are worked out arithmetically (pages share a width,
// so a line is as tall on one page as on another), and all the moves are made
// at once. A check afterwards hands anything the estimate got wrong to the
// page-by-page flow.

interface Paragraph {
  /** The paragraph's first block, and its continuations on later pages. */
  head: HTMLElement;
  parts: HTMLElement[];
  /** Space above it (its margin), page px. */
  preSpace: number;
  /** Each line's height and, for all but the first, how to find where it starts
   *  (looked up only for the lines a page break falls on; see blockLines). */
  lines: { height: number; start: (() => LineStart | null) | null }[];
  splittable: boolean;
  /** Where its blocks are now: the line each starts at, and its page in the run. */
  placed: { line: number; page: number }[];
}

interface RunMeasure {
  paras: Paragraph[];
  /** Where the first line starts on each page (its top padding), page px. */
  tops: number[];
}

/** Measure every paragraph of a run of pages (reads only; no DOM changes). */
function measureRun(run: Link[]): RunMeasure {
  const tops = run.map((link) => {
    const first = link.el.firstElementChild;
    return first ? (first.getBoundingClientRect().top - link.el.getBoundingClientRect().top) / scaleOf(link.el) : 0;
  });
  const out: Paragraph[] = [];
  for (const [page, link] of run.entries()) {
    const top = link.el.getBoundingClientRect().top;
    const scale = scaleOf(link.el);
    let prevBottom: number | null = null;
    for (const block of blocks(link.el)) {
      const r = block.getBoundingClientRect();
      const blockTop = (r.top - top) / scale;
      const blockBottom = (r.bottom - top) / scale;
      const splittable = SPLITTABLE.has(block.tagName);
      const { lines: found, startOf } = splittable ? blockLines(link.el, block) : { lines: [], startOf: () => null };
      const lines: Paragraph["lines"] = [];
      if (found.length < 2) {
        lines.push({ height: blockBottom - blockTop, start: null });
      } else {
        found.forEach((ln, k) => {
          const lineTop = k === 0 ? blockTop : (found[k - 1].center + ln.center) / 2;
          const lineBottom = k === found.length - 1 ? blockBottom : (ln.center + found[k + 1].center) / 2;
          lines.push({ height: lineBottom - lineTop, start: k === 0 ? null : () => startOf(k) });
        });
      }
      const preSpace = prevBottom === null ? 0 : Math.max(0, blockTop - prevBottom);
      prevBottom = blockBottom;
      const last = out[out.length - 1];
      if (block.hasAttribute(CONT) && last) {
        // The rest of a paragraph split at the previous page break.
        last.parts.push(block);
        last.placed.push({ line: last.lines.length, page });
        last.lines.push(...lines.map((l, k) => (k === 0 ? { ...l, start: () => firstStart(block) } : l)));
        last.splittable = last.splittable && splittable;
      } else {
        out.push({ head: block, parts: [], preSpace, lines, splittable, placed: [{ line: 0, page }] });
      }
    }
  }
  return { paras: out, tops };
}

/** Where a continuation block's text starts (its first line, once joined). */
function firstStart(block: HTMLElement): LineStart | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
    if (t.length) return { node: t, offset: 0, bottom: 0, center: 0 };
  }
  return null;
}

/** Split without tidying, so measured positions in the part that stays remain valid. */
function rawSplit(block: HTMLElement, node: Text, offset: number): HTMLElement {
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(block, block.childNodes.length);
  const tail = block.cloneNode(false) as HTMLElement;
  tail.appendChild(range.extractContents());
  tail.setAttribute(CONT, "");
  return tail;
}

type Piece = { para: Paragraph; from: number; to: number };

/** Which lines of which paragraph go on which page, and where in the text each
 *  paragraph is cut (looked up now, before anything moves). */
interface PagePlan {
  pages: Piece[][];
  cuts: Map<Paragraph, Map<number, LineStart>>;
  /** Every paragraph would stay where it is: nothing to change. */
  same: boolean;
}

/** Work out the page breaks of a run of continuing pages from one measurement. Reads only. */
function planPages(run: Link[], { paras: measured, tops: measuredTops }: RunMeasure): PagePlan {
  const limitOf = (p: number) => run[Math.min(p, run.length - 1)].limit;
  const tops = measuredTops.length ? measuredTops : [0];

  // Work out the breaks: which lines of which paragraph go on which page.
  const pages: Piece[][] = [[]];
  let p = 0;
  let y = tops[0];
  let filled = false;
  for (const para of measured) {
    if (filled) y += para.preSpace;
    let from = 0;
    for (let k = 0; k < para.lines.length; ) {
      const h = para.lines[k].height;
      const breakable = k === 0 || (para.splittable && para.lines[k].start);
      if (filled && breakable && y + h > limitOf(p) + 0.5) {
        if (k > from) pages[p].push({ para, from, to: k });
        p++;
        pages[p] = [];
        y = tops[Math.min(p, tops.length - 1)];
        filled = false;
        from = k;
        continue;
      }
      y += h;
      filled = true;
      k++;
    }
    pages[p].push({ para, from, to: para.lines.length });
  }

  // Already laid out like this (e.g. a document just opened): leave the DOM
  // alone, or the browser lays every page out again for nothing.
  const planned = new Map<Paragraph, { line: number; page: number }[]>();
  pages.forEach((pieces, page) => {
    for (const piece of pieces) {
      if (!planned.has(piece.para)) planned.set(piece.para, []);
      planned.get(piece.para)!.push({ line: piece.from, page });
    }
  });
  const same = pages.length <= run.length && measured.every((para) => {
    const now = planned.get(para) ?? [];
    return now.length === para.placed.length && now.every((x, i) => x.line === para.placed[i].line && x.page === para.placed[i].page);
  });
  if (same) return { pages, cuts: new Map(), same };

  const cuts = new Map<Paragraph, Map<number, LineStart>>();
  for (const piece of pages.flat()) {
    if (piece.from === 0) continue;
    const start = piece.para.lines[piece.from].start?.();
    if (!start) continue;
    if (!cuts.has(piece.para)) cuts.set(piece.para, new Map());
    cuts.get(piece.para)!.set(piece.from, start);
  }
  return { pages, cuts, same };
}

/**
 * Re-break a run of continuing pages as planned. Returns the HTML of pages to
 * add after the run's last page, and the run pages left empty.
 */
function repaginate(run: Link[], measured: Paragraph[], { pages, cuts }: PagePlan): { extra: string[]; emptied: Link[] } {
  // Build the blocks: join each paragraph's parts, then cut it at its breaks,
  // from the last cut back so earlier positions stay valid.
  const chunkAt = new Map<Paragraph, Map<number, HTMLElement>>();
  for (const para of measured) {
    for (const part of para.parts) {
      if (isEmptyBlock(para.head)) para.head.replaceChildren();
      while (part.firstChild) para.head.appendChild(part.firstChild);
      part.remove();
    }
    const chunks = new Map<number, HTMLElement>([[0, para.head]]);
    const paraCuts = cuts.get(para);
    for (const cut of [...(paraCuts?.keys() ?? [])].sort((a, b) => b - a)) {
      const start = paraCuts!.get(cut)!;
      if (start.node.isConnected && para.head.contains(start.node)) chunks.set(cut, rawSplit(para.head, start.node, start.offset));
    }
    chunkAt.set(para, chunks);
  }
  const blocksOf = (pieces: Piece[]): HTMLElement[] =>
    pieces.map((piece) => chunkAt.get(piece.para)!.get(piece.from)).filter((b): b is HTMLElement => !!b);

  const emptied: Link[] = [];
  run.forEach((link, i) => {
    const content = pages[i] ? blocksOf(pages[i]) : [];
    if (content.length) link.el.replaceChildren(...content);
    else {
      link.el.replaceChildren(Object.assign(document.createElement("div"), { innerHTML: "<br>" }));
      emptied.push(link);
    }
    for (const b of blocks(link.el)) clean(b);
  });
  const extra = pages.slice(run.length).map((pieces) => {
    const box = document.createElement("div");
    box.append(...blocksOf(pieces));
    for (const b of blocks(box)) clean(b);
    return box.innerHTML;
  });
  return { extra, emptied };
}

// ── caret ────────────────────────────────────────────────────────────────────
// A position is counted in characters across the editors of the chain, with one
// extra for every paragraph break. Splitting or joining a paragraph at a page
// break changes neither, so the caret lands on the same letter afterwards.

function boundary(editors: HTMLElement[], node: Node, offset: number): { node: Node; offset: number } {
  const ed = editors.find((e) => e === node);
  if (!ed) return { node, offset };
  const bs = blocks(ed);
  if (offset < bs.length) return { node: bs[offset], offset: 0 };
  const last = bs[bs.length - 1];
  return last ? { node: last, offset: last.childNodes.length } : { node, offset };
}

export function positionOf(editors: HTMLElement[], rawNode: Node, rawOffset: number): number | null {
  const { node, offset } = boundary(editors, rawNode, rawOffset);
  let pos = 0;
  let first = true;
  for (const ed of editors) {
    for (const b of blocks(ed)) {
      if (!first && !b.hasAttribute(CONT)) pos += 1;
      first = false;
      if (b === node || b.contains(node)) {
        const r = document.createRange();
        r.setStart(b, 0);
        r.setEnd(node, offset);
        return pos + r.toString().length;
      }
      pos += (b.textContent ?? "").length;
    }
  }
  return null;
}

export function placeAt(editors: HTMLElement[], pos: number): { ed: HTMLElement; node: Node; offset: number } | null {
  let at = 0;
  let first = true;
  let lastSeen: { ed: HTMLElement; b: HTMLElement } | null = null;
  for (const ed of editors) {
    for (const b of blocks(ed)) {
      const startsParagraph = first || !b.hasAttribute(CONT);
      if (!first && startsParagraph) at += 1;
      first = false;
      const len = (b.textContent ?? "").length;
      if (startsParagraph && pos === at) return { ed, node: b, offset: 0 };
      if (pos > at && pos <= at + len) {
        let remaining = pos - at;
        const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
        for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
          if (remaining <= t.length) return { ed, node: t, offset: remaining };
          remaining -= t.length;
        }
      }
      at += len;
      lastSeen = { ed, b };
    }
  }
  return lastSeen && pos >= at ? { ed: lastSeen.ed, node: lastSeen.b, offset: lastSeen.b.childNodes.length } : null;
}

interface SavedCaret {
  baseFrameId: string;
  anchor: number;
  focus: number;
}

function saveCaret(chain: Link[]): SavedCaret | null {
  const editors = chain.map((l) => l.el);
  if (!editors.includes(document.activeElement as HTMLElement)) return null;
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode || !sel.focusNode) return null;
  const anchor = positionOf(editors, sel.anchorNode, sel.anchorOffset);
  const focus = positionOf(editors, sel.focusNode, sel.focusOffset);
  if (anchor === null || focus === null) return null;
  return { baseFrameId: chain[0].frame.id, anchor, focus };
}

/** Put the caret back; false when its page is not on screen yet. */
function restoreCaret(saved: SavedCaret): boolean {
  const chain = buildChain(useDoc.getState().pages);
  const base = chain.findIndex((l) => l.frame.id === saved.baseFrameId);
  if (base === -1) return true;
  const editors = chain.slice(base).map((l) => l.el);
  const total = positionOf(editors, editors[editors.length - 1], blocks(editors[editors.length - 1]).length) ?? 0;
  if (saved.focus > total) return false;
  const focus = placeAt(editors, saved.focus);
  if (!focus) return true;
  const anchor = placeAt(editors, saved.anchor);
  if (document.activeElement !== focus.ed) focus.ed.focus({ preventScroll: true });
  const sel = window.getSelection();
  if (!sel) return true;
  if (anchor && anchor.ed === focus.ed) sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  else if (anchor) {
    // A selection cannot span two page editors. Keep the part on the anchor's
    // page (e.g. a whole page selected with ⌘A stays selected after its text
    // reflows), rather than collapsing it.
    const forward = saved.focus >= saved.anchor;
    const edge = forward ? anchor.ed.childNodes.length : 0;
    if (document.activeElement !== anchor.ed) anchor.ed.focus({ preventScroll: true });
    sel.setBaseAndExtent(anchor.node, anchor.offset, anchor.ed, edge);
  } else sel.collapse(focus.node, focus.offset);
  const link = chain.find((l) => l.el === focus.ed);
  if (link) {
    const doc = useDoc.getState();
    if (doc.selectedFrameId !== link.frame.id) doc.selectFrame(link.frame.id);
    if (doc.activePageId !== link.page.id) doc.setActivePage(link.page.id);
  }
  scrollCaretIntoView(sel);
  return true;
}

function scrollCaretIntoView(sel: Selection) {
  if (!sel.rangeCount) return;
  const canvas = document.getElementById("document-canvas");
  const range = sel.getRangeAt(0);
  let rect = range.getBoundingClientRect();
  if (!rect.height) {
    const el = (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement) as Element | null;
    if (el) rect = el.getBoundingClientRect();
  }
  if (!canvas || !rect.height) return;
  const view = canvas.getBoundingClientRect();
  if (rect.bottom > view.bottom - 24) canvas.scrollTop += rect.bottom - view.bottom + 48;
  else if (rect.top < view.top + 24) canvas.scrollTop -= view.top - rect.top + 48;
}

// ── one pass ─────────────────────────────────────────────────────────────────

let pendingCaret: SavedCaret | null = null;
let applying = false;

function frameText(el: HTMLElement): string {
  return shownInPage(el) ? el.innerText : plainText(el);
}

function htmlText(html: string): string {
  const box = document.createElement("div");
  box.innerHTML = html;
  return frameText(box);
}

/**
 * Flow pages from page index `start`. Pages after `end` that this pass did not
 * touch are already settled, so it stops at the first of them.
 * Returns the range of pages it added (which then need a pass of their own).
 */
async function flowPass(start: number, end: number): Promise<{ start: number; end: number } | null> {
  if (useUi.getState().viewMode !== "edit") {
    abandoned = true; // flowed when the editor is back (see usePageFlow)
    return null;
  }
  const pages = useDoc.getState().pages;
  const whole = buildChain(pages);
  const first = whole.findIndex((l) => l.pageIndex >= start);
  if (first === -1) return null;
  const chain = whole.slice(first);

  try {
    await Promise.all([...new Set(chain.map((l) => l.frame.fontKey))].map((k) => ensureFontFace(k).catch(() => {})));
    await document.fonts.ready;
  } catch {
    abandoned = true;
    return null;
  }
  // Print preview may have opened while fonts loaded: flow when the editor is back.
  if (useUi.getState().viewMode !== "edit") {
    abandoned = true;
    return null;
  }
  // The document may have changed while fonts loaded: flow this range again
  // with the new pages (a change that touched no page frame queues nothing).
  if (useDoc.getState().pages !== pages) {
    request = request ? { start: Math.min(request.start, start), end: Math.max(request.end, end) } : { start, end };
    return null;
  }

  const before = chain.map((l) => l.el.innerHTML);
  const wasEmpty = chain.map((l) => isEmpty(l.el));
  const caret = pendingCaret ?? saveCaret(chain);
  // Overflow from a page whose next page is not its continuation goes onto a
  // new page inserted after it (one holder per such page).
  const holders = new Map<string, HTMLElement>();
  const skipped = new Set<string>();

  const continues = (a: Link | undefined, b: Link | undefined) => !!a && !!b && b.pageIndex === a.pageIndex + 1 && !b.frame.pageBreak;
  /** The page `link` pulls text back from: the next continuing page, skipping
   *  empty ones (e.g. after a large deletion; removed below if they stay empty). */
  const pullSource = (i: number): HTMLElement | null => {
    let j = i + 1;
    while (continues(chain[j - 1], chain[j]) && chain[j + 1] && isEmpty(chain[j].el) && chain[j].page.frames.length === 1) {
      skipped.add(chain[j].page.id);
      j++;
    }
    return continues(chain[j - 1], chain[j]) ? chain[j].el : null;
  };
  const needsWork = (i: number): boolean => {
    const link = chain[i];
    if (overflows(link)) return true;
    const source = pullSource(i);
    return !!source && !isEmpty(source) && canPull(link, source);
  };

  // A change across pages re-breaks every run of continuing pages from one
  // measurement (see repaginate); typing on one page uses the page-by-page
  // flow below, which only touches the pages around it.
  const repaged: { afterPageId: string; html: string; text: string }[] = [];
  let from = 0;
  let until = chain.findIndex((l) => l.pageIndex >= end);
  if (until === -1) until = chain.length - 1;
  // A big paste overflows its page by far more than a line: repaginate that too.
  if (end > start || used(chain[0].el) > chain[0].limit * 1.5) {
    const runs: Link[][] = [];
    chain.forEach((link, i) => {
      if (i > 0 && continues(chain[i - 1], link)) runs[runs.length - 1].push(link);
      else runs.push([link]);
    });
    // Every read (measuring, and finding where the breaks fall in the text)
    // before any change.
    const measures = runs.map(measureRun);
    const plans = runs.map((run, r) => planPages(run, measures[r]));
    runs.forEach((run, r) => {
      if (plans[r].same) return;
      const { extra } = repaginate(run, measures[r].paras, plans[r]);
      const afterPageId = run[run.length - 1].page.id;
      for (const html of extra) repaged.push({ afterPageId, html, text: htmlText(html) });
    });
    // Anything the estimate got wrong is fixed page by page from there.
    from = chain.findIndex((_, i) => needsWork(i));
    until = from;
  }

  // Each page is measured once per round and all its moves are made from that
  // measurement; a check afterwards (one layout for the whole document) starts
  // another round from the first page that is still not settled.
  for (let round = 0; round < 6 && from !== -1; round++) {
    const touched: number[] = [];
    for (let i = from; i < chain.length; i++) {
      const link = chain[i];
      const next = continues(link, chain[i + 1]) ? chain[i + 1].el : null;
      let changed = false;
      if (overflows(link)) {
        prepare(link.el);
        let target = next;
        if (target) prepare(target);
        else {
          target = holders.get(link.page.id) ?? document.createElement("div");
          holders.set(link.page.id, target);
        }
        changed = pushOverflow(link, target);
      } else {
        const source = pullSource(i);
        if (source && !isEmpty(source) && canPull(link, source)) {
          prepare(link.el);
          prepare(source);
          changed = pullFit(link, source);
        }
      }
      if (changed) touched.push(i);
      if (!changed && i >= until) break;
    }
    if (!touched.length) break;
    from = -1;
    for (let i = Math.max(0, touched[0] - 1); i < chain.length; i++) {
      if (needsWork(i)) {
        from = i;
        until = i;
        break;
      }
      if (i > touched[touched.length - 1] + 1) break;
    }
  }

  // Drop pages that this pass emptied (and that hold nothing else). A page
  // that was already empty, or one starting with a page break, is kept.
  const removePageIds = chain
    .filter((l, i) => i > 0 && !l.frame.pageBreak && (!wasEmpty[i] || skipped.has(l.page.id)) && isEmpty(l.el) && l.page.frames.length === 1 && !holders.has(l.page.id))
    .map((l) => l.page.id);

  const changes = chain
    .filter((l, i) => l.el.innerHTML !== before[i] && !removePageIds.includes(l.page.id))
    .map((l) => ({ frameId: l.frame.id, html: l.el.innerHTML, text: frameText(l.el) }));
  // Overflow found by the check goes before the pages repagination added.
  const newPages = [...holders].flatMap(([afterPageId, holder]) => {
    const link = chain.find((l) => l.page.id === afterPageId)!;
    return paginate(link, holder).map((html) => ({ afterPageId, html, text: htmlText(html) }));
  }).concat(repaged);
  if (!changes.length && !newPages.length && !removePageIds.length) return null;

  applying = true;
  try {
    useDoc.getState().applyFlow(changes, newPages, removePageIds);
  } finally {
    applying = false;
  }
  if (caret) pendingCaret = restoreCaret(caret) ? null : caret;
  if (!newPages.length) return null;
  // The new pages may overflow in turn: flow them once they are on screen.
  const now = useDoc.getState().pages;
  const indices = newPages.map((n) => now.findIndex((p) => p.id === n.afterPageId) + 1).filter((i) => i > 0);
  return indices.length ? { start: Math.min(...indices), end: Math.max(...indices) } : null;
}

// ── scheduling ───────────────────────────────────────────────────────────────

let request: { start: number; end: number } | null = null;
let running = false;
/** The pages as the last finished passes left them, all flowed: entering the
 *  editor again with these same pages has nothing to flow. */
let settled: Page[] | null = null;
/** A pass gave up without flowing (e.g. print preview was showing). */
let abandoned = false;
/** Wait until this time (ms) before the next pass, so a burst of clicks flows once. */
let notBefore = 0;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ask for pages `start`..`end` (indices) to be flowed once the DOM has caught
 * up. `delay` (ms) postpones it, restarting with every new request: a change
 * spanning many pages (e.g. clicking Size + repeatedly with every page
 * selected) then reflows once, after the clicks, instead of after each one.
 */
export function requestFlow(start: number, end = start, delay = 0) {
  request = request ? { start: Math.min(request.start, start), end: Math.max(request.end, end) } : { start, end };
  notBefore = Math.max(notBefore, Date.now() + delay);
  if (running) return;
  running = true;
  abandoned = false;
  void (async () => {
    try {
      while (request) {
        while (Date.now() < notBefore) await sleep(notBefore - Date.now());
        await nextFrame();
        const { start: s, end: e } = request;
        request = null;
        const added = await flowPass(s, e);
        if (added) {
          const queued = request as { start: number; end: number } | null; // set again by edits during the pass
          request = queued ? { start: Math.min(queued.start, added.start), end: Math.max(queued.end, added.end) } : added;
        } else if (pendingCaret && !request) {
          await nextFrame();
          if (restoreCaret(pendingCaret)) pendingCaret = null;
        }
      }
      settled = abandoned ? null : useDoc.getState().pages;
    } finally {
      running = false;
    }
  })();
}

/** Pages whose main frame changed between two states, as an index range. */
function changedRange(now: Page[], before: Page[]): { start: number; end: number } | null {
  let start = -1;
  let end = -1;
  const n = Math.max(now.length, before.length);
  for (let i = 0; i < n; i++) {
    const a = now[i] && mainFrame(now[i]);
    const b = before[i] && mainFrame(before[i]);
    if (a !== b || now[i]?.height !== before[i]?.height) {
      if (start === -1) start = i;
      end = i;
    }
  }
  if (start === -1) return null;
  return { start: Math.max(0, Math.min(start, now.length - 1)), end: Math.min(end, now.length - 1) };
}

// ── keys at a page break ─────────────────────────────────────────────────────

function caretInfo(el: HTMLElement): { atStart: boolean; atEnd: boolean; rect: DOMRect | null } | null {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return null;
  const before = document.createRange();
  before.setStart(el, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.setStart(range.startContainer, range.startOffset);
  after.setEnd(el, el.childNodes.length);
  const firstBlock = el.firstElementChild;
  const lastBlock = el.lastElementChild;
  const node = range.startContainer;
  const inFirst = !!firstBlock && (firstBlock === node || firstBlock.contains(node) || (node === el && range.startOffset === 0));
  const inLast = !!lastBlock && (lastBlock === node || lastBlock.contains(node) || (node === el && range.startOffset >= el.childNodes.length - 1));
  const rects = range.getClientRects();
  return {
    atStart: inFirst && before.toString() === "",
    atEnd: inLast && after.toString() === "",
    rect: rects.length ? rects[0] : null,
  };
}

function emitFrom(links: Link[], befores: string[]) {
  const changes = links
    .filter((l, i) => l.el.innerHTML !== befores[i])
    .map((l) => ({ frameId: l.frame.id, html: l.el.innerHTML, text: frameText(l.el) }));
  if (changes.length) useDoc.getState().applyFlow(changes, [], []);
}

/**
 * Backspace at the start of a page and Delete at the end of the page before it
 * work across the page boundary (not across a page break), and the up/down arrows move to the neighbouring page from its first or
 * last line, as if the pages were one text.
 */
function onKeyDown(e: KeyboardEvent) {
  // Shift+arrows extend a selection (editor/crossPageSelection.ts), not move the caret.
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return;
  if (!["Backspace", "Delete", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  if (useUi.getState().viewMode !== "edit") return;
  const el = (e.target as HTMLElement | null)?.closest?.(".text-frame-edit") as HTMLElement | null;
  if (!el) return;
  const chain = buildChain(useDoc.getState().pages);
  const i = chain.findIndex((l) => l.el === el);
  if (i === -1) return;
  const info = caretInfo(el);
  if (!info) return;
  const prev = chain[i - 1];
  const next = chain[i + 1];
  const sel = window.getSelection()!;

  if (e.key === "Backspace" && info.atStart && prev && !chain[i].frame.pageBreak && prev.pageIndex === chain[i].pageIndex - 1) {
    e.preventDefault();
    const links = [prev, chain[i]];
    const befores = links.map((l) => l.el.innerHTML);
    prepare(prev.el);
    prepare(el);
    const first = el.firstElementChild as HTMLElement;
    const continues = first.hasAttribute(CONT);
    const last = prev.el.lastElementChild as HTMLElement | null;
    // Mark the join point, so the caret can go there after the blocks merge.
    const marker = document.createElement("span");
    if (last && !isEmptyBlock(last)) last.appendChild(marker);
    if (last) join(last, first);
    else prev.el.appendChild(first);
    if (!el.firstElementChild) el.appendChild(Object.assign(document.createElement("div"), { innerHTML: "<br>" }));
    prev.el.focus({ preventScroll: true });
    if (marker.isConnected) {
      const r = document.createRange();
      r.setStartBefore(marker);
      marker.remove();
      sel.collapse(r.startContainer, r.startOffset);
      if (continues) document.execCommand("delete");
    } else if (prev.el.lastElementChild) {
      sel.collapse(prev.el.lastElementChild, 0);
    }
    emitFrom(links, befores);
    useDoc.getState().selectFrame(prev.frame.id);
    requestFlow(prev.pageIndex, chain[i].pageIndex);
    return;
  }

  if (e.key === "Delete" && info.atEnd && next && !next.frame.pageBreak && next.pageIndex === chain[i].pageIndex + 1) {
    e.preventDefault();
    const links = [chain[i], next];
    const befores = links.map((l) => l.el.innerHTML);
    prepare(el);
    prepare(next.el);
    const nextFirst = next.el.firstElementChild as HTMLElement | null;
    if (!nextFirst) return;
    const continues = nextFirst.hasAttribute(CONT);
    const last = el.lastElementChild as HTMLElement;
    const marker = document.createElement("span");
    if (!isEmptyBlock(last)) last.appendChild(marker);
    join(last, nextFirst);
    if (!next.el.firstElementChild) next.el.appendChild(Object.assign(document.createElement("div"), { innerHTML: "<br>" }));
    if (marker.isConnected) {
      const r = document.createRange();
      r.setStartBefore(marker);
      marker.remove();
      sel.collapse(r.startContainer, r.startOffset);
      if (continues) document.execCommand("forwardDelete");
    } else {
      sel.collapse(last, 0);
    }
    emitFrom(links, befores);
    requestFlow(chain[i].pageIndex, next.pageIndex);
    return;
  }

  if (e.key === "ArrowDown" && next && info.rect) {
    const lastBlock = el.lastElementChild as HTMLElement | null;
    const lh = lastBlock ? lineHeightOf(lastBlock) * scaleOf(el) : 0;
    if (lastBlock && info.rect.bottom + lh / 2 > lastBlock.getBoundingClientRect().bottom) {
      e.preventDefault();
      next.el.focus({ preventScroll: true });
      const target = next.el.firstElementChild ?? next.el;
      sel.collapse(target, 0);
      useDoc.getState().selectFrame(next.frame.id);
      useDoc.getState().setActivePage(next.page.id);
      scrollCaretIntoView(sel);
    }
    return;
  }

  if (e.key === "ArrowUp" && prev && info.rect) {
    const firstBlock = el.firstElementChild as HTMLElement | null;
    const lh = firstBlock ? lineHeightOf(firstBlock) * scaleOf(el) : 0;
    if (firstBlock && info.rect.top - lh / 2 < firstBlock.getBoundingClientRect().top) {
      e.preventDefault();
      prev.el.focus({ preventScroll: true });
      const target = prev.el.lastElementChild ?? prev.el;
      sel.collapse(target, target.childNodes.length);
      useDoc.getState().selectFrame(prev.frame.id);
      useDoc.getState().setActivePage(prev.page.id);
      scrollCaretIntoView(sel);
    }
  }
}

/** Keep text flowing between pages while the editor is open. */
export function usePageFlow() {
  useEffect(() => {
    const unsubscribe = useDoc.subscribe((state, previous) => {
      if (applying || state.pages === previous.pages) return;
      // A document that was just opened, restored or imported flows as a whole,
      // so pages laid out by an older version (or another tool) are fixed up.
      if (state.documentEpoch !== previous.documentEpoch) {
        requestFlow(0, state.pages.length - 1);
        return;
      }
      const range = changedRange(state.pages, previous.pages);
      // Typing on a page flows at once; a change across pages waits for a pause.
      if (range) requestFlow(range.start, range.end, range.end > range.start ? 200 : 0);
    });
    // Flow is off while print preview shows. Coming back flows the document
    // only if it changed since it was last flowed: flowing it measures every
    // page, which takes seconds on a long Nastaliq document.
    const unsubscribeUi = useUi.subscribe((state, previous) => {
      if (state.viewMode !== "edit" || previous.viewMode === "edit") return;
      const { pages } = useDoc.getState();
      if (pages !== settled || running) requestFlow(0, pages.length - 1);
    });
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      unsubscribe();
      unsubscribeUi();
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
}
