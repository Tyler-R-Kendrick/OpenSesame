//! Test builds only (cargo feature `upstream-override`): aim the broker's
//! upstream at a loopback server.
//!
//! The acceptance run and the process tests need the plugin to place a real
//! credential on a wire they can read, and the provider's real host is not
//! one. `OPENSESAME_SURROGATE_TEST_UPSTREAM=<host>=<ip>:<port>,ca=<file>`
//! makes the broker dial that loopback address whenever a request is admitted
//! for `<host>`, verifying the server certificate against the one PEM
//! certificate in `<file>` for the name `<host>`.
//!
//! What it does not move: admission, scope, the egress fence and the ledger
//! all still see the provider's own host (`api.vercel.com` is the host the
//! child connects to, the surrogate is bound to, and the request is cleared
//! for); only the address the finished request is dialled at changes. So a
//! test exercises every fence a real run does.
//!
//! Gated the way `plugin-settings`' `path-override` is: the module, the
//! variable's name and the code that reads it exist only in a build with the
//! feature. A shipped build contains none of them (`tests/shipped_build.rs`
//! searches its bytes for the name), so no environment can aim a person's
//! credential at a server of the caller's choosing. Even here the target must
//! be a loopback address and the host one the egress rules already name, and
//! every run says so on stderr.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use opensesame_invoke_through::{Invoker, TlsClientSpec};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName};

use crate::providers;

/// The variable that carries the override.
pub const ENV: &str = "OPENSESAME_SURROGATE_TEST_UPSTREAM";

/// A parsed override: the provider host, the loopback address that stands in
/// for it, and the certificate its server presents.
#[derive(Debug)]
pub struct Override {
    host: String,
    addr: SocketAddr,
    ca_pem: Vec<u8>,
}

/// Why an override was refused. Never names the file's contents.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum OverrideError {
    #[error("{ENV} must read <host>=<ip>:<port>,ca=<file>")]
    Malformed,
    #[error("{ENV} may only stand in for a host an egress rule already names")]
    UnknownHost,
    #[error("{ENV} may only aim at a loopback address")]
    NotLoopback,
    #[error("{ENV} names a certificate file that is not one PEM certificate")]
    Trust,
}

/// Parse the override and read its certificate.
///
/// # Errors
///
/// See [`OverrideError`].
pub fn parse(value: &str) -> Result<Override, OverrideError> {
    let (target, ca) = value.split_once(",ca=").ok_or(OverrideError::Malformed)?;
    let (host, addr) = target.split_once('=').ok_or(OverrideError::Malformed)?;
    let addr: SocketAddr = addr.parse().map_err(|_| OverrideError::Malformed)?;
    let host = host.to_ascii_lowercase();
    if !providers::rules()
        .iter()
        .any(|rule| rule.hosts.contains(&host.as_str()))
    {
        return Err(OverrideError::UnknownHost);
    }
    if !IpAddr::is_loopback(&addr.ip()) {
        return Err(OverrideError::NotLoopback);
    }
    let ca_pem = std::fs::read(ca).map_err(|_| OverrideError::Trust)?;
    Ok(Override { host, addr, ca_pem })
}

impl Override {
    /// The plugin's own rules over an https-only client that trusts the one
    /// certificate and dials only this host, at this address.
    ///
    /// # Errors
    ///
    /// `Trust` when the certificate does not parse or the host is not a name.
    pub fn invoker(&self) -> Result<Invoker, OverrideError> {
        let der = CertificateDer::from_pem_slice(&self.ca_pem).map_err(|_| OverrideError::Trust)?;
        let mut roots = rustls::RootCertStore::empty();
        roots.add(der).map_err(|_| OverrideError::Trust)?;
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|_| OverrideError::Trust)?
        .with_root_certificates(roots)
        .with_no_client_auth();
        let name = ServerName::try_from(self.host.clone()).map_err(|_| OverrideError::Trust)?;
        Ok(Invoker::with_tls(
            providers::rules(),
            &TlsClientSpec {
                config: Arc::new(config),
                server_name: Some(name),
                pinned: Some((self.host.clone(), vec![self.addr])),
            },
        ))
    }

    /// The line a run prints so nobody mistakes this build for a shipped one.
    #[must_use]
    pub fn banner(&self) -> String {
        format!(
            "opensesame-surrogate-proxy: TEST BUILD: requests admitted for {} are sent to {} \
             instead; this build must never hold a real credential",
            self.host, self.addr
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pem_file() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ca.pem");
        std::fs::write(&path, b"not a certificate").unwrap();
        let path = path.display().to_string();
        (dir, path)
    }

    #[test]
    fn only_a_loopback_address_for_a_host_a_rule_names_is_accepted() {
        let (_dir, ca) = pem_file();
        assert!(parse(&format!("api.vercel.com=127.0.0.1:8443,ca={ca}")).is_ok());
        assert!(parse(&format!("API.VERCEL.COM=[::1]:8443,ca={ca}")).is_ok());
        assert_eq!(
            parse(&format!("api.vercel.com=10.0.0.5:8443,ca={ca}")).unwrap_err(),
            OverrideError::NotLoopback
        );
        assert_eq!(
            parse(&format!("collect.evil.test=127.0.0.1:8443,ca={ca}")).unwrap_err(),
            OverrideError::UnknownHost
        );
    }

    #[test]
    fn a_malformed_value_is_refused() {
        for value in [
            "",
            "api.vercel.com",
            "api.vercel.com=127.0.0.1:8443",
            "api.vercel.com=localhost:8443,ca=/x",
            "=127.0.0.1:8443,ca=/x",
        ] {
            assert!(parse(value).is_err(), "{value}");
        }
    }

    #[test]
    fn a_certificate_file_that_is_not_pem_is_refused_when_the_invoker_is_built() {
        let (_dir, ca) = pem_file();
        let over = parse(&format!("api.vercel.com=127.0.0.1:8443,ca={ca}")).unwrap();
        assert_eq!(over.invoker().err(), Some(OverrideError::Trust));
        assert!(over.banner().contains("TEST BUILD"));
    }
}
