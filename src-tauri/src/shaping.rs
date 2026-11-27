//! Nastaliq / Arabic-script text shaping.
//!
//! This is the genuinely hard part of an Urdu DTP app — turning a string of
//! Unicode code points into correctly joined, ligated, positioned glyphs in the
//! Nastaliq calligraphic style. We lean on `harfrust` (the HarfBuzz project's
//! pure-Rust port of HarfBuzz) which carries the same complex-shaping logic
//! HarfBuzz uses for fonts like Noto Nastaliq Urdu and Gulzar — including
//! bari-ye handling. Outlines and metrics come from `ttf-parser`.
//!
//! The frontend registers each font once (see `register_font`), then asks for
//! the layout of a text frame by font key. Layout is done here rather than by
//! the browser's line breaker, so print preview and PDF place every glyph the
//! same way.
//!
//! ── Speed ────────────────────────────────────────────────────────────────────
//! Shaping Nastaliq is expensive: about 3 µs a letter with Noto Nastaliq Urdu
//! and 35 µs with Gulzar (rustybuzz, used before, took 12 and 220 µs). So each
//! paragraph is shaped once, line breaks are found from the glyph advances, and
//! lines are cut out of that one shaping. A line is shaped again on its own
//! only where HarfBuzz marks the break as unsafe (the two sides would shape
//! differently). Shaping plans, shaped paragraphs and laid-out frames are cached
//! per font, so the PDF reuses what print preview already laid out.

use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex, OnceLock};

/// One positioned glyph, ready for the renderer to place on a page.
#[derive(Serialize, Clone, Debug)]
pub struct ShapedGlyph {
    /// Glyph index within the font (for canvas/SVG glyph rendering).
    pub glyph_id: u32,
    /// Cluster = byte offset in the source string this glyph maps back to.
    /// Critical for cursor placement / selection in an RTL editor.
    pub cluster: u32,
    /// Horizontal advance in pixels at the requested font size.
    pub x_advance: f32,
    /// Vertical advance (0 for horizontal Urdu text, but kept for completeness).
    pub y_advance: f32,
    /// Per-glyph offset from the pen position, in pixels.
    pub x_offset: f32,
    pub y_offset: f32,
}

/// Result of shaping a single run of text.
#[derive(Serialize, Clone, Debug)]
pub struct ShapedRun {
    pub glyphs: Vec<ShapedGlyph>,
    /// Total width of the run in pixels — used by the line breaker / justifier.
    pub total_advance: f32,
    /// Whether shaping detected right-to-left direction.
    pub rtl: bool,
}

// ── Fonts ────────────────────────────────────────────────────────────────────

/// A font the shaper can use, with its caches.
pub struct Font {
    /// Outlines and metrics.
    pub face: ttf_parser::Face<'static>,
    /// The font as the shaper reads it.
    shaper: harfrust::Font,
    /// Shaping plans by direction and script (building one walks the font's
    /// lookups, which is not free with a font like Gulzar).
    plans: Mutex<HashMap<Props, Arc<harfrust::ShapePlan>>>,
    /// The raw font file (embedded as-is in PDFs).
    pub data: &'static [u8],
    /// The font file compressed for embedding in PDFs (see `embedded`).
    compressed: OnceLock<Vec<u8>>,
    paragraphs: Mutex<HashMap<String, Arc<Paragraph>>>,
    layouts: Mutex<HashMap<LayoutKey, Arc<FrameLayout>>>,
    tails: Mutex<HashMap<(u16, u32), Arc<GlyphTail>>>,
}

/// Cache sizes. A cache that fills up is emptied and starts again, which is
/// simpler than LRU and only costs a re-shape after a lot of editing.
const MAX_PARAGRAPHS: usize = 20_000;
const MAX_LAYOUTS: usize = 2_000;
const MAX_TAILS: usize = 50_000;

impl Font {
    /// Parse a font file. The bytes live for the rest of the process (fonts
    /// are registered once each and kept), which lets the parsed face be cached.
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Font, String> {
        match ttf_parser::Face::parse(&bytes, 0) {
            Ok(face) if face.units_per_em() > 0 => {}
            Ok(_) => return Err("Font reported invalid units-per-em".into()),
            Err(_) => return Err("Failed to parse font (not a valid ttf/otf)".into()),
        }
        let data: &'static [u8] = Box::leak(bytes.into_boxed_slice());
        let face = ttf_parser::Face::parse(data, 0)
            .map_err(|_| "Failed to parse font (not a valid ttf/otf)".to_string())?;
        let shaper = harfrust::Font::new(data, 0)
            .ok_or_else(|| "Failed to parse font (not a valid ttf/otf)".to_string())?;
        let font = Font {
            face,
            shaper,
            plans: Mutex::default(),
            data,
            compressed: OnceLock::new(),
            paragraphs: Mutex::default(),
            layouts: Mutex::default(),
            tails: Mutex::default(),
        };
        // The shaper refuses malformed fonts (HarfBuzz would fall back to
        // drawing nothing useful); find out now rather than on every line.
        font.try_shape("اب ab").map_err(|e| format!("This font cannot be shaped: {e}"))?;
        Ok(font)
    }

    /// Shape `text` on its own, with the direction and script it implies.
    /// Registration checked the font shapes, so a failure here is not expected;
    /// it gives no glyphs rather than a panic.
    fn shape(&self, text: &str) -> Run {
        self.try_shape(text).unwrap_or(Run { glyphs: Vec::new(), rtl: false })
    }

    fn try_shape(&self, text: &str) -> Result<Run, harfrust::ShapeError> {
        let mut buffer = harfrust::Buffer::new();
        buffer.push_str(text);
        buffer.guess_segment_properties();
        let props = (buffer.direction(), buffer.script());
        let plan = self.plan(props);
        let shaper = harfrust::ShaperFont::new(&self.shaper);
        harfrust::shape(&shaper, &mut buffer, harfrust::ShapeOptions::new().plan(Some(&plan)))?;
        let glyphs = buffer
            .glyph_infos()
            .iter()
            .zip(buffer.glyph_positions())
            .map(|(info, pos)| PGlyph {
                gid: info.glyph_id as u16,
                cluster: info.cluster,
                adv: pos.x_advance,
                xo: pos.x_offset,
                yo: pos.y_offset,
                unsafe_to_break: info.unsafe_to_break(),
            })
            .collect();
        Ok(Run { glyphs, rtl: props.0 == harfrust::Direction::RightToLeft })
    }

    fn plan(&self, (direction, script): Props) -> Arc<harfrust::ShapePlan> {
        if let Some(plan) = lock(&self.plans).get(&(direction, script)) {
            return plan.clone();
        }
        let plan = Arc::new(harfrust::ShapePlan::new(&self.shaper, direction, script, None, &[]));
        lock(&self.plans).insert((direction, script), plan.clone());
        plan
    }

    /// The font file deflated for embedding in a PDF. Made once; registering a
    /// font starts it in the background, so an export rarely waits for it.
    pub fn embedded(&self) -> &[u8] {
        // Level 3: about 40 ms for a 1 MB font, within 2% of the size level 6
        // reaches in twice the time.
        self.compressed.get_or_init(|| miniz_oxide::deflate::compress_to_vec_zlib(self.data, 3))
    }

