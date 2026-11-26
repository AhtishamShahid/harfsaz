// Workspace UI state (panel visibility, zoom) — separate from the document model.
import { create } from "zustand";
import { useDoc } from "./store";

interface UiState {
  aiPanelOpen: boolean;
  objectBarOpen: boolean;
  zoom: number; // 0.25 – 2
  /** Editor view mode for the canvas (applies to all frames). */
  viewMode: "edit" | "preview";
  /** Whole-document selection: toolbar formatting applies to every page. */
  allPagesSelected: boolean;
  setAllPagesSelected: (v: boolean) => void;
  /** Phonetic Roman→Urdu typing. */
  phonetic: boolean;
  /** Print dialog open. */
  printOpen: boolean;
  setPrintOpen: (v: boolean) => void;
  /** Keyboard-reference overlay open. */
  keyboardHelpOpen: boolean;
  setKeyboardHelpOpen: (v: boolean) => void;
  /** Upgrade / paywall modal open. */
  upgradeOpen: boolean;
  setUpgradeOpen: (v: boolean) => void;
  /** Settings (AI provider/key) dialog open. */
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
  /** OCR ("scan handwriting") dialog open. */
  ocrOpen: boolean;
  setOcrOpen: (v: boolean) => void;
  /** Show the floating AI menu when text is selected (and on right-click). */
  selectionAi: boolean;
  setSelectionAi: (v: boolean) => void;
  toggleAiPanel: () => void;
  setAiPanel: (open: boolean) => void;
  toggleObjectBar: () => void;
  setViewMode: (m: "edit" | "preview") => void;
  togglePhonetic: () => void;
  setZoom: (z: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fitZoom: () => void;
}

const SELECTION_AI_KEY = "harfsaz.selectionAi";
function readSelectionAi(): boolean {
  try {
    return localStorage.getItem(SELECTION_AI_KEY) !== "off";
  } catch {
    return true;
  }
}

const clampZoom = (z: number) => Math.max(0.25, Math.min(2, Math.round(z * 100) / 100));

export const useUi = create<UiState>((set) => ({
  aiPanelOpen: false,
  objectBarOpen: false,
  zoom: 1,
  viewMode: "edit",
  phonetic: true,
  allPagesSelected: false,
  setAllPagesSelected: (v) => set({ allPagesSelected: v }),
  printOpen: false,
  setPrintOpen: (v) => set({ printOpen: v }),
  keyboardHelpOpen: false,
  setKeyboardHelpOpen: (v) => set({ keyboardHelpOpen: v }),
  upgradeOpen: false,
  setUpgradeOpen: (v) => set({ upgradeOpen: v }),
  settingsOpen: false,
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  ocrOpen: false,
  setOcrOpen: (v) => set({ ocrOpen: v }),
  selectionAi: readSelectionAi(),
  setSelectionAi: (v) => {
    try {
      localStorage.setItem(SELECTION_AI_KEY, v ? "on" : "off");
    } catch {
      /* private mode etc.: the choice lasts for this session only */
    }
    set({ selectionAi: v });
  },
  toggleAiPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
  setAiPanel: (open) => set({ aiPanelOpen: open }),
  toggleObjectBar: () => set((s) => ({ objectBarOpen: !s.objectBarOpen })),
  setViewMode: (m) => set({ viewMode: m }),
  togglePhonetic: () => set((s) => ({ phonetic: !s.phonetic })),
  setZoom: (z) => set({ zoom: clampZoom(z) }),
  zoomIn: () => set((s) => ({ zoom: clampZoom(s.zoom + 0.1) })),
  zoomOut: () => set((s) => ({ zoom: clampZoom(s.zoom - 0.1) })),
  fitZoom: () => {
    const canvas = document.getElementById("document-canvas");
    const doc = useDoc.getState();
    const page = doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0];
    if (!canvas || !page) return;
    const availableWidth = Math.max(1, canvas.clientWidth - 80);
    const availableHeight = Math.max(1, canvas.clientHeight - 100);
    const fitted = Math.min(availableWidth / page.width, availableHeight / page.height);
    set({ zoom: clampZoom(Math.floor(fitted * 100) / 100) });
  },
}));
