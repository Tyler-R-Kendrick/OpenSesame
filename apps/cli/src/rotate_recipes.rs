//! `opensesame access connectors rotate …` and the recipes a web-login run replays (ADR 0076
//! §4, ADR 0159).
//!
//! The recipe verbs read and write the organization's recipes on the Host;
//! the signer verbs pin the Ed25519 public keys the organization trusts to
//! sign them. **Signing is local**: `recipe sign --key FILE` reads a private
//! key from a file and never names a Host, and `signer keygen` makes the file.
//! The Host takes only public keys, derives a recipe's trust from a signature
//! it checks itself, and refuses any request that names a trust.
//!
//! The order of an operator's first recipe, each step a verb:
//!
//! 1. `signer keygen --out KEY`, then `signer add --key KEY --label NAME`
//!    (a step-up: the operator token or a fresh passkey);
//! 2. `recipe sign --key KEY recipe.json --out signed.json`;
//! 3. `recipe put signed.json --if-version 0`;
//! 4. `recipe canary ORIGIN` — one attended run, driven from your browser,
//!    whose completion is the recipe's canary (`recipe get` shows it); an
//!    unattended run needs one.
//!
//! An agent has none of these (ADR 0076 §1, ADR 0159): the recipes govern it.

#[path = "rotate_recipes_call.rs"]
mod call;
#[path = "rotate_recipes_sign.rs"]
mod sign;
#[cfg(test)]
#[path = "rotate_recipes_tests.rs"]
mod tests;

use std::path::PathBuf;

use anyhow::{bail, Result};
use clap::Subcommand;
use reqwest::Method;
use serde_json::{json, Value};

use call::{call, failure, origin_path, Reply, RECIPES, SIGNERS};

#[derive(Subcommand, Debug)]
pub(crate) enum RotateCmd {
    /// Sandboxed runs and where each one is (metadata only).
    Runs,
    /// Read a run's observation log. Sealed: sizes and lanes, never content.
    Watch {
        /// The run id, from `opensesame access connectors rotate runs`.
        run: String,
        /// Start after this sequence number. Defaults to the whole log.
        #[arg(long, default_value = "-1")]
        after: i64,
        /// Keep polling for new entries.
        #[arg(long)]
        follow: bool,
    },
    /// Ask the agent to park so a person can take the page.
    Attach {
        /// The run id, from `opensesame access connectors rotate runs`.
        run: String,
    },
    /// Read a Host-run agent's hook records: what each interceptor decided,
    /// value-blind (no messages, targets or transform values).
    Hooks {
        /// The run id, from `opensesame access connectors rotate runs`.
        run: String,
        /// Start after this record sequence number. Defaults to the start.
        #[arg(long, default_value = "-1")]
        after: i64,
        /// Keep polling for new records.
        #[arg(long)]
        follow: bool,
    },
    /// The recipes a web-login run replays: store, read, sign, remove, and
    /// prove one with an attended run.
    Recipe {
        #[command(subcommand)]
        cmd: RecipeCmd,
    },
    /// The keys the organization trusts to sign recipes.
    Signer {
        #[command(subcommand)]
        cmd: SignerCmd,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum RecipeCmd {
    /// The organization's recipes, and whether a run may replay each.
    Ls,
    /// One recipe and what the Host verified about it.
    Get {
        /// The relying party's origin, like <https://login.example>.
        origin: String,
        /// Print only the recipe document, ready to edit and sign again.
        #[arg(long)]
        document: bool,
    },
    /// Store a recipe (compare-and-set). The Host checks its signature against
    /// the pinned signers and derives its trust; an unsigned recipe is stored
    /// as a candidate no run replays.
    Put {
        /// The recipe document (JSON).
        file: PathBuf,
        /// The version this write was made against, as `get` printed it
        /// (0 for a new recipe).
        #[arg(long)]
        if_version: u64,
    },
    /// Remove a recipe (compare-and-set).
    Rm {
        origin: String,
        /// The version being removed, as `get` printed it.
        #[arg(long)]
        if_version: u64,
    },
    /// Sign a recipe with a private key file, locally. Prints the signed
    /// document, or writes it to --out. Never names a Host.
    Sign {
        /// The signing key: 64 hex characters, mode 0600. From `signer keygen`.
        #[arg(long)]
        key: PathBuf,
        /// The recipe document (JSON). Any signature it carries is replaced.
        file: PathBuf,
        /// Write the signed document here instead of printing it.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Attest that the recipe completed a real change, verified by a fresh
        /// login, at this time (`now` or RFC 3339). You answer for it.
        #[arg(long)]
        canary_at: Option<String>,
        /// Set the recipe to expire this many days from now (1 to 93), so a
        /// renewal re-signs the same steps with a fresh window.
        #[arg(long, value_parser = clap::value_parser!(i64).range(1..=93))]
        expires_in_days: Option<i64>,
    },
    /// Start one attended run of a verified recipe, driven from your own
    /// browser. A completed run is the recipe's canary.
    Canary { origin: String },
}

#[derive(Subcommand, Debug)]
pub(crate) enum SignerCmd {
    /// The keys pinned for the organization, revoked ones included.
    Ls,
    /// Pin a public key. Needs the operator token or a fresh passkey step-up.
    Add {
        /// The Ed25519 public key (64 hex characters)...
        #[arg(long, required_unless_present = "key", conflicts_with = "key")]
        public_key: Option<String>,
        /// ...or a signing key file to take the public half of.
        #[arg(long)]
        key: Option<PathBuf>,
        /// A name for the key, 1 to 80 characters.
        #[arg(long)]
        label: String,
    },
    /// Revoke a key, for good. Recipes it signed stop at their next run.
    Rm {
        /// The key id, from `signer ls` (`rsk_…`).
        key_id: String,
    },
    /// Make a signing key file (mode 0600, never overwritten). Prints only its
    /// public half and id. Local; never names a Host.
    Keygen {
        /// Where to write the private key.
        #[arg(long)]
        out: PathBuf,
    },
}

fn print(body: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(body)?);
    Ok(())
}

fn field<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or("-")
}

