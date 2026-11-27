// Rich-text hygiene for the contentEditable frames.
//
// ── The bug this exists for ─────────────────────────────────────────────────
// Text pasted from a website, Word or InPage arrives as HTML carrying the
// SOURCE document's typography — `<font face="Nafees">`, `font-size: 25px`,
// colours, WebKit's `caret-color` / `white-space-collapse` artifacts. The frame's
// own font/size are applied to the editor ROOT, so any such descendant styling
// silently wins for every character it wraps. The font and size pickers then
// appear completely dead: the store updates, the root's computed style updates,
// and not one glyph changes. When the named font isn't installed the browser
// falls back to the system Urdu face (Noto Nastaliq Urdu on macOS), which looks
// exactly like Harfsaz's default — so the report is "it always shows the default".
//
// Policy, matching InPage and every DTP tool: pasted text adopts the frame's
// style. We keep only line structure on paste, and on load we strip typography
// from stored HTML while preserving the editor's OWN per-selection formatting
// (bold / italic / underline / colour / per-paragraph alignment, and the size
// of selected text, which carries a data-harfsaz-size marker).

/** Inline style properties that belong to the FRAME, never to a pasted span. */
const STRIP_STYLE_PROPS = new Set([
  "font-family",
  "font-size",
  "font",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "background-color",
  "background",
  "caret-color",
  "white-space",
  "white-space-collapse",
  "text-wrap",
  "direction",
]);

/** Elements that carry source typography and should be unwrapped (children kept). */
const UNWRAP_TAGS = new Set(["FONT", "TT", "CODE", "KBD", "SAMP", "VAR", "PRE", "SMALL", "BIG"]);

/** Elements that must be dropped along with their content. */
const DROP_TAGS = new Set(["SCRIPT", "STYLE", "META", "LINK", "HEAD", "TITLE", "TEMPLATE", "IFRAME", "OBJECT"]);

const ALLOWED_TAGS = new Set("DIV P BR SPAN STRONG EM B I U S STRIKE SUP SUB OL UL LI TABLE THEAD TBODY TFOOT TR TH TD CAPTION COLGROUP COL H1 H2 H3 H4 H5 H6 BLOCKQUOTE".split(" "));
const ALLOWED_ATTRS = new Set(["style", "dir", "colspan", "rowspan", "start", "data-harfsaz-style", "data-harfsaz-table", "data-harfsaz-cont", "data-harfsaz-size"]);
const ALLOWED_STYLES = new Set(["color", "font-size", "font-weight", "font-style", "text-decoration", "text-decoration-line", "text-align", "line-height", "margin-left", "margin-right", "margin-top", "margin-bottom", "padding", "padding-left", "padding-right", "border", "border-width", "border-color", "border-style", "border-collapse", "width", "height", "vertical-align", "border-image-source", "border-image-slice", "border-image-width", "border-image-outset", "border-image-repeat", "padding-top", "padding-bottom", "table-layout", "list-style-type", "list-style-position", "text-indent", "margin-inline-start", "margin-inline-end", "margin-block", "margin-block-start", "margin-block-end", "padding-inline-start", "padding-inline-end"]);

/**
 * Remove source typography from stored/edited HTML, keeping structure and the
 * editor's own formatting. Every imported value is checked, including short HTML.
 */
