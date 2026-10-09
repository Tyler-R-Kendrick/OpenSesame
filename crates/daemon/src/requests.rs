//! Request bodies of the operator routes `lib.rs` serves.

use serde::Deserialize;

#[derive(Deserialize)]
pub(crate) struct MintCapReq {
    pub(crate) audience: String,
    #[serde(default)]
    pub(crate) scopes: Vec<String>,
    /// Bind the capability to this host session when more than one exists.
    #[serde(default)]
    pub(crate) session_id: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct ApproveDeviceReq {
    pub(crate) user_code: String,
    #[serde(default)]
    pub(crate) principal: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct ApproveClaimReq {
    pub(crate) claim_id: String,
    #[serde(default)]
    pub(crate) access_token: Option<String>,
    #[serde(default)]
    pub(crate) claim_token: Option<String>,
    /// User code shown by the device — required by the Identity API fallback.
    #[serde(default)]
    pub(crate) user_code: Option<String>,
}