fn table(
    output: &str,
    body: &Value,
    key: &str,
    header: &str,
    line: fn(&Value) -> String,
) -> Result<()> {
    if output == "json" {
        return print(body);
    }
    let rows = body
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rows.is_empty() {
        println!("None.");
        return Ok(());
    }
    println!("{header}");
    for row in &rows {
        println!("{}", line(row));
    }
    Ok(())
}

fn recipe_line(row: &Value) -> String {
    let canary = row["canary"]["result"]
        .as_str()
        .map_or("-".to_owned(), |result| {
            format!("{result} ({})", field(&row["canary"], "source"))
        });
    format!(
        "{:<34} {:<16} {:>3} {:<38} {:<18} {:<8} {}",
        field(row, "origin"),
        field(row, "trust"),
        row["version"].as_i64().unwrap_or_default(),
        field(row, "signer_key_id"),
        canary,
        if row["runnable"]["attended"].as_bool() == Some(true) {
            "yes"
        } else {
            "no"
        },
        if row["runnable"]["unattended"].as_bool() == Some(true) {
            "yes"
        } else {
            "no"
        },
    )
}

fn signer_line(row: &Value) -> String {
    format!(
        "{:<38} {:<24} {:<26} {}",
        field(row, "key_id"),
        field(row, "label"),
        field(row, "pinned_at"),
        if row["revoked_at"].is_string() {
            "revoked"
        } else {
            "active"
        },
    )
}

fn checked(reply: Reply, what: &str, reread: &str, if_version: Option<u64>) -> Result<Value> {
    if !reply.status.is_success() {
        bail!(failure(&reply, what, reread, if_version));
    }
    Ok(reply.body)
}

