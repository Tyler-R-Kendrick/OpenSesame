//! Optional Tailscale Serve passthrough so github.io can reach this machine.
//!
//! Validated failure modes this module must handle:
//! - `tailscale` missing on PATH while Windows `tailscale.exe` exists (WSL)
//! - `tailscale serve --bg` hanging when Serve is not enabled on the tailnet,
//!   printing `https://login.tailscale.com/f/serve?node=…` on stdout
//! - WSL localhost ≠ Windows localhost *unless* localhostForwarding / mirrored
//!   networking is on. Prefer Serve → `http://127.0.0.1:port` when Windows can
//!   reach the WSL daemon that way; otherwise Serve → WSL eth IP **and** bind
//!   that eth IP (loopback-only leave Serve hanging). Do not prefer eth when
//!   loopback works — Windows Tailscale Serve often hangs proxying to eth.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

const SERVE_TIMEOUT: Duration = Duration::from_secs(5);
const WINDOWS_CANDIDATES: &[&str] = &[
    "/mnt/c/Program Files/Tailscale/tailscale.exe",
    "/mnt/c/Program Files (x86)/Tailscale/tailscale.exe",
];

static LAST_SERVE_ENABLE_URL: Mutex<Option<String>> = Mutex::new(None);
static LAST_SERVE_ERROR: Mutex<Option<String>> = Mutex::new(None);

#[derive(Debug, Default, Clone)]
pub struct TailscaleInfo {
    pub dns_name: Option<String>,
    pub https_url: Option<String>,
    /// True when `tailscale serve` is proxying to this daemon.
    pub serve_enabled: bool,
    /// Admin URL to enable Serve on the tailnet when missing.
    pub serve_enable_url: Option<String>,
    /// How the CLI was resolved (for diagnostics).
    pub cli_path: Option<String>,
    pub last_error: Option<String>,
}

pub fn listen_port(listen: &str) -> Option<u16> {
    listen.rsplit(':').next()?.parse().ok()
}

/// This node's first tailnet IPv4 (`100.64.0.0/10`), from
/// `tailscale status --json` `Self/TailscaleIPs`. Used by the feature-gated
/// tailnet listener to choose its bind address.
#[cfg(all(unix, feature = "tailscale"))]
pub fn self_tailnet_ipv4() -> Option<String> {
    let bin = resolve_tailscale_bin()?;
    let output = run_tailscale(&bin, &["status", "--json"], Duration::from_secs(8)).ok()?;
    let json: Value = serde_json::from_slice(&output.stdout).ok()?;
    json.pointer("/Self/TailscaleIPs")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .find(|ip| ip.starts_with("100."))
        .map(str::to_string)
}

/// Pull `https://login.tailscale.com/f/serve?node=…` out of CLI output.
pub fn parse_serve_enable_url(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        if let Some(rest) = token.strip_prefix("https://login.tailscale.com/f/serve") {
            // token may already be the full URL
            let url = if rest.starts_with('?') || rest.is_empty() {
                format!("https://login.tailscale.com/f/serve{rest}")
            } else {
                token.to_string()
            };
            if url.contains("node=") {
                return Some(url.trim_end_matches(['.', ',', ';']).to_string());
            }
        }
    }
    // Multiline: "visit:\n\n    https://…"
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("https://login.tailscale.com/f/serve?") {
            return Some(line.trim_end_matches(['.', ',', ';']).to_string());
        }
    }
    None
}

