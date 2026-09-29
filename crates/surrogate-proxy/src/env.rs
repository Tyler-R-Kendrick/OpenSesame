//! The child's environment: its trust, its proxy, and its surrogates.
//!
//! The run's CA reaches the child through the child's own trust variables and
//! nowhere else (ADR 0150 §6.1): OpenSSL and curl read `SSL_CERT_FILE` and
//! `CURL_CA_BUNDLE`, Node adds `NODE_EXTRA_CA_CERTS`, Python's `requests`
//! reads `REQUESTS_CA_BUNDLE`, git reads `GIT_SSL_CAINFO`. No system or user
//! trust store is written. `NO_PROXY` is set explicitly so an inherited one
//! naming a provider's host cannot route around the proxy; it lists loopback
//! only.
//!
//! `HTTPS_PROXY` is advisory. A process that ignores it holds only a dead
//! string, so confidentiality survives the bypass; detection does not, and
//! confining the network is the sandbox's job.

use std::ffi::OsString;
use std::path::Path;

/// The variables that point a child at the run's CA certificate file.
pub const TRUST_VARS: &[&str] = &[
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "GIT_SSL_CAINFO",
];

/// The variables that point a child at the run's proxy, both spellings.
pub const PROXY_VARS: &[&str] = &["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];

/// The variables that exempt hosts from the proxy, both spellings.
pub const NO_PROXY_VARS: &[&str] = &["NO_PROXY", "no_proxy"];

/// Loopback only: a child's local services are not the proxy's business.
pub const NO_PROXY_VALUE: &str = "localhost,127.0.0.1,::1";

/// Whether `name` is one the proxy sets itself, and so cannot carry a
/// surrogate.
#[must_use]
pub fn is_reserved(name: &str) -> bool {
    TRUST_VARS
        .iter()
        .chain(PROXY_VARS)
        .chain(NO_PROXY_VARS)
        .any(|reserved| reserved.eq_ignore_ascii_case(name))
}

/// Whether `name` is a portable environment variable name.
#[must_use]
pub fn is_valid_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// The trust and proxy variables for a child whose CA certificate the caller
/// wrote at `ca_file`.
pub(crate) fn trust_and_proxy(ca_file: &Path, proxy_url: &str) -> Vec<(String, OsString)> {
    let mut env = Vec::with_capacity(TRUST_VARS.len() + PROXY_VARS.len() + NO_PROXY_VARS.len());
    for name in TRUST_VARS {
        env.push(((*name).to_owned(), ca_file.as_os_str().to_owned()));
    }
    for name in PROXY_VARS {
        env.push(((*name).to_owned(), OsString::from(proxy_url)));
    }
    for name in NO_PROXY_VARS {
        env.push(((*name).to_owned(), OsString::from(NO_PROXY_VALUE)));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_trust_variable_points_at_the_callers_file() {
        let env = trust_and_proxy(Path::new("/run/ca.pem"), "http://u:p@127.0.0.1:1");
        for name in TRUST_VARS {
            assert!(
                env.contains(&((*name).to_owned(), OsString::from("/run/ca.pem"))),
                "{name}"
            );
        }
        for name in PROXY_VARS {
            assert!(env
                .iter()
                .any(|(n, v)| n == name && v == "http://u:p@127.0.0.1:1"));
        }
        assert!(env.contains(&("NO_PROXY".to_owned(), OsString::from(NO_PROXY_VALUE))));
    }

    #[test]
    fn a_surrogate_cannot_take_a_reserved_or_malformed_name() {
        assert!(is_reserved("https_proxy"));
        assert!(is_reserved("Ssl_Cert_File"));
        assert!(!is_reserved("GITHUB_TOKEN"));
        assert!(is_valid_name("GITHUB_TOKEN"));
        assert!(is_valid_name("_X1"));
        assert!(!is_valid_name("1X"));
        assert!(!is_valid_name("A-B"));
        assert!(!is_valid_name(""));
        assert!(!is_valid_name("A=B"));
    }
}
