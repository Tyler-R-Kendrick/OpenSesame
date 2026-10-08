//! Unit tests of `main.rs`: argument helpers and private session writes.

use super::*;

#[test]
fn a_written_session_is_never_readable_by_anyone_else() {
    let dir = std::env::temp_dir().join(format!("opensesame-cli-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("session.json");

    // Left behind by an earlier version at a wider mode.
    std::fs::write(&path, b"{}").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    }

    write_private(&path, b"{\"access_token\":\"at\"}").unwrap();
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "{\"access_token\":\"at\"}"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "mode was {mode:o}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// `--output` is a *global* option, so a subcommand field of the same name
/// silently claims the same clap arg id and the parser panics at runtime
/// rather than failing to compile. Parsing is the only thing that catches
/// it, so pin every `pass` verb that takes a file argument.
#[test]
fn pass_kdbx_verbs_parse_without_colliding_with_the_global_output_option() {
    use clap::Parser;

    let cli = Cli::parse_from([
        "opensesame",
        "vault",
        "pass",
        "export-kdbx",
        "/tmp/vault.kdbx",
        "--reveal",
    ]);
    let Commands::Vault {
        cmd:
            vault_area::VaultArea::Pass {
                cmd: PassCmd::ExportKdbx { dest, reveal, .. },
            },
    } = cli.command
    else {
        panic!("expected vault pass export-kdbx");
    };
    assert_eq!(dest, PathBuf::from("/tmp/vault.kdbx"));
    assert!(reveal);

    let cli = Cli::parse_from([
        "opensesame",
        "vault",
        "pass",
        "import-kdbx",
        "/tmp/vault.kdbx",
        "--keyfile",
        "/tmp/vault.key",
        "--prefix",
        "Imported",
        "--replace",
    ]);
    let Commands::Vault {
        cmd:
            vault_area::VaultArea::Pass {
                cmd:
                    PassCmd::ImportKdbx {
                        file,
                        keyfile,
                        prefix,
                        replace,
                        ..
                    },
            },
    } = cli.command
    else {
        panic!("expected vault pass import-kdbx");
    };
    assert_eq!(file, PathBuf::from("/tmp/vault.kdbx"));
    assert_eq!(keyfile, Some(PathBuf::from("/tmp/vault.key")));
    assert_eq!(prefix.as_deref(), Some("Imported"));
    assert!(replace);
}

/// The whole command tree must keep parsing; `debug_assert` walks every
/// subcommand and catches id collisions the tests above cannot enumerate.
#[test]
fn the_command_tree_has_no_conflicting_argument_ids() {
    use clap::CommandFactory;
    Cli::command().debug_assert();
}
