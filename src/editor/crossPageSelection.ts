// Selecting text across pages with the mouse.
//
// Each page is its own contentEditable, and a browser selection never leaves
// the editor it started in, so a drag from one page onto the next used to stop
// at the end of the first page. While the mouse button is held, this module
// tracks the start and the point under the pointer itself and, once they are on
// different pages, paints everything between them with the selection colour
// (CSS Custom Highlight API). Copy, cut, delete, typing and the toolbar's
// bold / italic / underline / colour / size then act on every page's part.
//
// Positions are counted across the page editors the same way text flow counts
// them (editor/flow.ts), so the selection survives text moving between pages.
import { useEffect } from "react";
import { useDoc } from "../lib/store";
import { useUi } from "../lib/ui";
import { buildChain, placeAt, positionOf, CONT, type Link } from "./flow";
import { applySelectionSize } from "./selectionSize";

const NAME = "harfsaz-cross-page";
const BODY_CLASS = "harfsaz-cross-selecting";

interface CrossSelection {
  /** Frame id of the first page editor; positions count from its start. */
  baseFrameId: string;
  anchor: number;
  focus: number;
}

interface Segment {
  link: Link;
  range: Range;
}

let current: CrossSelection | null = null;

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = (): HighlightRegistry | null =>
  (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights ?? null;
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

/** True while a selection spans more than one page. */
export function isCrossPageSelectionActive(): boolean {
  return current !== null;
}

function chain(): Link[] {
  return buildChain(useDoc.getState().pages);
}

function editorOf(node: Node | null): HTMLElement | null {
  const el = node && (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement);
  return (el?.closest(".text-frame--page .text-frame-edit") as HTMLElement | null) ?? null;
}

/** The selected part of every page, in page order. */
function segments(): Segment[] | null {
  if (!current) return null;
  const links = chain();
  const base = links.findIndex((l) => l.frame.id === current!.baseFrameId);
  if (base === -1) return null;
  const editors = links.slice(base).map((l) => l.el);
  const lo = placeAt(editors, Math.min(current.anchor, current.focus));
  const hi = placeAt(editors, Math.max(current.anchor, current.focus));
  if (!lo || !hi) return null;
  const from = editors.indexOf(lo.ed);
  const to = editors.indexOf(hi.ed);
  if (from === -1 || to === -1 || from === to) return null;
  const out: Segment[] = [];
  for (let i = from; i <= to; i++) {
    const el = editors[i];
    const range = document.createRange();
    range.selectNodeContents(el);
    if (i === from) range.setStart(lo.node, lo.offset);
    if (i === to) range.setEnd(hi.node, hi.offset);
    out.push({ link: links[base + i], range });
  }
  return out;
}

function paint() {
  const segs = segments();
  const reg = registry();
  if (!segs) {
    clearCrossSelection();
    return;
  }
  document.body.classList.add(BODY_CLASS);
  if (reg && HighlightCtor) reg.set(NAME, new HighlightCtor(...segs.map((s) => s.range)));
}

/** End the cross-page selection (the native selection is left as it is). */
export function clearCrossSelection() {
  if (!current && !document.body.classList.contains(BODY_CLASS)) return;
  current = null;
  registry()?.delete(NAME);
  document.body.classList.remove(BODY_CLASS);
  // WebKit keeps painting a removed highlight until the text is redrawn.
  for (const link of chain()) link.el.style.opacity = "0.999";
  requestAnimationFrame(() => {
    for (const link of chain()) link.el.style.opacity = "";
  });
}

/** Put the caret at a chain position and focus its page. */
function caretAt(baseFrameId: string, pos: number) {
  const links = chain();
  const base = links.findIndex((l) => l.frame.id === baseFrameId);
  if (base === -1) return;
  const editors = links.slice(base).map((l) => l.el);
  const at = placeAt(editors, pos);
  if (!at) return;
  at.ed.focus({ preventScroll: true });
  window.getSelection()?.collapse(at.node, at.offset);
  const link = links.find((l) => l.el === at.ed);
  if (link) {
    useDoc.getState().selectFrame(link.frame.id);
    useDoc.getState().setActivePage(link.page.id);
  }
}

// ── text out ─────────────────────────────────────────────────────────────────

/** The range's text with a line break between paragraphs (Range.toString runs
 *  paragraphs together). */
function rangeText(el: HTMLElement, range: Range): string {
  const parts: string[] = [];
  for (const block of Array.from(el.children)) {
    if (!range.intersectsNode(block)) continue;
    const part = document.createRange();
    part.selectNodeContents(block);
    if (block.contains(range.startContainer) || block === range.startContainer) part.setStart(range.startContainer, range.startOffset);
    if (block.contains(range.endContainer) || block === range.endContainer) part.setEnd(range.endContainer, range.endOffset);
    // A range ending at the very start of a paragraph does not include it.
    if (part.collapsed && parts.length) continue;
    parts.push(part.toString());
  }
  return parts.join("\n");
}

function selectedContent(segs: Segment[]): { text: string; html: string } {
  let text = "";
  let html = "";
  segs.forEach((seg, i) => {
    if (i > 0) {
      // A paragraph continued from the previous page joins without a break.
      const first = seg.link.el.firstElementChild;
      if (!first?.hasAttribute(CONT)) text += "\n";
    }
    text += rangeText(seg.link.el, seg.range);
    const box = document.createElement("div");
    box.appendChild(seg.range.cloneContents());
    html += box.innerHTML;
  });
  return { text, html };
}

// ── edits ────────────────────────────────────────────────────────────────────

/** Delete the selected text on every page and join its two ends. */
export function deleteCrossSelection(): boolean {
  const segs = segments();
  if (!segs || !current) return false;
  const baseFrameId = current.baseFrameId;
  const start = Math.min(current.anchor, current.focus);
  const first = segs[0];
  const last = segs[segs.length - 1];
  const removePageIds: string[] = [];

  first.range.deleteContents();
  last.range.deleteContents();
  for (const seg of segs.slice(1, -1)) {
    seg.link.el.innerHTML = "<div><br></div>";
    // A page that only held this text goes; one with placed objects, or one
    // that starts with a page break, stays empty.
    if (seg.link.page.frames.length === 1 && !seg.link.frame.pageBreak) removePageIds.push(seg.link.page.id);
  }
  for (const seg of [first, last]) {
    if (!seg.link.el.firstElementChild) seg.link.el.innerHTML = "<div><br></div>";
  }
  // The rest of the last page's paragraph continues the first page's, so text
  // flow joins them into one paragraph (as deleting within a page would).
  if (!last.link.frame.pageBreak) last.link.el.firstElementChild!.setAttribute(CONT, "");

  const changes = segs
    .filter((s) => !removePageIds.includes(s.link.page.id))
    .map((s) => ({ frameId: s.link.frame.id, html: s.link.el.innerHTML, text: s.link.el.innerText }));
  clearCrossSelection();
  useDoc.getState().applyFlow(changes, [], removePageIds, true); // one undo step
  caretAt(baseFrameId, start);
  return true;
}

/** Run `apply` on each page's part of the selection, as one undo step. */
function formatAcross(apply: (seg: Segment) => void) {
  const segs = segments();
  if (!segs || !current) return;
  const saved = { ...current };
  useDoc.getState().batch(() => {
    for (const seg of segs) {
      seg.link.el.focus({ preventScroll: true });
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(seg.range);
      apply(seg);
    }
  });
  // Formatting replaces nodes; rebuild the ranges from the saved positions.
  current = saved;
  requestAnimationFrame(paint);
}

/** Bold / italic / underline on the whole selection. */
export function formatCrossSelection(command: "bold" | "italic" | "underline") {
  formatAcross(() => {
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand(command, false);
  });
}

export function colorCrossSelection(color: string) {
  formatAcross(() => {
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand("foreColor", false, color);
  });
}

export function sizeCrossSelection(px: number) {
  formatAcross((seg) => {
    applySelectionSize({ host: seg.link.el, range: seg.range }, px);
  });
}

// ── mouse ────────────────────────────────────────────────────────────────────

/** The page editor and caret position under (or nearest to) a screen point. */
function pointAt(x: number, y: number, links: Link[]): { el: HTMLElement; node: Node; offset: number } | null {
  // The page under the pointer, or the nearest one vertically (page gaps).
  let best: Link | null = null;
  let bestDistance = Infinity;
  for (const link of links) {
    const r = link.el.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < bestDistance) {
      best = link;
      bestDistance = d;
    }
  }
  if (!best) return null;
  const el = best.el;
  const r = el.getBoundingClientRect();
  const lastBlock = el.lastElementChild;
  const end = { el, node: el as Node, offset: el.childNodes.length };
  if (y < r.top) return { el, node: el, offset: 0 };
  if (y > r.bottom || (lastBlock && y > lastBlock.getBoundingClientRect().bottom)) return end;
  const cx = Math.min(Math.max(x, r.left + 1), r.right - 1);
  const hit = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(cx, y);
  if (hit && el.contains(hit.startContainer)) return { el, node: hit.startContainer, offset: hit.startOffset };
  return end;
}

