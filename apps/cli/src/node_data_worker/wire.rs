//! Strict bounded commands. Their strings select DATA; they never manufacture a held lease.
use serde::{Deserialize, Serialize};

pub(super) const MAX_DATA_BYTES: usize = 16 * 1024 * 1024;
pub(super) const MAX_FRAME_BYTES: usize = 48 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub v: u8,
    pub op: Operation,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Scope {
    Vault,
    Origin,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Operation {
    Credential {},
    Body {
        tomb: String,
    },
    ReadGeneration {},
    PublishGeneration {
        expected: Option<String>,
        next: Option<String>,
    },
    PublishDevice {
        logical_key: String,
        expected: Option<String>,
        next: Option<String>,
    },
    ReadDevice {
        logical_key: String,
    },
    CaptureInventory {},
    ReadRetired {
        tomb: String,
    },
    InventoryTombs {},
    OriginNames {},
    InventoryClose {},
    Inventory {
        scope: Scope,
        maximum: usize,
    },
    Identity {
        scope: Scope,
    },
    BodyClose {},
    CredentialClose {},
    Validate {},
    Close {},
}
#[derive(Serialize)]
pub(super) struct Response {
    pub v: u8,
    pub reply: Reply,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum Reply {
    Ack,
    Bytes { base64: Option<String> },
    Names { values: Vec<String> },
    Inventory { entries: Vec<(String, bool)> },
    Identity { value: String },
}
