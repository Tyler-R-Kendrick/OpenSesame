//! Non-2xx bodies as named errors.

use crate::error::Error;

/// Turn a non-2xx body into a *named* error. Bitwarden signals a wrong master
/// password as `invalid_grant`, and a 2FA challenge as a 400 carrying
/// `TwoFactorProviders`; both deserve their own variant, not "HTTP 400".
pub(super) fn classify_error(path: &str, status: u16, body: &[u8]) -> Error {
    let parsed: Option<serde_json::Value> = serde_json::from_slice(body).ok();
    let field = |value: &serde_json::Value, key: &str| -> Option<String> {
        let upper = uppercase_first(key);
        value
            .get(key)
            .or_else(|| value.get(&upper))
            .and_then(|v| v.as_str())
            .map(str::to_owned)
    };
    if let Some(value) = parsed.as_ref() {
        if let Some(providers) = value
            .get("TwoFactorProviders")
            .or_else(|| value.get("twoFactorProviders"))
        {
            return Error::TwoFactorRequired {
                providers: provider_numbers(providers),
            };
        }
        let code = field(value, "error");
        let description = field(value, "error_description");
        if description
            .as_deref()
            .is_some_and(|d| d.to_ascii_lowercase().contains("new device verification"))
        {
            return Error::NewDeviceVerification;
        }
        let description = description.or_else(|| field(value, "message")).or_else(|| {
            value
                .get("ErrorModel")
                .or_else(|| value.get("errorModel"))
                .and_then(|m| m.get("Message").or_else(|| m.get("message")))
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        });
        if code.as_deref() == Some("invalid_grant") || status == 401 {
            return Error::Authentication(
                description.unwrap_or_else(|| "invalid username or master password".into()),
            );
        }
        if let Some(message) = description.or(code) {
            return Error::Api {
                path: path.to_owned(),
                status,
                message,
            };
        }
    }
    Error::Api {
        path: path.to_owned(),
        status,
        message: "no error detail in response".into(),
    }
}

/// Provider numbers, whether a server lists them as numbers or as strings.
fn provider_numbers(listed: &serde_json::Value) -> Vec<u32> {
    listed
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            p.as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .or_else(|| p.as_str().and_then(|s| s.parse().ok()))
        })
        .collect()
}

fn uppercase_first(key: &str) -> String {
    let mut chars = key.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}