let drag: { baseFrameId: string; anchor: number; anchorEl: HTMLElement } | null = null;
let lastPointer = { x: 0, y: 0 };
let scrollFrame = 0;

function positionIn(links: Link[], baseFrameId: string, node: Node, offset: number): number | null {
  const base = links.findIndex((l) => l.frame.id === baseFrameId);
  if (base === -1) return null;
  return positionOf(links.slice(base).map((l) => l.el), node, offset);
}

function track() {
  if (!drag) return;
  const links = chain();
  const point = pointAt(lastPointer.x, lastPointer.y, links);
  if (!point) return;
  if (point.el === drag.anchorEl) {
    // Back on the starting page: the browser's own selection takes over.
    if (current) clearCrossSelection();
    return;
  }
  const focus = positionIn(links, drag.baseFrameId, point.node, point.offset);
  if (focus === null) return;
  current = { baseFrameId: drag.baseFrameId, anchor: drag.anchor, focus };
  paint();
}

/** Scroll the canvas while dragging near its top or bottom edge. */
function autoScroll() {
  cancelAnimationFrame(scrollFrame);
  const canvas = document.getElementById("document-canvas");
  if (!drag || !canvas) return;
  const view = canvas.getBoundingClientRect();
  const edge = 48;
  const speed =
    lastPointer.y > view.bottom - edge ? Math.min(40, (lastPointer.y - (view.bottom - edge)) / 2) :
    lastPointer.y < view.top + edge ? -Math.min(40, (view.top + edge - lastPointer.y) / 2) : 0;
  if (!speed) return;
  canvas.scrollTop += speed;
  track();
  scrollFrame = requestAnimationFrame(autoScroll);
}

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0 || useUi.getState().viewMode !== "edit") return;
  const target = e.target as HTMLElement | null;
  const inCanvas = !!target?.closest?.("#document-canvas");
  if (!inCanvas) return; // toolbar clicks keep the selection
  const el = editorOf(target);
  const links = chain();
  const link = el ? links.find((l) => l.el === el) : null;
  if (!el || !link) {
    clearCrossSelection();
    return;
  }

  // Shift+click on another page extends the selection to there.
  if (e.shiftKey) {
    const from = current ?? nativeAnchor(links);
    const point = pointAt(e.clientX, e.clientY, links);
    if (from && point) {
      const focus = positionIn(links, from.baseFrameId, point.node, point.offset);
      const anchorEl = placeAt(links.slice(links.findIndex((l) => l.frame.id === from.baseFrameId)).map((l) => l.el), from.anchor)?.ed;
      if (focus !== null && anchorEl && anchorEl !== point.el) {
        e.preventDefault();
        current = { baseFrameId: from.baseFrameId, anchor: from.anchor, focus };
        paint();
        return;
      }
    }
  }

  clearCrossSelection();
  const point = pointAt(e.clientX, e.clientY, links);
  if (!point) return;
  const baseFrameId = links[0].frame.id;
  const anchor = positionIn(links, baseFrameId, point.node, point.offset);
  if (anchor === null) return;
  drag = { baseFrameId, anchor, anchorEl: el };
  lastPointer = { x: e.clientX, y: e.clientY };
}

