import { useEffect, useRef, useState, type RefObject } from "react";
import { layoutPreview, PreviewLayout, isTauri } from "../lib/tauri";
import { ensureShaperFont } from "../lib/font";

/**
 * Print-grade renderer: draws the glyph outlines placed by the Rust
 * HarfBuzz (harfrust) shaper as SVG paths (one per line), the same layout the
 * vector PDF uses — independent of the browser's own text shaping.
 *
 * Only functional inside the Tauri runtime (it calls the Rust shaper). In a
 * plain browser tab it shows a hint instead. A frame is laid out once it comes
 * near the visible part of the canvas, so a long document doesn't shape every
 * page before showing the first.
 */
export function GlyphRenderer({
  text,
  fontSize,
  width,
  height,
  fontKey,
  align = "right",
  lineHeight,
}: {
  text: string;
  fontSize: number;
  width: number;
  height: number;
  fontKey: string;
  /** Paragraph alignment; "justify" enables kashida elongation in the shaper. */
  align?: "right" | "center" | "left" | "justify";
  /** Line height as a multiple of the font size. */
  lineHeight?: number;
}) {
  const [layout, setLayout] = useState<PreviewLayout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const near = useNearView(box);

  useEffect(() => {
    if (!isTauri() || !near) return;
    let alive = true;
    (async () => {
      try {
        const key = await ensureShaperFont(fontKey);
        const result = await layoutPreview({ fontKey: key, text, fontSize, width, align, lineHeight });
        if (alive) {
          setLayout(result);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [near, text, fontSize, width, fontKey, align, lineHeight]);

  if (!isTauri()) {
    return (
      <div className="render-hint">
        Print-grade vector rendering runs in the desktop app (Tauri). In the
        browser preview, use Edit mode to see Nastaliq.
      </div>
    );
  }

  const overflow = !!layout && layout.used_height > height;
  const clipId = `frame-clip-${width}x${height}`;

  return (
    <div ref={box} style={{ width, height }}>
      {error ? (
        <div className="render-error">{error}</div>
      ) : !layout ? (
        <div className="render-hint">Shaping…</div>
      ) : (
        <svg className="glyph-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          {/* Clip glyphs to the frame so nothing bleeds past its edges. */}
          <defs>
            <clipPath id={clipId}>
              <rect x={0} y={0} width={width} height={height} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${clipId})`}>
            {layout.lines.map((d, i) => d && <path key={i} d={d} className="glyph-path" />)}
          </g>
          {overflow && (
            <rect x={0} y={height - 4} width={width} height={4} className="overflow-marker" />
          )}
        </svg>
      )}
    </div>
  );
}

/** True once `ref` has come within a screen's height of the canvas viewport. */
function useNearView(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { root: el.closest("#document-canvas"), rootMargin: "100% 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, near]);
  return near;
}
