//! `opensesame vault circle recover|inspect`: the exit door of a trusted-contacts
//! circle (ADR 0187). The owner's browser sealed a payload in a recovery bundle
//! and gave each guardian one SLIP-0039 share of the key that opens it, written
//! with an empty passphrase; these verbs do what the browser's recovery does,
//! with no browser, through `opensesame-quorum-recovery` (the native reader of
//! the same vectors and fixture, ADR 0139).
//!
//! Human and terminal only: nothing here is an MCP or `WebMCP` tool, and no share
//! or recovered byte reaches a log, an error or stderr. A share on the command
//! line is visible to `ps` and the shell history, so shares are better read from
//! a file (`--share-file`) or stdin (`--share -`).

use std::fmt;
use std::io::{IsTerminal, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::Context as _;
use clap::Subcommand;
use opensesame_connector_host::password_agent::reveal_gate::agent_context_detected;
use opensesame_quorum_recovery::slip39::decode_share;
use opensesame_quorum_recovery::{
    match_shares, recover, BundleError, RecoverError, RecoveryBundle, ShareMatch,
};
use zeroize::Zeroizing;

use crate::private_file::{write_private, write_private_new};

mod render;
use render::render_inspect;

/// More than this is not a list of shares.
const SHARE_INPUT_LIMIT: u64 = 1 << 20;

#[derive(Subcommand)]
pub(crate) enum CircleCmd {
    /// Recombine a circle's shares and open its recovery bundle without a browser.
    ///
    /// Give the bundle the owner kept and the shares the guardians hold (enough
    /// of them: the threshold of each group the circle's policy asks for). The
    /// bundle's policy must carry the owner's signature. The payload is written
    /// to --out; shares and payload are never printed.
    ///
    /// Shares: put them in a file, one per line (blank lines and lines starting
    /// with # are skipped) and pass --share-file, or pipe them with `--share -`.
    /// A share given as --share <words> is visible to other users through `ps`
    /// and stays in your shell history.
    Recover {
        /// The recovery bundle (JSON) the owner kept.
        #[arg(long, value_name = "FILE")]
        bundle: PathBuf,
        /// One share's words, or `-` to read shares from stdin, one per line.
        #[arg(long = "share", value_name = "WORDS|-")]
        share: Vec<String>,
        /// A file of shares, one per line.
        #[arg(long = "share-file", value_name = "FILE")]
        share_file: Vec<PathBuf>,
        /// Where to write the payload: a new file (mode 0600), or `-` for stdout.
        #[arg(long, value_name = "FILE|-")]
        out: PathBuf,
        /// Refuse a bundle whose policy is not signed by this owner key (base64url).
        #[arg(long, value_name = "KEY")]
        owner_key: Option<String>,
        /// Replace --out if it exists.
        #[arg(long)]
        force: bool,
    },
    /// Verify a bundle's owner signature and print the circle's public shape.
    ///
    /// Reads no share and opens nothing: the circle's id and epoch, its groups
    /// and thresholds, its guardians' names and its timings.
    Inspect {
        /// The recovery bundle (JSON).
        #[arg(long, value_name = "FILE")]
        bundle: PathBuf,
        /// Refuse a bundle whose policy is not signed by this owner key (base64url).
        #[arg(long, value_name = "KEY")]
        owner_key: Option<String>,
    },
}

/// `--share` values are secrets; a debug print of the command must not show them.
impl fmt::Debug for CircleCmd {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Recover {
                bundle,
                share,
                share_file,
                out,
                ..
            } => f
                .debug_struct("Recover")
                .field("bundle", bundle)
                .field("share", &format_args!("[REDACTED; {}]", share.len()))
                .field("share_file", share_file)
                .field("out", out)
                .finish_non_exhaustive(),
            Self::Inspect { bundle, .. } => f
                .debug_struct("Inspect")
                .field("bundle", bundle)
                .finish_non_exhaustive(),
        }
    }
}

pub(crate) fn run(output: &str, cmd: CircleCmd) -> anyhow::Result<()> {
    match cmd {
        CircleCmd::Recover {
            bundle,
            share,
            share_file,
            out,
            owner_key,
            force,
        } => {
            refuse_in_agent_context()?;
            let bundle = read_bundle(&bundle, owner_key.as_deref())?;
            let shares = collect_shares(&share, &share_file)?;
            recover_to(&bundle, &shares, &out, force)
        }
        CircleCmd::Inspect { bundle, owner_key } => {
            let bundle = read_bundle(&bundle, owner_key.as_deref())?;
            println!("{}", render_inspect(&bundle, output));
            Ok(())
        }
    }
}

/// The same refuse-only agent detection the `pass` reveal verbs use
/// (`spec/conformance/cli-reveal-gate.json`): recovery is a person's act, and
/// the detection can refuse but never allow.
fn refuse_in_agent_context() -> anyhow::Result<()> {
    anyhow::ensure!(
        !agent_context_detected(),
        "Refusing to recover a circle in an agent context: it is a person's act at a terminal"
    );
    Ok(())
}

fn read_bundle(path: &Path, owner_key: Option<&str>) -> anyhow::Result<RecoveryBundle> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| anyhow::anyhow!("cannot read {}: {error}", path.display()))?;
    RecoveryBundle::parse(&text, owner_key).map_err(|error| match error {
        BundleError::Malformed(reason) => anyhow::anyhow!("Not a recovery bundle: {reason}"),
        BundleError::Policy(refusal) => anyhow::anyhow!("Refused: {refusal}"),
        BundleError::Open => anyhow::anyhow!("Refused: {}", BundleError::Open),
    })
}