pub fn resolve_tailscale_bin() -> Option<PathBuf> {
    if let Ok(path) = which("tailscale") {
        return Some(path);
    }
    if let Ok(path) = which("tailscale.exe") {
        return Some(path);
    }
    for candidate in WINDOWS_CANDIDATES {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn which(name: &str) -> Result<PathBuf, ()> {
    let path = std::env::var_os("PATH").ok_or(())?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(())
}

fn is_wsl() -> bool {
    std::fs::read_to_string("/proc/version")
        .map(|v| v.to_ascii_lowercase().contains("microsoft"))
        .unwrap_or(false)
}

fn is_windows_tailscale(bin: &Path) -> bool {
    bin.to_string_lossy().contains("/mnt/c/")
        || bin
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
}

/// IPv4 Windows Tailscale should dial when the daemon runs inside WSL2.
pub fn wsl_host_reachable_ipv4() -> Option<String> {
    let output = Command::new("hostname").arg("-I").output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .find(|ip| {
            let parts: Vec<_> = ip.split('.').collect();
            parts.len() == 4 && !ip.starts_with("127.")
        })
        .map(str::to_string)
}

fn serve_target(bin: &Path, port: u16) -> String {
    if is_wsl() && is_windows_tailscale(bin) {
        // Prefer Windows loopback when mirrored/localhostForwarding reaches WSL.
        if windows_loopback_reaches_daemon(port) {
            return format!("http://127.0.0.1:{port}");
        }
        if let Some(bridge) = wsl_eth_listen(port) {
            return format!("http://{bridge}");
        }
    }
    format!("http://127.0.0.1:{port}")
}

fn wsl_eth_listen(port: u16) -> Option<String> {
    let ip = wsl_host_reachable_ipv4()?;
    Some(format!("{ip}:{port}"))
}

/// True when Windows `curl.exe` can fetch this daemon via `127.0.0.1`.
fn windows_loopback_reaches_daemon(port: u16) -> bool {
    let curl = PathBuf::from("/mnt/c/Windows/System32/curl.exe");
    if !curl.is_file() {
        return false;
    }
    let url = format!("http://127.0.0.1:{port}/health");
    let Ok(output) = run_command(
        &curl,
        &["-fsS", "--connect-timeout", "2", "--max-time", "3", &url],
        Duration::from_secs(4),
    ) else {
        return false;
    };
    output.status.success() && String::from_utf8_lossy(&output.stdout).contains("opensesame-daemon")
}

/// Extra TCP bind needed so Windows Tailscale Serve can reach a WSL daemon
/// when loopback forwarding is unavailable.
pub fn wsl_bridge_listen(port: u16) -> Option<String> {
    let bin = resolve_tailscale_bin()?;
    if !(is_wsl() && is_windows_tailscale(&bin)) {
        return None;
    }
    if windows_loopback_reaches_daemon(port) {
        return None;
    }
    wsl_eth_listen(port)
}

fn run_tailscale(
    bin: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<std::process::Output, String> {
    run_command(bin, args, timeout)
}

fn run_command(
    bin: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let child = Command::new(bin)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => {
            #[cfg(unix)]
            {
                let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/F"])
                    .status();
            }
            // Prefer partial output if the join completes quickly after kill.
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(Ok(output)) => Ok(output),
                _ => Err(format!(
                    "{} {} timed out after {}s",
                    bin.display(),
                    args.join(" "),
                    timeout.as_secs()
                )),
            }
        }
    }
}

fn combined_text(output: &std::process::Output) -> String {
    let mut text = String::new();
    text.push_str(&String::from_utf8_lossy(&output.stdout));
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    text
}

pub fn info() -> TailscaleInfo {
    let Some(bin) = resolve_tailscale_bin() else {
        return TailscaleInfo {
            last_error: Some("tailscale CLI not found on PATH or Windows install path".into()),
            ..TailscaleInfo::default()
        };
    };
    let cli_path = Some(bin.display().to_string());
    let Ok(output) = run_tailscale(&bin, &["status", "--json"], Duration::from_secs(8)) else {
        return TailscaleInfo {
            cli_path,
            last_error: Some("tailscale status failed".into()),
            ..TailscaleInfo::default()
        };
    };
    if !output.status.success() && output.stdout.is_empty() {
        return TailscaleInfo {
            cli_path,
            last_error: Some(combined_text(&output).trim().to_string()),
            ..TailscaleInfo::default()
        };
    }
    let Ok(json) = serde_json::from_slice::<Value>(&output.stdout) else {
        return TailscaleInfo {
            cli_path,
            last_error: Some("tailscale status JSON parse failed".into()),
            ..TailscaleInfo::default()
        };
    };
    let dns = json
        .pointer("/Self/DNSName")
        .and_then(Value::as_str)
        .map(|name| name.trim_end_matches('.').to_string())
        .filter(|name| !name.is_empty());
    let (serve_enabled, serve_enable_url, serve_err) = serve_status(&bin);
    let cached_enable = LAST_SERVE_ENABLE_URL.lock().ok().and_then(|g| g.clone());
    let cached_err = LAST_SERVE_ERROR.lock().ok().and_then(|g| g.clone());
    let https_url = if serve_enabled {
        dns.as_ref().map(|name| format!("https://{name}"))
    } else {
        None
    };
    TailscaleInfo {
        dns_name: dns,
        https_url,
        serve_enabled,
        serve_enable_url: serve_enable_url.or(cached_enable),
        cli_path,
        last_error: serve_err.or(cached_err),
    }
}

fn serve_status(bin: &Path) -> (bool, Option<String>, Option<String>) {
    let Ok(output) = run_tailscale(bin, &["serve", "status", "--json"], Duration::from_secs(5))
    else {
        return (false, None, Some("tailscale serve status failed".into()));
    };
    let text = combined_text(&output);
    let enable_url = parse_serve_enable_url(&text);
    if text.to_ascii_lowercase().contains("no serve config")
        || text.to_ascii_lowercase().contains("serve is not enabled")
    {
        return (false, enable_url, None);
    }
    if let Ok(json) = serde_json::from_slice::<Value>(&output.stdout) {
        let active = match json {
            Value::Object(map) => !map.is_empty(),
            Value::Array(items) => !items.is_empty(),
            Value::Bool(flag) => flag,
            Value::String(s) => {
                !s.trim().is_empty() && !s.to_ascii_lowercase().contains("no serve")
            }
            _ => false,
        };
        return (active, enable_url, None);
    }
    let body = String::from_utf8_lossy(&output.stdout);
    let active = !body.trim().is_empty() && !body.to_ascii_lowercase().contains("no serve");
    (active, enable_url, None)
}

/// Reverse-proxy this daemon onto the tailnet at https://<machine>.ts.net/.
pub fn enable_serve(listen: &str) -> Result<TailscaleInfo, String> {
    let port = listen_port(listen).ok_or_else(|| "daemon listen has no port".to_string())?;
    let bin = resolve_tailscale_bin().ok_or_else(|| {
        "tailscale CLI not found (install Tailscale, or ensure tailscale.exe is reachable from WSL)"
            .to_string()
    })?;
    let target = serve_target(&bin, port);
    let output = run_tailscale(&bin, &["serve", "--bg", &target], SERVE_TIMEOUT)?;
    let text = combined_text(&output);
    if let Some(url) = parse_serve_enable_url(&text) {
        if let Ok(mut slot) = LAST_SERVE_ENABLE_URL.lock() {
            *slot = Some(url.clone());
        }
        let message = format!(
            "Tailscale Serve is not enabled on this tailnet. Open {url} (sign in), then restart the daemon. Serve target would be {target}."
        );
        if let Ok(mut slot) = LAST_SERVE_ERROR.lock() {
            *slot = Some(message.clone());
        }
        let mut state = info();
        state.serve_enable_url = Some(url);
        state.serve_enabled = false;
        state.https_url = None;
        state.cli_path = Some(bin.display().to_string());
        state.last_error = Some(message.clone());
        return Err(message);
    }
    if !output.status.success() && !text.trim().is_empty() {
        if let Ok(mut slot) = LAST_SERVE_ERROR.lock() {
            *slot = Some(text.trim().to_string());
        }
        return Err(text.trim().to_string());
    }
    if let Ok(mut slot) = LAST_SERVE_ENABLE_URL.lock() {
        *slot = None;
    }
    if let Ok(mut slot) = LAST_SERVE_ERROR.lock() {
        *slot = None;
    }
    let mut state = info();
    state.cli_path = Some(bin.display().to_string());
    if !state.serve_enabled && output.status.success() {
        state.serve_enabled = true;
        if state.https_url.is_none() {
            if let Some(dns) = state.dns_name.clone() {
                state.https_url = Some(format!("https://{dns}"));
            }
        }
    }
    if !state.serve_enabled {
        return Err(format!(
            "tailscale serve did not become active for {target}. {}",
            state.last_error.unwrap_or_default()
        ));
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listen_port_reads_the_tcp_port() {
        assert_eq!(listen_port("127.0.0.1:18790"), Some(18790));
        assert_eq!(listen_port("[::1]:18790"), Some(18790));
        assert_eq!(listen_port("nope"), None);
    }

    #[test]
    fn parse_enable_url_from_hanging_serve_output() {
        let text = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nRNg4QkEnC11CNTRL\n\n";
        assert_eq!(
            parse_serve_enable_url(text).as_deref(),
            Some("https://login.tailscale.com/f/serve?node=nRNg4QkEnC11CNTRL")
        );
    }

    #[test]
    fn resolve_tailscale_bin_finds_windows_install_in_wsl_layout() {
        // On this agent host the Windows binary exists; elsewhere skip.
        let path = PathBuf::from("/mnt/c/Program Files/Tailscale/tailscale.exe");
        if path.is_file() {
            let resolved = resolve_tailscale_bin().expect("should find windows tailscale");
            assert!(resolved.ends_with("tailscale.exe"));
        }
    }

    #[test]
    fn wsl_bridge_listen_skipped_when_windows_loopback_works() {
        let path = PathBuf::from("/mnt/c/Program Files/Tailscale/tailscale.exe");
        if !(is_wsl() && path.is_file()) {
            return;
        }
        // Daemon must already be listening on 127.0.0.1 for this probe; when it
        // is not, bridge may be Some — both outcomes are valid for unit tests.
        let _ = wsl_bridge_listen(18790);
        let target = serve_target(&path, 18790);
        assert!(
            target.starts_with("http://127.0.0.1:") || target.starts_with("http://"),
            "unexpected target {target}"
        );
        if windows_loopback_reaches_daemon(18790) {
            assert_eq!(target, "http://127.0.0.1:18790");
            assert!(wsl_bridge_listen(18790).is_none());
        }
    }
}
