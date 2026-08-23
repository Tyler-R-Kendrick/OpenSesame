//! `opensesame bridge` — install and operate the local-IPC password-manager
//! bridges (ADR 0053).
//!
//! # The seam
//!
//! [`BridgeCmd`] is deliberately **open for extension**: each new serving
//! surface in `apps/pm-bridges` adds one variant here (and, if it needs more
//! than install/uninstall, its own nested subcommand enum, as `keepassxc`
//! does). Handlers live in this file and nowhere else, so the top-level
//! command enum in `main.rs` only ever grows the single `Bridge` arm.
//!
//! Two rules keep that seam honest:
//!
//! 1. **No secret ever passes through this file.** The CLI writes manifests,
//!    opens pairing windows, and spawns bridge binaries. Store passphrases,
//!    entry contents, and session keys belong to the bridge processes.
//! 2. **Every verb here is an explicit human act.** `install` writing a
//!    native-messaging manifest *is* the approval that lets a browser launch
//!    a bridge; `keepassxc pair` *is* the approval that lets one extension
//!    talk to the store (constitution C2(b)). Nothing enables itself.

use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use clap::{Subcommand, ValueEnum};
use opensesame_pm_bridges::conflict::{keepassxc_socket_path, probe_unix_socket, SocketState};
use opensesame_pm_bridges::manifest::{self, Browser, BridgeKind};
use opensesame_pm_bridges::now_unix;
use opensesame_pm_bridges::pairing::{
    load_pairings, save_pairings, PairingWindow, WindowState, DEFAULT_WINDOW_SECS,
};

/// Pairing file / window basename for the keepassxc bridge. Mirrors
/// `opensesame_pm_bridges::keepassxc::pairing::BRIDGE_NAME`, which lives
/// behind that crate's `keepassxc` feature; the CLI depends on pm-bridges
/// with default (all-off) features so it never links the bridge cores.
const KEEPASSXC_BRIDGE: &str = "keepassxc";

/// Which stdio bridge to install a manifest for.
#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum BridgeArg {
    /// browserpass-native compatible host (`opensesame-browserpass-host`).
    Browserpass,
    /// gopass-jsonapi compatible host (`opensesame-gopass-jsonapi`).
    Gopass,
    /// keepassxc-protocol host (`opensesame-keepassxc-bridge`).
    Keepassxc,
}

