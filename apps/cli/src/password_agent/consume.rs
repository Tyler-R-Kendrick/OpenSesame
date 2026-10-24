use clap::Subcommand;
use opensesame_connector_host::password_agent::env as core;
use std::{io::Write, path::PathBuf, process::Command};
#[derive(Subcommand, Debug)]
pub(crate) enum Env {
    Write {
        file: PathBuf,
        #[arg(required = true)]
        env: Vec<String>,
    },
    Run {
        file: PathBuf,
        #[arg(last = true, required = true)]
        command: Vec<String>,
    },
}
pub(super) fn reveal(reference: &str, desktop: bool, reveal: bool) -> anyhow::Result<()> {
    use opensesame_connector_host::password_agent::reveal_gate::{
        assert_human_reveal, emit_reveal_receipt, HumanRevealRequest,
    };
    anyhow::ensure!(reference.starts_with("op://"), "Expected op://reference");
    assert_human_reveal(HumanRevealRequest {
        verb: "reveal",
        reveal,
        desktop,
        reference: Some(reference),
        stdin_tty: None,
        stdout_tty: None,
    })?;
    if reveal {
        crate::cli_app_integration::ensure_reveal("reveal", Some(reference))?;
    }
    emit_reveal_receipt("reveal", Some(reference));
    std::io::stdout().write_all(&super::io::op(
        &["read".into(), reference.into()],
        None,
        None,
    )?)?;
    Ok(())
}
pub(super) fn run_assignments(
    assignments: &[String],
    command: &[String],
    grant_approved: bool,
) -> anyhow::Result<()> {
    core::validate_run_assignments(assignments)?;
    if !grant_approved {
        crate::cli_app_integration::ensure_reveal("run", None)?;
    }
    let mut args = super::io::host("op")?;
    args.arg("run");
    for assignment in assignments {
        let (name, reference) = core::assignment(assignment)?;
        args.env(name, reference);
    }
    finish(launch(args, command)?);
    Ok(())
}
fn launch(mut op: Command, command: &[String]) -> anyhow::Result<std::process::ExitStatus> {
    anyhow::ensure!(!command.is_empty(), "A child command is required");
    super::credential::authenticate(&mut op)?;
    op.args([
        "--",
        std::env::current_exe()?
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid executable path"))?,
        "password-agent",
        "internal-exec",
        "--",
    ])
    .args(command);
    op.status()
        .map_err(|_| anyhow::anyhow!("1Password CLI could not be started"))
}
fn finish(status: std::process::ExitStatus) {
    if !status.success() {
        std::process::exit(status.code().unwrap_or(1));
    }
}
pub(super) fn internal_exec(command: &[String]) -> anyhow::Result<()> {
    let (program, args) = command
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("A child command is required"))?;
    let status = Command::new(program)
        .args(args)
        .env_remove("OP_SERVICE_ACCOUNT_TOKEN")
        .status()?;
    if !status.success() {
        std::process::exit(status.code().unwrap_or(1));
    }
    Ok(())
}
pub(super) fn internal_batch(count: usize) -> anyhow::Result<()> {
    let values = (0..count)
        .map(|i| {
            std::env::var(format!("OPENSESAME_SECRET_{i}"))
                .map_err(|_| anyhow::anyhow!("Missing batch value"))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    std::io::stdout().write_all(&serde_json::to_vec(&values)?)?;
    Ok(())
}
pub(super) fn env(cmd: Env) -> anyhow::Result<()> {
    match cmd {
        Env::Write { file, env } => {
            let assignments = env
                .iter()
                .map(|input| core::assignment(input))
                .collect::<anyhow::Result<Vec<_>>>()?;
            let mut text = String::new();
            for (name, reference) in assignments {
                text.push_str(&name);
                text.push('=');
                text.push_str(&reference);
                text.push('\n');
            }
            std::fs::write(file, text)?;
        }
        Env::Run { file, command } => {
            crate::cli_app_integration::ensure_reveal("run", None)?;
            let content = zeroize::Zeroizing::new(std::fs::read_to_string(file)?);
            core::validate_run_template(&content)?;
            let mut snapshot = tempfile::NamedTempFile::new()?;
            snapshot.write_all(content.as_bytes())?;
            let mut op = super::io::host("op")?;
            op.arg("run")
                .arg(format!("--env-file={}", snapshot.path().display()));
            let status = launch(op, &command)?;
            snapshot.close()?;
            finish(status);
        }
    }
    Ok(())
}
