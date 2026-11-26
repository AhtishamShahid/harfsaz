// "Select all pages" (⌘A twice) as something you can see and copy.
//
// A browser selection cannot span the separate page editors, so while the mode
// is on, the text of every page is painted with the selection colour through
// the CSS Custom Highlight API, and ⌘C copies every page.
import { useEffect } from "react";
import { useDoc } from "../lib/store";
import { useUi } from "../lib/ui";

const NAME = "harfsaz-all-pages";

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = (): HighlightRegistry | null =>
  (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights ?? null;
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

function pageEditors(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".text-frame--page .text-frame-edit"));
}

let current: { clear?: () => void } | null = null;

function paint() {
  const reg = registry();
  if (!reg || !HighlightCtor) return;
  const ranges = pageEditors().map((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return r;
  });
  current = new HighlightCtor(...ranges) as { clear?: () => void };
  reg.set(NAME, current);
}

function clear() {
  if (!current) return;
  current.clear?.();
  registry()?.delete(NAME);
  current = null;
  // WebKit does not repaint text when a highlight is removed: the page that was
  // just clicked kept showing it until something else redrew it. Nudge every
  // page editor into a repaint.
  const editors = pageEditors();
  for (const el of editors) el.style.opacity = "0.999";
  requestAnimationFrame(() => {
    for (const el of editors) el.style.opacity = "";
  });
}

/** Every page's text, in page order, one page after another. */
function allPagesText(): { text: string; html: string } {
  const frames = useDoc.getState().pages
    .map((p) => p.frames.find((f) => f.isPageFrame && (f.kind ?? "text") === "text"))
    .filter((f) => !!f);
  const editors = new Map(pageEditors().map((el) => [el.dataset.frameId, el]));
  return {
    text: frames.map((f) => editors.get(f.id)?.innerText ?? f.text).join("\n"),
    html: frames.map((f) => editors.get(f.id)?.innerHTML ?? f.html ?? "").join(""),
  };
}

/** Collapse a range selection inside a page editor to a caret at its start. */
function collapsePageSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode) return;
  const editor = (sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode as Element : sel.anchorNode.parentElement)
    ?.closest(".text-frame--page .text-frame-edit");
  if (editor) sel.collapseToStart();
}

/** Delete every page's text, end the mode and put the caret on page 1. */
export function deleteAllPagesText() {
  useDoc.getState().clearAllPageText();
  useUi.getState().setAllPagesSelected(false);
  // The editors reseed from the store on the next render; focus page 1 after it.
  requestAnimationFrame(() => {
    const doc = useDoc.getState();
    const id = doc.pages[0]?.frames.find((f) => f.isPageFrame)?.id;
    const el = id ? document.querySelector<HTMLElement>(`.text-frame-edit[data-frame-id="${CSS.escape(id)}"]`) : null;
    if (!el) return;
    el.focus();
    window.getSelection()?.collapse(el.firstElementChild ?? el, 0);
    document.getElementById("document-canvas")?.scrollTo({ top: 0 });
  });
}

/** True when the browser can paint the whole-document highlight. */
export const canHighlightAllPages = (): boolean => !!registry() && !!HighlightCtor;

export function useAllPagesSelection() {
  useEffect(() => {
    let frame = 0;
    const repaint = () => {
      cancelAnimationFrame(frame);
      // Wait for React to commit the change so the ranges cover the new text.
      frame = requestAnimationFrame(() => (useUi.getState().allPagesSelected ? paint() : clear()));
    };
    const offUi = useUi.subscribe((s, prev) => {
      if (s.allPagesSelected === prev.allPagesSelected) return;
      // The current page's own selection (from the first ⌘A) stays underneath,
      // hidden by CSS, so ⌘C still has something to copy. It must not show up
      // again once the mode ends (e.g. after a click in the page margin, which
      // does not clear a contentEditable selection), so collapse it then.
      if (!s.allPagesSelected) {
        collapsePageSelection();
        cancelAnimationFrame(frame);
        clear(); // at once, before the click that ended the mode is painted
        return;
      }
      repaint();
    });
    const offDoc = useDoc.subscribe((s, prev) => {
      if (s.pages !== prev.pages && useUi.getState().allPagesSelected) repaint();
    });
    const onCopy = (e: ClipboardEvent) => {
      if (!useUi.getState().allPagesSelected || !e.clipboardData) return;
      // Copying inside a toolbar field (e.g. the Size box) copies that field.
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select")) return;
      const { text, html } = allPagesText();
      e.clipboardData.setData("text/plain", text);
      e.clipboardData.setData("text/html", html);
      e.preventDefault();
    };
    // ⌘X copies every page, then deletes all the text.
    const onCut = (e: ClipboardEvent) => {
      if (!useUi.getState().allPagesSelected || !e.clipboardData) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select")) return;
      const { text, html } = allPagesText();
      e.clipboardData.setData("text/plain", text);
      e.clipboardData.setData("text/html", html);
      e.preventDefault();
      deleteAllPagesText();
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    return () => {
      cancelAnimationFrame(frame);
      offUi();
      offDoc();
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      clear();
    };
  }, []);
}
