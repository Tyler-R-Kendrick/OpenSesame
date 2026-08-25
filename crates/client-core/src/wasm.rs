//! Optional wasm-bindgen façade for browser/extension (feature `wasm-bindgen`).
use crate::{open, seal, DeviceKey, SyncCursor, SyncStore};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmDeviceKey {
    inner: DeviceKey,
}

#[wasm_bindgen]
impl WasmDeviceKey {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn generate() -> WasmDeviceKey {
        WasmDeviceKey {
            inner: DeviceKey::generate(),
        }
    }
}

#[wasm_bindgen]
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn wasm_seal(key: &WasmDeviceKey, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsValue> {
    seal(&key.inner, plaintext, aad).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn wasm_open(key: &WasmDeviceKey, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsValue> {
    open(&key.inner, sealed, aad).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub struct WasmSyncStore {
    inner: SyncStore,
}

#[wasm_bindgen]
impl WasmSyncStore {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(device_id: String) -> WasmSyncStore {
        WasmSyncStore {
            inner: SyncStore::new(device_id),
        }
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.inner.cursor.epoch
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn device_id(&self) -> String {
        self.inner.cursor.device_id.clone()
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn put_local(
        &mut self,
        key: &WasmDeviceKey,
        id: String,
        plaintext: &[u8],
    ) -> Result<JsValue, JsValue> {
        let blob = self
            .inner
            .put_local(&key.inner, id, plaintext)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        serde_wasm_bindgen::to_value(&blob).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn to_persisted_json(&self) -> Result<String, JsValue> {
        self.inner
            .to_persisted_json()
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn load_persisted_json(json: &str) -> Result<WasmSyncStore, JsValue> {
        let inner =
            SyncStore::from_persisted_json(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(WasmSyncStore { inner })
    }
}

#[wasm_bindgen]
#[must_use]
pub fn wit_package() -> String {
    crate::wit_contract::PACKAGE.to_string()
}

#[allow(dead_code)]
fn _cursor_shape(c: SyncCursor) -> SyncCursor {
    c
}