impl From<BridgeArg> for BridgeKind {
    fn from(value: BridgeArg) -> Self {
        match value {
            BridgeArg::Browserpass => BridgeKind::Browserpass,
            BridgeArg::Gopass => BridgeKind::Gopass,
            BridgeArg::Keepassxc => BridgeKind::KeepassXc,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum BrowserArg {
    Chrome,
    Chromium,
    Firefox,
}

impl From<BrowserArg> for Browser {
    fn from(value: BrowserArg) -> Self {
        match value {
            BrowserArg::Chrome => Browser::Chrome,
            BrowserArg::Chromium => Browser::Chromium,
            BrowserArg::Firefox => Browser::Firefox,
        }
    }
}

/// Local-IPC bridges for foreign password-manager clients.
#[derive(Subcommand, Debug)]
pub enum BridgeCmd {
    /// Write a browser's native-messaging manifest — the approval that lets
    /// that browser launch the bridge.
    Install {
        #[arg(value_enum)]
        bridge: BridgeArg,
        #[arg(long, value_enum)]
        browser: BrowserArg,
        /// Path to the bridge binary; defaults to one beside this CLI.
        #[arg(long)]
        bin: Option<PathBuf>,
        /// Print the manifest and its destination without writing anything.
        #[arg(long, default_value_t = false)]
        print: bool,
    },
    /// Remove a previously installed manifest.
    Uninstall {
        #[arg(value_enum)]
        bridge: BridgeArg,
        #[arg(long, value_enum)]
        browser: BrowserArg,
    },
    /// Show which manifests are installed where.
    Status,
    /// KeePassXC-browser bridge: pairing and the socket server.
    Keepassxc {
        #[command(subcommand)]
        cmd: KeepassxcCmd,
    },
}

/// Verbs specific to the keepassxc bridge.
#[derive(Subcommand, Debug)]
pub enum KeepassxcCmd {
    /// Open a pairing window and confirm an incoming client's fingerprint.
    Pair {
        /// How long the window stays open, in seconds.
        #[arg(long, default_value_t = DEFAULT_WINDOW_SECS)]
        timeout: u64,
        /// Confirm without prompting. Only for scripted, unattended setup —
        /// it skips the fingerprint check that makes pairing meaningful.
        #[arg(long, default_value_t = false)]
        yes: bool,
    },
    /// Install the `org.keepassxc.keepassxc_browser` native-messaging
    /// manifest (the recommended, singleton-free install).
    InstallNativeHost {
        #[arg(long, value_enum)]
        browser: BrowserArg,
        #[arg(long)]
        bin: Option<PathBuf>,
        #[arg(long, default_value_t = false)]
        print: bool,
    },
    /// Run the unix-socket server a stock `keepassxc-proxy` dials.
    Serve {
        /// Socket to bind; defaults to the KeePassXC convention.
        #[arg(long)]
        socket: Option<PathBuf>,
        /// Remove a *verified-dead* socket first. Never a live one.
        #[arg(long, default_value_t = false)]
        takeover: bool,
        #[arg(long)]
        bin: Option<PathBuf>,
    },
    /// List paired clients (public key fingerprints only).
    Associations,
    /// Forget a paired client by id.
    Revoke { id: String },
}

/// Entry point called from `main.rs`'s `Commands::Bridge` arm.
pub fn run(cmd: BridgeCmd) -> anyhow::Result<()> {
    match cmd {
        BridgeCmd::Install {
            bridge,
            browser,
            bin,
            print,
        } => install(bridge.into(), browser.into(), bin, print),
        BridgeCmd::Uninstall { bridge, browser } => {
            let path = manifest::uninstall(bridge.into(), browser.into(), &home()?)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            println!("removed {}", path.display());
            Ok(())
        }
        BridgeCmd::Status => status(),
        BridgeCmd::Keepassxc { cmd } => keepassxc(cmd),
    }
}

fn home() -> anyhow::Result<PathBuf> {
    directories::BaseDirs::new()
        .map(|dirs| dirs.home_dir().to_path_buf())
        .ok_or_else(|| anyhow::anyhow!("cannot determine the home directory"))
}

fn install(
    bridge: BridgeKind,
    browser: Browser,
    bin: Option<PathBuf>,
    print: bool,
) -> anyhow::Result<()> {
    let binary = bin.unwrap_or_else(|| manifest::default_binary_path(bridge));
    let home = home()?;
    if print {
        let json = manifest::render_manifest(bridge, browser, &binary)
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        println!("{}", manifest::manifest_path(bridge, browser, &home).display());
        print!("{json}");
        return Ok(());
    }
    if !binary.exists() {
        eprintln!(
            "warning: {} does not exist yet — the manifest will point at it anyway",
            binary.display()
        );
    }
    let installed = manifest::install(bridge, browser, &home, &binary)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    println!(
        "installed {} → {}",
        installed.host_name,
        installed.path.display()
    );
    println!("  binary: {}", installed.binary.display());
    println!(
        "  the {} extension may now launch it; restart the browser to pick it up",
        browser_label(browser)
    );
    Ok(())
}

fn browser_label(browser: Browser) -> &'static str {
    browser.as_str()
}

fn status() -> anyhow::Result<()> {
    let home = home()?;
    let mut any = false;
    for bridge in [
        BridgeKind::Browserpass,
        BridgeKind::Gopass,
        BridgeKind::KeepassXc,
    ] {
        for browser in [Browser::Chrome, Browser::Chromium, Browser::Firefox] {
            let path = manifest::manifest_path(bridge, browser, &home);
            if path.exists() {
                any = true;
                println!(
                    "{:<12} {:<9} {}",
                    bridge.default_binary(),
                    browser.as_str(),
                    path.display()
                );
            }
        }
    }
    if !any {
        println!("no bridge manifests installed (run `opensesame bridge install …`)");
    }

    let socket = keepassxc_socket_path();
    println!("keepassxc socket: {}", probe_unix_socket(&socket).diagnostic(&socket));

    let pairings = load_pairings(KEEPASSXC_BRIDGE).map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("keepassxc pairings: {}", pairings.associations.len());
    Ok(())
}

fn keepassxc(cmd: KeepassxcCmd) -> anyhow::Result<()> {
    match cmd {
        KeepassxcCmd::Pair { timeout, yes } => pair(timeout, yes),
        KeepassxcCmd::InstallNativeHost { browser, bin, print } => {
            install(BridgeKind::KeepassXc, browser.into(), bin, print)
        }
        KeepassxcCmd::Serve {
            socket,
            takeover,
            bin,
        } => serve(socket, takeover, bin),
        KeepassxcCmd::Associations => associations(),
        KeepassxcCmd::Revoke { id } => revoke(&id),
    }
}

/// The C2 approval ceremony.
///
/// The bridge and this command share one small file: we open the window, the
/// bridge posts the fingerprint of whatever key knocked, and the human here
/// decides. Neither side can pair a client on its own.
fn pair(timeout_secs: u64, assume_yes: bool) -> anyhow::Result<()> {
    let window = PairingWindow::for_bridge(KEEPASSXC_BRIDGE).map_err(|e| anyhow::anyhow!("{e}"))?;
    window
        .open(now_unix(), timeout_secs)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    println!(
        "pairing window open for {timeout_secs}s — now click \"Connect\" in KeePassXC-Browser"
    );

    let deadline = Instant::now() + Duration::from_secs(timeout_secs + 2);
    let fingerprint = loop {
        match window.state(now_unix()).map_err(|e| anyhow::anyhow!("{e}"))? {
            WindowState::Requested { fingerprint, .. } => break fingerprint,
            WindowState::Expired | WindowState::Closed => {
                let _ = window.close();
                anyhow::bail!("no client asked to pair before the window closed");
            }
            WindowState::Confirmed { .. } | WindowState::Rejected => {
                let _ = window.close();
                anyhow::bail!("the pairing window was already decided");
            }
            WindowState::Open { .. } => {}
        }
        if Instant::now() >= deadline {
            let _ = window.close();
            anyhow::bail!("no client asked to pair before the window closed");
        }
        std::thread::sleep(Duration::from_millis(200));
    };

    println!();
    println!("  a client wants to pair, key fingerprint:");
    println!("      {fingerprint}");
    println!("  confirm it matches the fingerprint your browser is showing.");
    println!();

    let approved = if assume_yes {
        true
    } else if io::stdin().is_terminal() {
        prompt_yes_no("pair this client? [y/N]")?
    } else {
        eprintln!("no TTY to confirm on; rejecting (re-run with --yes to pair unattended)");
        false
    };

    if approved {
        window
            .confirm(now_unix())
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        println!("confirmed — the bridge will persist the association");
    } else {
        window.reject().map_err(|e| anyhow::anyhow!("{e}"))?;
        println!("rejected");
    }
    Ok(())
}

fn prompt_yes_no(prompt: &str) -> anyhow::Result<bool> {
    eprint!("{prompt} ");
    let _ = io::stderr().flush();
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    Ok(matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes"))
}

/// Run the bridge binary's UDS server as a child process.
///
/// The CLI does not link the bridge core: the serving surfaces are behind
/// cargo features in `apps/pm-bridges`, and keeping them out of the CLI is
/// what makes "default off" true at link time rather than only at runtime.
fn serve(socket: Option<PathBuf>, takeover: bool, bin: Option<PathBuf>) -> anyhow::Result<()> {
    let socket = socket.unwrap_or_else(keepassxc_socket_path);
    match probe_unix_socket(&socket) {
        SocketState::Live { .. } => {
            anyhow::bail!("{}", probe_unix_socket(&socket).diagnostic(&socket));
        }
        SocketState::Stale if !takeover => {
            anyhow::bail!("{}", probe_unix_socket(&socket).diagnostic(&socket));
        }
        _ => {}
    }
    let binary = bin.unwrap_or_else(|| manifest::default_binary_path(BridgeKind::KeepassXc));
    let mut command = std::process::Command::new(&binary);
    command.arg("serve").arg("--socket").arg(&socket);
    if takeover {
        command.arg("--takeover");
    }
    let status = command
        .status()
        .map_err(|e| anyhow::anyhow!("could not run {}: {e}", binary.display()))?;
    if !status.success() {
        anyhow::bail!("{} exited with {status}", binary.display());
    }
    Ok(())
}

fn associations() -> anyhow::Result<()> {
    let file = load_pairings(KEEPASSXC_BRIDGE).map_err(|e| anyhow::anyhow!("{e}"))?;
    if file.associations.is_empty() {
        println!("no paired keepassxc clients");
        return Ok(());
    }
    for association in &file.associations {
        // Fingerprint, never the raw key material — even though the stored
        // key is public, a short fingerprint is what a human can check.
        println!(
            "{:<24} {:<20} paired {}",
            association.id,
            association.fingerprint(),
            association.created_at
        );
    }
    Ok(())
}

fn revoke(id: &str) -> anyhow::Result<()> {
    let mut file = load_pairings(KEEPASSXC_BRIDGE).map_err(|e| anyhow::anyhow!("{e}"))?;
    let before = file.associations.len();
    file.associations.retain(|a| a.id != id);
    if file.associations.len() == before {
        anyhow::bail!("no paired client with id '{id}'");
    }
    save_pairings(KEEPASSXC_BRIDGE, &file).map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("revoked {id}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_pm_bridges::pairing::Association;

    /// `OPENSESAME_BRIDGES_DIR` is process-global.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_bridges_dir<T>(f: impl FnOnce(&std::path::Path) -> T) -> T {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("OPENSESAME_BRIDGES_DIR", dir.path());
        let out = f(dir.path());
        std::env::remove_var("OPENSESAME_BRIDGES_DIR");
        out
    }

    #[test]
    fn install_writes_a_manifest_the_browser_can_read() {
        let home = tempfile::tempdir().unwrap();
        let installed = manifest::install(
            BridgeArg::Browserpass.into(),
            BrowserArg::Firefox.into(),
            home.path(),
            std::path::Path::new("/usr/bin/opensesame-browserpass-host"),
        )
        .unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&installed.path).unwrap()).unwrap();
        assert_eq!(json["name"], "com.github.browserpass.native");
        assert_eq!(json["type"], "stdio");
        assert_eq!(json["allowed_extensions"][0], "browserpass@maximbaz.com");
    }

    #[test]
    fn arg_enums_map_onto_the_bridge_types() {
        assert_eq!(BridgeKind::from(BridgeArg::Gopass), BridgeKind::Gopass);
        assert_eq!(BridgeKind::from(BridgeArg::Keepassxc), BridgeKind::KeepassXc);
        assert_eq!(
            BridgeKind::from(BridgeArg::Browserpass),
            BridgeKind::Browserpass
        );
        assert_eq!(Browser::from(BrowserArg::Chrome), Browser::Chrome);
        assert_eq!(Browser::from(BrowserArg::Chromium), Browser::Chromium);
        assert_eq!(Browser::from(BrowserArg::Firefox), Browser::Firefox);
    }

    #[test]
    fn pair_opens_a_window_and_gives_up_when_nobody_knocks() {
        with_bridges_dir(|dir| {
            // A zero-second window is already expired when first polled.
            let error = pair(0, true).unwrap_err().to_string();
            assert!(error.contains("no client asked to pair"), "{error}");
            // The window file is cleaned up rather than left armed.
            assert!(!dir.join("keepassxc-pairing.json").exists());
        });
    }

    #[test]
    fn associations_and_revoke_operate_on_public_state_only() {
        with_bridges_dir(|_dir| {
            let mut file = load_pairings(KEEPASSXC_BRIDGE).unwrap();
            file.upsert(Association {
                id: "firefox".into(),
                name: "firefox".into(),
                id_key: "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=".into(),
                created_at: "1750000000".into(),
            });
            save_pairings(KEEPASSXC_BRIDGE, &file).unwrap();

            associations().unwrap();
            assert!(revoke("nope").is_err());
            revoke("firefox").unwrap();
            assert!(load_pairings(KEEPASSXC_BRIDGE)
                .unwrap()
                .associations
                .is_empty());
        });
    }

    #[test]
    fn serve_refuses_a_live_socket_without_running_anything() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("live.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let error = serve(Some(socket), false, None).unwrap_err().to_string();
        assert!(error.contains("refusing to take over"), "{error}");
    }

    #[test]
    fn serve_refuses_a_stale_socket_unless_takeover_is_asked_for() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("stale.sock");
        drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
        let error = serve(Some(socket), false, None).unwrap_err().to_string();
        assert!(error.contains("--takeover"), "{error}");
    }
}
