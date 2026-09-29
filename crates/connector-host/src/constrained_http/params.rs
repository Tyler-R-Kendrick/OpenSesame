//! The L2 request as a caller describes it: the URL, method, headers and body
//! it would send, and the connection it names. Parsed strictly: a key this
//! path does not know is refused rather than ignored, and credential material
//! is never a parameter at all.
//!
//! `header_name`/`header_value` and `body_field`/`body_value` are the shape
//! the placeholder simulation took, kept so a caller written against it still
//! describes the same request. They are folded into `headers` and `body`
//! before admission; nothing downstream treats them specially.

use serde_json::{Map, Value};

use crate::{HostError, InvokeRequest};

/// Every parameter an L2 request may carry.
const KNOWN: &[&str] = &[
    "url",
    "method",
    "headers",
    "body",
    "connection_ref",
    "placeholder",
    "header_name",
    "header_value",
    "body_field",
    "body_value",
];

/// One L2 request, as the caller would have sent it.
pub(super) struct L2Call {
    pub(super) url: String,
    pub(super) method: String,
    pub(super) headers: Vec<(String, String)>,
    pub(super) body: Vec<u8>,
    pub(super) connection_ref: String,
    /// The placeholder the caller says it is using. Optional: the request
    /// carries it where it belongs, and admission finds it there.
    pub(super) placeholder: Option<String>,
}

impl L2Call {
    pub(super) fn parse(req: &InvokeRequest) -> Result<Self, HostError> {
        let params = req
            .parameters
            .as_object()
            .ok_or_else(|| invalid("parameters must be an object"))?;
        // Credential material is never a request parameter. A caller that
        // names it is either confused or trying to have the host send a string
        // of its own choosing as the connection's credential.
        if params.contains_key("material") {
            return Err(HostError::MaterializeDenied);
        }
        // The key itself is not echoed: it is caller text, and could be the
        // placeholder.
        if params.keys().any(|key| !KNOWN.contains(&key.as_str())) {
            return Err(invalid("unknown parameter"));
        }
        let url = string(params, "url")?.ok_or_else(|| invalid("url required for L2"))?;
        let method = string(params, "method")?.unwrap_or_else(|| "GET".into());
        let mut headers = header_pairs(params)?;
        if let Some(pair) = paired(params, "header_name", "header_value")? {
            headers.push(pair);
        }
        Ok(Self {
            url,
            method,
            headers,
            body: body(params)?,
            connection_ref: connection_ref(params, &req.connection_ref)?,
            placeholder: string(params, "placeholder")?,
        })
    }
}

fn invalid(what: &str) -> HostError {
    HostError::Connector(format!("constrained HTTP: {what}"))
}

fn string(params: &Map<String, Value>, key: &str) -> Result<Option<String>, HostError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(invalid(&format!("{key} must be a string"))),
    }
}

/// Two parameters that mean something only together.
fn paired(
    params: &Map<String, Value>,
    first: &str,
    second: &str,
) -> Result<Option<(String, String)>, HostError> {
    match (string(params, first)?, string(params, second)?) {
        (Some(a), Some(b)) => Ok(Some((a, b))),
        (None, None) => Ok(None),
        _ => Err(invalid(&format!("{first} and {second} go together"))),
    }
}

/// `headers` is a list of `[name, value]` pairs rather than an object, so a
/// repeated header reaches admission as the repeat it is.
fn header_pairs(params: &Map<String, Value>) -> Result<Vec<(String, String)>, HostError> {
    let Some(value) = params.get("headers") else {
        return Ok(Vec::new());
    };
    let shape = || invalid("headers must be [name, value] pairs");
    value
        .as_array()
        .ok_or_else(shape)?
        .iter()
        .map(|pair| match pair.as_array().map(Vec::as_slice) {
            Some([Value::String(name), Value::String(value)]) => Ok((name.clone(), value.clone())),
            _ => Err(shape()),
        })
        .collect()
}

fn body(params: &Map<String, Value>) -> Result<Vec<u8>, HostError> {
    match (
        string(params, "body")?,
        paired(params, "body_field", "body_value")?,
    ) {
        (Some(_), Some(_)) => Err(invalid("body and body_field are exclusive")),
        (Some(raw), None) => Ok(raw.into_bytes()),
        (None, Some((field, value))) => {
            let mut object = Map::new();
            object.insert(field, Value::String(value));
            serde_json::to_vec(&Value::Object(object)).map_err(|_| invalid("body_field"))
        }
        (None, None) => Ok(Vec::new()),
    }
}

/// The connection the request names: the parameter, which the intent's
/// digest freezes, or the request's own reference. Two that disagree are
/// refused rather than one silently preferred.
fn connection_ref(params: &Map<String, Value>, on_request: &str) -> Result<String, HostError> {
    match (string(params, "connection_ref")?, on_request.is_empty()) {
        (Some(named), true) => Ok(named),
        (Some(named), false) if named == on_request => Ok(named),
        (Some(_), false) => Err(invalid("connection_ref disagrees with the request")),
        (None, false) => Ok(on_request.to_string()),
        (None, true) => Err(invalid("connection_ref required for L2")),
    }
}
