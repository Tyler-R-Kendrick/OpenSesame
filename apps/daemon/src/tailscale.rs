//! Optional Tailscale Serve passthrough so github.io can reach this machine.

use serde_json::Value;
use std::process::Command;

#[derive(Debug, Default, Clone)]
pub struct TailscaleInfo {
    pub dns_name: Option<String>,
    pub https_url: Option<String>,
    pub ip4: Option<String>,
    /// True when `tailscale serve` is proxying to this daemon.
    pub serve_enabled: bool,
}

pub fn listen_port(listen: &str) -> Option<u16> {
    listen.rsplit(':').next()?.parse().ok()
}

pub fn info() -> TailscaleInfo {
    let Ok(output) = Command::new("tailscale")
        .args(["status", "--json"])
        .output()
    else {
        return TailscaleInfo::default();
    };
    if !output.status.success() {
        return TailscaleInfo::default();
    }
    let Ok(json) = serde_json::from_slice::<Value>(&output.stdout) else {
        return TailscaleInfo::default();
    };
    let dns = json
        .pointer("/Self/DNSName")
        .and_then(Value::as_str)
        .map(|name| name.trim_end_matches('.').to_string())
        .filter(|name| !name.is_empty());
    let ip4 = json
        .pointer("/Self/TailscaleIPs")
        .and_then(Value::as_array)
        .and_then(|ips| {
            ips.iter()
                .filter_map(Value::as_str)
                .find(|ip| ip.contains('.'))
                .map(str::to_string)
        });
    let https_url = dns.as_ref().map(|name| format!("https://{name}"));
    let serve_enabled = serve_is_active();
    TailscaleInfo {
        dns_name: dns,
        https_url: if serve_enabled { https_url } else { None },
        ip4,
        serve_enabled,
    }
}

fn serve_is_active() -> bool {
    let Ok(output) = Command::new("tailscale")
        .args(["serve", "status", "--json"])
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        // Older CLI may lack --json; treat non-empty text status as active.
        let Ok(text) = Command::new("tailscale")
            .args(["serve", "status"])
            .output()
        else {
            return false;
        };
        if !text.status.success() {
            return false;
        }
        let body = String::from_utf8_lossy(&text.stdout);
        return !body.trim().is_empty()
            && !body.to_ascii_lowercase().contains("no serve");
    }
    let Ok(json) = serde_json::from_slice::<Value>(&output.stdout) else {
        return false;
    };
    match json {
        Value::Object(map) => !map.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Bool(flag) => flag,
        Value::String(s) => !s.trim().is_empty(),
        _ => false,
    }
}

/// Reverse-proxy this daemon onto the tailnet at https://<machine>.ts.net/.
pub fn enable_serve(listen: &str) -> Result<TailscaleInfo, String> {
    let port = listen_port(listen).ok_or_else(|| "daemon listen has no port".to_string())?;
    let target = format!("http://127.0.0.1:{port}");
    let output = Command::new("tailscale")
        .args(["serve", "--bg", &target])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().to_string());
    }
    let mut state = info();
    if !state.serve_enabled {
        // Status can lag briefly after enable; trust the successful CLI call.
        state.serve_enabled = true;
        if state.https_url.is_none() {
            if let Some(dns) = state.dns_name.clone() {
                state.https_url = Some(format!("https://{dns}"));
            }
        }
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::listen_port;

    #[test]
    fn listen_port_reads_the_tcp_port() {
        assert_eq!(listen_port("127.0.0.1:18790"), Some(18790));
        assert_eq!(listen_port("[::1]:18790"), Some(18790));
        assert_eq!(listen_port("nope"), None);
    }
}
