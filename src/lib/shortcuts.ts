import { useWorkspace } from "./workspace";
// Global keyboard shortcuts + auto-save. Mounted once from App.
import { useEffect } from "react";
import { deleteAllPagesText } from "../editor/allPagesSelection";
import { useDoc } from "./store";
import { useUi } from "./ui";
import { useSearch } from "./search";
import { ensureAllDocumentFonts } from "./font";
import {
  saveDocument,
  saveDocumentAs,
  openDocument,
  autoSave,
  newDocumentGuarded,
  installCloseGuard,
  writeRecovery,
  offerRecovery,
} from "./documents";

const AUTOSAVE_MS = 30_000;

/** The main text editor of the page being worked on (selected frame's page, else the active page). */
function currentPageEditor(): HTMLElement | null {
  const doc = useDoc.getState();
  const page = doc.getSelectedFrame()?.page ?? doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0];
  const frame = page?.frames.find((f) => f.isPageFrame && (f.kind ?? "text") === "text");
  return frame ? document.querySelector<HTMLElement>(`.text-frame-edit[data-frame-id="${CSS.escape(frame.id)}"]`) : null;
}

/** Whether the selection covers all of `editor`'s text. */
function wholeEditorSelected(editor: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode || !editor.contains(sel.anchorNode) || !sel.focusNode || !editor.contains(sel.focusNode)) return false;
  return sel.toString().replace(/\s/g, "") === (editor.textContent ?? "").replace(/\s/g, "");
}

/**
 * Wires application keyboard shortcuts (⌘/Ctrl based) and a periodic auto-save.
 *
 * Shortcuts:
 *   ⌘S save · ⇧⌘S save as · ⌘O open · ⌘N new page · ⌘P print
 *   ⌘Z undo · ⇧⌘Z / ⌘Y redo · ⌘+ / ⌘- / ⌘0 zoom in/out/fit
 *
 * Editing shortcuts (bold/italic/underline) are left to the contentEditable's
 * native handling so they apply to the selection.
 */