/** The native selection's anchor as a chain position (for Shift+click). */
function nativeAnchor(links: Link[]): CrossSelection | null {
  const sel = window.getSelection();
  if (!sel?.anchorNode || !editorOf(sel.anchorNode) || !links.length) return null;
  const baseFrameId = links[0].frame.id;
  const anchor = positionIn(links, baseFrameId, sel.anchorNode, sel.anchorOffset);
  return anchor === null ? null : { baseFrameId, anchor, focus: anchor };
}

function onMouseMove(e: MouseEvent) {
  if (!drag) return;
  if (!(e.buttons & 1)) {
    onMouseUp();
    return;
  }
  lastPointer = { x: e.clientX, y: e.clientY };
  track();
  autoScroll();
}

function onMouseUp() {
  drag = null;
  cancelAnimationFrame(scrollFrame);
}

// ── keys and clipboard ───────────────────────────────────────────────────────

// ── Shift+arrow keys ─────────────────────────────────────────────────────────

const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
/** Horizontal position kept across consecutive Shift+Up/Down presses. */
let goalX: number | null = null;

function chainEditors(baseFrameId: string): { links: Link[]; editors: HTMLElement[] } | null {
  const links = chain();
  const base = links.findIndex((l) => l.frame.id === baseFrameId);
  if (base === -1) return null;
  return { links, editors: links.slice(base).map((l) => l.el) };
}

