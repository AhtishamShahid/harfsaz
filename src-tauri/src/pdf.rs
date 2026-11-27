//! Vector PDF output.
//!
//! Text frames are laid out by the shaper (see shaping.rs) and written as
//! glyphs of the embedded font (Type0 font, Identity-H, CID = glyph id), so the
//! file stays small and prints sharp. Each line also carries its source text as
//! ActualText, for PDF readers that use it (Apple's PDFKit does not). Frame
//! backgrounds, shapes and images use the editor's own geometry, sent from the
//! frontend.
//!
//! This replaced drawing every glyph outline through jsPDF in the webview,
//! which took several seconds and wrote 60–90 MB for an 18-page document.

use crate::shaping::{self, Font, FrameLayout};
use base64::Engine as _;
use pdf_writer::types::{CidFontType, FontFlags, LineCapStyle, LineJoinStyle, SystemInfo};
use pdf_writer::{Content, Filter, Finish, Name, Pdf, Rect, Ref, Str, TextStr};
use serde::Deserialize;
use std::collections::{BTreeSet, HashMap};
use rayon::prelude::*;
use std::sync::Arc;

/// 1px @96dpi = 0.75pt.
const PX_TO_PT: f32 = 0.75;
/// Largest PNG decoded for embedding: an A4 page at 600 dpi is about 35 million.
const MAX_IMAGE_PIXELS: u64 = 40_000_000;

type Rgb = [u8; 3];

#[derive(Deserialize)]
pub struct PrintDoc {
    pub pages: Vec<PrintPage>,
}

