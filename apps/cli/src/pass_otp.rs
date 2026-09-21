//! `opensesame pass otp` clap types + dispatch.

use std::path::PathBuf;

use clap::Subcommand;

use crate::store;

#[derive(Subcommand, Debug)]
pub enum PassOtpCmd {
    /// Generate a TOTP code.
    Code {
        name: String,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Insert a new OTP entry from an otpauth URI.
    Insert {
        name: Option<String>,
        #[arg(short, long)]
        force: bool,
        #[arg(short, long)]
        echo: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Append / replace otpauth URI on an existing entry.
    Append {
        name: String,
        #[arg(short, long)]
        force: bool,
        #[arg(short, long)]
        echo: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Show the stored otpauth URI.
    Uri {
        name: String,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Validate an otpauth URI.
    Validate { uri: String },
}

pub fn run(cmd: PassOtpCmd) -> anyhow::Result<()> {
    match cmd {
        PassOtpCmd::Code { name, path, tomb } => {
            store::cmd_otp_code(&name, path.as_deref(), tomb.as_deref())
        }
        PassOtpCmd::Insert { name, force, echo, path, tomb } => {
            store::cmd_otp_insert(name, force, echo, path.as_deref(), tomb.as_deref())
        }
        PassOtpCmd::Append { name, force, echo, path, tomb } => {
            store::cmd_otp_append(&name, force, echo, path.as_deref(), tomb.as_deref())
        }
        PassOtpCmd::Uri { name, path, tomb } => {
            store::cmd_otp_uri(&name, path.as_deref(), tomb.as_deref())
        }
        PassOtpCmd::Validate { uri } => store::cmd_otp_validate(&uri),
    }
}

