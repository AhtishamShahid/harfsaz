//! Harfsaz — Tauri application entry. Wires the Nastaliq shaper and the Claude AI
//! bridge as invokable commands the React frontend can call.

mod account;
mod ai;
mod inpage;
mod printing;
mod pdf;
mod settings;
mod shaping;

use ai::{AiRequest, AiResponse};
use shaping::ShapedRun;

/// Shape a run of (Urdu) text into positioned glyphs.
///
/// `font_bytes` is the raw font file sent from the frontend as a byte array.
#[tauri::command]
fn shape_text(text: String, font_bytes: Vec<u8>, font_size: f32) -> Result<ShapedRun, String> {
    shaping::shape_text(&text, &font_bytes, font_size)
}

/// Make a font available to the shaper. The body is the raw font file and the
/// `font-key` header names it; later calls refer to the font by that key, so
/// the file crosses the bridge once instead of with every layout.
///
/// Async, so parsing the font and building its first shape plan (the slow
/// part for Gulzar) runs off the main thread instead of stalling the window.
#[tauri::command]
async fn register_font(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let key = request
        .headers()
        .get("font-key")
        .and_then(|v| v.to_str().ok())
        .ok_or("register_font needs a font-key header")?
        .to_string();
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        // The bridge may fall back to JSON (an array of byte values).
        tauri::ipc::InvokeBody::Json(value) => serde_json::from_value(value.clone()).map_err(|e| e.to_string())?,
    };
    tauri::async_runtime::spawn_blocking(move || shaping::register_font(&key, bytes))
        .await
        .map_err(|e| e.to_string())?
}

/// A text frame to lay out, as the frontend describes it.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameSpec {
    font_key: String,
    text: String,
    font_size: f32,
    width: f32,
    align: Option<String>,
    line_height: Option<f32>,
}

/// Layouts run on the blocking pool, at most one per core at a time, so a
/// document's worth of preview frames neither blocks the UI thread nor starts
/// hundreds of threads.
fn layout_permits() -> &'static tokio::sync::Semaphore {
    static PERMITS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    PERMITS.get_or_init(|| {
        tokio::sync::Semaphore::new(std::thread::available_parallelism().map_or(4, |n| n.get()))
    })
}

/// Lay out a text frame for print preview: an SVG path per line.
#[tauri::command]
async fn layout_preview(frame: FrameSpec) -> Result<shaping::PreviewLayout, String> {
    let _permit = layout_permits().acquire().await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let font = shaping::font(&frame.font_key)?;
        // "justify" triggers kashida elongation; other values just set line origin.
        let align = frame.align.as_deref().unwrap_or("right");
        let layout = shaping::layout_frame(&font, &frame.text, frame.font_size, frame.width, align, frame.line_height);
        Ok(shaping::preview_paths(&font, &layout))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Render the document to a vector PDF in the temp directory; returns its path.
#[tauri::command]
async fn render_pdf(document: pdf::PrintDoc) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = pdf::render(&document)?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let path = std::env::temp_dir().join(format!("harfsaz-vector-{stamp}.pdf"));
        std::fs::write(&path, bytes).map_err(|e| format!("Could not write the PDF: {e}"))?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run an AI task (write / proofread / translate / layout) via Claude.
#[tauri::command]
async fn ai_task(req: AiRequest) -> Result<AiResponse, String> {
    ai::run_task(req).await
}

/// Multi-turn chat with conversation context (the AI panel's chat thread).
#[tauri::command]
async fn ai_chat(
    messages: Vec<ai::ChatMessage>,
    system: String,
) -> Result<ai::AiResponse, String> {
    ai::chat(messages, system).await
}

/// Add diacritics/harakat (تشكيل) to RTL text for the given base language.
#[tauri::command]
async fn ai_add_diacritics(
    text: String,
    lang: String,
    model: Option<String>,
) -> Result<ai::AiResponse, String> {
    ai::add_diacritics(text, lang, model).await
}

/// Transform a selected snippet (rephrase/grammar/caption/define/expand/custom…)
/// for the selection AI menu.
#[tauri::command]
async fn ai_transform(
    text: String,
    action: String,
    instruction: Option<String>,
    lang: Option<String>,
    model: Option<String>,
) -> Result<ai::AiResponse, String> {
    ai::transform(text, action, instruction, lang, model).await
}

/// Proofread Urdu text and return span-level corrections for inline,
/// non-destructive highlighting (accept/reject per suggestion).
#[tauri::command]
async fn ai_proofread_inline(
    text: String,
    model: Option<String>,
) -> Result<ai::ProofreadResult, String> {
    ai::proofread_inline(text, model).await
}

/// OCR an attached image/PDF (handwritten or printed) into editable text.
///
/// `data` is the file as base64 (a data URL is accepted too), `media_type` its
/// MIME type. `mode` is "plain" or "layout"; `diacritics` adds aerab.
#[tauri::command]
async fn ai_ocr(
    data: String,
    media_type: String,
    lang: String,
    mode: String,
    diacritics: bool,
    instruction: Option<String>,
    model: Option<String>,
) -> Result<ai::OcrResult, String> {
    ai::ocr(data, media_type, lang, mode, diacritics, instruction, model).await
}

/// Import an InPage (.inp) document: returns its paragraphs as Unicode text.
///
/// The file is read here rather than via the fs plugin so the OLE container
/// never has to cross the IPC bridge as a JSON byte array.
#[tauri::command]
fn import_inpage(path: String) -> Result<inpage::InpageDoc, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read file: {e}"))?;
    inpage::extract_text(&bytes)
}

