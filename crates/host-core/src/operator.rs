use axum::http::{header, HeaderMap};

/// Length-hiding comparison of two secrets (SHA-256 then XOR-fold).
#[must_use]
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    use sha2::{Digest, Sha256};
    let ha = Sha256::digest(a.as_bytes());
    let hb = Sha256::digest(b.as_bytes());
    ha.iter().zip(hb.iter()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// `X-OpenSesame-Operator: <token>` or `Authorization: Bearer operator:<token>`.
pub fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    // Operator credentials are never browser credentials, even at a paired origin.
    if headers.contains_key(header::ORIGIN) {
        return None;
    }
    let from_header = headers
        .get("x-opensesame-operator")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let from_bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|a| {
            a.strip_prefix("Bearer operator:")
                .or_else(|| a.strip_prefix("bearer operator:"))
                .map(str::to_string)
        });
    from_header.or(from_bearer)
}

/// Why a request is not operator-authorized.
#[derive(Debug, PartialEq, Eq)]
pub enum OperatorDenial {
    /// No token configured — the route denies rather than opening up.
    Unconfigured,
    Unauthorized,
}

///
/// # Errors
///
/// Returns `Unconfigured` for an empty expected token and `Unauthorized`
/// when no constant-time token match exists.
pub fn check(expected: &str, headers: &HeaderMap) -> Result<(), OperatorDenial> {
    if expected.is_empty() {
        return Err(OperatorDenial::Unconfigured);
    }
    match token_from_headers(headers) {
        Some(t) if constant_time_eq(&t, expected) => Ok(()),
        _ => Err(OperatorDenial::Unauthorized),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn an_unset_token_denies_instead_of_allowing() {
        let mut headers = HeaderMap::new();
        headers.insert("x-opensesame-operator", HeaderValue::from_static(""));
        assert_eq!(check("", &headers), Err(OperatorDenial::Unconfigured));
    }

    #[test]
    fn header_and_bearer_forms_both_authorize() {
        let mut headers = HeaderMap::new();
        headers.insert("x-opensesame-operator", HeaderValue::from_static("s3cret"));
        assert!(check("s3cret", &headers).is_ok());

        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer operator:s3cret"),
        );
        assert!(check("s3cret", &headers).is_ok());
    }

    #[test]
    fn a_wrong_or_missing_token_is_unauthorized() {
        assert_eq!(
            check("s3cret", &HeaderMap::new()),
            Err(OperatorDenial::Unauthorized)
        );
        let mut headers = HeaderMap::new();
        headers.insert("x-opensesame-operator", HeaderValue::from_static("nope"));
        assert_eq!(check("s3cret", &headers), Err(OperatorDenial::Unauthorized));
    }

    #[test]
    fn comparison_is_length_checked() {
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(constant_time_eq("abc", "abc"));
    }

    #[test]
    fn browser_origins_cannot_present_operator_authority() {
        for origin in ["https://paired.example", "null", "http://localhost:5180"] {
            let mut headers = HeaderMap::new();
            headers.insert("x-opensesame-operator", HeaderValue::from_static("s3cret"));
            headers.insert(header::ORIGIN, origin.parse().unwrap());
            assert_eq!(check("s3cret", &headers), Err(OperatorDenial::Unauthorized));
        }
    }
}
