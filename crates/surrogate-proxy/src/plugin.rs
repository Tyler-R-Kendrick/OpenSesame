//! The installable plugin (ADR 0150 §7): `opensesame-surrogate-proxy`, a
//! separate executable that the `opensesame` binary and the daemon never link.
//!
//! A person installs it (`opensesame plugins install surrogate-proxy …`,
//! pinned by sha256) and switches it on; `opensesame dev run --agent` then
//! spawns it for one run and talks to it over stdio ([`wire`]). The plugin
//! refuses to start unless the settings file says it is active and its own
//! bytes match the install pin ([`gate`]). Credentials come from the
//! provider's local tool inside this process ([`source`]); every refusal
//! becomes a vetted notice line in the file the daemon's Settings route reads
//! ([`notices`]).

pub mod gate;
pub mod notices;
pub mod serve;
pub mod source;
pub mod wire;

use std::process::ExitCode;

use opensesame_plugin_settings::default_settings_path;

use self::serve::{serve, ServeOptions};
use self::wire::ErrorReply;

/// Exit status when the gate refuses. Distinct from a run that could not
/// start, so the parent can tell "not allowed" from "not possible".
pub const EXIT_REFUSED: u8 = 3;
/// Exit status when the run could not start.
pub const EXIT_START_FAILED: u8 = 2;

/// The binary's whole `main`.
#[must_use]
pub fn main_entry() -> ExitCode {
    let Ok(runtime) = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    else {
        return ExitCode::from(EXIT_START_FAILED);
    };
    let code = runtime.block_on(run());
    // Stdin is read on a blocking thread that only returns at EOF; a run that
    // ended on its TTL or a signal must not wait for the parent to close it.
    runtime.shutdown_timeout(std::time::Duration::from_millis(200));
    code
}

async fn run() -> ExitCode {
    let admitted = default_settings_path()
        .map_err(|_| gate::GateError::Settings)
        .and_then(|settings| {
            let own = std::env::current_exe().map_err(|_| gate::GateError::PinMismatch)?;
            gate::admit(&settings, &own, |key| std::env::var(key).ok())
        });
    let admitted = match admitted {
        Ok(admitted) => admitted,
        Err(error) => {
            refuse(&error.to_string());
            return ExitCode::from(EXIT_REFUSED);
        }
    };
    let input = tokio::io::BufReader::new(tokio::io::stdin());
    let output = tokio::io::stdout();
    match serve(
        &admitted,
        ServeOptions::production(),
        input,
        output,
        stop_signal(),
    )
    .await
    {
        Ok(_) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("opensesame-surrogate-proxy: {error}");
            ExitCode::from(EXIT_START_FAILED)
        }
    }
}

/// One error line on stdout and one on stderr: a class, never a value.
fn refuse(class: &str) {
    let line = serde_json::to_string(&ErrorReply {
        error: class.to_owned(),
    })
    .unwrap_or_default();
    println!("{line}");
    eprintln!("opensesame-surrogate-proxy: {class}");
}

/// `SIGTERM` or `SIGINT` (Ctrl-C elsewhere).
async fn stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let (Ok(mut term), Ok(mut int)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
        ) else {
            return std::future::pending().await;
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
