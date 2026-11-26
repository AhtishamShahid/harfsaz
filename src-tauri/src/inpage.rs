//! InPage (`.inp`) import — text extraction from the closed InPage format.
//!
//! InPage is the incumbent Urdu DTP application (1994–). Its file format is
//! proprietary and undocumented, so this is a port of a reverse-engineered
//! extractor (Kamal Abdali's InpToUni, C, public on GitHub) that we verified
//! byte-for-byte against its own sample document. What is known:
//!
//! * The container is an OLE2 / Compound File (magic `D0 CF 11 E0 A1 B1 1A E1`).
//!   The text stream is not read via the OLE directory; instead the file is
//!   scanned raw after stripping the 512-byte FAT sectors that interrupt it
//!   (the `separator` pattern below is exactly one such FAT sector).
//! * Pre-3.0 documents store text as **records** (one per paragraph): a 4-byte
//!   header whose first two bytes are the little-endian length, followed by the
//!   bytes, ending in `0x0D`. Records follow a `0D 00 00 00 00 00` marker.
//! * Inside a record, plain bytes pass through as Latin-1, and `0x04` escapes a
//!   one-byte code for an Urdu/Arabic-script character, mapped through a
//!   256-entry table into the U+06xx block (with a handful of punctuation
//!   specials).
//! * InPage 3.0+ switched to Unicode internally. We have no sample of that
//!   format; `extract_text` falls back to scanning for UTF-16LE runs of
//!   Arabic-script text, which is best-effort and flagged in the result.
//!
//! Formatting, frames, page geometry and images are NOT recovered — the format
//! for those is unknown. Output is plain paragraphs, which the frontend then
//! paginates into a Harfsaz document.

use serde::Serialize;

/// Result of importing an InPage file.
#[derive(Serialize, Debug, Clone)]
pub struct InpageDoc {
    /// Paragraphs in document order.
    pub paragraphs: Vec<String>,
    /// True when the pre-3.0 record format was found and decoded (reliable).
    /// False when we fell back to the UTF-16 heuristic for newer files.
    pub legacy_format: bool,
    /// The same text with character formatting, one entry per paragraph.
    /// None when the formatting tables could not be read and verified.
    pub styled: Option<Vec<Vec<InpageSpan>>>,
    /// Page size and margins from the document setup, when found.
    pub page: Option<InpagePage>,
}

/// A run of text sharing one character format.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct InpageSpan {
    pub text: String,
    pub bold: bool,
    /// Font size in points (0 when the run does not set one).
    pub size_pt: f32,
}

/// Page geometry in points. InPage stores lengths in 1/144000 inch.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct InpagePage {
    pub width_pt: f32,
    pub height_pt: f32,
    pub margin_left_pt: f32,
    pub margin_top_pt: f32,
    pub margin_right_pt: f32,
    pub margin_bottom_pt: f32,
}

const OLE_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

/// Marker that precedes a run of text records.
const RECORD_MARKER: [u8; 6] = [0x0D, 0x00, 0x00, 0x00, 0x00, 0x00];
/// After a `00 00 xx xx` header, this sequence means "end of stream".
const SKIP_TAIL: [u8; 5] = [0x00, 0xFF, 0xFF, 0xFF, 0xFF];

