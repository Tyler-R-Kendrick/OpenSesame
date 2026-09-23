//! `pass protect rewrap | remove | root-rotate` — the verbs that change who can
//! open the store, and therefore rotate the root key by default.
//!
//! Rewrapping or removing a protector without a new root is not revocation:
//! the store's history (and any pushed remote) keeps the previous
//! `.opensesame-key`, and its wrap still opens the unchanged root. So both
//! verbs re-encrypt the store under a new root unless `--no-rotate` is given,
//! and then they say plainly that nothing was revoked.

use std::path::Path;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use opensesame_sealed_store::{
    protect_remove_store, protect_rewrap_store_password, rotate_store_root, RotationEdit,
    RotationOutcome,
};

use super::require_yes;
use crate::store::{prompt_password, require_reveal, resolve_root};

/// Flags shared by every verb that can rotate the root key.
#[derive(clap::Args, Debug, Default, Clone, Copy)]
pub struct RotateArgs {
    /// Replace each recovery key with a new one; a recovery wrap cannot follow
    /// a new root without its secret. Requires --reveal.
    #[arg(long)]
    pub reissue_recovery: bool,
    /// Print each reissued recovery key once.
    #[arg(long)]
    pub reveal: bool,
}

const NOT_REVOKED: &str = "warning: the root key was NOT rotated (--no-rotate). The previous \
     .opensesame-key is still in this store's git history and any pushed remote, and its wrap \
     still opens every entry. Run `opensesame pass protect root-rotate --yes` to revoke it.";

const HISTORY_NOTE: &str = "note: ciphertext already in git history (and any pushed remote) \
     still opens with the previous root; rotation covers the current store and everything \
     written from now on, not history";

fn check_rotate_args(args: RotateArgs, no_rotate: bool) -> anyhow::Result<()> {
    if args.reissue_recovery && no_rotate {
        anyhow::bail!("--reissue-recovery only applies to a rotation; drop --no-rotate");
    }
    if args.reissue_recovery && !args.reveal {
        anyhow::bail!("--reissue-recovery prints the new recovery key once; pass --reveal");
    }
    if args.reveal {
        require_reveal(true)?;
    }
    Ok(())
}

pub fn cmd_protect_rewrap(
    path: Option<&Path>,
    tomb: Option<&str>,
    yes: bool,
    no_rotate: bool,
    args: RotateArgs,
) -> anyhow::Result<()> {
    require_yes(yes, "rewrap")?;
    check_rotate_args(args, no_rotate)?;
    let root = resolve_root(path, tomb)?;
    let old = prompt_password("Current store passphrase")?;
    let new = prompt_password("New store passphrase")?;
    let confirm = prompt_password("Confirm new store passphrase")?;
    if new != confirm {
        anyhow::bail!("passphrases do not match");
    }
    if no_rotate {
        protect_rewrap_store_password(&root, old.as_bytes(), new.as_bytes())?;
        eprintln!("rewrapped the password protector; the root key is unchanged");
        eprintln!("{NOT_REVOKED}");
        return Ok(());
    }
    let edit = RotationEdit {
        new_password: Some(new.as_bytes()),
        reissue_recovery: args.reissue_recovery,
        ..RotationEdit::default()
    };
    let outcome = rotate_store_root(&root, old.as_bytes(), edit)?;
    eprintln!(
        "rewrapped under the new passphrase; the previous passphrase no longer opens the store"
    );
    report(&outcome, args);
    Ok(())
}