export function useShortcuts() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (useWorkspace.getState().view !== "editor") return;
      const doc = useDoc.getState();
      const ui = useUi.getState();

      // Backspace/Delete with every page selected deletes all the text, like
      // in a word processor (not just the current page's, or nothing).
      const inField = !!(e.target as HTMLElement | null)?.closest?.("input, textarea, select");
      if (ui.allPagesSelected && !inField && !e.metaKey && !e.ctrlKey && (e.key === "Backspace" || e.key === "Delete")) {
        e.preventDefault();
        deleteAllPagesText();
        return;
      }

      // Delete / Backspace removes the selected image/shape frame. We only block
      // it when the user is actively typing — i.e. focus is in an input/textarea,
      // or in a *text* frame's editor. Image/shape frames have no text editor, so
      // selecting one and pressing Delete always removes it (even though the page
      // frame's editor may still hold focus in the background).
      if (e.key === "Delete" || e.key === "Backspace") {
        const sel = doc.getSelectedFrame();
        if (!sel || sel.frame.isPageFrame) return;

        const ae = document.activeElement as HTMLElement | null;
        const typingInForm = !!ae?.closest?.("input, textarea");
        // Editing THIS text frame? (only relevant for text frames)
        const editingThisText =
          sel.frame.kind === "text" && !!ae?.closest?.(".text-frame-edit");
        if (typingInForm || editingThisText) return;

        e.preventDefault();
        doc.removeFrame(sel.page.id, sel.frame.id);
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // Whole-document selection ends on Escape or on any key that would edit
      // or move within the page (typing only ever affects the current page).
      // Keys typed into toolbar fields (e.g. the Size box) must keep it, and so
      // must ⌘C and ⌘X, which copy (and cut) every page while it is on.
      const inDocument = !!(e.target as HTMLElement | null)?.closest?.("#document-canvas");
      if (ui.allPagesSelected && (e.key === "Escape" || (inDocument && !(mod && (key === "a" || key === "c" || key === "x")) && !["shift", "meta", "control", "alt"].includes(key)))) {
        ui.setAllPagesSelected(false);
        if (e.key === "Escape") { e.preventDefault(); return; }
      }

      if (!mod) return;

      switch (key) {
        case "a": {
          // First ⌘A: the current page's text is selected. ⌘A again (whole page
          // already selected): select ALL pages, so the toolbar's font, size,
          // line height etc. apply to every page. This also works right after
          // using the toolbar (e.g. the Size box), where focus has left the page.
          const ae = document.activeElement as HTMLElement | null;
          let editor = ae?.closest?.(".text-frame--page .text-frame-edit") as HTMLElement | null;
          if (!editor) {
            const field = ae?.closest?.("input, textarea, select, [contenteditable='true']") as HTMLElement | null;
            const toolbarNumber = field instanceof HTMLInputElement && field.type === "number" && !field.closest("#document-canvas, [role='dialog']");
            if (field && !toolbarNumber) break; // ⌘A inside a text field selects that field
            editor = currentPageEditor();
            if (!editor) break;
          }
          e.preventDefault();
          if (ui.allPagesSelected || wholeEditorSelected(editor)) {
            ui.setAllPagesSelected(true);
          } else {
            editor.focus({ preventScroll: true });
            const range = document.createRange();
            range.selectNodeContents(editor);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
          }
          break;
        }
        case "f":
          // ⌘F opens find & replace. Handled here (capture phase) so it wins
          // over the webview's own find behaviour.
          e.preventDefault();
          useSearch.getState().setOpen(true);
          break;
        case "g":
          // ⌘G / ⇧⌘G steps through matches, matching platform convention.
          e.preventDefault();
          if (e.shiftKey) useSearch.getState().prev();
          else useSearch.getState().next();
          break;
        case "s":
          e.preventDefault();
          if (e.shiftKey) saveDocumentAs();
          else saveDocument();
          break;
        case "o":
          e.preventDefault();
          openDocument();
          break;
        case "n":
          // ⌘⇧N is New document in the File menu; without the shift branch it
          // fell through and added a page instead.
          e.preventDefault();
          if (e.shiftKey) newDocumentGuarded();
          else doc.addPage();
          break;
        case "p":
          e.preventDefault();
          ui.setPrintOpen(true);
          break;
        case "z":
          e.preventDefault();
          if (e.shiftKey) doc.redo();
          else doc.undo();
          break;
        case "y":
          e.preventDefault();
          doc.redo();
          break;
        case "=":
        case "+":
          e.preventDefault();
          ui.zoomIn();
          break;
        case "-":
          e.preventDefault();
          ui.zoomOut();
          break;
        case "0":
          e.preventDefault();
          ui.fitZoom();
          break;
        default:
          break;
      }
    }
    // Capture phase so our undo/redo wins over the contentEditable's native undo
    // (which would otherwise revert DOM text out of sync with our history).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Clicking anywhere in the document ends whole-document selection; toolbar
  // and menu clicks (outside the canvas) keep it so formatting can be applied.
  useEffect(() => {
    const end = (e: PointerEvent) => {
      if (!useUi.getState().allPagesSelected) return;
      if ((e.target as HTMLElement | null)?.closest?.("#document-canvas")) useUi.getState().setAllPagesSelected(false);
    };
    window.addEventListener("pointerdown", end, true);
    return () => window.removeEventListener("pointerdown", end, true);
  }, []);

  // Periodic auto-save (only writes when a file exists and there are changes).
  // autoSave records its own failures on the store (surfaced in the status bar),
  // so the catch here is only for unexpected throws, not for write errors.
  useEffect(() => {
    const id = setInterval(() => {
      autoSave().catch(() => {});
      // Mirror never-saved documents to the recovery file on the same tick;
      // it no-ops once the document has a real path.
      writeRecovery().catch(() => {});
    }, AUTOSAVE_MS);
    return () => clearInterval(id);
  }, []);

  // Offer to restore work left behind by a crash. Runs once, on mount.
  useEffect(() => {
    offerRecovery().then(restored => { if(restored) useWorkspace.getState().setView("editor"); }).catch(() => {});
  }, []);

  // Keep every font the document references registered as a CSS @font-face.
  //
  // Faces were previously registered only by the frame that used them, when it
  // mounted. That left two holes: a font chosen from the toolbar was not
  // registered until a re-render, and opening a .harfsaz file whose frames use
  // fonts this session has never shown left them unregistered — in both cases
  // CSS silently falls back to serif, so Nastaliq is lost with no error.
  // Subscribing here covers the whole document, including after undo/redo/open.
  useEffect(() => {
    const sync = (pages: ReturnType<typeof useDoc.getState>["pages"]) => {
      ensureAllDocumentFonts(pages.flatMap((p) => p.frames.map((f) => f.fontKey))).catch(
        () => {}
      );
    };
    sync(useDoc.getState().pages);
    return useDoc.subscribe((s, prev) => {
      if (s.pages !== prev.pages) sync(s.pages);
    });
  }, []);

  // Confirm before the window closes over unsaved changes.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    installCloseGuard().then((fn) => {
      // The effect may have torn down while the listener was being installed.
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
