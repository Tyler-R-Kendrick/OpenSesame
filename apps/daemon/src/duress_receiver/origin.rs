//! Exact-origin / path allow-list for the optional peer receiver.
//!
//! Nothing outside the tests calls these guards yet: they are the SSRF checks
//! an outbound peer delivery must pass once one is wired (PEER-to-HOST.md).

use std::net::Ipv4Addr;

#[cfg_attr(not(test), allow(dead_code))] // Test-exercised guard awaiting an outbound peer caller.
pub fn is_allowed_peer_path(path: &str) -> bool {
    matches!(
        path,
        "/v1/duress/peer/health" | "/v1/duress/peer/envelope" | "/v1/duress/peer/receipt"
    ) && !path.contains("..")
}

#[cfg_attr(not(test), allow(dead_code))] // Test-exercised guard awaiting an outbound peer caller.
pub fn assert_safe_peer_origin(origin: &str) -> Result<(), &'static str> {
    if origin.len() < 8 || origin.len() > 512 {
        return Err("unapproved_route");
    }
    if origin.contains('\0') {
        return Err("unapproved_route");
    }
    let url = url_parse(origin).ok_or("unapproved_route")?;
    if url.username.is_some() || url.password.is_some() {
        return Err("unapproved_route");
    }
    let host = url.host.to_ascii_lowercase();
    if host.is_empty()
        || host == "169.254.169.254"
        || host == "metadata.google.internal"
        || host == "metadata.google.com"
        || host == "metadata"
    {
        return Err("unapproved_route");
    }
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1";
    match url.scheme.as_str() {
        "https" if !loopback && host.parse::<Ipv4Addr>().is_ok_and(is_blocked_v4) => {
            Err("unapproved_route")
        }
        "https" => Ok(()),
        "http" if loopback => Ok(()),
        _ => Err("unapproved_route"),
    }
}

#[cfg_attr(not(test), allow(dead_code))] // Only reached through assert_safe_peer_origin.
fn is_blocked_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 0
        || o[0] == 10
        || o[0] == 127
        || (o[0] == 169 && o[1] == 254)
        || (o[0] == 172 && (16..=31).contains(&o[1]))
        || (o[0] == 192 && o[1] == 168)
        || o[0] >= 224
}

#[cfg_attr(not(test), allow(dead_code))] // Only reached through assert_safe_peer_origin.
struct ParsedUrl {
    scheme: String,
    host: String,
    username: Option<String>,
    password: Option<String>,
}

/// Minimal URL parse — avoids adding a `url` crate dependency to the daemon.
#[cfg_attr(not(test), allow(dead_code))] // Only reached through assert_safe_peer_origin.
fn url_parse(raw: &str) -> Option<ParsedUrl> {
    let (scheme, rest) = raw.split_once("://")?;
    if rest.contains('#') {
        return None;
    }
    let authority = rest.split('/').next().unwrap_or(rest);
    let (userinfo, hostport) = if let Some((u, h)) = authority.split_once('@') {
        (Some(u), h)
    } else {
        (None, authority)
    };
    let (username, password) = match userinfo {
        None => (None, None),
        Some(ui) => {
            if let Some((u, p)) = ui.split_once(':') {
                (Some(u.to_string()), Some(p.to_string()))
            } else {
                (Some(ui.to_string()), None)
            }
        }
    };
    let host = hostport
        .rsplit_once(':')
        .map_or(hostport, |(h, _)| h)
        .trim_matches(|c| c == '[' || c == ']')
        .to_string();
    Some(ParsedUrl {
        scheme: scheme.to_string(),
        host,
        username,
        password,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_private_http() {
        assert!(assert_safe_peer_origin("http://10.0.0.1/").is_err());
        assert!(assert_safe_peer_origin("https://192.168.0.1/").is_err());
    }
}
