//! `opensesame pass otp` clap types + dispatch.

use std::path::PathBuf;

use clap::Subcommand;

use opensesame_sealed_store::validate_otpauth;

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
    /// Show the stored otpauth URI. It carries the TOTP seed, so it needs a
    /// TTY or --reveal, like `pass show`.
    Uri {
        name: String,
        #[arg(long)]
        reveal: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Validate an otpauth URI read from a hidden prompt or stdin — never argv,
    /// where the seed would land in shell history and `/proc/<pid>/cmdline`.
    Validate {},
}

pub fn run(cmd: PassOtpCmd) -> anyhow::Result<()> {
    match cmd {
        PassOtpCmd::Code { name, path, tomb } => {
            store::cmd_otp_code(&name, path.as_deref(), tomb.as_deref())
        }
        PassOtpCmd::Insert {
            name,
            force,
            echo,
            path,
            tomb,
        } => store::cmd_otp_insert(name, force, echo, path.as_deref(), tomb.as_deref()),
        PassOtpCmd::Append {
            name,
            force,
            echo,
            path,
            tomb,
        } => store::cmd_otp_append(&name, force, echo, path.as_deref(), tomb.as_deref()),
        PassOtpCmd::Uri {
            name,
            reveal,
            path,
            tomb,
        } => store::cmd_otp_uri(&name, reveal, path.as_deref(), tomb.as_deref()),
        PassOtpCmd::Validate {} => cmd_otp_validate(),
    }
}

fn cmd_otp_validate() -> anyhow::Result<()> {
    let uri = store::read_uri_input(false)?;
    if validate_otpauth(&uri) {
        println!("ok");
        Ok(())
    } else {
        anyhow::bail!("invalid otpauth URI");
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::*;

    #[derive(Parser)]
    struct Harness {
        #[command(subcommand)]
        cmd: PassOtpCmd,
    }

    fn parse(args: &[&str]) -> Result<PassOtpCmd, clap::Error> {
        Harness::try_parse_from(std::iter::once("otp").chain(args.iter().copied())).map(|h| h.cmd)
    }

    /// An otpauth URI is the TOTP seed; on argv it lands in shell history.
    #[test]
    fn validate_refuses_the_uri_on_argv() {
        let seed = "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP";
        assert!(parse(&["validate", seed]).is_err());
        assert!(matches!(parse(&["validate"]), Ok(PassOtpCmd::Validate {})));
    }

    #[test]
    fn uri_is_withheld_without_reveal_off_a_terminal() {
        let Ok(PassOtpCmd::Uri { reveal, .. }) = parse(&["uri", "Dev/otp"]) else {
            panic!("uri parses");
        };
        assert!(!reveal);
        if std::io::IsTerminal::is_terminal(&std::io::stdin()) {
            return; // A terminal is allowed to see it; the refusal is for pipes.
        }
        // Refused before any unlock prompt or store read.
        let missing = std::path::Path::new("/nonexistent/opensesame-otp-test");
        let err = store::cmd_otp_uri("Dev/otp", false, Some(missing), None).unwrap_err();
        assert!(err.to_string().contains("--reveal"), "{err}");
    }
}