    /// The shaping of one paragraph (text without newlines), cached.
    fn paragraph(&self, text: &str) -> Arc<Paragraph> {
        if let Some(p) = lock(&self.paragraphs).get(text) {
            return p.clone();
        }
        let p = Arc::new(Paragraph::new(text, self.shape(text)));
        insert_bounded(&self.paragraphs, text.to_string(), p.clone(), MAX_PARAGRAPHS);
        p
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn insert_bounded<K: Eq + Hash, V>(map: &Mutex<HashMap<K, V>>, key: K, value: V, max: usize) {
    let mut map = lock(map);
    if map.len() >= max {
        map.clear();
    }
    map.insert(key, value);
}

fn registry() -> &'static Mutex<HashMap<String, Arc<Font>>> {
    static FONTS: OnceLock<Mutex<HashMap<String, Arc<Font>>>> = OnceLock::new();
    FONTS.get_or_init(Mutex::default)
}

/// Keys whose font was refused, with the reason. Parsing keeps the bytes for
/// good before the shaper has checked them, so asking again (the frontend
/// retries a failed font on the next preview) must not parse them again.
fn refused() -> &'static Mutex<HashMap<String, String>> {
    static REFUSED: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    REFUSED.get_or_init(Mutex::default)
}

/// Make a font available under `key`. Registering a key again keeps the first.
pub fn register_font(key: &str, bytes: Vec<u8>) -> Result<(), String> {
    if lock(registry()).contains_key(key) {
        return Ok(());
    }
    if let Some(reason) = lock(refused()).get(key) {
        return Err(reason.clone());
    }
    let font = match Font::from_bytes(bytes) {
        Ok(font) => Arc::new(font),
        Err(reason) => {
            lock(refused()).insert(key.to_string(), reason.clone());
            return Err(reason);
        }
    };
    let font = lock(registry()).entry(key.to_string()).or_insert(font).clone();
    std::thread::spawn(move || {
        font.embedded();
    });
    Ok(())
}

/// A registered font.
pub fn font(key: &str) -> Result<Arc<Font>, String> {
    lock(registry())
        .get(key)
        .cloned()
        .ok_or_else(|| format!("Font \"{key}\" has not been loaded for shaping"))
}

// ── Paragraph shaping ────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
struct PGlyph {
    gid: u16,
    cluster: u32,
    /// Advance and offsets in font units.
    adv: i32,
    xo: i32,
    yo: i32,
    /// Breaking the text where this glyph's cluster starts changes the shaping.
    unsafe_to_break: bool,
}

/// The direction and script the shaper picks for a text.
type Props = (harfrust::Direction, Option<harfrust::Script>);

/// One paragraph shaped once, in font units.
struct Paragraph {
    /// Glyphs in visual order (right to left text is already reversed).
    glyphs: Vec<PGlyph>,
    props: Props,
    /// `prefix[b]`: total advance of the clusters that start before byte `b`.
    prefix: Vec<i64>,
    /// `safe[b]`: the text can be broken at byte `b` and each side shaped on
    /// its own with exactly the glyphs this shaping has.
    safe: Vec<bool>,
}

impl Paragraph {
    fn new(text: &str, run: Run) -> Paragraph {
        let props = props(text);
        let n = text.len();
        let mut advance_at = vec![0i64; n + 1];
        let mut starts = vec![false; n + 1];
        let mut unsafe_at = vec![false; n + 1];
        for g in &run.glyphs {
            let c = (g.cluster as usize).min(n);
            advance_at[c] += g.adv as i64;
            starts[c] = true;
            unsafe_at[c] |= g.unsafe_to_break;
        }
        let glyphs = run.glyphs;
        let mut prefix = vec![0i64; n + 1];
        for b in 0..n {
            prefix[b + 1] = prefix[b] + advance_at[b];
        }
        let safe = (0..=n)
            .map(|b| b == 0 || b == n || (starts[b] && !unsafe_at[b]))
            .collect();
        Paragraph { glyphs, props, prefix, safe }
    }

    /// Whether the text in `a..b` shapes, on its own, exactly as it does here.
    fn can_slice(&self, text: &str, a: usize, b: usize) -> bool {
        self.safe[a] && self.safe[b] && props(&text[a..b]) == self.props
    }

    /// Width of `a..b` in font units (only meaningful when `can_slice`).
    fn width(&self, a: usize, b: usize) -> i64 {
        self.prefix[b] - self.prefix[a]
    }

    /// The advance of each letter of `text[a..b]`, in px.
    fn char_advances(&self, text: &str, a: usize, b: usize, scale: f32) -> Vec<f32> {
        text[a..b]
            .char_indices()
            .map(|(i, c)| (self.prefix[a + i + c.len_utf8()] - self.prefix[a + i]) as f32 * scale)
            .collect()
    }
}

/// The direction and script the shaper picks for `text` on its own.
fn props(text: &str) -> Props {
    let mut buffer = harfrust::Buffer::new();
    buffer.push_str(text);
    buffer.guess_segment_properties();
    (buffer.direction(), buffer.script())
}

// ── Kashida (کشیدہ) justification ───────────────────────────────────────────
//
// Latin text justifies by stretching the SPACES between words. Arabic-script
// text justifies by elongating the connecting strokes WITHIN words — the
// kashida. Space-justification applied to Urdu produces the rivers of white
// space that make browser-rendered Urdu look visibly wrong to a typesetter,
// which is why this is the defining feature of real Nastaliq typesetting.
//
// We elongate by inserting U+0640 ARABIC TATWEEL at valid positions and letting
// the shaper do the rest: it joins the tatweel into the surrounding
// letters, so the stroke genuinely lengthens rather than a separate glyph being
// drawn. Not every gap is a legal kashida site, and not every legal site is
// equally good, so candidates are ranked by typographic priority.

/// A position where a tatweel may be inserted, with a priority (higher = better).
#[derive(Clone, Copy, Debug)]
struct KashidaSite {
    /// Byte index in the line string at which to insert the tatweel.
    byte_idx: usize,
    priority: u8,
}

/// Letters that never connect to the FOLLOWING letter (right-joining only).
/// A kashida cannot be placed after these — the stroke would not join.
fn is_non_connecting(c: char) -> bool {
    matches!(
        c,
        'ا' | 'آ' | 'أ' | 'إ' | 'ٱ' | 'د' | 'ذ' | 'ڈ' | 'ر' | 'ز' | 'ژ' | 'ڑ'
            | 'و' | 'ؤ' | 'ے' | 'ۓ' | 'ء'
    )
}

/// Whether `c` is an Arabic-script letter that can bear a connection at all.
fn is_arabic_letter(c: char) -> bool {
    matches!(c as u32, 0x0620..=0x064A | 0x066E..=0x06D3 | 0x06FA..=0x06FF | 0x0750..=0x077F)
}

/// Combining marks (harakat) — skipped when looking for the real letter.
fn is_mark(c: char) -> bool {
    matches!(c as u32, 0x064B..=0x065F | 0x0670 | 0x06D6..=0x06ED)
}

/// Priority of a kashida placed between `prev` and `next`.
///
/// Ordering follows classical Arabic/Urdu typesetting practice: elongate before
/// a final letter first, then after specific letters that carry a long stroke
/// well, and avoid stretching immediately after the first letter of a word.
fn site_priority(prev: char, next: char, is_word_final_next: bool) -> Option<u8> {
    if !is_arabic_letter(prev) || is_non_connecting(prev) {
        return None; // prev cannot connect forward — illegal site
    }
    if !is_arabic_letter(next) {
        return None;
    }
    // Before the final letter of a word is the classic, most natural stretch.
    if is_word_final_next {
        return Some(5);
    }
    // After these the kashida sits particularly well (long flat stroke).
    if matches!(prev, 'ک' | 'گ' | 'ل' | 'ط' | 'ظ' | 'ب' | 'ت' | 'ث' | 'ن' | 'ی' | 'س' | 'ش') {
        return Some(4);
    }
    // Generic legal connection.
    Some(2)
}

