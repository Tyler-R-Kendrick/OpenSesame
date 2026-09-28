//! The two service bases a Bitwarden server exposes, validated and pinned.

use url::Url;

use crate::error::{Error, Result};

/// The two service bases, already validated and pinned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoints {
    api: Url,
    identity: Url,
}

impl Endpoints {
    /// Derive both bases from one configured server URL.
    ///
    /// `https://vault.bitwarden.com` (or `.eu`, or a bare `bitwarden.com`)
    /// expands to the cloud's split hosts; everything else is treated as a
    /// self-hosted/vaultwarden origin with `/api` and `/identity` mounted
    /// under it, which is exactly what vaultwarden serves.
    ///
    /// # Errors
    ///
    /// Returns [`Error::InvalidServerUrl`] when the URL is malformed, lacks a
    /// usable host, or uses a forbidden scheme.
    pub fn from_server_url(raw: &str) -> Result<Self> {
        let base = parse_base(raw)?;
        if let Some(suffix) = cloud_suffix(&base) {
            return Self::split(
                &format!("https://api.{suffix}"),
                &format!("https://identity.{suffix}"),
            );
        }
        let trimmed = base.as_str().trim_end_matches('/').to_owned();
        Self::split(&format!("{trimmed}/api"), &format!("{trimmed}/identity"))
    }

    /// Explicit split bases, for a deployment that mounts them elsewhere.
    ///
    /// # Errors
    ///
    /// Returns [`Error::InvalidServerUrl`] when either URL is malformed,
    /// lacks a usable host, or uses a forbidden scheme.
    pub fn split(api: &str, identity: &str) -> Result<Self> {
        Ok(Self {
            api: parse_base(api)?,
            identity: parse_base(identity)?,
        })
    }

    #[must_use]
    pub fn api_base(&self) -> &Url {
        &self.api
    }

    #[must_use]
    pub fn identity_base(&self) -> &Url {
        &self.identity
    }

    /// The hosts this client is pinned to. Any other host is out of bounds.
    #[must_use]
    pub fn pinned_hosts(&self) -> Vec<String> {
        let mut hosts = vec![host_of(&self.api), host_of(&self.identity)];
        hosts.dedup();
        hosts
    }

    pub(super) fn api_url(&self, path: &str) -> Result<Url> {
        join(&self.api, path)
    }

    pub(super) fn identity_url(&self, path: &str) -> Result<Url> {
        join(&self.identity, path)
    }
}

fn cloud_suffix(base: &Url) -> Option<&'static str> {
    let host = base.host_str()?.to_ascii_lowercase();
    match host.as_str() {
        "bitwarden.com" | "vault.bitwarden.com" => Some("bitwarden.com"),
        "bitwarden.eu" | "vault.bitwarden.eu" => Some("bitwarden.eu"),
        _ => None,
    }
}

pub(super) fn host_of(url: &Url) -> String {
    url.host_str().unwrap_or_default().to_ascii_lowercase()
}

/// https, or loopback http so offline tests can run against a stub. No
/// embedded credentials, ever — same rule as `provider-openbao`.
/// A download link: the same rules as a server URL (https, or loopback
/// http; no embedded credentials).
pub(super) fn parse_download(raw: &str) -> Result<Url> {
    parse_base(raw)
}

fn parse_base(raw: &str) -> Result<Url> {
    let url = Url::parse(raw.trim()).map_err(|e| Error::InvalidServerUrl(e.to_string()))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Error::InvalidServerUrl(
            "server URL must not embed credentials".into(),
        ));
    }
    if url.host_str().is_none() {
        return Err(Error::InvalidServerUrl("server URL has no host".into()));
    }
    let loopback = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    match url.scheme() {
        "https" => Ok(url),
        "http" if loopback => Ok(url),
        _ => Err(Error::InvalidServerUrl(
            "server URL must be https (loopback http is allowed for tests)".into(),
        )),
    }
}

fn join(base: &Url, path: &str) -> Result<Url> {
    let joined = format!("{}{}", base.as_str().trim_end_matches('/'), path);
    Url::parse(&joined).map_err(|e| Error::InvalidServerUrl(e.to_string()))
}
