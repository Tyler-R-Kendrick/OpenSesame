//! The typed `tool_call.args` of each verb.
//!
//! Every struct is `deny_unknown_fields`, so a transform that adds a member
//! the verb does not take is refused rather than silently dropped. They carry
//! URLs, selectors and *references* — never a value (ADR 0076 §1). Which of
//! their members an interceptor may not rewrite is `authority`'s to say.

use opensesame_ceremony::Slot;
use opensesame_session_observe::MaskManifest;
use serde::{Deserialize, Serialize};

use crate::tools::CredentialRef;

/// `navigate`.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UrlArgs {
    pub url: String,
}

/// `wait_for`, `submit`.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SelectorArgs {
    pub selector: String,
}

/// `fill_credential`, `assert_present`: a reference and a place, never a value.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PlacedRefArgs {
    pub reference: CredentialRef,
    pub selector: String,
}

/// `verify_login`.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RefArgs {
    pub reference: CredentialRef,
}

/// `read_dom_redacted`, `outstanding`: `{}`.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NoArgs {}

/// `screenshot_redacted`.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MaskArgs {
    pub mask: MaskManifest,
}

/// `capture_credential`.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CaptureFieldArgs {
    pub slot: Slot,
    pub selector: String,
}

/// `capture_download`.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CaptureDownloadArgs {
    pub slot: Slot,
    pub content_type: String,
}
