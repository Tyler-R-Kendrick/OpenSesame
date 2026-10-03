//! `opensesame plugins pair | unpair`: let one browser origin reach this
//! daemon's plugin settings, and take that back (ADR 0150 §7).
//!
//! Pairing writes a one-time code's SHA-256 beside `plugins.json` and prints
//! the code once, wrapped with the daemon's address as a pairing code the
//! page reads (`spec/conformance/plugin-pairing.json`). The page trades it,
//! once, within five minutes, from exactly `--origin`, for a bearer that
//! opens `/v1/plugins` and nothing else. Nothing here talks to the daemon:
//! it reads the same file on every request, so pairing and unpairing take
//! effect whether or not it is running.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::Path;

use opensesame_plugin_settings::{
    format_pairing_code, is_pairable_origin, unix_now, PairingError, PluginPairings,
};
use serde_json::{json, Value};

/// Where a page on this machine reaches the daemon.
pub(crate) const DEFAULT_DAEMON_URL: &str = "http://127.0.0.1:18790";

/// Tailscale's CGNAT range, `100.64.0.0/10`.
fn is_tailnet_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 100 && (64..128).contains(&b)
}

/// Tailscale's ULA range, `fd7a:115c:a1e0::/48`.
fn is_tailnet_v6(ip: Ipv6Addr) -> bool {
    let [a, b, c, ..] = ip.segments();
    a == 0xfd7a && b == 0x115c && c == 0xa1e0
}

/// The daemon address a page will accept: a tailnet name or address, or
/// this machine — the same rule Pages applies to a pasted code.
pub(crate) fn is_daemon_url(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    let clean = url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path() == "/";
    let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let loopback = host == "localhost" || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
    let tailnet = host.ends_with(".ts.net")
        || match host.parse::<IpAddr>() {
            Ok(IpAddr::V4(ip)) => is_tailnet_v4(ip),
            Ok(IpAddr::V6(ip)) => is_tailnet_v6(ip),
            Err(_) => !host.contains('.'),
        };
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    clean && scheme_ok && (loopback || tailnet)
}

/// Record a one-time code for `origin` and return what to print.
pub(crate) fn pair(settings: &Path, origin: &str, url: &str, label: &str) -> anyhow::Result<Value> {
    anyhow::ensure!(
        is_pairable_origin(origin),
        "--origin must be exactly what a browser sends: https://host[:port] or \
         http://localhost:port, with no path or trailing slash"
    );
    anyhow::ensure!(
        is_daemon_url(url),
        "--url must be this machine (http://127.0.0.1:18790) or its tailnet address \
         (https://<name>.ts.net); a page refuses any other"
    );
    let pairings = PluginPairings::beside(settings);
    let (code, expires_at) = match pairings.issue(origin, unix_now()) {
        Ok(issued) => issued,
        Err(PairingError::Full) => anyhow::bail!(
            "too many pairing codes are waiting; let them expire or run \
             'opensesame plugins unpair --origin {origin}'"
        ),
        Err(other) => return Err(other.into()),
    };
    Ok(json!({
        "pairing_code": format_pairing_code(url, &code, origin, label),
        "origin": origin,
        "url": url.trim_end_matches('/'),
        "expires_at": expires_at,
    }))
}

/// Revoke every bearer and waiting code for `origin`, or for all origins.
pub(crate) fn unpair(settings: &Path, origin: Option<&str>) -> anyhow::Result<Value> {
    let pairings = PluginPairings::beside(settings);
    let removed = pairings.unpair(origin)?;
    Ok(json!({ "origin": origin, "revoked": removed }))
}

/// Paired pages and waiting codes, for `plugins list`: never a digest.
pub(crate) fn listing(settings: &Path) -> anyhow::Result<Value> {
    let (paired, pending) = PluginPairings::beside(settings).list(unix_now())?;
    Ok(json!({ "paired": paired, "pending": pending }))
}

#[cfg(test)]
#[path = "plugins_pair_tests.rs"]
mod tests;