/// A page in px, with what is drawn on it in order (back to front).
#[derive(Deserialize)]
pub struct PrintPage {
    pub width: f32,
    pub height: f32,
    pub items: Vec<PrintItem>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PrintItem {
    /// A frame's background and border.
    Rect { x: f32, y: f32, width: f32, height: f32, fill: Option<Rgb>, stroke: Option<Rgb>, line_width: f32 },
    Text {
        x: f32,
        y: f32,
        width: f32,
        font_key: String,
        font_size: f32,
        align: String,
        line_height: Option<f32>,
        color: Rgb,
        text: String,
    },
    /// An image frame; `data` is a PNG or JPEG data URL.
    Image { x: f32, y: f32, width: f32, height: f32, data: String },
    /// A shape: SVG path data (absolute M, L, Q, C, Z) in px from (x, y).
    Path { x: f32, y: f32, d: String, fill: Option<Rgb>, stroke: Option<Rgb>, line_width: f32 },
}

/// Render the document to PDF bytes.
pub fn render(doc: &PrintDoc) -> Result<Vec<u8>, String> {
    let layouts = layout_text(doc)?;

    // The fonts used, with the glyphs each one needs.
    let mut used: HashMap<String, BTreeSet<u16>> = HashMap::new();
    for (key, layout) in layouts.values() {
        used.entry(key.clone())
            .or_default()
            .extend(layout.lines.iter().flat_map(|l| l.glyphs.iter().map(|g| g.gid)));
    }
    let mut font_order: Vec<String> = used.keys().cloned().collect();
    font_order.sort();

    let mut pdf = Pdf::new();
    let mut next_ref = Ref::new(1);
    let catalog_id = next_ref.bump();
    let tree_id = next_ref.bump();

    let mut font_names: HashMap<String, String> = HashMap::new();
    let mut font_refs: Vec<(String, Ref)> = Vec::new();
    for (i, key) in font_order.iter().enumerate() {
        let font = shaping::font(key)?;
        let id = write_font(&mut pdf, &mut next_ref, &font, key, &used[key]);
        let name = format!("F{i}");
        font_names.insert(key.clone(), name.clone());
        font_refs.push((name, id));
    }

    // Images, each written once however often it appears.
    let mut images: HashMap<&str, Option<(String, Ref)>> = HashMap::new();
    let mut page_ids = Vec::with_capacity(doc.pages.len());
    for (pi, page) in doc.pages.iter().enumerate() {
        let page_id = next_ref.bump();
        let content_id = next_ref.bump();
        let page_h = page.height * PX_TO_PT;
        let mut content = Content::new();
        let mut page_fonts: BTreeSet<String> = BTreeSet::new();
        let mut page_images: BTreeSet<(String, Ref)> = BTreeSet::new();

        for (ii, item) in page.items.iter().enumerate() {
            match item {
                PrintItem::Rect { x, y, width, height, fill, stroke, line_width } => {
                    if fill.is_none() && stroke.is_none() {
                        continue;
                    }
                    content.save_state();
                    paint(&mut content, *fill, *stroke, *line_width);
                    content.rect(x * PX_TO_PT, page_h - (y + height) * PX_TO_PT, width * PX_TO_PT, height * PX_TO_PT);
                    finish_path(&mut content, fill.is_some(), stroke.is_some());
                    content.restore_state();
                }
                PrintItem::Path { x, y, d, fill, stroke, line_width } => {
                    if fill.is_none() && stroke.is_none() {
                        continue;
                    }
                    content.save_state();
                    paint(&mut content, *fill, *stroke, *line_width);
                    content.set_line_cap(LineCapStyle::RoundCap);
                    content.set_line_join(LineJoinStyle::RoundJoin);
                    if draw_path(&mut content, d, *x, *y, page_h) {
                        finish_path(&mut content, fill.is_some(), stroke.is_some());
                    }
                    content.restore_state();
                }
                PrintItem::Image { x, y, width, height, data } => {
                    let entry = images.entry(data.as_str()).or_insert_with(|| {
                        // An image that cannot be read is left out rather than
                        // failing the whole export.
                        let id = write_image(&mut pdf, &mut next_ref, data).ok()?;
                        Some((format!("Im{}", id.get()), id))
                    });
                    let Some((name, id)) = entry.clone() else { continue };
                    content.save_state();
                    content.transform([
                        width * PX_TO_PT,
                        0.0,
                        0.0,
                        height * PX_TO_PT,
                        x * PX_TO_PT,
                        page_h - (y + height) * PX_TO_PT,
                    ]);
                    content.x_object(Name(name.as_bytes()));
                    content.restore_state();
                    page_images.insert((name, id));
                }
                PrintItem::Text { x, y, color, .. } => {
                    let Some((key, layout)) = layouts.get(&(pi, ii)) else { continue };
                    let name = &font_names[key];
                    if draw_text(&mut content, layout, name, *x, *y, page_h, *color) {
                        page_fonts.insert(name.clone());
                    }
                }
            }
        }

        let data = deflate(&content.finish(), 6);
        pdf.stream(content_id, &data).filter(Filter::FlateDecode);
        let mut p = pdf.page(page_id);
        p.media_box(Rect::new(0.0, 0.0, page.width * PX_TO_PT, page_h))
            .parent(tree_id)
            .contents(content_id);
        let mut resources = p.resources();
        if !page_fonts.is_empty() {
            let mut fonts = resources.fonts();
            for (name, id) in font_refs.iter().filter(|(n, _)| page_fonts.contains(n)) {
                fonts.pair(Name(name.as_bytes()), *id);
            }
        }
        if !page_images.is_empty() {
            let mut objects = resources.x_objects();
            for (name, id) in &page_images {
                objects.pair(Name(name.as_bytes()), *id);
            }
        }
        resources.finish();
        p.finish();
        page_ids.push(page_id);
    }

    let count = page_ids.len() as i32;
    pdf.pages(tree_id).kids(page_ids).count(count);
    pdf.catalog(catalog_id).pages(tree_id);
    Ok(pdf.finish())
}

/// Lay out every text item, spread over the CPU cores (pages, and paragraphs
/// within them). Keyed by
/// (page index, item index), with the font key.
fn layout_text(doc: &PrintDoc) -> Result<HashMap<(usize, usize), (String, Arc<FrameLayout>)>, String> {
    struct Job<'a> {
        at: (usize, usize),
        font: Arc<Font>,
        key: &'a str,
        text: &'a str,
        size: f32,
        width: f32,
        align: &'a str,
        line_height: Option<f32>,
    }
    let mut fonts: HashMap<&str, Arc<Font>> = HashMap::new();
    let mut jobs = Vec::new();
    for (pi, page) in doc.pages.iter().enumerate() {
        for (ii, item) in page.items.iter().enumerate() {
            let PrintItem::Text { width, font_key, font_size, align, line_height, text, .. } = item else { continue };
            if text.trim().is_empty() {
                continue;
            }
            let font = match fonts.get(font_key.as_str()) {
                Some(f) => f.clone(),
                None => {
                    let f = shaping::font(font_key)?;
                    fonts.insert(font_key, f.clone());
                    f
                }
            };
            jobs.push(Job {
                at: (pi, ii),
                font,
                key: font_key,
                text,
                size: *font_size,
                width: *width,
                align,
                line_height: *line_height,
            });
        }
    }
    let laid: Vec<Arc<FrameLayout>> = jobs
        .par_iter()
        .map(|job| shaping::layout_frame(&job.font, job.text, job.size, job.width, job.align, job.line_height))
        .collect();
    Ok(jobs.iter().zip(laid).map(|(job, layout)| (job.at, (job.key.to_string(), layout))).collect())
}