/// Low byte of the U+06xx code point for each escaped InPage character code.
/// Copied verbatim from the reference implementation (`unicodebyte[]`).
#[rustfmt::skip]
const UNICODE_LOW: [u8; 256] = [
    /* 00 */ 0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,
    /* 08 */ 0x55,0x09,0x0a,0x0b,0x0c,0x0d,0x0e,0x0f,
    /* 10 */ 0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,
    /* 18 */ 0x18,0x19,0x1a,0x1b,0x1c,0x1d,0x1e,0x1f,
    /* 20 */ 0x20,0x21,0x22,0x23,0x24,0x25,0x26,0x27,
    /* 28 */ 0x28,0x29,0x2a,0x2b,0x2c,0x2d,0x2e,0x2f,
    /* 30 */ 0x30,0x31,0x32,0x33,0x34,0x35,0x36,0x37,
    /* 38 */ 0x38,0x39,0x3a,0x3b,0x3c,0x3d,0x3e,0x3f,
    /* 40 */ 0x40,0x41,0x42,0x43,0x44,0x45,0x46,0x47,
    /* 48 */ 0x48,0x49,0x4a,0x4b,0x4c,0x4d,0x4e,0x4f,
    /* 50 */ 0x50,0x51,0x52,0x53,0x54,0x55,0x56,0x57,
    /* 58 */ 0x58,0x59,0x5a,0x5b,0x5c,0x5d,0x5e,0x5f,
    /* 60 */ 0x60,0x61,0x62,0x63,0x64,0x65,0x66,0x67,
    /* 68 */ 0x68,0x69,0x6a,0x41,0x6c,0x6d,0x6e,0x6f,
    /* 70 */ 0x70,0x71,0x72,0x73,0x74,0x75,0x76,0x77,
    /* 78 */ 0x78,0x79,0x7a,0x7b,0x7c,0x7d,0x7e,0x7f,
    /* 80 */ 0x80,0x27,0x28,0x7e,0x2a,0x79,0x2b,0x2c,
    /* 88 */ 0x86,0x2d,0x2e,0x2f,0x88,0x30,0x31,0x91,
    /* 90 */ 0x32,0x98,0x33,0x34,0x35,0x36,0x37,0x38,
    /* 98 */ 0x39,0x3a,0x41,0x42,0xa9,0xaf,0x44,0x45,
    /* a0 */ 0x46,0xba,0x48,0x26,0xcc,0xd2,0xc1,0xbe,
    /* a8 */ 0x4d,0x40,0x50,0x4e,0x4f,0x51,0x11,0xaf,
    /* b0 */ 0x56,0xe1,0xb2,0x53,0x52,0x4c,0x24,0xa3,
    /* b8 */ 0x4a,0xc3,0xba,0xbb,0xbc,0x70,0x57,0x54,
    /* c0 */ 0xc0,0xc1,0xc2,0xc3,0xc4,0xc5,0xc6,0x4b,
    /* c8 */ 0x22,0x23,0x25,0xcb,0x1f,0x1f,0x1f,0x14,
    /* d0 */ 0x60,0x61,0x62,0x63,0x64,0x65,0x66,0x67,
    /* d8 */ 0x68,0x69,0xda,0xdb,0xdc,0xdd,0x6a,0xdf,
    /* e0 */ 0xe0,0xe1,0xe2,0xe3,0xe4,0xe5,0x13,0x12,
    /* e8 */ 0x6d,0xe9,0x1b,0xeb,0xec,0x0c,0x1f,0xef,
    /* f0 */ 0xc7,0x0d,0x0e,0xd4,0x19,0x40,0xf6,0x01,
    /* f8 */ 0x10,0x6b,0xfa,0xfb,0xfc,0xfd,0xfe,0xff,
];

/// Whether `bytes` looks like an InPage / OLE2 container.
pub fn is_inpage(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && bytes[..8] == OLE_MAGIC
}

/// The 512-byte FAT-sector pattern the reference strips before scanning.
fn separator() -> [u8; 0x200] {
    let mut s = [0u8; 0x200];
    for i in 1..0x15usize {
        s[4 * i - 4] = i as u8;
    }
    s[0x50] = 0xFE;
    for b in s.iter_mut().skip(0x51) {
        *b = 0xFF;
    }
    s
}

/// Remove every occurrence of `pat` from `buf` (non-overlapping, left to right).
fn strip_pattern(buf: &[u8], pat: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(buf.len());
    let mut i = 0;
    while i < buf.len() {
        if buf.len() - i >= pat.len() && &buf[i..i + pat.len()] == pat {
            i += pat.len();
        } else {
            out.push(buf[i]);
            i += 1;
        }
    }
    out
}