/// List installed system printers (CUPS via lpstat).
#[tauri::command]
fn list_printers() -> Result<Vec<printing::PrinterInfo>, String> {
    printing::list_printers()
}

/// Print a file to a chosen printer via the OS print system (lp).
#[tauri::command]
fn print_file(
    file_path: String,
    printer: Option<String>,
    copies: u32,
    range: Option<String>,
    grayscale: bool,
) -> Result<String, String> {
    printing::print_file(file_path, printer, copies, range, grayscale)
}

/// Lightweight health check the UI can call on startup to confirm the active
/// AI provider is configured, without leaking any key.
#[tauri::command]
fn ai_key_present() -> bool {
    ai::is_configured()
}

/// Which AI provider is active (Claude / DeepSeek / Mistral / OpenAI / Claude CLI).
#[tauri::command]
fn ai_provider() -> String {
    ai::provider_name()
}

/// Read current AI settings (provider + model + whether a key is saved — never
/// returns the raw key).
#[tauri::command]
fn get_ai_settings() -> settings::AiSettingsView {
    settings::view()
}

/// Save AI settings (provider, api key, model) to local config. Takes effect
/// immediately (no restart). If `api_key` is blank the previously-saved key is
/// preserved, so the UI never has to read a key back to re-save the other
/// fields. Use `clear_ai_key` to actually remove a stored key.
#[tauri::command]
fn set_ai_settings(provider: String, api_key: String, model: String) -> Result<(), String> {
    let key = if api_key.trim().is_empty() {
        settings::load().api_key // keep existing
    } else {
        api_key
    };
    settings::save(&settings::AiSettings { provider, api_key: key, model })
}

/// Forget the stored API key (keeps provider/model). The UI's "Remove key"
/// action — previously unreachable, since saving a blank key preserves it.
#[tauri::command]
fn clear_ai_key() -> Result<(), String> {
    let current = settings::load();
    settings::save(&settings::AiSettings {
        provider: current.provider,
        api_key: String::new(),
        model: current.model,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            account::desktop_account,
            account::desktop_ai,
            shape_text,
            register_font,
            layout_preview,
            render_pdf,
            ai_task,
            ai_chat,
            ai_proofread_inline,
            ai_add_diacritics,
            ai_transform,
            ai_ocr,
            import_inpage,
            list_printers,
            print_file,
            ai_key_present,
            ai_provider,
            get_ai_settings,
            set_ai_settings,
            clear_ai_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running Harfsaz");
}