/// Find every legal kashida insertion point in `line`, best first.
fn kashida_sites(line: &str) -> Vec<KashidaSite> {
    let chars: Vec<(usize, char)> = line.char_indices().collect();
    let mut sites = Vec::new();

    for i in 0..chars.len() {
        let (_, prev) = chars[i];
        if is_mark(prev) {
            continue;
        }
        // Find the next non-mark character.
        let mut j = i + 1;
        while j < chars.len() && is_mark(chars[j].1) {
            j += 1;
        }
        if j >= chars.len() {
            break;
        }
        let (next_idx, next) = chars[j];

        // Is `next` the last letter of its word?
        let mut k = j + 1;
        while k < chars.len() && is_mark(chars[k].1) {
            k += 1;
        }
        let is_word_final = k >= chars.len() || !is_arabic_letter(chars[k].1);

        if let Some(priority) = site_priority(prev, next, is_word_final) {
            sites.push(KashidaSite { byte_idx: next_idx, priority });
        }
    }

    // Best sites first; ties broken by position so elongation spreads along the
    // line instead of clustering at one end.
    sites.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.byte_idx.cmp(&b.byte_idx)));
    sites
}

/// Insert `n` tatweels at each of the first `sites_used` sites of `line`.
fn apply_kashida(line: &str, sites: &[KashidaSite], per_site: &[usize]) -> String {
    let mut inserts: Vec<(usize, usize)> = sites
        .iter()
        .zip(per_site.iter())
        .filter(|(_, &n)| n > 0)
        .map(|(s, &n)| (s.byte_idx, n))
        .collect();
    // Descending byte order so earlier offsets stay valid as we splice.
    inserts.sort_by(|a, b| b.0.cmp(&a.0));

    let mut out = line.to_string();
    for (idx, n) in inserts {
        let tatweels: String = std::iter::repeat('ـ').take(n).collect();
        out.insert_str(idx, &tatweels);
    }
    out
}

/// Justify `line` to `target_width` by inserting kashidas, returning the new
/// string.
#[cfg(test)]
fn justify_with_kashida(line: &str, font: &Font, scale: f32, target_width: f32) -> String {
    justify_line(line, None, font, scale, target_width).map_or_else(|| line.to_string(), |(s, _)| s)
}

/// Justify `line` to `target_width` by inserting kashidas. Returns the
/// elongated line with its shaping, or None to leave the line as it is.
/// `natural` is the line's width when the caller already knows it.
///
/// ── Why this measures instead of calculating ────────────────────────────────
/// The obvious implementation — measure one tatweel, divide the deficit by it —
/// is wrong for this script. A tatweel is not a spacer glyph: it changes which
/// contextual form the neighbouring letters take, so its effect on width is a
/// property of the *font and the surrounding letters*, not a constant. Measured
/// on the bundled faces at 32px, inserting one tatweel into the same line gives:
///
///   Noto Naskh Arabic   +6.7px      Amiri   +5.9px
///   Gulzar (Nastaliq)  +22.3px      Noto Nastaliq Urdu   +0.0px
///
/// Noto Nastaliq Urdu — Harfsaz's DEFAULT font — ignores tatweel entirely: its
/// isolated tatweel has zero advance and the face substitutes the same
/// contextual forms regardless. So the first tatweel is measured, and the line
/// is left ragged when it gains nothing (rather than silently corrupting it
/// with invisible tatweels).
///
/// Tatweels go in round-robin across the sites, best first, at most
/// `MAX_PER_SITE` each, and the line takes the fewest that bring it within
/// 0.5px of the measure (one fewer if that many overshoots). Rather than
/// shaping the line once per tatweel, the count is guessed from the first
/// tatweel's gain and then pinned down by doubling steps and bisection, so a
/// line is shaped a handful of times (a slow font like Gulzar took seconds a
/// line otherwise).
fn justify_line(
    line: &str,
    natural: Option<f32>,
    font: &Font,
    scale: f32,
    target_width: f32,
) -> Option<(String, Run)> {
    let natural = natural.unwrap_or_else(|| measure(line, font, scale));
    if target_width - natural <= 0.5 {
        return None; // already at/over the measure
    }

    let sites = kashida_sites(line);
    if sites.is_empty() {
        return None;
    }

    // Cap per-site elongation so one joint never becomes a caricature.
    const MAX_PER_SITE: usize = 4;
    let total = sites.len() * MAX_PER_SITE;
    let mut trials = Trials { line, sites: &sites, font, scale, shaped: HashMap::new() };
    let short = |w: f32| target_width - w > 0.5;
    let overshoots = |w: f32| w > target_width + 0.5;

    let w1 = trials.width(1);
    if overshoots(w1) || w1 <= natural + 0.01 {
        // One tatweel is already too many, or this font ignores tatweel: further
        // insertions would add invisible characters without reaching the measure.
        return None;
    }
    if !short(w1) {
        return Some(trials.take(1));
    }

    // The fewest tatweels that are no longer short lie in (lo, hi].
    let guess = (((target_width - 0.5 - natural) / (w1 - natural)).ceil() as usize).clamp(2, total);
    let (mut lo, mut hi);
    if short(trials.width(guess)) {
        lo = guess;
        let mut step = 1;
        loop {
            if lo == total {
                return Some(trials.take(total)); // the most allowed still falls short
            }
            let k = (lo + step).min(total);
            if short(trials.width(k)) {
                lo = k;
                step *= 2;
            } else {
                hi = k;
                break;
            }
        }
    } else {
        hi = guess;
        lo = 1;
        let mut step = 1;
        while hi - lo > 1 {
            let k = hi.saturating_sub(step).max(lo + 1);
            if short(trials.width(k)) {
                lo = k;
                break;
            }
            hi = k;
            step *= 2;
        }
    }
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if short(trials.width(mid)) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let k = if overshoots(trials.width(hi)) { lo } else { hi };
    Some(trials.take(k))
}

/// The line with the first `k` tatweels of the round-robin order, shaped once each.
struct Trials<'a> {
    line: &'a str,
    sites: &'a [KashidaSite],
    font: &'a Font,
    scale: f32,
    shaped: HashMap<usize, (String, Run)>,
}

impl Trials<'_> {
    fn width(&mut self, k: usize) -> f32 {
        if !self.shaped.contains_key(&k) {
            let s = self.sites.len();
            let per_site: Vec<usize> = (0..s).map(|i| if k > i { (k - 1 - i) / s + 1 } else { 0 }).collect();
            let text = apply_kashida(self.line, self.sites, &per_site);
            let run = self.font.shape(&text);
            self.shaped.insert(k, (text, run));
        }
        self.shaped[&k].1.width(self.scale)
    }

    fn take(mut self, k: usize) -> (String, Run) {
        self.width(k);
        self.shaped.remove(&k).expect("just shaped")
    }
}

// ── Frame layout ─────────────────────────────────────────────────────────────

/// A glyph placed in a frame: its origin in frame px (y down), offsets applied.
#[derive(Clone, Copy, Debug)]
pub struct Placed {
    pub gid: u16,
    pub x: f32,
    pub y: f32,
}

/// One laid-out line.
#[derive(Clone, Debug)]
pub struct Line {
    pub glyphs: Vec<Placed>,
    /// Width of the glyphs (checked by the tests).
    #[allow(dead_code)]
    pub width: f32,
    pub baseline: f32,
    /// The source text of the line (without justification tatweels).
    pub text: String,
}