export function sanitizeStoredHtml(html: string | undefined): string | undefined {
  if (!html) return html;
  if (typeof DOMParser === "undefined") return escapeHtml(html); // fail closed without a DOM

  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const body = doc.body;

  // Drop dangerous/irrelevant subtrees first.
  for (const tag of DROP_TAGS) {
    body.querySelectorAll(tag).forEach((el) => el.remove());
  }

  // Walk a static list — we mutate the tree as we go.
  const all = Array.from(body.querySelectorAll("*"));
  for (const el of all) {
    if (!el.isConnected) continue;

    if (UNWRAP_TAGS.has(el.tagName)) {
      unwrap(el);
      continue;
    }

    if (el.namespaceURI !== "http://www.w3.org/1999/xhtml" || !ALLOWED_TAGS.has(el.tagName)) {
      el.remove();
      continue;
    }
    for (const attribute of Array.from(el.attributes)) {
      if (!ALLOWED_ATTRS.has(attribute.name)) el.removeAttribute(attribute.name);
    }

    const style = (el as HTMLElement).style;
    if (style && style.length) {
      for (const prop of Array.from(style)) {
        const ownParagraph = /^(DIV|P|LI|H[1-6])$/.test(el.tagName) &&
          ["body", "heading", "subheading", "caption"].includes(el.getAttribute("data-harfsaz-style") ?? "");
        // Sizes the editor set on selected text (editor/selectionSize.ts) are kept;
        // pasted spans never carry the marker.
        const selectionSize = el.tagName === "SPAN" && el.hasAttribute("data-harfsaz-size") && prop === "font-size";
        const paragraphMetric = selectionSize || (ownParagraph && (prop === "font-size" || prop === "line-height"));
        if ((!ALLOWED_STYLES.has(prop) && !/^border-(top|right|bottom|left)(-(width|style|color))?$/.test(prop)) || /url\s*\(|expression|@import|var\s*\(/i.test(style.getPropertyValue(prop)) || (STRIP_STYLE_PROPS.has(prop) && !paragraphMetric)) style.removeProperty(prop);
      }
      if (!style.length) el.removeAttribute("style");
    }

    // A span left with no attributes is pure wrapper noise — unwrap it so
    // neighbouring letters share a text node (Nastaliq only joins within one).
    if (el.tagName === "SPAN" && el.attributes.length === 0) unwrap(el);
  }

  body.normalize();
  return body.innerHTML;
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/**
 * Reduce clipboard content to plain lines for insertion. Prefers text/plain;
 * falls back to flattening text/html (block boundaries → line breaks).
 */
export function clipboardToLines(data: DataTransfer): string[] {
  let text = data.getData("text/plain");
  if (!text) {
    const html = data.getData("text/html");
    if (html && typeof DOMParser !== "undefined") {
      const doc = new DOMParser().parseFromString(html, "text/html");
      for (const tag of DROP_TAGS) doc.querySelectorAll(tag).forEach((el) => el.remove());
      // Turn block boundaries into newlines before reading innerText-ish text.
      doc.body.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
      doc.body
        .querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6, tr, blockquote")
        .forEach((b) => b.append("\n"));
      text = doc.body.textContent ?? "";
    }
  }
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    // Collapse runs of blank lines to one — pasted articles are full of them.
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""));
}

const BLOCK_TAGS = /^(DIV|P|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TABLE|TR)$/;

/**
 * An editor's plain text, one line per block, read from the DOM. Unlike
 * `innerText` it doesn't depend on rendering: `innerText` leaves out text that
 * isn't visible, and print preview keeps the editor hidden rather than
 * removed. Text typed straight into an empty editor (no block yet) counts as
 * its first line.
 */
export function plainText(el: HTMLElement): string {
  const lines: string[] = [];
  let line: string | null = null;
  for (const node of Array.from(el.childNodes)) {
    if (node instanceof HTMLElement && BLOCK_TAGS.test(node.tagName)) {
      if (line !== null) lines.push(line);
      line = null;
      lines.push(node.textContent ?? "");
    } else if (node instanceof HTMLBRElement) {
      lines.push(line ?? "");
      line = null;
    } else {
      line = (line ?? "") + (node.textContent ?? "");
    }
  }
  if (line !== null) lines.push(line);
  return lines.join("\n");
}

/** Whether `el` is in the page and visible, so `innerText` reads all of it. */
export function shownInPage(el: HTMLElement): boolean {
  return el.isConnected && getComputedStyle(el).visibility !== "hidden";
}

/** Escape text for insertion as HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
