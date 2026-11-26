// Font size for selected text (not just the whole frame).
//
// The size lives on `<span data-harfsaz-size style="font-size: …em">`, relative
// to the surrounding paragraph, so changing the frame's size later still scales
// it. The marker is what lets the sanitizer keep these sizes while it strips the
// font sizes pasted content brings along (see sanitize.ts).

export const SIZE_ATTR = "data-harfsaz-size";

/** A text range inside one editor, kept while focus visits the toolbar. */
export interface SizeSelection {
  host: HTMLElement;
  range: Range;
}

/** The current non-empty selection, if it lies inside one editable frame editor. */
export function captureSizeSelection(): SizeSelection | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
  const host = start?.closest<HTMLElement>('.text-frame-edit[contenteditable="true"]');
  if (!host || !host.contains(range.endContainer)) return null;
  if (!range.toString().trim()) return null;
  return { host, range: range.cloneRange() };
}

/** Font size in px of the selection's first character. */
export function selectionSizePx(target: SizeSelection): number | null {
  const node = target.range.startContainer;
  let el = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  // A range starting at the end of a text node reads the next character's size.
  if (node.nodeType === Node.TEXT_NODE && target.range.startOffset >= (node as Text).length) {
    const walker = document.createTreeWalker(target.host, NodeFilter.SHOW_TEXT);
    walker.currentNode = node;
    const next = walker.nextNode();
    if (next && target.range.intersectsNode(next)) el = next.parentElement;
  }
  if (!el) return null;
  const px = parseFloat(getComputedStyle(el).fontSize);
  return Number.isFinite(px) ? Math.round(px) : null;
}

/** Whether the range covers all of the editor's text. */
export function coversWholeEditor(target: SizeSelection): boolean {
  return target.range.toString().replace(/\s/g, "") === (target.host.textContent ?? "").replace(/\s/g, "");
}

/** Remove per-selection sizes inside `root` (unwrapping spans left bare). */
export function clearSelectionSizes(root: Element) {
  for (const span of Array.from(root.querySelectorAll<HTMLElement>(`[${SIZE_ATTR}]`))) {
    span.style.removeProperty("font-size");
    span.removeAttribute(SIZE_ATTR);
    if (!span.getAttribute("style")) span.removeAttribute("style");
    if (span.tagName === "SPAN" && span.attributes.length === 0) {
      while (span.firstChild) span.parentNode!.insertBefore(span.firstChild, span);
      span.remove();
    }
  }
}

/**
 * Set the selected text to `px` (page px). Returns the range now covering the
 * resized text, or null when nothing was applied.
 *
 * Wraps exactly the selected text nodes (split at the selection's ends) in size
 * spans, so nothing outside the selection changes. (execCommand("fontSize")
 * was tried first: it rewrites surrounding font sizes, moving a paragraph's
 * size onto unselected neighbours and emptying earlier size spans.)
 */
export function applySelectionSize(target: SizeSelection, px: number): SizeSelection | null {
  const { host, range } = target;
  if (!host.isConnected || !host.contains(range.startContainer) || !host.contains(range.endContainer) || range.collapsed) return null;

  // Split text nodes at the selection's ends so whole nodes can be wrapped.
  let { startContainer: start, startOffset, endContainer: end, endOffset } = range;
  if (end.nodeType === Node.TEXT_NODE && endOffset > 0 && endOffset < (end as Text).length) {
    (end as Text).splitText(endOffset);
  }
  if (start.nodeType === Node.TEXT_NODE && startOffset > 0 && startOffset < (start as Text).length) {
    const tail = (start as Text).splitText(startOffset);
    if (end === start) { end = tail; endOffset -= startOffset; }
    start = tail;
    startOffset = 0;
  }
  const within = document.createRange();
  within.setStart(start, startOffset);
  within.setEnd(end, end.nodeType === Node.TEXT_NODE ? Math.min(endOffset, (end as Text).length) : endOffset);

  const texts: Text[] = [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
    if (!t.data || !within.intersectsNode(t)) continue;
    // Skip nodes the range only touches at an edge.
    if (t === within.endContainer && within.endOffset === 0) continue;
    if (t === within.startContainer && within.startOffset >= t.length) continue;
    texts.push(t);
  }
  if (!texts.length) return null;

  const spans: HTMLElement[] = [];
  for (const t of texts) {
    const parent = t.parentElement!;
    let span: HTMLElement;
    if (parent.hasAttribute(SIZE_ATTR) && parent.childNodes.length === 1) {
      span = parent; // already its own size span: just resize it
    } else {
      span = document.createElement("span");
      span.setAttribute(SIZE_ATTR, "");
      parent.insertBefore(span, t);
      span.appendChild(t);
    }
    const parentPx = parseFloat(getComputedStyle(span.parentElement ?? host).fontSize) || px;
    span.style.fontSize = `${Math.round((px / parentPx) * 10000) / 10000}em`;
    // Join with an identical neighbour so letters stay in one text node
    // (Nastaliq only joins within one).
    const prev = span.previousSibling;
    if (prev instanceof HTMLElement && prev.hasAttribute(SIZE_ATTR) && prev.getAttribute("style") === span.getAttribute("style") && spans.includes(prev)) {
      while (span.firstChild) prev.appendChild(span.firstChild);
      span.remove();
      prev.normalize();
      continue;
    }
    spans.push(span);
  }

  host.dispatchEvent(new Event("harfsaz-format")); // RichEditor stores the new HTML
  const next = document.createRange();
  next.setStartBefore(spans[0]);
  next.setEndAfter(spans[spans.length - 1]);
  host.focus({ preventScroll: true });
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(next);
  return { host, range: next.cloneRange() };
}