/// Write one frame's text as glyphs of its font. Returns whether anything was drawn.
fn draw_text(c: &mut Content, layout: &FrameLayout, font: &str, ox: f32, oy: f32, page_h: f32, color: Rgb) -> bool {
    if layout.lines.iter().all(|l| l.glyphs.is_empty()) {
        return false;
    }
    c.set_fill_rgb(color[0] as f32 / 255.0, color[1] as f32 / 255.0, color[2] as f32 / 255.0);
    c.begin_text();
    c.set_font(Name(font.as_bytes()), layout.font_size * PX_TO_PT);
    // Glyphs are placed with relative moves between positions rounded to a
    // hundredth of a point, so the moves add up exactly.
    let hundredths = |v: f32| (v * 100.0).round() as i64;
    let (mut px, mut py) = (0i64, 0i64);
    for line in &layout.lines {
        if line.glyphs.is_empty() {
            continue;
        }
        c.begin_marked_content_with_properties(Name(b"Span"))
            .properties()
            .actual_text(TextStr(&line.text));
        for g in &line.glyphs {
            let x = hundredths((ox + g.x) * PX_TO_PT);
            let y = hundredths(page_h - (oy + g.y) * PX_TO_PT);
            c.next_line((x - px) as f32 / 100.0, (y - py) as f32 / 100.0);
            (px, py) = (x, y);
            c.show(Str(&g.gid.to_be_bytes()));
        }
        c.end_marked_content();
    }
    c.end_text();
    true
}