fn find(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || from >= hay.len() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// Decode the character starting at `rec[i]`. Returns the character (None for
/// bytes that are formatting/control codes we skip) and how many bytes it used:
/// 2 for an `0x04`-escaped script character, 1 otherwise.
fn decode_char(rec: &[u8], i: usize) -> (Option<char>, usize) {
    let ch = rec[i];
    if (0x08 < ch && ch < 0x0E) || (0x1F < ch && ch < 0xFF) {
        // Plain byte: Latin-1 passthrough (ASCII punctuation, digits, Latin).
        return (Some(ch as char), 1);
    }
    if ch == 0x04 {
        // Escaped script character.
        let Some(&c) = rec.get(i + 1) else { return (None, 1) };
        let cp: u32 = match c {
            0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20 => c as u32,
            0x3A => 0x005E,
            0xCB => 0xFDF2, // ﷲ
            0xDA => 0x0021,
            0xDB => 0x007D,
            0xDC => 0x007B,
            0xDD => 0x0024,
            0xDF => 0x002F,
            0xE0 => 0x2026, // …
            0xE1 => 0x0029,
            0xE2 => 0x0028,
            0xE3 => 0x002A,
            0xE4 => 0x002B,
            0xE9 => 0x003A,
            0xEB => 0x00D7,
            0xEC => 0x003D,
            0xEF => 0x00F7,
            0xF5 => 0x2212,
            0xF6 => 0xFDFA, // ﷺ
            0xFA => 0x005D,
            0xFB => 0x005B,
            0xFC => 0x002E,
            0xFD => 0x2018,
            0xFE => 0x2019,
            _ => 0x0600 + UNICODE_LOW[c as usize] as u32,
        };
        return (char::from_u32(cp), 2);
    }
    // Any other byte (control codes, 0xFF) is formatting we don't decode.
    (None, 1)
}

/// Decode one text record's bytes (excluding its trailing 0x0D) into a string.
fn decode_record(rec: &[u8]) -> String {
    let mut out = String::with_capacity(rec.len());
    let mut i = 0;
    while i < rec.len() {
        let (chr, used) = decode_char(rec, i);
        if let Some(chr) = chr {
            out.push(chr);
        }
        i += used;
    }
    out
}

/// InPage typists often use the bari-ye key (ے) inside a word — InPage draws it
/// as a joined medial ye, so "فرےق" looks like "فریق" there. Unicode ے cannot
/// join to the following letter, so the imported word visibly breaks. A ے that
/// is directly followed by a letter is therefore a choti ye (ی). Word-final ے
/// (before a space, punctuation, a digit or the end) is a real bari ye and stays.
fn fix_bari_ye(chars: &mut [char]) {
    let is_letter = |c: char| {
        matches!(c, '\u{0621}'..='\u{064A}' | '\u{066E}'..='\u{06D3}' | '\u{06D5}' | '\u{06EE}'..='\u{06EF}' | '\u{06FA}'..='\u{06FF}')
    };
    for i in 0..chars.len().saturating_sub(1) {
        if chars[i] == '\u{06D2}' && is_letter(chars[i + 1]) {
            chars[i] = '\u{06CC}';
        }
    }
}

/// Decode a record and apply the bari-ye correction.
fn decode_paragraph(rec: &[u8]) -> String {
    let mut chars: Vec<char> = decode_record(rec).chars().collect();
    fix_bari_ye(&mut chars);
    chars.into_iter().collect()
}

/// Extract paragraphs from a pre-3.0 InPage file. Empty when no records found.
fn extract_legacy(raw: &[u8]) -> Vec<String> {
    let buf = strip_pattern(raw, &separator());
    let mut paragraphs = Vec::new();
    let mut pos = 0usize;

    'outer: loop {
        // Find the next record marker.
        let Some(m) = find(&buf, pos, &RECORD_MARKER) else { break };
        pos = m + RECORD_MARKER.len();

        loop {
            if pos + 4 > buf.len() {
                break 'outer;
            }
            let (c0, c1, c2, c3) = (buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
            pos += 4;

            if c0 == 0x00 && c1 == 0x00 {
                // Zero length = end of a story. If followed by 00 FF FF FF FF the
                // story list is over.
                if pos + SKIP_TAIL.len() <= buf.len() && buf[pos..pos + SKIP_TAIL.len()] == SKIP_TAIL {
                    break 'outer;
                }
                // Otherwise the next story follows right after a single 0x00
                // separator. Resyncing on the next marker here skipped that whole
                // story — in real documents often the main body text.
                if c2 == 0x00 && c3 == 0x00 && pos < buf.len() && buf[pos] == 0x00 {
                    pos += 1;
                    continue;
                }
                continue 'outer;
            }
            if c0 == 0xFF && c1 == 0xFF && c2 == 0xFF && c3 == 0xFF {
                break 'outer; // document end
            }

            let reclen = c0 as usize + 256 * c1 as usize;
            // The reference ignores a malformed record and re-emits stale data;
            // we resync instead so a bad header can't corrupt the output.
            if reclen == 0 || pos + reclen > buf.len() || buf[pos + reclen - 1] != 0x0D {
                continue 'outer;
            }
            paragraphs.push(decode_paragraph(&buf[pos..pos + reclen - 1]));
            pos += reclen;
        }
    }
    paragraphs
}

fn is_arabic_script(c: char) -> bool {
    matches!(c as u32, 0x0600..=0x06FF | 0x0750..=0x077F | 0x08A0..=0x08FF | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF)
}

/// Best-effort fallback for Unicode-era (3.0+) files: harvest UTF-16LE runs of
/// Arabic-script text. Paragraph boundaries come from CR/LF code units.
fn extract_utf16_runs(raw: &[u8]) -> Vec<String> {
    let mut paragraphs = Vec::new();
    // Try both byte alignments — the text stream need not start on an even offset.
    for start in [0usize, 1] {
        let mut cur = String::new();
        let mut arabic_in_cur = 0usize;
        let flush = |cur: &mut String, arabic: &mut usize, out: &mut Vec<String>| {
            let t = cur.trim();
            if *arabic >= 4 && t.chars().count() >= 8 {
                out.push(t.to_string());
            }
            cur.clear();
            *arabic = 0;
        };
        let mut i = start;
        while i + 1 < raw.len() {
            let u = u16::from_le_bytes([raw[i], raw[i + 1]]);
            i += 2;
            match char::from_u32(u as u32) {
                Some(c) if c == '\r' || c == '\n' => flush(&mut cur, &mut arabic_in_cur, &mut paragraphs),
                Some(c) if is_arabic_script(c) => {
                    cur.push(c);
                    arabic_in_cur += 1;
                }
                Some(c) if c == ' ' || c == '\t' || (c.is_ascii_graphic()) || ('\u{00A0}'..='\u{2044}').contains(&c) => cur.push(c),
                _ => flush(&mut cur, &mut arabic_in_cur, &mut paragraphs),
            }
        }
        flush(&mut cur, &mut arabic_in_cur, &mut paragraphs);
        if !paragraphs.is_empty() {
            break;
        }
    }
    paragraphs
}

// ── Formatting (InPage 2.x) ─────────────────────────────────────────────────
//
// Reverse-engineered from real documents; every structure below is verified
// before it is trusted, and any mismatch drops back to plain text.
//
// * Stories: a list of stories, each a run of `[u32 len][len bytes ending 0x0D]`
//   paragraphs closed by a u32 0 and one 0x00 separator byte. The list ends with
//   FF FF FF FF.
// * Character runs follow immediately: `[u32 byte count][u32 size][size bytes]`.
//   Counts are in story BYTES (an escaped script character counts 2) and cover
//   every story in order, so their total must equal the stories' byte total —
//   that equality is how we find (and verify) where the story list starts.
//   A run body is `u16 kind, u32 len, tags…` where each tag is a u16 id and a
//   u16 or u32 value. 0x7F00 = size (÷2000 = pt), 0x7F02 = weight (700 = bold).
// * Page setup: tags 0x0106..0x010B in sequence — width, height, then margins
//   (left, top, right, bottom), all in 1/144000 inch.

const STORY_LIST_END: [u8; 10] = [0x0D, 0, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF];
/// 1/144000 inch → points.
const UNITS_PER_PT: f32 = 2000.0;

fn read_u32(buf: &[u8], at: usize) -> Option<u32> {
    buf.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

fn read_u16(buf: &[u8], at: usize) -> Option<u16> {
    buf.get(at..at + 2).map(|b| u16::from_le_bytes([b[0], b[1]]))
}

/// Parse a story list starting at `p`. Returns the stories' paragraphs (each
/// including its trailing 0x0D) and the offset just past FF FF FF FF.
fn story_list(buf: &[u8], mut p: usize) -> Option<(Vec<&[u8]>, usize)> {
    let mut paragraphs = Vec::new();
    loop {
        loop {
            let n = read_u32(buf, p)? as usize;
            p += 4;
            if n == 0 {
                break; // end of this story
            }
            if n > 0x10_0000 || p + n > buf.len() || buf[p + n - 1] != 0x0D {
                return None;
            }
            paragraphs.push(&buf[p..p + n]);
            p += n;
        }
        if *buf.get(p)? != 0x00 {
            return None;
        }
        p += 1;
        if read_u32(buf, p)? == u32::MAX {
            return Some((paragraphs, p + 4));
        }
    }
}

struct CharRun {
    bytes: usize,
    bold: bool,
    size_pt: f32,
}

/// Parse one run's tag list; None unless the tags consume it exactly.
fn run_format(body: &[u8]) -> Option<(bool, f32)> {
    let inner_len = read_u32(body, 2)? as usize;
    let inner = body.get(6..)?;
    if inner.len() != inner_len {
        return None;
    }
    let (mut bold, mut size) = (false, 0.0);
    let mut q = 0;
    while q < inner.len() {
        let tag = read_u16(inner, q)?;
        q += 2;
        let wide = matches!(tag, 0x0080 | 0x7F00 | 0x7F05 | 0x7F06);
        let value = if wide { read_u32(inner, q)? } else { read_u16(inner, q)? as u32 };
        q += if wide { 4 } else { 2 };
        match tag {
            0x7F00 => size = value as f32 / UNITS_PER_PT,
            0x7F02 => bold = value >= 600,
            _ => {}
        }
    }
    (q == inner.len()).then_some((bold, size))
}

/// The character-run table at `p`. Empty if the first run does not parse.
fn char_runs(buf: &[u8], mut p: usize) -> Vec<CharRun> {
    let mut runs = Vec::new();
    while let (Some(count), Some(size)) = (read_u32(buf, p), read_u32(buf, p + 4)) {
        let (count, size) = (count as usize, size as usize);
        if count > 0x10_0000 || size < 6 || size > 0x400 {
            break;
        }
        let Some(body) = buf.get(p + 8..p + 8 + size) else { break };
        let Some((bold, size_pt)) = run_format(body) else { break };
        runs.push(CharRun { bytes: count, bold, size_pt });
        p += 8 + size;
    }
    runs
}

/// Paragraphs with character formatting, or None if anything fails to verify.
fn extract_formatted(buf: &[u8]) -> Option<Vec<Vec<InpageSpan>>> {
    let end = find(buf, 0, &STORY_LIST_END)? + STORY_LIST_END.len();
    let runs = char_runs(buf, end);
    let total: usize = runs.iter().map(|r| r.bytes).sum();
    if runs.is_empty() || total == 0 {
        return None;
    }
    // The first offset whose story list ends exactly where the runs begin and
    // whose byte total matches theirs is the start of the stories.
    let paragraphs = (0..end).find_map(|p| {
        if read_u32(buf, p)? == 0 {
            return None;
        }
        let (paras, stop) = story_list(buf, p)?;
        let bytes: usize = paras.iter().map(|x| x.len()).sum();
        (stop == end && bytes == total).then_some(paras)
    })?;

    let mut out = Vec::with_capacity(paragraphs.len());
    let (mut run, mut left) = (0usize, runs[0].bytes);
    for para in paragraphs {
        let mut spans: Vec<InpageSpan> = Vec::new();
        let mut i = 0;
        while i < para.len() {
            while left == 0 && run + 1 < runs.len() {
                run += 1;
                left = runs[run].bytes;
            }
            let (chr, used) = decode_char(para, i);
            let r = &runs[run];
            // The trailing 0x0D is the paragraph break, not text.
            if let Some(c) = chr.filter(|_| i + used < para.len()) {
                match spans.last_mut() {
                    Some(s) if s.bold == r.bold && s.size_pt == r.size_pt => s.text.push(c),
                    _ => spans.push(InpageSpan { text: c.to_string(), bold: r.bold, size_pt: r.size_pt }),
                }
            }
            left = left.saturating_sub(used);
            i += used;
        }
        // Same correction as the plain text, across span boundaries (ے and the
        // next letter can sit in different formatting runs). It swaps one char
        // for one char, so each span keeps its length.
        let mut chars: Vec<char> = spans.iter().flat_map(|s| s.text.chars()).collect();
        fix_bari_ye(&mut chars);
        let mut rest = chars.into_iter();
        for span in &mut spans {
            let n = span.text.chars().count();
            span.text = rest.by_ref().take(n).collect();
        }
        out.push(spans);
    }
    Some(out)
}

/// Page size and margins from the document setup tags, if present and sane.
fn page_setup(buf: &[u8]) -> Option<InpagePage> {
    let at = (0..buf.len().saturating_sub(36)).find(|&i| {
        (0..6).all(|k| buf[i + 6 * k] == 0x06 + k as u8 && buf[i + 6 * k + 1] == 0x01)
    })?;
    let v: Vec<f32> = (0..6)
        .map(|k| read_u32(buf, at + 6 * k + 2).map(|x| x as f32 / UNITS_PER_PT))
        .collect::<Option<_>>()?;
    let sane = (72.0..=3000.0).contains(&v[0])
        && (72.0..=3000.0).contains(&v[1])
        && v[2] + v[4] < v[0]
        && v[3] + v[5] < v[1];
    sane.then(|| InpagePage {
        width_pt: v[0],
        height_pt: v[1],
        margin_left_pt: v[2],
        margin_top_pt: v[3],
        margin_right_pt: v[4],
        margin_bottom_pt: v[5],
    })
}

/// Extract the text of an InPage file.
pub fn extract_text(bytes: &[u8]) -> Result<InpageDoc, String> {
    if !is_inpage(bytes) {
        return Err("This is not an InPage document (missing OLE2 container signature).".into());
    }
    let legacy = extract_legacy(bytes);
    if !legacy.is_empty() {
        let buf = strip_pattern(bytes, &separator());
        return Ok(InpageDoc {
            paragraphs: legacy,
            legacy_format: true,
            styled: extract_formatted(&buf),
            page: page_setup(&buf),
        });
    }
    let modern = extract_utf16_runs(bytes);
    if modern.is_empty() {
        return Err(
            "No text could be recovered from this InPage file. Files saved by InPage 3.0 or \
             later use a format we can only read heuristically — try File ▸ Export as Unicode \
             text in InPage, then paste."
                .into(),
        );
    }
    Ok(InpageDoc { paragraphs: modern, legacy_format: false, styled: None, page: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reference sample (story.inp + its verified story.txt) is not ours to
    /// redistribute, so tests read it from `HARFSAZ_INP_FIXTURE_DIR` and skip
    /// when the variable is unset.
    fn fixture() -> Option<(Vec<u8>, String)> {
        let dir = std::env::var("HARFSAZ_INP_FIXTURE_DIR").ok()?;
        let inp = std::fs::read(format!("{dir}/story.inp")).ok()?;
        let txt = std::fs::read(format!("{dir}/story.txt")).ok()?;
        // story.txt is UTF-16LE with a BOM and CRLF line ends.
        let units: Vec<u16> = txt.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let s = String::from_utf16_lossy(&units);
        Some((inp, s.trim_start_matches('\u{FEFF}').replace("\r\n", "\n")))
    }

    #[test]
    fn matches_reference_output_exactly() {
        let Some((inp, expected)) = fixture() else {
            eprintln!("skipped: HARFSAZ_INP_FIXTURE_DIR not set");
            return;
        };
        let doc = extract_text(&inp).expect("extracts");
        assert!(doc.legacy_format);
        let mut ours = doc.paragraphs.join("\n");
        ours.push('\n'); // the reference terminates every record with a newline
        assert_eq!(ours, expected, "decoded text differs from the verified reference output");
    }

    /// One length-prefixed text record (paragraph) ending in 0x0D.
    fn rec(body: &[u8]) -> Vec<u8> {
        let mut r = ((body.len() + 1) as u32).to_le_bytes().to_vec();
        r.extend_from_slice(body);
        r.push(0x0D);
        r
    }

    #[test]
    fn reads_every_story_not_just_the_first_after_the_marker() {
        // Real InPage 2.x streams hold several stories back to back. Each one is
        // a run of records ended by a zero length plus one separator byte; the
        // list ends with FF FF FF FF. The main text is often NOT the first story
        // after the marker, so stopping/resyncing at a story end lost it.
        let mut buf = vec![0x0D, 0, 0, 0, 0, 0]; // end of a previous story = marker
        buf.extend(rec(&[])); // story A: one empty paragraph (header filler)
        buf.extend(rec(&[]));
        buf.extend([0, 0, 0, 0, 0]); // story end + separator
        buf.extend(rec(&[0x04, 0x27, 0x04, 0x28])); // story B: the body text "اب"
        buf.extend(rec(&[0x04, 0x28]));
        buf.extend([0, 0, 0, 0, 0]);
        buf.extend(rec(&[0x04, 0x27])); // story C: signature block
        buf.extend([0, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF]);

        let paragraphs = extract_legacy(&buf);
        assert_eq!(paragraphs, vec!["", "", "اب", "\u{0628}", "ا"]);
    }

    /// A character run: byte count, then `kind, len, tags` with size and weight.
    fn run(bytes: u32, size_pt: u32, weight: u16) -> Vec<u8> {
        let mut tags = vec![0x80, 0x00, 0, 0, 0, 0]; // 0x0080 = 0 (u32)
        tags.extend([0x00, 0x7F]);
        tags.extend((size_pt * 2000).to_le_bytes());
        tags.extend([0x02, 0x7F]);
        tags.extend(weight.to_le_bytes());
        let mut body = vec![0x01, 0x00];
        body.extend((tags.len() as u32).to_le_bytes());
        body.extend(tags);
        let mut r = bytes.to_le_bytes().to_vec();
        r.extend((body.len() as u32).to_le_bytes());
        r.extend(body);
        r
    }

    /// Filler, then a bold 30pt title story ("اب") and a regular 15pt story ("ا").
    fn formatted_doc(second_run_bytes: u32) -> Vec<u8> {
        let mut buf = vec![0x07; 40]; // stands in for the style/font tables
        buf.extend(rec(&[0x04, 0x27, 0x04, 0x28])); // 4 + 5 bytes
        buf.extend([0, 0, 0, 0, 0]);
        buf.extend(rec(&[0x04, 0x27])); // 4 + 3 bytes
        buf.extend([0, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF]);
        buf.extend(run(5, 30, 700));
        buf.extend(run(second_run_bytes, 15, 400));
        buf
    }

    #[test]
    fn reads_bold_and_size_from_the_character_runs() {
        let span = |text: &str, bold, size_pt| InpageSpan { text: text.into(), bold, size_pt };
        assert_eq!(
            extract_formatted(&formatted_doc(3)),
            Some(vec![vec![span("اب", true, 30.0)], vec![span("ا", false, 15.0)]])
        );
    }

    #[test]
    fn falls_back_to_plain_text_when_runs_do_not_cover_the_stories() {
        // Runs covering 5 + 2 bytes cannot belong to stories of 5 + 3 bytes.
        assert_eq!(extract_formatted(&formatted_doc(2)), None);
    }

    #[test]
    fn reads_page_size_and_margins() {
        let mut buf = vec![0u8; 8];
        for (k, inches) in [8.5f32, 14.0, 0.5, 4.0, 0.5, 0.5].iter().enumerate() {
            buf.extend([0x06 + k as u8, 0x01]);
            buf.extend(((inches * 144000.0) as u32).to_le_bytes());
        }
        buf.extend([0u8; 8]);
        assert_eq!(
            page_setup(&buf),
            Some(InpagePage {
                width_pt: 612.0,
                height_pt: 1008.0,
                margin_left_pt: 36.0,
                margin_top_pt: 288.0,
                margin_right_pt: 36.0,
                margin_bottom_pt: 36.0,
            })
        );
    }

    #[test]
    fn bari_ye_typed_inside_a_word_becomes_choti_ye() {
        // InPage typists use the bari-ye key mid-word; InPage draws it as a
        // joined ye, but Unicode ے cannot join forward and breaks the word.
        let fixed = |s: &str| {
            let mut chars: Vec<char> = s.chars().collect();
            fix_bari_ye(&mut chars);
            chars.into_iter().collect::<String>()
        };
        assert_eq!(fixed("فرےق مےں ےا"), "فریق میں یا");
        // Word-final bari ye is real and must stay — including before punctuation.
        assert_eq!(fixed("لےے ہے۔ کرلے، دے 2"), "لیے ہے۔ کرلے، دے 2");
        // The decoder applies it to every paragraph.
        let mut buf = vec![0x0D, 0, 0, 0, 0, 0];
        buf.extend(rec(&[0x04, 0xA5, 0x04, 0x81])); // ے then ا  → یا
        buf.extend([0, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF]);
        assert_eq!(extract_legacy(&buf), vec!["یا"]);
    }

    #[test]
    fn rejects_non_ole_input() {
        assert!(extract_text(b"%PDF-1.4 not inpage").is_err());
    }

    #[test]
    fn decodes_escaped_urdu_letters() {
        // 0x04 0x27 -> U+0627 (ا) per the table (0x27 maps to 0x27).
        assert_eq!(decode_record(&[0x04, 0x27, 0x20, 0x04, 0x28]), "ا \u{0628}");
    }

    #[test]
    fn separator_is_a_fat_sector_shape() {
        let s = separator();
        assert_eq!(s[0], 1);
        assert_eq!(s[4], 2);
        assert_eq!(s[0x50], 0xFE);
        assert_eq!(s[0x1FF], 0xFF);
        assert_eq!(s[1], 0);
    }
}
