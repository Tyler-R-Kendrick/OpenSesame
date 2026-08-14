//! Optional Tailscale Serve passthrough so github.io can reach this machine.

use serde_json::Value;
use std::process::Command;

#[derive(Debug, Default, Clone)]
pub struct TailscaleInfo {
    pub dns_name: Option<String>,
    pub https_url: Option<String>,
    pub ip4: Option<String>,
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
    TailscaleInfo {
        dns_name: dns,
        https_url,
        ip4,
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
    Ok(info())
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