/** Screen rectangle of the caret at (node, offset). */
function caretRect(node: Node, offset: number): DOMRect | null {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  const rect = r.getClientRects()[0];
  if (rect) return rect;
  // An empty line or an element boundary has no caret box: use the element's.
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element).childNodes[offset] ?? node : node.parentElement;
  return el instanceof Element ? el.getBoundingClientRect() : null;
}

function lineHeightPx(el: Element): number {
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight);
  const scale = (el as HTMLElement).offsetHeight ? el.getBoundingClientRect().height / (el as HTMLElement).offsetHeight : 1;
  return (Number.isFinite(lh) ? lh : parseFloat(cs.fontSize) * 1.2) * scale;
}

/** Whether ArrowLeft moves forward in this editor's text (right-to-left text). */
function leftIsForward(el: HTMLElement): boolean {
  return getComputedStyle(el).direction === "rtl";
}

/** Total position count of the chain (the end of the last page). */
function endPosition(editors: HTMLElement[]): number {
  const last = editors[editors.length - 1];
  return positionOf(editors, last, last.childNodes.length) ?? 0;
}

/**
 * The position one line above or below `pos`, at horizontal position `x`,
 * continuing onto the neighbouring page from a page's first or last line.
 */
function verticalMove(editors: HTMLElement[], pos: number, down: boolean, x: number | null, retried = false): { pos: number; x: number } | null {
  const at = placeAt(editors, pos);
  if (!at) return null;
  const rect = caretRect(at.node, at.offset);
  if (!rect) return null;
  const startX = x ?? rect.left;
  const block = (at.node.nodeType === Node.ELEMENT_NODE ? at.node as Element : at.node.parentElement)?.closest(".text-frame-edit > *") ?? at.ed;
  const lh = lineHeightPx(block);
  let target = at.ed;
  let y = down ? rect.bottom + lh / 2 : rect.top - lh / 2;
  const first = at.ed.firstElementChild?.getBoundingClientRect();
  const last = at.ed.lastElementChild?.getBoundingClientRect();
  const i = editors.indexOf(at.ed);
  if (down && last && y > last.bottom) {
    const next = editors[i + 1];
    if (!next) return { pos: endPosition(editors), x: startX };
    next.firstElementChild?.scrollIntoView({ block: "nearest" });
    target = next;
    const r = next.firstElementChild?.getBoundingClientRect() ?? next.getBoundingClientRect();
    y = r.top + Math.min(lineHeightPx(next.firstElementChild ?? next), r.height) / 2;
  } else if (!down && first && y < first.top) {
    const prev = editors[i - 1];
    if (!prev) return { pos: 0, x: startX };
    prev.lastElementChild?.scrollIntoView({ block: "nearest" });
    target = prev;
    const r = prev.lastElementChild?.getBoundingClientRect() ?? prev.getBoundingClientRect();
    y = r.bottom - Math.min(lineHeightPx(prev.lastElementChild ?? prev), r.height) / 2;
  } else {
    // Same page: bring the line into view so it can be hit-tested.
    const canvas = document.getElementById("document-canvas");
    const view = canvas?.getBoundingClientRect();
    if (!retried && canvas && view && (y < view.top || y > view.bottom)) {
      canvas.scrollTop += y < view.top ? y - view.top - lh : y - view.bottom + lh;
      return verticalMove(editors, pos, down, startX, true);
    }
  }
  const box = target.getBoundingClientRect();
  const cx = Math.min(Math.max(startX, box.left + 1), box.right - 1);
  const hit = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(cx, y);
  const node = hit && target.contains(hit.startContainer) ? hit.startContainer : target;
  const offset = hit && target.contains(hit.startContainer) ? hit.startOffset : down ? 0 : target.childNodes.length;
  const next = positionOf(editors, node, offset);
  return next === null ? null : { pos: next, x: startX };
}

