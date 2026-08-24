//! `opensesame-keepassxc-bridge` — serve the **keepassxc-protocol** from the
//! `OpenSesame` sealed store, so the stock KeePassXC-Browser extension works
//! against `OpenSesame` unchanged.
//!
//! Two transports, both opt-in:
//!
//! ```text
//!   # recommended: the browser launches us directly, no singleton involved
//!   opensesame bridge keepassxc install-native-host --browser firefox
//!
//!   # compatibility: serve the socket a stock keepassxc-proxy dials
//!   opensesame-keepassxc-bridge serve [--socket PATH] [--takeover]
//! ```
//!
//! Pairing is a separate, human act: `opensesame bridge keepassxc pair` opens
//! a time-boxed window and prints the incoming key's fingerprint to confirm.
//! Without it, `associate` is refused (C2(b)).
//!
//! Implemented from the public keepassxc-protocol document; `KeePassXC`'s own
//! (GPL) source was not read or copied (C3).

use std::io::{self, IsTerminal};
use std::path::PathBuf;

use opensesame_pm_bridges::conflict::keepassxc_socket_path;
use opensesame_pm_bridges::keepassxc::pairing::BRIDGE_NAME;
use opensesame_pm_bridges::keepassxc::transport::{self, serve_stdio};
use opensesame_pm_bridges::keepassxc::{Session, SessionConfig};
use opensesame_pm_bridges::pairing::PairingWindow;
use opensesame_pm_bridges::store::StoreAccess;
use opensesame_pm_bridges::BridgeError;

/// How the binary was asked to run.
enum Mode {
    /// Native-messaging host on stdio (the default: this is how a browser
    /// invokes us, and browsers pass their own arguments we must ignore).
    Stdio,
    /// UDS server on the keepassxc-proxy socket.
    Serve {
        socket: PathBuf,
        takeover: bool,
    },
    Help,
}

fn main() {
    let mode = parse_args(std::env::args().skip(1));
    if let Err(error) = run(mode) {
        // Failure class only — never a store path's contents, never a key.
        eprintln!("keepassxc bridge: {error}");
        std::process::exit(1);
    }
}

fn parse_args(args: impl Iterator<Item = String>) -> Mode {
    let args: Vec<String> = args.collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        return Mode::Help;
    }
    if !args.iter().any(|a| a == "serve") {
        // Browsers append the manifest path and (on Chrome) the caller's
        // origin; anything that is not an explicit `serve` is stdio mode.
        return Mode::Stdio;
    }
    let mut socket = keepassxc_socket_path();
    let mut takeover = false;
    let mut iter = args.iter().peekable();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--socket" => {
                if let Some(value) = iter.next() {
                    socket = PathBuf::from(value);
                }
            }
            "--takeover" => takeover = true,
            _ => {}
        }
    }
    Mode::Serve { socket, takeover }
}

fn run(mode: Mode) -> Result<(), BridgeError> {
    match mode {
        Mode::Help => {
            print_help();
            Ok(())
        }
        Mode::Stdio => {
            let mut session = open_session()?;
            let mut stdin = io::stdin().lock();
            let mut stdout = io::stdout().lock();
            serve_stdio(&mut session, &mut stdin, &mut stdout)
        }
        Mode::Serve { socket, takeover } => serve_socket(&socket, takeover),
    }
}

fn open_session() -> Result<Session, BridgeError> {
    let store = StoreAccess::from_env(None)?;
    let window = PairingWindow::for_bridge(BRIDGE_NAME)?;
    Ok(Session::new(store, SessionConfig::new(window)))
}

#[cfg(unix)]
fn serve_socket(socket: &std::path::Path, takeover: bool) -> Result<(), BridgeError> {
    let listener = transport::bind_uds(socket, takeover)?;
    if io::stderr().is_terminal() {
        eprintln!(
            "keepassxc bridge: serving {} — pair a client with `opensesame bridge keepassxc pair`",
            socket.display()
        );
    }
    // One session per process: the ephemeral host keypair, the client table,
    // and the unlocked store all belong to this process's lifetime.
    let mut session = open_session()?;
    for stream in listener.incoming() {
        let mut stream = match stream {
            Ok(stream) => stream,
            Err(error) => {
                eprintln!("keepassxc bridge: accept failed: {error}");
                continue;
            }
        };
        if let Err(error) = transport::serve_uds_connection(&mut session, &mut stream) {
            eprintln!("keepassxc bridge: connection ended: {error}");
        }
    }
    let _ = std::fs::remove_file(socket);
    Ok(())
}

#[cfg(not(unix))]
fn serve_socket(_socket: &std::path::Path, _takeover: bool) -> Result<(), BridgeError> {
    Err(BridgeError::Denied(
        "UDS mode needs a unix platform; use the stdio native-messaging host",
    ))
}

fn print_help() {
    println!(
        "opensesame-keepassxc-bridge — serve the keepassxc-protocol from the OpenSesame sealed store

USAGE:
  opensesame-keepassxc-bridge                      stdio native-messaging host (browser-launched)
  opensesame-keepassxc-bridge serve [OPTIONS]      unix-socket server for a stock keepassxc-proxy

OPTIONS (serve):
  --socket <PATH>   socket to bind (default: $XDG_RUNTIME_DIR/{socket})
  --takeover        remove a verified-dead socket before binding; never a live one

ENVIRONMENT:
  OPENSESAME_STORE_PASSWORD      sealed-store passphrase (no TTY is available here)
  OPENSESAME_BRIDGE_STORE_DIR    explicit store root
  OPENSESAME_BRIDGES_DIR         pairing-state directory

Pairing is a separate human action: `opensesame bridge keepassxc pair`.",
        socket = opensesame_pm_bridges::conflict::KEEPASSXC_SOCKET_NAME
    );
}