/// A text frame laid out into lines.
#[derive(Debug)]
pub struct FrameLayout {
    pub lines: Vec<Line>,
    /// Total height consumed (px) — lets the UI detect overflow.
    pub used_height: f32,
    pub font_size: f32,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct LayoutKey {
    text: String,
    size: u32,
    width: u32,
    align: String,
    line_height: Option<u32>,
}

/// Lay out `text` into a frame of `frame_width` px with greedy word wrapping.
///
/// RTL-aware: lines start at the right edge and advance leftward. Line height is
/// the frame's own (as the editor uses it), else generous Nastaliq leading.
pub fn layout_frame(
    font: &Font,
    text: &str,
    font_size: f32,
    frame_width: f32,
    align: &str,
    line_height_factor: Option<f32>,
) -> Arc<FrameLayout> {
    let key = LayoutKey {
        text: text.to_string(),
        size: font_size.to_bits(),
        width: frame_width.to_bits(),
        align: align.to_string(),
        line_height: line_height_factor.map(f32::to_bits),
    };
    if let Some(l) = lock(&font.layouts).get(&key) {
        return l.clone();
    }
    let layout = Arc::new(compute_layout(font, text, font_size, frame_width, align, line_height_factor));
    insert_bounded(&font.layouts, key, layout.clone(), MAX_LAYOUTS);
    layout
}

struct Ctx<'a> {
    font: &'a Font,
    scale: f32,
    font_size: f32,
    frame_width: f32,
    pad: f32,
    max_width: f32,
    align: &'a str,
}

/// The line being filled: a stretch of the paragraph, or (after a long word was
/// broken) a piece that is not in the source text.
enum Current {
    Range(usize, usize),
    Owned(String),
}

impl Current {
    fn is_empty(&self) -> bool {
        match self {
            Current::Range(a, b) => a == b,
            Current::Owned(s) => s.is_empty(),
        }
    }
}

fn compute_layout(
    font: &Font,
    text: &str,
    font_size: f32,
    frame_width: f32,
    align: &str,
    line_height_factor: Option<f32>,
) -> FrameLayout {
    let face = &font.face;
    let scale = font_size / face.units_per_em() as f32;
    let line_height = font_size * line_height_factor.filter(|f| *f > 0.0).unwrap_or(2.1);
    let pad = 10.0_f32; // inner padding matching the editor frame

    // Nastaliq glyphs ascend far above the baseline. Use the font's real ascender
    // so the first line isn't clipped at the top of the frame. Fall back to a
    // generous multiple of the font size if the metric is missing/zero.
    let ascender_px = {
        let a = face.ascender() as f32 * scale;
        if a > 0.0 { a } else { font_size * 1.2 }
    };
    let ctx = Ctx {
        font,
        scale,
        font_size,
        frame_width,
        pad,
        max_width: frame_width - pad * 2.0,
        align,
    };

    // Greedy word-wrap on each source line (respect explicit newlines). Each
    // paragraph starts on a fresh line, so they are laid out in parallel and
    // stacked afterwards.
    let paragraphs: Vec<&str> = text.split('\n').collect();
    let laid: Vec<Option<Vec<Line>>> = paragraphs
        .par_iter()
        .map(|p| (!p.is_empty()).then(|| layout_paragraph(p, &font.paragraph(p), &ctx)))
        .collect();

    let mut lines = Vec::new();
    let mut baseline = pad + ascender_px; // first baseline sits below the ascent
    for paragraph in laid {
        let Some(paragraph) = paragraph else {
            baseline += line_height; // blank line
            continue;
        };
        for mut line in paragraph {
            line.baseline = baseline;
            for g in &mut line.glyphs {
                g.y += baseline;
            }
            lines.push(line);
            baseline += line_height;
        }
    }

    FrameLayout {
        lines,
        used_height: baseline - font_size + pad,
        font_size,
    }
}

/// Lay out one paragraph. Lines come back with their baseline at 0.
fn layout_paragraph(src: &str, para: &Paragraph, ctx: &Ctx) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut emit = |line: Option<Line>| lines.extend(line);
    let mut current = Current::Range(0, 0);
    // The current line shaped on its own, when it had to be measured that way.
    let mut current_run: Option<Run> = None;
    let mut offset = 0;
    for word in src.split(' ') {
        let (ws, we) = (offset, offset + word.len());
        offset = we + 1;

        // A word wider than the line (e.g. a long run with no spaces) is
        // broken between letters, as the editor does, instead of running off
        // the page on one line.
        // Only words that could be that wide are checked (a letter is
        // rarely wider than 1em).
        if word.chars().count() as f32 * ctx.font_size > ctx.max_width {
            let advances = para.char_advances(src, ws, we, ctx.scale);
            let mut pieces = split_long_word(word, &advances, ctx.font, ctx.scale, ctx.max_width);
            if pieces.len() > 1 {
                if !current.is_empty() {
                    emit(flush(src, para, &current, current_run.take(), true, ctx));
                }
                let last = pieces.pop();
                for (piece, shaped) in pieces {
                    let text = piece.trim_matches(ZWJ).to_string();
                    emit(Some(place_shaped(&shaped, ctx, text)));
                }
                let (text, run) = last.map_or((String::new(), None), |(t, r)| (t, Some(r)));
                current = Current::Owned(text);
                current_run = run;
                continue;
            }
        }

        let (candidate, fits, run) = match &current {
            Current::Owned(s) if !s.is_empty() => {
                let c = format!("{s} {word}");
                let run = ctx.font.shape(&c);
                let fits = run.width(ctx.scale) <= ctx.max_width;
                (Current::Owned(c), fits, Some(run))
            }
            Current::Range(a, b) if a != b => {
                let (fits, run) = fits_range(src, para, *a, we, ctx);
                (Current::Range(*a, we), fits, run)
            }
            _ => {
                let (fits, run) = fits_range(src, para, ws, we, ctx);
                (Current::Range(ws, we), fits, run)
            }
        };
        if !fits && !current.is_empty() {
            // A line that wrapped is a full measure line — justify it.
            emit(flush(src, para, &current, current_run.take(), true, ctx));
            current = Current::Range(ws, we);
        } else {
            current = candidate;
            current_run = run;
        }
    }
    // Last line of the paragraph: never justified.
    emit(flush(src, para, &current, current_run, false, ctx));
    lines
}

/// Whether `src[a..b]` fits on a line, with its own shaping if it had to be
/// shaped to tell.
///
/// Where the paragraph's shaping can be cut at both ends, its width is exact.
/// Otherwise (Gulzar adjusts the space between words, so almost none of its
/// word breaks can be cut) the range shaped alone differs from the paragraph
/// only near its two ends: by up to a third of an em on the bundled fonts. So
/// the paragraph's width decides when it is more than an em from the line
/// width, and only candidates closer than that are shaped to measure.
fn fits_range(src: &str, para: &Paragraph, a: usize, b: usize, ctx: &Ctx) -> (bool, Option<Run>) {
    let text = &src[a..b];
    let estimate = para.width(a, b) as f32 * ctx.scale;
    let same_props = props(text) == para.props;
    if same_props && para.safe[a] && para.safe[b] {
        return (estimate <= ctx.max_width, None);
    }
    if same_props && (estimate - ctx.max_width).abs() > ctx.font_size {
        return (estimate <= ctx.max_width, None);
    }
    let run = ctx.font.shape(text);
    (run.width(ctx.scale) <= ctx.max_width, Some(run))
}

