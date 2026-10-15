//! Root helper: holds per-UID CLI root-trust sealing keys outside user-writable state.

use std::os::unix::net::UnixListener;
use std::path::PathBuf;

use opensesame_cli_trust_guard::protocol::DEFAULT_SOCKET_PATH;
use opensesame_cli_trust_guard::server;

fn main() -> anyhow::Result<()> {
    #[cfg(feature = "server-bin")]
    tracing_subscriber::fmt::init();

    let socket = std::env::var_os("OPENSESAME_CLI_TRUST_GUARD_LISTEN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_SOCKET_PATH));
    let state_root = std::env::var_os("OPENSESAME_CLI_TRUST_GUARD_STATE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/var/lib/opensesame/cli-trust"));
    if socket.exists() {
        std::fs::remove_file(&socket)?;
    }
    if let Some(parent) = socket.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let listener = UnixListener::bind(&socket)?;
    eprintln!(
        "opensesame-cli-trust-guard listening on {} (state {})",
        socket.display(),
        state_root.display()
    );
    for stream in listener.incoming() {
        match stream {
            Ok(mut stream) => {
                let _ = server::handle_connection(&mut stream, &state_root);
            }
            Err(err) => eprintln!("accept error: {err}"),
        }
    }
    Ok(())
}