/// A list of shares as a file or stdin holds it: one per line, `#` comments and
/// blank lines skipped.
fn shares_in(text: &str) -> Vec<Zeroizing<String>> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| Zeroizing::new(line.to_owned()))
        .collect()
}

fn read_limited(reader: impl Read) -> anyhow::Result<Zeroizing<String>> {
    let mut text = Zeroizing::new(String::new());
    reader
        .take(SHARE_INPUT_LIMIT + 1)
        .read_to_string(&mut text)
        .context("cannot read shares")?;
    anyhow::ensure!(
        u64::try_from(text.len()).is_ok_and(|n| n <= SHARE_INPUT_LIMIT),
        "that is too much text to be shares"
    );
    Ok(text)
}

/// Shares typed at a terminal are read without echo, until an empty line.
fn shares_from_terminal() -> anyhow::Result<Vec<Zeroizing<String>>> {
    let mut shares = Vec::new();
    loop {
        let prompt = format!("Share {} (empty line to finish)", shares.len() + 1);
        let line = Zeroizing::new(crate::store::prompt_secret_hidden(&prompt)?);
        if line.trim().is_empty() {
            return Ok(shares);
        }
        shares.push(Zeroizing::new(line.trim().to_owned()));
    }
}

fn shares_from_stdin() -> anyhow::Result<Vec<Zeroizing<String>>> {
    if std::io::stdin().is_terminal() {
        return shares_from_terminal();
    }
    Ok(shares_in(&read_limited(std::io::stdin().lock())?))
}

fn collect_shares(args: &[String], files: &[PathBuf]) -> anyhow::Result<Vec<Zeroizing<String>>> {
    anyhow::ensure!(
        args.iter().filter(|a| a.as_str() == "-").count() <= 1,
        "`--share -` reads stdin once; put every share on its own line"
    );
    let mut shares = Vec::new();
    for arg in args {
        if arg == "-" {
            shares.extend(shares_from_stdin()?);
        } else {
            eprintln!(
                "warning: a share on the command line is visible to other users (ps) and stays in your shell history; prefer --share-file or `--share -`"
            );
            shares.push(Zeroizing::new(arg.trim().to_owned()));
        }
    }
    for path in files {
        let file = std::fs::File::open(path)
            .map_err(|error| anyhow::anyhow!("cannot read {}: {error}", path.display()))?;
        shares.extend(shares_in(&read_limited(file)?));
    }
    anyhow::ensure!(
        !shares.is_empty(),
        "no shares given: use --share-file <file> or --share -"
    );
    Ok(shares)
}

/// Whom each share belongs to, by name, and nothing of the share itself.
fn describe_matches(matches: &[ShareMatch]) {
    for m in matches {
        match &m.guardian {
            Some(g) => eprintln!("share {}: {} ({})", m.position, g.name, g.group_id),
            None => eprintln!(
                "share {}: no guardian of this circle committed to this share (damaged, or from another circle)",
                m.position
            ),
        }
    }
}

fn recover_to(
    bundle: &RecoveryBundle,
    shares: &[Zeroizing<String>],
    out: &Path,
    force: bool,
) -> anyhow::Result<()> {
    let policy = &bundle.signed_policy.policy;
    eprintln!(
        "circle {} \"{}\", epoch {}, signed by owner key {}",
        policy.circle_id, policy.label, policy.epoch, policy.owner_key
    );
    describe_matches(&match_shares(policy, shares));
    // Refuse before the work, not after it, when a share is unreadable or the
    // output cannot be written.
    check_shares_decode(shares)?;
    check_destination(out, force)?;
    let recovered = recover(bundle, shares).map_err(|error| match error {
        RecoverError::Bundle(BundleError::Open) => {
            anyhow::anyhow!("{error}; check that every share is this circle's and this epoch's")
        }
        other => anyhow::anyhow!("{other}"),
    })?;
    write_payload(out, recovered.payload.expose(), force)?;
    eprintln!(
        "recovered {} bytes from {} shares",
        recovered.payload.len(),
        shares.len()
    );
    Ok(())
}

/// A share that does not decode is named by its position, never quoted.
fn check_shares_decode(shares: &[Zeroizing<String>]) -> anyhow::Result<()> {
    for (i, share) in shares.iter().enumerate() {
        decode_share(share).map_err(|error| {
            anyhow::anyhow!("share {} is not a valid SLIP-0039 share: {error}", i + 1)
        })?;
    }
    Ok(())
}

fn is_stdout(path: &Path) -> bool {
    path.as_os_str() == "-"
}

fn check_destination(out: &Path, force: bool) -> anyhow::Result<()> {
    if is_stdout(out) {
        anyhow::ensure!(
            !std::io::stdout().is_terminal(),
            "refusing to print the recovered payload to a terminal: redirect it, or use --out <file>"
        );
    } else if !force {
        anyhow::ensure!(
            !out.exists(),
            "{} exists; use --force to replace it",
            out.display()
        );
    }
    Ok(())
}

fn write_payload(out: &Path, payload: &[u8], force: bool) -> anyhow::Result<()> {
    if is_stdout(out) {
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(payload)?;
        return Ok(stdout.flush()?);
    }
    let written = if force {
        write_private(out, payload)
    } else {
        write_private_new(out, payload)
    };
    written.map_err(|error| anyhow::anyhow!("cannot write {}: {error}", out.display()))?;
    eprintln!("wrote {}", out.display());
    Ok(())
}

#[cfg(test)]
#[path = "circle_tests.rs"]
mod tests;
