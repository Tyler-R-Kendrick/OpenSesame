//! Unit tests of `main.rs`: the TUI renderer and the argument helpers.

use super::*;

#[test]
fn tui_renders_metadata_without_public_config() {
    use ratatui::{backend::TestBackend, Terminal};
    let providers = vec![TuiProvider {
        id: "plain".into(),
        display_name: "Plain environment".into(),
        support: "contract_tested".into(),
    }];
    let connections = vec![CliConnection {
        id: "connection_1".into(),
        provider_id: "plain".into(),
        display_name: "Demo".into(),
        public_config: json!({"path": "must-not-render"}),
    }];
    let mut terminal = Terminal::new(TestBackend::new(100, 12)).unwrap();
    terminal
        .draw(|frame| draw_tui(frame, &providers, &connections))
        .unwrap();
    let buffer = terminal.backend().buffer();
    let rendered: String = (0..buffer.area.height)
        .flat_map(|y| (0..buffer.area.width).map(move |x| buffer[(x, y)].symbol().to_owned()))
        .collect();
    assert!(rendered.contains("Plain environment"));
    assert!(rendered.contains("Demo"));
    assert!(!rendered.contains("must-not-render"));
}

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

#[test]
fn a_server_cannot_choose_an_unbounded_device_code_lifetime() {
    for (given, expected) in [
        (600_i64, 600_i64),
        (0, 1),
        (-5, 1),
        (i64::MAX, MAX_DEVICE_CODE_TTL_SECS),
    ] {
        assert_eq!(given.clamp(1, MAX_DEVICE_CODE_TTL_SECS), expected);
    }
    // The clamp is what keeps this out of chrono, which panics rather than errors.
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let refused = std::panic::catch_unwind(|| chrono::Duration::seconds(i64::MAX)).is_err();
    std::panic::set_hook(hook);
    assert!(refused);
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
        "pass",
        "export-kdbx",
        "/tmp/vault.kdbx",
        "--reveal",
    ]);
    let Commands::Pass {
        cmd: PassCmd::ExportKdbx { dest, reveal, .. },
    } = cli.command
    else {
        panic!("expected pass export-kdbx");
    };
    assert_eq!(dest, PathBuf::from("/tmp/vault.kdbx"));
    assert!(reveal);

    let cli = Cli::parse_from([
        "opensesame",
        "pass",
        "import-kdbx",
        "/tmp/vault.kdbx",
        "--keyfile",
        "/tmp/vault.key",
        "--prefix",
        "Imported",
        "--replace",
    ]);
    let Commands::Pass {
        cmd:
            PassCmd::ImportKdbx {
                file,
                keyfile,
                prefix,
                replace,
                ..
            },
    } = cli.command
    else {
        panic!("expected pass import-kdbx");
    };
    assert_eq!(file, PathBuf::from("/tmp/vault.kdbx"));
    assert_eq!(keyfile, Some(PathBuf::from("/tmp/vault.key")));
    assert_eq!(prefix.as_deref(), Some("Imported"));
    assert!(replace);
}

/// The whole `pass` tree must keep parsing; `debug_assert` walks every
/// subcommand and catches id collisions the tests above cannot enumerate.
#[test]
fn the_command_tree_has_no_conflicting_argument_ids() {
    use clap::CommandFactory;
    Cli::command().debug_assert();
}