/** Show the selection's moving end. */
function revealFocus(editors: HTMLElement[], pos: number) {
  const at = placeAt(editors, pos);
  const rect = at && caretRect(at.node, at.offset);
  const canvas = document.getElementById("document-canvas");
  if (!rect || !canvas) return;
  const view = canvas.getBoundingClientRect();
  if (rect.bottom > view.bottom - 24) canvas.scrollTop += rect.bottom - view.bottom + 48;
  else if (rect.top < view.top + 24) canvas.scrollTop -= view.top - rect.top + 48;
}

/** Set the selection to anchor..focus: native within one page, painted across pages. */
function setSelection(baseFrameId: string, anchor: number, focus: number) {
  const ctx = chainEditors(baseFrameId);
  if (!ctx) return;
  const a = placeAt(ctx.editors, anchor);
  const f = placeAt(ctx.editors, focus);
  if (!a || !f) return;
  if (a.ed === f.ed) {
    clearCrossSelection();
    if (document.activeElement !== a.ed) a.ed.focus({ preventScroll: true });
    window.getSelection()?.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
  } else {
    current = { baseFrameId, anchor, focus };
    paint();
  }
  revealFocus(ctx.editors, focus);
}

/**
 * Shift+arrow: extend the selection like within a page, continuing onto the
 * next or previous page at a page's edge. Returns true when handled here
 * (otherwise the browser moves the selection within the page).
 */
