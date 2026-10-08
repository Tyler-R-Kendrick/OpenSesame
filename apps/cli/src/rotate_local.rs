//! Local web-login recipe signing (ADR 0076 §4, ADR 0159).
//!
//! Host-held recipe storage is gone from this binary; only acts that read a
//! private key file on disk remain.

#[path = "rotate_recipes_sign.rs"]
mod sign;

use std::path::PathBuf;

use anyhow::Result;
use clap::Subcommand;
use serde_json::Value;

#[derive(Subcommand, Debug)]
pub(crate) enum RotateCmd {
    /// Sign or inspect recipe documents with a local key file.
    Recipe {
        #[command(subcommand)]
        cmd: LocalRecipeCmd,
    },
    /// Create a signing key file (mode 0600).
    Signer {
        #[command(subcommand)]
        cmd: LocalSignerCmd,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum LocalRecipeCmd {
    /// Sign a recipe with a private key file. Prints the signed document, or
    /// writes it to --out. Never talks to a Host.
    Sign {
        /// The signing key: 64 hex characters, mode 0600. From `rotate signer keygen`.
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
        /// Set the recipe to expire this many days from now (1 to 93).
        #[arg(long, value_parser = clap::value_parser!(i64).range(1..=93))]
        expires_in_days: Option<i64>,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum LocalSignerCmd {
    /// Make a signing key file (mode 0600, never overwritten). Prints only its
    /// public half and id.
    Keygen {
        /// Where to write the private key.
        #[arg(long)]
        out: PathBuf,
    },
}

pub(crate) fn run(cmd: RotateCmd) -> Result<()> {
    match cmd {
        RotateCmd::Recipe {
            cmd: LocalRecipeCmd::Sign {
                key,
                file,
                out,
                canary_at,
                expires_in_days,
            },
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
        RotateCmd::Signer {
            cmd: LocalSignerCmd::Keygen { out },
        } => {
            let body: Value = sign::keygen(&out)?;
            println!("{}", serde_json::to_string_pretty(&body)?);
            Ok(())
        }
    }
}