/// Lay out the current line. `justify_this` is false for the final line of a
/// paragraph: stretching it to the full measure is the classic justification
/// bug (a two-word last line spread across the whole column). `run` is the
/// line already shaped on its own, if it was.
fn flush(
    src: &str,
    para: &Paragraph,
    current: &Current,
    run: Option<Run>,
    justify_this: bool,
    ctx: &Ctx,
) -> Option<Line> {
    let text = match current {
        Current::Range(a, b) => &src[*a..*b],
        Current::Owned(s) => s.as_str(),
    };
    if text.trim().is_empty() {
        return None;
    }
    let source = text.trim_matches(ZWJ).to_string();
    let slice = match current {
        Current::Range(a, b) if para.can_slice(src, *a, *b) => Some((*a, *b)),
        _ => None,
    };
    if justify_this && ctx.align == "justify" {
        let natural = match (slice, &run) {
            (Some((a, b)), _) => Some(para.width(a, b) as f32 * ctx.scale),
            (None, Some(run)) => Some(run.width(ctx.scale)),
            (None, None) => None,
        };
        if let Some((_, justified)) = justify_line(text, natural, ctx.font, ctx.scale, ctx.max_width) {
            return Some(place_shaped(&justified, ctx, source));
        }
    }
    if let Some((a, b)) = slice {
        let range = a as u32..b as u32;
        let glyphs = para.glyphs.iter().filter(|g| range.contains(&g.cluster)).copied();
        let rtl = para.props.0 == harfrust::Direction::RightToLeft;
        return Some(place(glyphs, rtl, ctx, source));
    }
    let run = run.unwrap_or_else(|| ctx.font.shape(text));
    Some(place_shaped(&run, ctx, source))
}

/// Text shaped on its own: glyphs in visual order, in font units.
struct Run {
    glyphs: Vec<PGlyph>,
    rtl: bool,
}

impl Run {
    fn width(&self, scale: f32) -> f32 {
        self.glyphs.iter().map(|g| g.adv as f32 * scale).sum()
    }
}

fn place_shaped(run: &Run, ctx: &Ctx, text: String) -> Line {
    place(run.glyphs.iter().copied(), run.rtl, ctx, text)
}

/// Position one line's glyphs (in visual order), on a baseline at 0. RTL lines
/// are pinned to the right edge of the frame.
///
/// The shaper returns glyphs in VISUAL order (already reordered for RTL), so we
/// use the canonical pen model: a cursor that starts at the line's left edge and
/// INCREASES by each glyph's advance. Each glyph (including zero-advance
/// marks/dots) is drawn at cursor + x_offset, which positions marks correctly
/// relative to their base.
fn place(glyphs: impl Iterator<Item = PGlyph> + Clone, rtl: bool, ctx: &Ctx, text: String) -> Line {
    let scale = ctx.scale;
    let width: f32 = glyphs.clone().map(|g| g.adv as f32 * scale).sum();
    let (pad, frame_width) = (ctx.pad, ctx.frame_width);
    let content_width = frame_width - pad * 2.0;
    let start_x = match ctx.align {
        "center" => pad + (content_width - width) / 2.0,
        // A justified line has already been stretched to the measure by the
        // kashida pass, so it starts at the same edge as its natural direction.
        "left" => pad,
        "right" => (frame_width - pad - width).max(pad),
        _ => {
            if rtl {
                (frame_width - pad - width).max(pad)
            } else {
                pad
            }
        }
    }
    .max(pad);

    let mut cursor = start_x;
    let placed = glyphs
        .map(|g| {
            let p = Placed {
                gid: g.gid,
                x: cursor + g.xo as f32 * scale,
                y: -g.yo as f32 * scale,
            };
            cursor += g.adv as f32 * scale;
            p
        })
        .collect();
    Line { glyphs: placed, width, baseline: 0.0, text }
}

/// Zero-width joiner: keeps a letter in its joined form where a word is broken.
const ZWJ: char = '\u{200D}';

/// True for combining marks (harakat, Quranic marks, Latin diacritics) and
/// joiners, which must stay with the letter before them.
fn is_break_mark(c: char) -> bool {
    matches!(c as u32,
        0x0300..=0x036F | 0x0610..=0x061A | 0x064B..=0x065F | 0x0670 |
        0x06D6..=0x06DC | 0x06DF..=0x06E4 | 0x06E7..=0x06E8 | 0x06EA..=0x06ED |
        0x200C | 0x200D)
}

/// Break a word wider than `max_width` into pieces that each fit, splitting
/// between letters (never before a combining mark). Pieces are joined with ZWJ
/// at the break so Nastaliq letters keep their connected shapes. Returns each
/// piece with its shaping, or nothing when the word fits.
///
/// `advance` is each letter's advance in the paragraph's shaping: breaks are
/// found from these sums, and each piece is shaped once to check it.
fn split_long_word(
    word: &str,
    advance: &[f32],
    font: &Font,
    scale: f32,
    max_width: f32,
) -> Vec<(String, Run)> {
    let chars: Vec<char> = word.chars().collect();
    let n = chars.len();
    if advance.iter().sum::<f32>() <= max_width {
        return Vec::new(); // fits as it is
    }

    // Move an index forward past combining marks so a break never lands before one.
    let snap = |mut i: usize| { while i < n && is_break_mark(chars[i]) { i += 1; } i };
    let piece = |start: usize, end: usize| {
        let mut s = String::new();
        if start > 0 { s.push(ZWJ); }
        s.extend(&chars[start..end]);
        if end < n { s.push(ZWJ); }
        s
    };
    let mut pieces = Vec::new();
    let mut start = 0;
    while start < n {
        // Always take at least one letter (with its marks).
        let first = snap(start + 1);
        let mut end = first;
        let mut w: f32 = advance[start..end].iter().sum();
        while end < n {
            let next = snap(end + 1);
            let more: f32 = advance[end..next].iter().sum();
            if w + more > max_width { break; }
            w += more;
            end = next;
        }
        // Letters change shape at a break, so check the real piece once and
        // give back a letter at a time if it came out too wide.
        let mut text = piece(start, end);
        let mut shaped = font.shape(&text);
        while end > first && shaped.width(scale) > max_width {
            end -= 1;
            while end > first && is_break_mark(chars[end]) { end -= 1; }
            text = piece(start, end);
            shaped = font.shape(&text);
        }
        pieces.push((text, shaped));
        start = end;
    }
    pieces
}

/// Measure the shaped width of a string in px.
fn measure(text: &str, font: &Font, scale: f32) -> f32 {
    font.shape(text).width(scale)
}

// ── Print preview paths ──────────────────────────────────────────────────────

/// What print preview needs for one frame: an SVG path per line.
#[derive(Serialize, Debug)]
pub struct PreviewLayout {
    pub lines: Vec<String>,
    pub used_height: f32,
}

/// A glyph outline at one size, as SVG path data relative to its first point
/// (in hundredths of a px), so one string serves every place the glyph is drawn.
struct GlyphTail {
    /// The first point relative to the glyph origin.
    first: (i64, i64),
    /// Everything after the first move, in relative commands.
    path: String,
    empty: bool,
}

/// Collects ttf-parser outline callbacks as relative SVG commands, scaled to
/// hundredths of a px with Y flipped (font space is y-up; screen is y-down).
/// Points are rounded before taking differences, so the relative steps add up
/// exactly and long contours don't drift.
struct TailBuilder {
    scale: f32,
    path: String,
    first: Option<(i64, i64)>,
    current: (i64, i64),
    start: (i64, i64),
}

impl TailBuilder {
    fn point(&self, x: f32, y: f32) -> (i64, i64) {
        ((x * self.scale).round() as i64, (-y * self.scale).round() as i64)
    }
    fn rel(&mut self, p: (i64, i64)) {
        push_num(&mut self.path, p.0 - self.current.0);
        push_num(&mut self.path, p.1 - self.current.1);
    }
}