function shiftArrow(e: KeyboardEvent): boolean {
  const vertical = e.key === "ArrowUp" || e.key === "ArrowDown";
  if (!vertical) goalX = null;
  let baseFrameId: string;
  let anchor: number;
  let focus: number;
  let editors: HTMLElement[];
  if (current) {
    const ctx = chainEditors(current.baseFrameId);
    if (!ctx) return false;
    ({ baseFrameId, anchor, focus } = current);
    editors = ctx.editors;
  } else {
    // A selection inside one page: only its edges are ours.
    const sel = window.getSelection();
    const el = editorOf(sel?.focusNode ?? null);
    if (!sel?.focusNode || !sel.anchorNode || !el || editorOf(sel.anchorNode) !== el) return false;
    const links = chain();
    if (links.length < 2 || !links.some((l) => l.el === el)) return false;
    baseFrameId = links[0].frame.id;
    editors = links.map((l) => l.el);
    const a = positionOf(editors, sel.anchorNode, sel.anchorOffset);
    const f = positionOf(editors, sel.focusNode, sel.focusOffset);
    if (a === null || f === null) return false;
    anchor = a;
    focus = f;
    const i = editors.indexOf(el);
    const start = positionOf(editors, el, 0);
    const end = positionOf(editors, el, el.childNodes.length);
    const forward = e.key === (leftIsForward(el) ? "ArrowLeft" : "ArrowRight");
    if (!vertical) {
      if (forward && !(f === end && editors[i + 1])) return false;
      if (!forward && !(f === start && editors[i - 1])) return false;
    } else {
      const rect = caretRect(sel.focusNode, sel.focusOffset);
      const lh = rect ? lineHeightPx(el.lastElementChild ?? el) : 0;
      const lastBottom = el.lastElementChild?.getBoundingClientRect().bottom ?? 0;
      const firstTop = el.firstElementChild?.getBoundingClientRect().top ?? 0;
      if (!rect) return false;
      if (e.key === "ArrowDown" && !(rect.bottom + lh / 2 > lastBottom && editors[i + 1])) return false;
      if (e.key === "ArrowUp" && !(rect.top - lh / 2 < firstTop && editors[i - 1])) return false;
    }
  }

  let next: number | null = null;
  if (vertical) {
    const moved = verticalMove(editors, focus, e.key === "ArrowDown", goalX);
    if (moved) {
      next = moved.pos;
      goalX = moved.x;
    }
  } else {
    const at = placeAt(editors, focus);
    const forward = e.key === (at && leftIsForward(at.ed) ? "ArrowLeft" : "ArrowRight");
    next = Math.max(0, Math.min(endPosition(editors), focus + (forward ? 1 : -1)));
  }
  if (next === null) return false;
  setSelection(baseFrameId, anchor, next);
  return true;
}

function onKeyDown(e: KeyboardEvent) {
  if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && ARROWS.includes(e.key) && useUi.getState().viewMode === "edit") {
    if (shiftArrow(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    return;
  }
  goalX = null;
  if (!current) return;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (["shift", "meta", "control", "alt"].includes(key)) return;
  if (mod && (key === "c" || key === "x")) return; // copy/cut events below
  if (mod && (key === "b" || key === "i" || key === "u")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    formatCrossSelection(key === "b" ? "bold" : key === "i" ? "italic" : "underline");
    return;
  }
  if (!mod && (e.key === "Backspace" || e.key === "Delete")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    deleteCrossSelection();
    return;
  }
  // Typing (and Enter) replaces the selection: delete it, then let the key
  // insert at the join, where the caret now is.
  if (!mod && (e.key.length === 1 || e.key === "Enter")) {
    deleteCrossSelection();
    return;
  }
  // Anything else (arrows, Escape, ⌘A, …) ends it, with the caret at its end.
  const saved = current;
  clearCrossSelection();
  if (e.key === "Escape" || e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") {
    e.preventDefault();
    caretAt(saved.baseFrameId, saved.focus);
  }
}

function onCopy(e: ClipboardEvent) {
  const segs = segments();
  if (!segs || !e.clipboardData) return;
  if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select")) return;
  const { text, html } = selectedContent(segs);
  e.clipboardData.setData("text/plain", text);
  e.clipboardData.setData("text/html", html);
  e.preventDefault();
}

function onCut(e: ClipboardEvent) {
  if (!current) return;
  onCopy(e);
  if (e.defaultPrevented) deleteCrossSelection();
}

/** Mouse selection across pages, mounted once from the editor. */
export function useCrossPageSelection() {
  useEffect(() => {
    // A document change (undo, load, another edit) ends a stale selection;
    // formatting re-paints its own.
    const off = useDoc.subscribe((s, prev) => {
      if (s.documentEpoch !== prev.documentEpoch || s.revision !== prev.revision) clearCrossSelection();
    });
    const offUi = useUi.subscribe((s) => {
      if (s.allPagesSelected || s.viewMode !== "edit") clearCrossSelection();
    });
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseup", onMouseUp, true);
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    return () => {
      off();
      offUi();
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      clearCrossSelection();
    };
  }, []);
}