/// `opensesame access connectors rotate recipe …`.
pub(crate) async fn run_recipe(server: &str, output: &str, cmd: RecipeCmd) -> Result<()> {
    const READ: &str = "opensesame access connectors rotate recipe get ORIGIN";
    match cmd {
        RecipeCmd::Ls => {
            let reply = call(server, Method::GET, RECIPES, None, None).await?;
            let body = checked(
                reply,
                "the recipes",
                "opensesame access connectors rotate recipe ls",
                None,
            )?;
            table(
                output,
                &body,
                "recipes",
                &format!(
                    "{:<34} {:<16} {:>3} {:<38} {:<18} {:<8} UNATTENDED",
                    "ORIGIN", "TRUST", "VER", "SIGNER", "CANARY", "ATTENDED"
                ),
                recipe_line,
            )
        }
        RecipeCmd::Get { origin, document } => {
            let reply = call(server, Method::GET, &origin_path(&origin)?, None, None).await?;
            let body = checked(reply, "the recipe", READ, None)?;
            print(if document { &body["document"] } else { &body })
        }
        RecipeCmd::Put { file, if_version } => {
            let (text, document) = sign::read_recipe(&file)?;
            let path = origin_path(&document.origin)?;
            let reply = call(server, Method::PUT, &path, Some(if_version), Some(text)).await?;
            print(&checked(reply, "the recipe", READ, Some(if_version))?)
        }
        RecipeCmd::Rm { origin, if_version } => {
            let path = origin_path(&origin)?;
            let reply = call(server, Method::DELETE, &path, Some(if_version), None).await?;
            print(&checked(reply, "the recipe", READ, Some(if_version))?)
        }
        RecipeCmd::Sign {
            key,
            file,
            out,
            canary_at,
            expires_in_days,
        } => {
            let options = sign::SignOptions {
                canary_at: canary_at.as_deref(),
                expires_in_days,
            };
            let signed = sign::sign(&key, &file, options)?;
            sign::emit(&signed, out.as_deref())?;
            if let Some(signature) = &signed.signature {
                eprintln!("signed {} with {}", signed.origin, signature.key_id);
            }
            Ok(())
        }
        RecipeCmd::Canary { origin } => {
            let path = format!("{}/canary", origin_path(&origin)?);
            let reply = call(server, Method::POST, &path, None, None).await?;
            print(&checked(reply, "the recipe", READ, None)?)
        }
    }
}

/// `opensesame access connectors rotate signer …`.
pub(crate) async fn run_signer(server: &str, output: &str, cmd: SignerCmd) -> Result<()> {
    match cmd {
        SignerCmd::Ls => {
            let reply = call(server, Method::GET, SIGNERS, None, None).await?;
            let body = checked(
                reply,
                "the signers",
                "opensesame access connectors rotate signer ls",
                None,
            )?;
            table(
                output,
                &body,
                "signers",
                &format!("{:<38} {:<24} {:<26} STATE", "KEY", "LABEL", "PINNED"),
                signer_line,
            )
        }
        SignerCmd::Add {
            public_key,
            key,
            label,
        } => {
            let public = match (public_key, key) {
                (Some(public), None) => public,
                (None, Some(key)) => sign::public_half(&key)?.1,
                _ => bail!("name --public-key or --key, not both"),
            };
            let body = json!({"public_key": public, "label": label}).to_string();
            let reply = call(server, Method::POST, SIGNERS, None, Some(body)).await?;
            print(&checked(
                reply,
                "pinning a recipe signer",
                "opensesame access connectors rotate signer ls",
                None,
            )?)
        }
        SignerCmd::Rm { key_id } => {
            let path = format!("{SIGNERS}/{key_id}");
            let reply = call(server, Method::DELETE, &path, None, None).await?;
            print(&checked(
                reply,
                "revoking a recipe signer",
                "opensesame access connectors rotate signer ls",
                None,
            )?)
        }
        SignerCmd::Keygen { out } => print(&sign::keygen(&out)?),
    }
}
