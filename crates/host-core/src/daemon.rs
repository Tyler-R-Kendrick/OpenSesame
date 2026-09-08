pub const DEFAULT_LISTEN: &str = "127.0.0.1:18790";
pub const ENV_LISTEN: &str = "OPENSESAME_AGENT_LISTEN";
pub const ENV_LISTEN_ALIAS: &str = "OPENSESAME_DAEMON_LISTEN";
/// When `1`, skip TCP and serve Unix socket only (`OPENSESAME_AGENT_SOCK` required).
pub const ENV_UDS_ONLY: &str = "OPENSESAME_DAEMON_UDS_ONLY";
/// When `1`, allow non-loopback TCP binds (explicit operator override).
/// Shared by daemon, credential-agent, and gateway.
pub const ENV_ALLOW_NONLOCAL: &str = "OPENSESAME_ALLOW_NONLOCAL";
/// Legacy alias kept for daemon/operator docs.
pub const ENV_ALLOW_NONLOCAL_DAEMON: &str = "OPENSESAME_DAEMON_ALLOW_NONLOCAL";

/// True when `host` of `host:port` (or bare host) is loopback.
#[must_use]
pub fn listen_host_is_loopback(listen: &str) -> bool {
    let host = match listen.rsplit_once(':') {
        Some((h, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            h.trim_start_matches('[').trim_end_matches(']')
        }
        _ => listen.trim_start_matches('[').trim_end_matches(']'),
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "0:0:0:0:0:0:0:1")
}

fn nonlocal_override_enabled() -> bool {
    [ENV_ALLOW_NONLOCAL, ENV_ALLOW_NONLOCAL_DAEMON]
        .iter()
        .any(|k| std::env::var(k).ok().as_deref() == Some("1"))
}

/// Refuse non-loopback TCP unless `OPENSESAME_ALLOW_NONLOCAL=1`
/// (or legacy `OPENSESAME_DAEMON_ALLOW_NONLOCAL=1`).
///
/// # Errors
///
/// Returns an error when a non-loopback listener is requested without the
/// explicit override.
pub fn assert_tcp_listen_allowed(listen: &str) -> Result<(), String> {
    if nonlocal_override_enabled() || listen_host_is_loopback(listen) {
        return Ok(());
    }
    Err(format!(
        "TCP listen `{listen}` is not loopback; set {ENV_ALLOW_NONLOCAL}=1 to override"
    ))
}

#[must_use]
pub fn uds_only_requested() -> bool {
    std::env::var(ENV_UDS_ONLY).ok().as_deref() == Some("1")
}

/// True when an `http(s)://` base names this machine.
///
/// The operator token is a shared secret for *this host*, so a base that
/// names anywhere else must not be offered it. Userinfo makes the authority
/// ambiguous — `http://127.0.0.1@evil.test/` is a request to evil.test — so a
/// base carrying any is not local.
#[must_use]
pub fn base_url_is_local(base: &str) -> bool {
    let trimmed = base.trim();
    let Some(rest) = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
    else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    listen_host_is_loopback(&authority.to_ascii_lowercase())
}
