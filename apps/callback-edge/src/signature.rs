use axum::http::{HeaderMap, Method, Uri};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub const MAX_BODY: usize = 256 * 1024;
pub struct VerifiedDelivery {
    pub connection: String,
    pub route: String,
    pub delivery: String,
    pub request_digest: String,
}

fn segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn header<'a>(headers: &'a HeaderMap, name: &str, limit: usize) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() || value.len() > limit {
        return None;
    }
    Some(value)
}

pub fn verify(
    master: &[u8; 32],
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: &[u8],
    now: i64,
) -> Option<VerifiedDelivery> {
    if method != Method::POST
        || uri.query().is_some()
        || body.len() > MAX_BODY
        || headers.len() > 32
        || headers
            .iter()
            .map(|(k, v)| k.as_str().len() + v.as_bytes().len())
            .sum::<usize>()
            > 8192
    {
        return None;
    }
    let path = uri.path();
    let mut parts = path.strip_prefix("/webhooks/")?.split('/');
    let connection = parts.next()?;
    let route = parts.next()?;
    if parts.next().is_some() || !segment(connection) || !segment(route) {
        return None;
    }
    let timestamp = header(headers, "x-opensesame-timestamp", 20)?;
    let delivery = header(headers, "x-opensesame-delivery-id", 128)?;
    if !segment(delivery) || !timestamp.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let time = timestamp.parse::<i64>().ok()?;
    if time.to_string() != timestamp || now.checked_sub(time)?.unsigned_abs() > 300 {
        return None;
    }
    let provided = URL_SAFE_NO_PAD
        .decode(header(headers, "x-opensesame-signature", 64)?.strip_prefix("v1=")?)
        .ok()?;
    let body_digest = hex::encode(Sha256::digest(body));
    let canonical = format!("v1\n{method}\n{path}\n{timestamp}\n{delivery}\n{body_digest}");
    let key = connection_key(master, connection)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key[..]).ok()?;
    mac.update(canonical.as_bytes());
    mac.verify_slice(&provided).ok()?;
    // Retry timestamps can change; destination, verb, and body cannot.
    let digest = hex::encode(Sha256::digest(format!(
        "v1\n{method}\n{path}\n{body_digest}"
    )));
    Some(VerifiedDelivery {
        connection: connection.into(),
        route: route.into(),
        delivery: delivery.into(),
        request_digest: digest,
    })
}

pub fn registered_route(value: &str) -> bool {
    let mut parts = value.split('/');
    parts.next().is_some_and(segment) && parts.next().is_some_and(segment) && parts.next().is_none()
}

fn connection_key(master: &[u8; 32], connection: &str) -> Option<Zeroizing<[u8; 32]>> {
    let mut key = Zeroizing::new([0; 32]);
    Hkdf::<Sha256>::new(Some(b"opensesame/callback-edge/key/v1"), master)
        .expand(connection.as_bytes(), &mut key[..])
        .ok()?;
    Some(key)
}

#[cfg(test)]
pub fn sign(
    master: &[u8; 32],
    path: &str,
    timestamp: i64,
    delivery: &str,
    body: &[u8],
) -> HeaderMap {
    let connection = path
        .strip_prefix("/webhooks/")
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    let mut mac =
        Hmac::<Sha256>::new_from_slice(&connection_key(master, connection).unwrap()[..]).unwrap();
    mac.update(
        format!(
            "v1\nPOST\n{path}\n{timestamp}\n{delivery}\n{}",
            hex::encode(Sha256::digest(body))
        )
        .as_bytes(),
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-opensesame-timestamp",
        timestamp.to_string().parse().unwrap(),
    );
    headers.insert("x-opensesame-delivery-id", delivery.parse().unwrap());
    headers.insert(
        "x-opensesame-signature",
        format!("v1={}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
            .parse()
            .unwrap(),
    );
    headers
}