impl ttf_parser::OutlineBuilder for TailBuilder {
    fn move_to(&mut self, x: f32, y: f32) {
        let p = self.point(x, y);
        if self.first.is_none() {
            self.first = Some(p);
        } else {
            self.path.push('m');
            self.rel(p);
        }
        self.current = p;
        self.start = p;
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let p = self.point(x, y);
        self.path.push('l');
        self.rel(p);
        self.current = p;
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (c, p) = (self.point(x1, y1), self.point(x, y));
        self.path.push('q');
        self.rel(c);
        self.rel(p);
        self.current = p;
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (c1, c2, p) = (self.point(x1, y1), self.point(x2, y2), self.point(x, y));
        self.path.push('c');
        self.rel(c1);
        self.rel(c2);
        self.rel(p);
        self.current = p;
    }
    fn close(&mut self) {
        self.path.push('z');
        self.current = self.start;
    }
}

/// Append a number given in hundredths, separated from the previous one.
fn push_num(s: &mut String, v: i64) {
    let after_command = s.as_bytes().last().map_or(true, |b| b.is_ascii_alphabetic());
    if v < 0 {
        s.push('-');
    } else if !after_command {
        s.push(' ');
    }
    let a = v.unsigned_abs();
    let mut digits = [0u8; 20];
    let mut i = digits.len();
    let mut int = a / 100;
    loop {
        i -= 1;
        digits[i] = b'0' + (int % 10) as u8;
        int /= 10;
        if int == 0 { break; }
    }
    s.push_str(std::str::from_utf8(&digits[i..]).unwrap_or("0"));
    let frac = a % 100;
    if frac != 0 {
        s.push('.');
        s.push((b'0' + (frac / 10) as u8) as char);
        if frac % 10 != 0 {
            s.push((b'0' + (frac % 10) as u8) as char);
        }
    }
}

impl Font {
    fn tail(&self, gid: u16, font_size: f32) -> Arc<GlyphTail> {
        let key = (gid, (font_size * 100.0).round() as u32);
        if let Some(t) = lock(&self.tails).get(&key) {
            return t.clone();
        }
        let mut b = TailBuilder {
            scale: font_size / self.face.units_per_em() as f32 * 100.0,
            path: String::new(),
            first: None,
            current: (0, 0),
            start: (0, 0),
        };
        let _ = self.face.outline_glyph(ttf_parser::GlyphId(gid), &mut b);
        let tail = Arc::new(GlyphTail { first: b.first.unwrap_or((0, 0)), empty: b.first.is_none(), path: b.path });
        insert_bounded(&self.tails, key, tail.clone(), MAX_TAILS);
        tail
    }
}

/// SVG path data for each line of a laid-out frame, in frame px.
pub fn preview_paths(font: &Font, layout: &FrameLayout) -> PreviewLayout {
    let lines = layout
        .lines
        .iter()
        .map(|line| {
            let mut d = String::new();
            for g in &line.glyphs {
                let tail = font.tail(g.gid, layout.font_size);
                if tail.empty {
                    continue;
                }
                d.push('M');
                push_num(&mut d, (g.x * 100.0).round() as i64 + tail.first.0);
                push_num(&mut d, (g.y * 100.0).round() as i64 + tail.first.1);
                d.push_str(&tail.path);
            }
            d
        })
        .collect();
    PreviewLayout { lines, used_height: layout.used_height }
}

