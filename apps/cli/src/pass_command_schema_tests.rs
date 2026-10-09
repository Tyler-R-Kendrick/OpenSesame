//! Compare the bounded builder with the genuine original Clap-derived schema.
use super::pass_commands::{BoundedPassCmd, PassCmd};
use super::PassAttachCmd;
use clap::{Command, FromArgMatches, Subcommand};
use std::path::PathBuf;

fn compare_help(mut original: Command, mut bounded: Command) {
    assert_eq!(
        original.render_long_help().to_string(),
        bounded.render_long_help().to_string()
    );
    let original_children: Vec<_> = original.get_subcommands().cloned().collect();
    let bounded_children: Vec<_> = bounded.get_subcommands().cloned().collect();
    assert_eq!(original_children.len(), bounded_children.len());
    for (old, new) in original_children.into_iter().zip(bounded_children) {
        assert_eq!(old.get_name(), new.get_name());
        compare_help(old, new);
    }
}

#[test]
fn every_help_tree_and_update_schema_matches_the_original_derive() {
    compare_help(
        PassCmd::augment_subcommands(Command::new("pass")),
        BoundedPassCmd::augment_subcommands(Command::new("pass")),
    );
    compare_help(
        PassCmd::augment_subcommands_for_update(Command::new("pass")),
        BoundedPassCmd::augment_subcommands_for_update(Command::new("pass")),
    );
}

fn parse(args: &[&str]) -> BoundedPassCmd {
    let mut matches = BoundedPassCmd::augment_subcommands(Command::new("pass"))
        .try_get_matches_from(args)
        .unwrap();
    BoundedPassCmd::from_arg_matches_mut(&mut matches).unwrap()
}

#[test]
fn attachment_arguments_reach_the_same_original_typed_command() {
    let cmd = parse(&[
        "pass",
        "attach",
        "add",
        "Taxes/w2",
        "document.pdf",
        "--mime",
        "application/pdf",
        "--force",
        "--shred",
        "--path",
        "store",
        "--tomb",
        "office",
    ]);
    match cmd.into_inner() {
        PassCmd::Attach {
            cmd:
                PassAttachCmd::Add {
                    name,
                    file,
                    mime,
                    force,
                    shred,
                    path,
                    tomb,
                },
        } => {
            assert_eq!(name, "Taxes/w2");
            assert_eq!(file, PathBuf::from("document.pdf"));
            assert_eq!(mime.as_deref(), Some("application/pdf"));
            assert!(force && shred);
            assert_eq!(path, Some(PathBuf::from("store")));
            assert_eq!(tomb.as_deref(), Some("office"));
        }
        other => panic!("wrong genuine command: {other:?}"),
    }
}