fn paint(c: &mut Content, fill: Option<Rgb>, stroke: Option<Rgb>, line_width: f32) {
    if let Some([r, g, b]) = fill {
        c.set_fill_rgb(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    }
    if let Some([r, g, b]) = stroke {
        c.set_stroke_rgb(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
        c.set_line_width(line_width * PX_TO_PT);
    }
}

fn finish_path(c: &mut Content, fill: bool, stroke: bool) {
    match (fill, stroke) {
        (true, true) => c.fill_nonzero_and_stroke(),
        (true, false) => c.fill_nonzero(),
        _ => c.stroke(),
    };
}

/// Draw SVG path data (the absolute M, L, Q, C, Z subset the shape geometry
/// writes) offset by (ox, oy) px. Returns whether anything was drawn.
fn draw_path(c: &mut Content, d: &str, ox: f32, oy: f32, page_h: f32) -> bool {
    let x = |v: f32| (ox + v) * PX_TO_PT;
    let y = |v: f32| page_h - (oy + v) * PX_TO_PT;
    let mut drew = false;
    let (mut cx, mut cy) = (0.0_f32, 0.0_f32);
    let mut started = false;
    for (cmd, nums) in path_commands(d) {
        match cmd {
            'M' | 'L' => {
                for p in nums.chunks_exact(2) {
                    if cmd == 'M' {
                        c.move_to(x(p[0]), y(p[1]));
                        started = true;
                    } else if started {
                        c.line_to(x(p[0]), y(p[1]));
                        drew = true;
                    }
                    (cx, cy) = (p[0], p[1]);
                }
            }
            'Q' if started => {
                for p in nums.chunks_exact(4) {
                    // Quadratic to cubic.
                    let (x1, y1) = (cx + 2.0 / 3.0 * (p[0] - cx), cy + 2.0 / 3.0 * (p[1] - cy));
                    let (x2, y2) = (p[2] + 2.0 / 3.0 * (p[0] - p[2]), p[3] + 2.0 / 3.0 * (p[1] - p[3]));
                    c.cubic_to(x(x1), y(y1), x(x2), y(y2), x(p[2]), y(p[3]));
                    (cx, cy) = (p[2], p[3]);
                    drew = true;
                }
            }
            'C' if started => {
                for p in nums.chunks_exact(6) {
                    c.cubic_to(x(p[0]), y(p[1]), x(p[2]), y(p[3]), x(p[4]), y(p[5]));
                    (cx, cy) = (p[4], p[5]);
                    drew = true;
                }
            }
            'Z' if started => {
                c.close_path();
            }
            _ => {}
        }
    }
    drew
}

/// Split path data into commands (upper-cased) and their numbers. A command
/// with an unreadable number is dropped, as the old jsPDF path did.
fn path_commands(d: &str) -> Vec<(char, Vec<f32>)> {
    let mut out = Vec::new();
    let mut rest = d;
    while let Some(start) = rest.find(|c: char| "MLQCZmlqcz".contains(c)) {
        let cmd = rest[start..].chars().next().unwrap_or('Z').to_ascii_uppercase();
        let body = &rest[start + 1..];
        let end = body.find(|c: char| "MLQCZmlqcz".contains(c)).unwrap_or(body.len());
        let nums: Option<Vec<f32>> = body[..end]
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter(|t| !t.is_empty())
            .map(|t| t.parse::<f32>().ok().filter(|v| v.is_finite()))
            .collect();
        if let Some(nums) = nums {
            out.push((cmd, nums));
        }
        rest = &body[end..];
    }
    out
}

fn deflate(data: &[u8], level: u8) -> Vec<u8> {
    miniz_oxide::deflate::compress_to_vec_zlib(data, level)
}

/// Embed a whole font as a Type0 font with Identity-H encoding, so the content
/// stream addresses glyphs by id. Returns the Type0 font's id.
fn write_font(pdf: &mut Pdf, next_ref: &mut Ref, font: &Font, key: &str, gids: &BTreeSet<u16>) -> Ref {
    let type0_id = next_ref.bump();
    let cid_id = next_ref.bump();
    let descriptor_id = next_ref.bump();
    let file_id = next_ref.bump();

    let face = &font.face;
    let units = face.units_per_em() as f32;
    let to_1000 = |v: f32| v * 1000.0 / units;
    let base = base_font_name(face, key);
    let base = Name(base.as_bytes());
    // Without TrueType outlines the font is CFF-based (an OpenType .otf).
    let cff = face.tables().glyf.is_none();

    pdf.type0_font(type0_id)
        .base_font(base)
        .encoding_predefined(Name(b"Identity-H"))
        .descendant_font(cid_id);

    let mut cid = pdf.cid_font(cid_id);
    cid.subtype(if cff { CidFontType::Type0 } else { CidFontType::Type2 })
        .base_font(base)
        .system_info(SystemInfo { registry: Str(b"Adobe"), ordering: Str(b"Identity"), supplement: 0 })
        .font_descriptor(descriptor_id)
        .default_width(0.0);
    if !cff {
        cid.cid_to_gid_map_predefined(Name(b"Identity"));
    }
    // Advance widths of the glyphs used, in runs of consecutive ids.
    let mut widths = cid.widths();
    let ids: Vec<u16> = gids.iter().copied().collect();
    for run in ids.chunk_by(|a, b| *b == *a + 1) {
        widths.consecutive(
            run[0],
            run.iter().map(|g| to_1000(face.glyph_hor_advance(ttf_parser::GlyphId(*g)).unwrap_or(0) as f32)),
        );
    }
    widths.finish();
    cid.finish();

    let bbox = face.global_bounding_box();
    let mut descriptor = pdf.font_descriptor(descriptor_id);
    descriptor
        .name(base)
        .flags(FontFlags::SYMBOLIC)
        .bbox(Rect::new(
            to_1000(bbox.x_min as f32),
            to_1000(bbox.y_min as f32),
            to_1000(bbox.x_max as f32),
            to_1000(bbox.y_max as f32),
        ))
        .italic_angle(0.0)
        .ascent(to_1000(face.ascender() as f32))
        .descent(to_1000(face.descender() as f32))
        .cap_height(to_1000(face.capital_height().unwrap_or(face.ascender()) as f32))
        .stem_v(80.0);
    if cff {
        descriptor.font_file3(file_id);
    } else {
        descriptor.font_file2(file_id);
    }
    descriptor.finish();

    let mut file = pdf.stream(file_id, font.embedded());
    file.filter(Filter::FlateDecode);
    if cff {
        file.pair(Name(b"Subtype"), Name(b"OpenType"));
    } else {
        file.pair(Name(b"Length1"), font.data.len() as i32);
    }
    file.finish();
    type0_id
}

/// The font's PostScript name (letters, digits and hyphens only), or one made
/// from its key.
fn base_font_name(face: &ttf_parser::Face, key: &str) -> String {
    let clean = |s: &str| s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect::<String>();
    face.names()
        .into_iter()
        .filter(|n| n.name_id == ttf_parser::name_id::POST_SCRIPT_NAME)
        .find_map(|n| n.to_string())
        .map(|s| clean(&s))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("Harfsaz-{}", clean(key)))
}

/// Write an image from a PNG or JPEG data URL. Returns its id.
fn write_image(pdf: &mut Pdf, next_ref: &mut Ref, data_url: &str) -> Result<Ref, String> {
    let (header, payload) = data_url.split_once(',').ok_or("not a data URL")?;
    if !header.starts_with("data:image/") || !header.ends_with(";base64") {
        return Err("unsupported image data".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| e.to_string())?;
    let id = next_ref.bump();
    if bytes.starts_with(&[0xFF, 0xD8]) {
        let jpeg = jpeg_info(&bytes).ok_or("unreadable JPEG")?;
        let mut image = pdf.image_xobject(id, &bytes);
        image.width(jpeg.width).height(jpeg.height).bits_per_component(8);
        image.filter(Filter::DctDecode);
        match jpeg.components {
            1 => image.color_space().device_gray(),
            4 => image.color_space().device_cmyk(),
            _ => image.color_space().device_rgb(),
        }
        if jpeg.components == 4 && jpeg.adobe {
            // Photoshop writes CMYK JPEGs inverted.
            image.decode([1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0]);
        }
        image.finish();
        return Ok(id);
    }

    let mut decoder = png::Decoder::new(std::io::Cursor::new(&bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    // The decoder sizes its output from the header alone, so a small file can
    // claim a huge picture; leave such a picture out instead of allocating it.
    let (w, h) = (reader.info().width as u64, reader.info().height as u64);
    if w * h > MAX_IMAGE_PIXELS {
        return Err(format!("picture too large to embed ({w}×{h} pixels)"));
    }
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let pixels = &buf[..info.buffer_size()];
    let (color, _) = reader.output_color_type();
    let (channels, gray) = match color {
        png::ColorType::Grayscale => (1, true),
        png::ColorType::GrayscaleAlpha => (2, true),
        png::ColorType::Rgb => (3, false),
        png::ColorType::Rgba => (4, false),
        png::ColorType::Indexed => return Err("unexpanded palette PNG".into()),
    };
    let has_alpha = channels == 2 || channels == 4;
    let colour_channels = if gray { 1 } else { 3 };
    let mut colour = Vec::with_capacity(pixels.len() / channels * colour_channels);
    let mut alpha = Vec::new();
    for px in pixels.chunks_exact(channels) {
        colour.extend_from_slice(&px[..colour_channels]);
        if has_alpha {
            alpha.push(px[channels - 1]);
        }
    }
    let mask_id = if has_alpha && alpha.iter().any(|a| *a != 255) {
        let mask_id = next_ref.bump();
        let data = deflate(&alpha, 3);
        let mut mask = pdf.image_xobject(mask_id, &data);
        mask.width(info.width as i32).height(info.height as i32).bits_per_component(8);
        mask.filter(Filter::FlateDecode);
        mask.color_space().device_gray();
        mask.finish();
        Some(mask_id)
    } else {
        None
    };
    let data = deflate(&colour, 3);
    let mut image = pdf.image_xobject(id, &data);
    image.width(info.width as i32).height(info.height as i32).bits_per_component(8);
    image.filter(Filter::FlateDecode);
    if gray {
        image.color_space().device_gray();
    } else {
        image.color_space().device_rgb();
    }
    if let Some(mask_id) = mask_id {
        image.s_mask(mask_id);
    }
    image.finish();
    Ok(id)
}

struct JpegInfo {
    width: i32,
    height: i32,
    components: u8,
    /// An Adobe APP14 marker (its CMYK data is stored inverted).
    adobe: bool,
}

/// Size and colour components from a JPEG's frame header.
fn jpeg_info(b: &[u8]) -> Option<JpegInfo> {
    let mut i = 2;
    let mut adobe = false;
    while i + 4 <= b.len() {
        if b[i] != 0xFF {
            return None;
        }
        let marker = b[i + 1];
        if marker == 0xFF {
            i += 1; // fill byte
            continue;
        }
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        let body = b.get(i + 4..i + 2 + len)?;
        match marker {
            0xEE if body.starts_with(b"Adobe") => adobe = true,
            0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                return Some(JpegInfo {
                    height: u16::from_be_bytes([*body.get(1)?, *body.get(2)?]) as i32,
                    width: u16::from_be_bytes([*body.get(3)?, *body.get(4)?]) as i32,
                    components: *body.get(5)?,
                    adobe,
                });
            }
            _ => {}
        }
        i += 2 + len;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn register(key: &str, file: &str) -> bool {
        match std::fs::read(format!("../public/fonts/{file}")) {
            Ok(bytes) => shaping::register_font(key, bytes).is_ok(),
            Err(_) => false,
        }
    }

    fn text(key: &str, s: &str) -> PrintItem {
        PrintItem::Text {
            x: 40.0,
            y: 40.0,
            width: 714.0,
            font_key: key.into(),
            font_size: 28.0,
            align: "right".into(),
            line_height: Some(1.7),
            color: [0, 0, 0],
            text: s.into(),
        }
    }

    #[test]
    fn writes_text_with_the_font_embedded_once() {
        if !register("test-nastaliq", "NotoNastaliqUrdu-Regular.ttf") {
            return;
        }
        let page = |s: &str| PrintPage { width: 794.0, height: 1123.0, items: vec![text("test-nastaliq", s)] };
        let doc = PrintDoc { pages: vec![page("اردو ایک خوبصورت زبان ہے"), page("نستعلیق")] };
        let bytes = render(&doc).unwrap();
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.starts_with("%PDF-"));
        assert_eq!(s.matches("/FontFile2").count(), 1, "font embedded once");
        assert!(s.contains("/Identity-H"));
        assert_eq!(s.matches("/Type /Page\n").count() + s.matches("/Type /Page ").count(), 2, "two pages");
        // Much smaller than outlines: the font plus a few KB.
        assert!(bytes.len() < 600_000, "{} bytes", bytes.len());
    }

    #[test]
    fn unknown_font_is_an_error() {
        let doc = PrintDoc { pages: vec![PrintPage { width: 100.0, height: 100.0, items: vec![text("no-such-font", "ا")] }] };
        assert!(render(&doc).is_err());
    }

    /// The start of a JPEG: SOI, an Adobe APP14 marker and a baseline frame
    /// header for a 3×2 image with `components` colour components.
    fn jpeg_header(components: u8) -> Vec<u8> {
        let mut b = vec![0xFF, 0xD8, 0xFF, 0xEE, 0x00, 0x07];
        b.extend_from_slice(b"Adobe");
        let len = 8 + 3 * components as u16;
        b.extend_from_slice(&[0xFF, 0xC0, (len >> 8) as u8, len as u8, 8, 0, 2, 0, 3, components]);
        for c in 0..components {
            b.extend_from_slice(&[c + 1, 0x11, 0]);
        }
        b.extend_from_slice(&[0xFF, 0xD9]);
        b
    }

    fn data_url(mime: &str, bytes: &[u8]) -> String {
        format!("data:image/{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    #[test]
    fn draws_shapes_rects_and_images() {
        // 2×1 RGBA PNG: a half-transparent red pixel and an opaque blue one.
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DQwMDw/z8ADX4DfuoeFyEAAAAASUVORK5CYII=";
        let jpeg = data_url("jpeg", &jpeg_header(3));
        let doc = PrintDoc {
            pages: vec![PrintPage {
                width: 200.0,
                height: 200.0,
                items: vec![
                    PrintItem::Rect { x: 0.0, y: 0.0, width: 50.0, height: 50.0, fill: Some([255, 0, 0]), stroke: Some([0, 0, 255]), line_width: 2.0 },
                    PrintItem::Path { x: 10.0, y: 10.0, d: "M 0 0 L 10 0 Q 20 5 10 10 C 5 15 0 15 0 10 Z".into(), fill: Some([0, 255, 0]), stroke: None, line_width: 0.0 },
                    PrintItem::Image { x: 0.0, y: 100.0, width: 50.0, height: 50.0, data: png.into() },
                    PrintItem::Image { x: 60.0, y: 100.0, width: 50.0, height: 50.0, data: png.into() },
                    PrintItem::Image { x: 120.0, y: 100.0, width: 50.0, height: 50.0, data: jpeg },
                    PrintItem::Image { x: 120.0, y: 100.0, width: 50.0, height: 50.0, data: "data:image/png;base64,broken".into() },
                ],
            }],
        };
        let bytes = render(&doc).unwrap();
        let s = String::from_utf8_lossy(&bytes);
        assert_eq!(s.matches("/Subtype /Image").count(), 3, "PNG once, its alpha mask, the JPEG");
        assert!(s.contains("/SMask"));
        assert!(s.contains("/DCTDecode"));
    }

    #[test]
    fn a_picture_claiming_a_huge_size_is_left_out() {
        // A PNG whose header claims 50000×50000 RGBA (10 GB decoded) with almost no data.
        fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
            out.extend_from_slice(&(data.len() as u32).to_be_bytes());
            let start = out.len();
            out.extend_from_slice(kind);
            out.extend_from_slice(data);
            let mut crc = !0u32;
            for &b in &out[start..] {
                crc ^= b as u32;
                for _ in 0..8 {
                    crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
                }
            }
            out.extend_from_slice(&(!crc).to_be_bytes());
        }
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&50_000u32.to_be_bytes());
        ihdr.extend_from_slice(&50_000u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        chunk(&mut png, b"IHDR", &ihdr);
        chunk(&mut png, b"IDAT", &miniz_oxide::deflate::compress_to_vec_zlib(&[0; 64], 1));
        chunk(&mut png, b"IEND", &[]);
        let err = write_image(&mut Pdf::new(), &mut Ref::new(1), &data_url("png", &png)).unwrap_err();
        assert!(err.contains("too large"), "{err}");
    }

    #[test]
    fn jpeg_size_and_colours_are_read_from_the_header() {
        let info = jpeg_info(&jpeg_header(3)).unwrap();
        assert_eq!((info.width, info.height, info.components, info.adobe), (3, 2, 3, true));
        assert_eq!(jpeg_info(&jpeg_header(4)).unwrap().components, 4);
        assert!(jpeg_info(&[0xFF, 0xD8, 0x00]).is_none());
    }

    #[test]
    fn path_commands_read_the_shape_subset() {
        let cmds = path_commands("M 1 2 L 3,4 Q 5 6 7 8 C 1 2 3 4 5 6 Z");
        let letters: String = cmds.iter().map(|(c, _)| *c).collect();
        assert_eq!(letters, "MLQCZ");
        assert_eq!(cmds[1].1, vec![3.0, 4.0]);
        assert!(path_commands("M 1 x L 2 2").iter().all(|(c, _)| *c == 'L'), "unreadable command dropped");
    }
}
