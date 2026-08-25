//! The promote handshake's wire contract (ADR 0048 D4).
//!
//! `POST /v1/promote` turns one discovery offer into a broker connection under
//! an explicit acquisition mode. The request shape lives here, next to the C1
//! offer model it references, so the parsing boundary is fuzzable without
//! pulling the daemon in: `deny_unknown_fields` is part of the contract — a
//! field this version does not know is a refusal, never a silent drop.

use serde::{Deserialize, Serialize};

use crate::{CapabilityClass, ProbeSource};

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromoteRequest {
    pub provider_id: String,
    pub source: ProbeSource,
    pub mode: PromotionMode,
    pub confirm: bool,
    #[serde(default)]
    pub wipe_after_import: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromotionMode {
    Mint,
    InvokeThrough,
    Import,
}

impl PromotionMode {
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            PromotionMode::Mint => "mint",
            PromotionMode::InvokeThrough => "invoke_through",
            PromotionMode::Import => "import",
        }
    }

    #[must_use]
    pub fn capability(self) -> CapabilityClass {
        match self {
            PromotionMode::Mint => CapabilityClass::Mintable,
            PromotionMode::InvokeThrough => CapabilityClass::InvokeThrough,
            PromotionMode::Import => CapabilityClass::Importable,
        }
    }
}
