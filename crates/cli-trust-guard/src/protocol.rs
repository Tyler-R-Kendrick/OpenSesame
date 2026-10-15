//! JSON-line RPC shared by the root trust guard and the daemon client.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_LINE_BYTES: usize = 4096;

pub const DEFAULT_SOCKET_PATH: &str = "/run/opensesame/cli-trust-guard.sock";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub v: u32,
    pub id: String,
    pub method: String,
    pub params: RequestParams,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestParams {
    #[serde(default)]
    pub spki_fingerprint: Option<String>,
    #[serde(default)]
    pub enrollment_epoch: Option<u64>,
    #[serde(default)]
    pub expected_epoch: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResultAbsent {
    pub status: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResultEnrolled {
    pub status: &'static str,
    pub spki_fingerprint: String,
    pub enrollment_epoch: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealResult {
    pub status: &'static str,
    pub enrollment_epoch: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorBody {
    pub code: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Response {
    pub v: u32,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

impl Response {
    pub fn open_absent(id: String) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id,
            ok: true,
            result: Some(serde_json::to_value(OpenResultAbsent { status: "absent" }).expect("json")),
            error: None,
        }
    }

    pub fn open_enrolled(id: String, fingerprint: String, epoch: u64) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id,
            ok: true,
            result: Some(
                serde_json::to_value(OpenResultEnrolled {
                    status: "enrolled",
                    spki_fingerprint: fingerprint,
                    enrollment_epoch: epoch,
                })
                .expect("json"),
            ),
            error: None,
        }
    }

    pub fn sealed(id: String, epoch: u64) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id,
            ok: true,
            result: Some(
                serde_json::to_value(SealResult {
                    status: "sealed",
                    enrollment_epoch: epoch,
                })
                .expect("json"),
            ),
            error: None,
        }
    }

    pub fn err(id: String, code: &'static str) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id,
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code: code.to_string(),
            }),
        }
    }
}