/// Shape `text` using the given font bytes at `font_size` px.
///
/// `font_bytes` is the raw .ttf/.otf (e.g. Noto Nastaliq Urdu) passed from the
/// frontend. We resolve the units-per-em from the font and scale advances to px.
pub fn shape_text(
    text: &str,
    font_bytes: &[u8],
    font_size: f32,
) -> Result<ShapedRun, String> {
    let not_a_font = || "Failed to parse font (not a valid ttf/otf)".to_string();
    let units_per_em = ttf_parser::Face::parse(font_bytes, 0).map_err(|_| not_a_font())?.units_per_em() as f32;
    if units_per_em <= 0.0 {
        return Err("Font reported invalid units-per-em".into());
    }
    let scale = font_size / units_per_em;
    let font = harfrust::Font::new(font_bytes.to_vec(), 0).ok_or_else(not_a_font)?;

    let mut buffer = harfrust::Buffer::new();
    buffer.push_str(text);
    // Let the shaper detect script/direction from the content; Urdu resolves
    // to Arabic script + RTL automatically.
    buffer.guess_segment_properties();
    let rtl = buffer.direction() == harfrust::Direction::RightToLeft;

    harfrust::shape(&harfrust::ShaperFont::new(&font), &mut buffer, harfrust::ShapeOptions::new())
        .map_err(|e| format!("Shaping failed: {e}"))?;

    let infos = buffer.glyph_infos();
    let positions = buffer.glyph_positions();

    let mut glyphs = Vec::with_capacity(infos.len());
    let mut total_advance = 0.0_f32;

    for (info, pos) in infos.iter().zip(positions.iter()) {
        let x_advance = pos.x_advance as f32 * scale;
        let y_advance = pos.y_advance as f32 * scale;
        total_advance += x_advance;

        glyphs.push(ShapedGlyph {
            glyph_id: info.glyph_id,
            cluster: info.cluster,
            x_advance,
            y_advance,
            x_offset: pos.x_offset as f32 * scale,
            y_offset: pos.y_offset as f32 * scale,
        });
    }

    Ok(ShapedRun {
        glyphs,
        total_advance,
        rtl,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // "یہ ایک اردو جملہ ہے جو انصاف کے ساتھ لکھا گیا"
    const URDU: &str = "یہ ایک اردو جملہ ہے جو انصاف کے ساتھ لکھا گیا";

    #[test]
    fn kashida_never_follows_a_non_connecting_letter() {
        // ا د ذ ر ز و ے never join to the LEFT, so a tatweel after one would
        // render as a detached floating stroke — the classic bug.
        for site in kashida_sites(URDU) {
            let before: char = URDU[..site.byte_idx].chars().next_back().unwrap();
            assert!(
                !is_non_connecting(before),
                "illegal kashida after non-connecting {:?} at byte {}",
                before, site.byte_idx
            );
        }
    }

    #[test]
    fn kashida_sites_are_valid_char_boundaries() {
        // Inserting at a non-boundary would panic on insert_str.
        for site in kashida_sites(URDU) {
            assert!(URDU.is_char_boundary(site.byte_idx));
        }
    }

    #[test]
    fn kashida_never_splits_across_a_space() {
        // A tatweel must stay inside a word; between words it is meaningless.
        for site in kashida_sites(URDU) {
            let before: char = URDU[..site.byte_idx].chars().next_back().unwrap();
            let after: char = URDU[site.byte_idx..].chars().next().unwrap();
            assert!(before != ' ' && after != ' ', "kashida adjacent to a space");
        }
    }

    #[test]
    fn latin_text_has_no_kashida_sites() {
        assert!(kashida_sites("hello world this is latin").is_empty());
    }

    #[test]
    fn sites_are_ordered_best_first() {
        let sites = kashida_sites(URDU);
        assert!(!sites.is_empty(), "expected kashida opportunities in Urdu text");
        for w in sites.windows(2) {
            assert!(w[0].priority >= w[1].priority, "sites not sorted by priority");
        }
    }

    #[test]
    fn justification_is_a_noop_when_line_already_fits() {
        let bytes = match std::fs::read("../public/fonts/NotoNastaliqUrdu-Regular.ttf") {
            Ok(b) => b,
            Err(_) => return,
        };
        let face = Font::from_bytes(bytes).expect("font parses");
        let scale = 32.0 / face.face.units_per_em() as f32;
        let line = "یہ ایک اردو جملہ";
        let natural = measure(line, &face, scale);
        // Target smaller than natural: must not shrink or corrupt the text.
        let out = justify_with_kashida(line, &face, scale, natural - 20.0);
        assert_eq!(out, line, "must not modify a line that already overflows");
    }



    /// Load a bundled font for tests, or None when the checkout lacks it.
    fn test_face(file: &str) -> Option<Vec<u8>> {
        std::fs::read(format!("../public/fonts/{file}")).ok()
    }

    #[test]
    fn justification_reaches_the_measure_when_the_font_supports_tatweel() {
        // Noto Naskh elongates properly (+~6.7px per tatweel at 32px).
        let Some(bytes) = test_face("NotoNaskhArabic-Regular.ttf") else { return };
        let face = Font::from_bytes(bytes).expect("font parses");
        let scale = 32.0 / face.face.units_per_em() as f32;

        let line = "یہ ایک اردو جملہ ہے جو انصاف";
        let natural = measure(line, &face, scale);
        let target = natural + 30.0;

        let out = justify_with_kashida(line, &face, scale, target);
        let got = measure(&out, &face, scale);

        assert!(out.contains('ـ'), "expected tatweels for a tatweel-capable font");
        assert!(got > natural, "justified line must grow: {natural} -> {got}");
        assert!(got <= target + 0.5, "must never overshoot the measure: {got} > {target}");
    }

    #[test]
    fn justification_degrades_gracefully_when_the_font_ignores_tatweel() {
        // Noto Nastaliq Urdu — Harfsaz's DEFAULT — gives tatweel zero advance.
        // The correct behaviour is to leave the line ALONE rather than stuff it
        // with invisible characters that never reach the measure.
        let Some(bytes) = test_face("NotoNastaliqUrdu-Regular.ttf") else { return };
        let face = Font::from_bytes(bytes).expect("font parses");
        let scale = 32.0 / face.face.units_per_em() as f32;

        let line = "یہ ایک اردو جملہ ہے جو انصاف";
        let out = justify_with_kashida(line, &face, scale, measure(line, &face, scale) + 40.0);

        assert_eq!(out, line, "must not insert tatweels that have no visual effect");
    }

    #[test]
    fn justification_never_overshoots() {
        for file in ["NotoNaskhArabic-Regular.ttf", "Amiri-Regular.ttf", "Gulzar-Regular.ttf"] {
            let Some(bytes) = test_face(file) else { continue };
            let face = Font::from_bytes(bytes).expect("font parses");
            let scale = 32.0 / face.face.units_per_em() as f32;
            let line = "یہ ایک اردو جملہ ہے جو انصاف";
            let natural = measure(line, &face, scale);

            // Sweep a range of targets; none may exceed the requested measure.
            for extra in [5.0_f32, 15.0, 40.0, 120.0] {
                let target = natural + extra;
                let out = justify_with_kashida(line, &face, scale, target);
                let got = measure(&out, &face, scale);
                assert!(
                    got <= target + 0.5,
                    "{file}: overshoot at +{extra}: {got} > {target}"
                );
            }
        }
    }

    #[test]
    fn justification_preserves_the_original_letters() {
        // Elongation must only ADD tatweels — never drop or reorder text.
        let Some(bytes) = test_face("NotoNaskhArabic-Regular.ttf") else { return };
        let face = Font::from_bytes(bytes).expect("font parses");
        let scale = 32.0 / face.face.units_per_em() as f32;
        let line = "یہ ایک اردو جملہ ہے جو انصاف";
        let out = justify_with_kashida(line, &face, scale, measure(line, &face, scale) + 30.0);

        let stripped: String = out.chars().filter(|&c| c != 'ـ').collect();
        assert_eq!(stripped, line, "justification altered the underlying text");
    }

    #[test]
    fn justification_stops_where_adding_tatweels_one_at_a_time_would() {
        // The binary search must land on the same count as trying each count in
        // turn (for fonts whose width grows with every tatweel).
        let Some(bytes) = test_face("NotoNaskhArabic-Regular.ttf") else { return };
        let face = Font::from_bytes(bytes).expect("font parses");
        let scale = 32.0 / face.face.units_per_em() as f32;
        let line = "یہ ایک اردو جملہ ہے جو انصاف";
        let natural = measure(line, &face, scale);
        for extra in [3.0_f32, 12.0, 30.0, 70.0] {
            let target = natural + extra;
            let got = justify_with_kashida(line, &face, scale, target);
            // One at a time, stopping within 0.5px of the target or before overshooting.
            let sites = kashida_sites(line);
            let mut per_site = vec![0usize; sites.len()];
            let mut best = line.to_string();
            'outer: for _ in 0..4 {
                for i in 0..sites.len() {
                    per_site[i] += 1;
                    let c = apply_kashida(line, &sites, &per_site);
                    let w = measure(&c, &face, scale);
                    if w > target + 0.5 { break 'outer; }
                    best = c;
                    if target - w <= 0.5 { break 'outer; }
                }
            }
            assert_eq!(got, best, "+{extra}px");
        }
    }

    fn test_font(file: &str) -> Option<Font> {
        Some(Font::from_bytes(test_face(file)?).expect("font parses"))
    }

    const PROSE: &str = "اردو ایک خوبصورت زبان ہے جو برصغیر میں صدیوں سے بولی اور لکھی جا رہی ہے۔ اس کا رسم الخط نستعلیق ہے جس میں حروف ایک دوسرے سے جڑ کر خوبصورت شکلیں بناتے ہیں۔ کتابیں، اخبارات اور رسائل اسی انداز میں چھاپے جاتے ہیں تاکہ پڑھنے والے کو آسانی ہو۔";

    #[test]
    fn lines_cut_from_the_paragraph_match_lines_shaped_alone() {
        // Each line is cut out of one shaping of the whole paragraph; it must
        // come out glyph for glyph as if the line had been shaped by itself.
        for file in ["NotoNastaliqUrdu-Regular.ttf", "Gulzar-Regular.ttf", "NotoNaskhArabic-Regular.ttf"] {
            let Some(font) = test_font(file) else { continue };
            let text = format!("{PROSE} Harfsaz 2026 {PROSE}");
            let layout = compute_layout(&font, &text, 28.0, 500.0, "right", Some(1.7));
            assert!(layout.lines.len() > 3, "{file}: expected several lines");
            let scale = 28.0 / font.face.units_per_em() as f32;
            for line in &layout.lines {
                let alone = font.shape(&line.text);
                let gids: Vec<u16> = alone.glyphs.iter().map(|g| g.gid).collect();
                let got: Vec<u16> = line.glyphs.iter().map(|g| g.gid).collect();
                assert_eq!(got, gids, "{file}: glyphs differ for line {:?}", line.text);
                let width = alone.width(scale);
                assert!((width - line.width).abs() < 0.01, "{file}: width {} vs {width}", line.width);
            }
        }
    }

    #[test]
    fn every_line_is_as_full_as_the_greedy_wrap_allows() {
        // Lines fit the frame, and the next line's first word would not have fit.
        let Some(font) = test_font("NotoNastaliqUrdu-Regular.ttf") else { return };
        let max = 500.0 - 20.0;
        let layout = compute_layout(&font, PROSE, 28.0, 500.0, "right", Some(1.7));
        let scale = 28.0 / font.face.units_per_em() as f32;
        for pair in layout.lines.windows(2) {
            assert!(pair[0].width <= max + 0.01, "line wider than the frame");
            let next_word = pair[1].text.split(' ').next().unwrap();
            let longer = format!("{} {next_word}", pair[0].text);
            assert!(measure(&longer, &font, scale) > max, "{next_word:?} would have fit on the line before");
        }
        let words: Vec<&str> = layout.lines.iter().flat_map(|l| l.text.split(' ')).collect();
        assert_eq!(words.join(" "), PROSE, "words lost or reordered");
    }

    #[test]
    fn justified_lines_reach_the_measure_and_the_last_line_does_not() {
        let Some(font) = test_font("NotoNaskhArabic-Regular.ttf") else { return };
        let layout = compute_layout(&font, PROSE, 28.0, 500.0, "justify", Some(1.7));
        let (last, full) = layout.lines.split_last().unwrap();
        for line in full {
            assert!(line.width <= 480.5 && line.width > 470.0, "justified width {}", line.width);
            assert!(!line.text.contains('ـ'), "line text keeps the source letters");
        }
        assert!(last.width < 470.0, "last line was stretched");
    }

    #[test]
    fn long_word_without_spaces_wraps_inside_the_frame() {
        let font = Font::from_bytes(std::fs::read("../public/fonts/Gulzar-Regular.ttf").expect("font")).unwrap();
        let word = "داسد".repeat(300); // no spaces, many lines wide
        let layout = compute_layout(&font, &word, 28.0, 714.0, "right", Some(1.7));
        assert!(layout.lines.len() > 5, "expected many lines, got {}", layout.lines.len());
        for line in &layout.lines {
            assert!(line.width <= 714.0 - 20.0 + 0.5, "line {} wider than the frame", line.width);
        }
        // Every letter is kept (pieces only add joiners).
        let letters: usize = layout
            .lines
            .iter()
            .map(|l| l.glyphs.iter().filter(|g| font.face.glyph_bounding_box(ttf_parser::GlyphId(g.gid)).is_some()).count())
            .sum();
        assert!(letters >= word.chars().count() - 1, "lost letters: {letters}");
        let text: String = layout.lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(text, word, "line texts must add up to the word");
        // Lines are spaced by the frame's line height.
        let step = layout.lines[1].baseline - layout.lines[0].baseline;
        assert!((step - 28.0 * 1.7).abs() < 0.01, "line step {step}");
    }

    #[test]
    fn blank_lines_take_up_a_line() {
        let Some(font) = test_font("NotoNastaliqUrdu-Regular.ttf") else { return };
        let one = compute_layout(&font, "اردو\nزبان", 28.0, 500.0, "right", Some(1.7));
        let gap = compute_layout(&font, "اردو\n\nزبان", 28.0, 500.0, "right", Some(1.7));
        let step = 28.0 * 1.7;
        assert!((one.lines[1].baseline - one.lines[0].baseline - step).abs() < 0.01);
        assert!((gap.lines[1].baseline - gap.lines[0].baseline - 2.0 * step).abs() < 0.01);
    }

    #[test]
    fn layouts_are_cached_per_frame() {
        let Some(font) = test_font("NotoNastaliqUrdu-Regular.ttf") else { return };
        let a = layout_frame(&font, PROSE, 28.0, 500.0, "right", Some(1.7));
        let b = layout_frame(&font, PROSE, 28.0, 500.0, "right", Some(1.7));
        let c = layout_frame(&font, PROSE, 30.0, 500.0, "right", Some(1.7));
        assert!(Arc::ptr_eq(&a, &b));
        assert!(!Arc::ptr_eq(&a, &c));
    }

    #[test]
    fn preview_path_retraces_the_glyph_outline() {
        // The relative path, started at the glyph's origin, must land on the
        // outline's own points (to the hundredth of a px).
        struct Abs(Vec<(f32, f32)>);
        impl ttf_parser::OutlineBuilder for Abs {
            fn move_to(&mut self, x: f32, y: f32) { self.0.push((x, y)); }
            fn line_to(&mut self, x: f32, y: f32) { self.0.push((x, y)); }
            fn quad_to(&mut self, _: f32, _: f32, x: f32, y: f32) { self.0.push((x, y)); }
            fn curve_to(&mut self, _: f32, _: f32, _: f32, _: f32, x: f32, y: f32) { self.0.push((x, y)); }
            fn close(&mut self) {}
        }
        let Some(font) = test_font("NotoNastaliqUrdu-Regular.ttf") else { return };
        let layout = compute_layout(&font, "ہے", 28.0, 300.0, "right", None);
        let g = layout.lines[0].glyphs.iter().find(|g| font.face.glyph_bounding_box(ttf_parser::GlyphId(g.gid)).is_some()).unwrap();
        let d = &preview_paths(&font, &FrameLayout { lines: vec![Line { glyphs: vec![*g], width: 0.0, baseline: 0.0, text: String::new() }], used_height: 0.0, font_size: 28.0 }).lines[0];

        // Walk the path: absolute M, then relative commands; collect end points.
        let mut ends = Vec::new();
        let (mut x, mut y, mut sx, mut sy) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
        let mut tokens = Vec::new();
        let mut num = String::new();
        for ch in d.chars() {
            if ch.is_ascii_alphabetic() || ch == ' ' || (ch == '-' && !num.is_empty()) {
                if !num.is_empty() { tokens.push(num.clone()); num.clear(); }
                if ch.is_ascii_alphabetic() { tokens.push(ch.to_string()); }
                if ch == '-' { num.push(ch); }
            } else {
                num.push(ch);
            }
        }
        if !num.is_empty() { tokens.push(num); }
        let mut i = 0;
        let take = |i: &mut usize| { *i += 1; tokens[*i].parse::<f64>().unwrap() };
        while i < tokens.len() {
            let cmd = tokens[i].clone();
            match cmd.as_str() {
                "M" => { x = take(&mut i); y = take(&mut i); sx = x; sy = y; ends.push((x, y)); }
                "m" => { x += take(&mut i); y += take(&mut i); sx = x; sy = y; ends.push((x, y)); }
                "l" => { x += take(&mut i); y += take(&mut i); ends.push((x, y)); }
                "q" => { take(&mut i); take(&mut i); x += take(&mut i); y += take(&mut i); ends.push((x, y)); }
                "c" => { for _ in 0..4 { take(&mut i); } x += take(&mut i); y += take(&mut i); ends.push((x, y)); }
                "z" => { x = sx; y = sy; }
                other => panic!("unexpected {other}"),
            }
            i += 1;
        }
        let mut abs = Abs(Vec::new());
        font.face.outline_glyph(ttf_parser::GlyphId(g.gid), &mut abs);
        let s = 28.0 / font.face.units_per_em() as f32;
        assert_eq!(ends.len(), abs.0.len());
        for ((px, py), (fx, fy)) in ends.iter().zip(&abs.0) {
            let ex = g.x + fx * s;
            let ey = g.y - fy * s;
            assert!((*px as f32 - ex).abs() < 0.011 && (*py as f32 - ey).abs() < 0.011, "({px},{py}) vs ({ex},{ey})");
        }
    }

    #[test]
    fn a_refused_font_is_not_parsed_again() {
        let bad = b"not a font".to_vec();
        let first = register_font("refused-test", bad.clone()).unwrap_err();
        assert!(lock(refused()).contains_key("refused-test"));
        assert_eq!(register_font("refused-test", bad).unwrap_err(), first);
    }

    #[test]
    fn numbers_are_written_compactly() {
        let mut s = String::from("M");
        for v in [0, 5, -5, 150, -1234, 100000] { push_num(&mut s, v); }
        assert_eq!(s, "M0 0.05-0.05 1.5-12.34 1000");
    }
}