pub fn cmd_protect_remove(
    protector_id: &str,
    path: Option<&Path>,
    tomb: Option<&str>,
    yes: bool,
    no_rotate: bool,
    args: RotateArgs,
) -> anyhow::Result<()> {
    require_yes(yes, "remove protector")?;
    check_rotate_args(args, no_rotate)?;
    let root = resolve_root(path, tomb)?;
    let password = prompt_password("Store passphrase")?;
    if no_rotate {
        protect_remove_store(&root, password.as_bytes(), protector_id)?;
        eprintln!("removed {protector_id} from the key file; the root key is unchanged");
        eprintln!("{NOT_REVOKED}");
        return Ok(());
    }
    let edit = RotationEdit {
        remove_protector: Some(protector_id),
        reissue_recovery: args.reissue_recovery,
        ..RotationEdit::default()
    };
    let outcome = rotate_store_root(&root, password.as_bytes(), edit)?;
    eprintln!("removed {protector_id}; it no longer opens the store");
    report(&outcome, args);
    Ok(())
}

pub fn cmd_protect_root_rotate(
    path: Option<&Path>,
    tomb: Option<&str>,
    yes: bool,
    args: RotateArgs,
) -> anyhow::Result<()> {
    require_yes(yes, "root-rotate")?;
    check_rotate_args(args, false)?;
    let root = resolve_root(path, tomb)?;
    let password = prompt_password("Store passphrase")?;
    let edit = RotationEdit {
        reissue_recovery: args.reissue_recovery,
        ..RotationEdit::default()
    };
    let outcome = rotate_store_root(&root, password.as_bytes(), edit)?;
    report(&outcome, args);
    Ok(())
}

fn report(outcome: &RotationOutcome, args: RotateArgs) {
    eprintln!(
        "root key rotated (epoch {}): re-encrypted {} entries and {} attachments",
        outcome.root_epoch, outcome.entries, outcome.attachments
    );
    if outcome.foreign_entries > 0 {
        eprintln!(
            "note: {} gpg/age entries are not sealed under the root key and were left unchanged",
            outcome.foreign_entries
        );
    }
    eprintln!("{HISTORY_NOTE}");
    for recovery in &outcome.reissued_recovery {
        println!(
            "protector={} kind=recovery-key fingerprint={}",
            recovery.protector_id, recovery.fingerprint_b64
        );
        if args.reveal {
            println!("recovery={}", URL_SAFE_NO_PAD.encode(recovery.secret));
        }
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::super::{PassProtectCmd, PassProtectRecoveryCmd};
    use super::*;

    #[derive(Parser)]
    struct Harness {
        #[command(subcommand)]
        cmd: PassProtectCmd,
    }

    fn parse(args: &[&str]) -> Result<PassProtectCmd, clap::Error> {
        Harness::try_parse_from(std::iter::once("protect").chain(args.iter().copied()))
            .map(|h| h.cmd)
    }

    #[test]
    fn rewrap_and_remove_rotate_unless_told_not_to() {
        let Ok(PassProtectCmd::Rewrap { no_rotate, .. }) = parse(&["rewrap", "--yes"]) else {
            panic!("rewrap parses");
        };
        assert!(!no_rotate);
        let Ok(PassProtectCmd::Remove { no_rotate, .. }) =
            parse(&["remove", "abc", "--yes", "--no-rotate"])
        else {
            panic!("remove parses");
        };
        assert!(no_rotate);
    }

    #[test]
    fn reissuing_recovery_needs_reveal_and_a_rotation() {
        let bare = RotateArgs {
            reissue_recovery: true,
            reveal: false,
        };
        assert!(check_rotate_args(bare, false).is_err());
        let shown = RotateArgs {
            reissue_recovery: true,
            reveal: true,
        };
        assert!(check_rotate_args(shown, true).is_err());
        assert!(check_rotate_args(shown, false).is_ok());
    }

    /// A recovery key on argv lands in shell history and `/proc/<pid>/cmdline`.
    #[test]
    fn recovery_test_refuses_the_secret_on_argv() {
        assert!(parse(&["recovery", "test", "AAAA"]).is_err());
        assert!(matches!(
            parse(&["recovery", "test"]),
            Ok(PassProtectCmd::Recovery {
                cmd: PassProtectRecoveryCmd::Test { .. }
            })
        ));
    }
}
