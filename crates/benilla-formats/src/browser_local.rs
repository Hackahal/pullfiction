//! Browser-local file transport, shared by every Chain and the asynchronous asset reader.
//! No rendering, UI or replay policy belongs at this boundary.

use std::io;

use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

#[wasm_bindgen(inline_js = "
export function localFilesActive() { return globalThis.__pullfiction_local_files !== undefined; }
export function localFileReadSync(name) { return globalThis.__pullfiction_local_files.readSync(name); }
export function localFileContainsSync(name) { return globalThis.__pullfiction_local_files.containsSync(name); }
export function localFileListSync() { return globalThis.__pullfiction_local_files.listSync(); }
export function localFileRead(name) { const files = globalThis.__pullfiction_local_files; return files.readStreaming ? files.readStreaming(name) : files.read(name); }
")]
extern "C" {
    #[wasm_bindgen(js_name = localFilesActive)]
    pub fn active() -> bool;
    #[wasm_bindgen(catch, js_name = localFileReadSync)]
    fn read_sync_js(name: &str) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = localFileContainsSync)]
    fn contains_sync_js(name: &str) -> Result<bool, JsValue>;
    #[wasm_bindgen(catch, js_name = localFileListSync)]
    fn list_sync_js() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = localFileRead)]
    pub fn read_async(name: &str) -> Result<js_sys::Promise, JsValue>;
}

pub fn error(value: JsValue) -> io::Error {
    let name = js_sys::Reflect::get(&value, &"name".into())
        .ok()
        .and_then(|v| v.as_string());
    let message = js_sys::Reflect::get(&value, &"message".into())
        .ok()
        .and_then(|v| v.as_string())
        .unwrap_or_else(|| format!("{value:?}"));
    let kind = match name.as_deref() {
        Some("NotFoundError") => io::ErrorKind::NotFound,
        Some("InvalidStateError") => io::ErrorKind::WouldBlock,
        Some("AbortError") => io::ErrorKind::Interrupted,
        _ => io::ErrorKind::Other,
    };
    io::Error::new(kind, message)
}

pub fn bytes(value: JsValue) -> io::Result<Vec<u8>> {
    value
        .dyn_into::<js_sys::Uint8Array>()
        .map(|bytes| bytes.to_vec())
        .map_err(|_| io::Error::other("Local client provider did not return Uint8Array"))
}

pub fn read_sync(name: &str) -> io::Result<Vec<u8>> {
    bytes(read_sync_js(name).map_err(error)?)
}

pub fn contains_sync(name: &str) -> io::Result<bool> {
    contains_sync_js(name).map_err(error)
}

pub fn list_sync() -> io::Result<Vec<String>> {
    let value = list_sync_js().map_err(error)?;
    let array = value
        .dyn_into::<js_sys::Array>()
        .map_err(|_| io::Error::other("Local client provider did not return a name list"))?;
    array
        .iter()
        .map(|entry| {
            entry
                .as_string()
                .ok_or_else(|| io::Error::other("Invalid local client name"))
        })
        .collect()
}
