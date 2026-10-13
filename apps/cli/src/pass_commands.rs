//! Preserve the public pass variants while bounding command-schema construction.
use super::pass_command_groups::command_groups;
use super::{pass_otp, pass_protect, PassAttachCmd, PassTombCmd};
use std::path::PathBuf;

command_groups! {
    pub(crate) enum PassCmd using BoundedPassCmd {
        EntrySchema {
            /// Initialize a git-native sealed secret store.
            Init {
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long = "recipient", value_name = "RECIPIENT")]
                recipients: Vec<String>,
                #[arg(long, default_value_t = true)]
                git: bool,
                /// Backup remote URL (git `origin`), e.g. a private GitHub repository.
                #[arg(long)]
                remote: Option<String>,
            },
            /// Insert a secret (human only).
            Insert {
                name: String,
                #[arg(long)]
                echo: bool,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
            /// Generate and insert a password.
            Generate {
                name: String,
                #[arg(long, default_value_t = opensesame_sealed_store::default_password_length())]
                length: usize,
                #[arg(long)]
                no_symbols: bool,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
            /// Show an entry (requires TTY or `--reveal`).
            Show {
                name: String,
                #[arg(long)]
                reveal: bool,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
        }
        PathSchema {
            /// List entries.
            Ls {
                prefix: Option<String>,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
            /// Find entries by name substring.
            Find {
                query: String,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
            /// Remove an entry.
            Rm {
                name: String,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
            /// Copy an entry.
            Cp {
                from: String,
                to: String,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
            /// Move an entry.
            Mv {
                from: String,
                to: String,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
            /// Run git in the sealed-store root.
            Git {
                #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
                args: Vec<String>,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
        }
        FileSchema {
            /// Seal a Pages plaintext path manifest into encrypted store entries.
            Seal {
                /// JSON manifest exported by Pages Settings → "Download store path manifest".
                manifest: PathBuf,
                /// Overwrite entries that already exist in the store.
                #[arg(long)]
                replace: bool,
                /// Overwrite and delete the plaintext manifest after sealing.
                #[arg(long)]
                shred: bool,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
            /// Import a `KeePass` (.kdbx) database into the store.
            ImportKdbx {
                /// KDBX 4.x database to read.
                file: PathBuf,
                /// Optional KDBX key file, if the database uses one.
                #[arg(long)]
                keyfile: Option<PathBuf>,
                /// Place imported entries under this store prefix.
                #[arg(long)]
                prefix: Option<String>,
                /// Overwrite store entries that already exist and differ.
                #[arg(long)]
                replace: bool,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
            /// Export the store as a `KeePass` (.kdbx) database.
            ExportKdbx {
                /// File to write the database to.
                dest: PathBuf,
                /// Export only entries under this store prefix.
                #[arg(long)]
                prefix: Option<String>,
                /// Required off a TTY: the export is a portable copy of the store.
                #[arg(long)]
                reveal: bool,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
            /// Commit and push the store to its backup remote (git `origin`).
            Backup {
                /// Set (or replace) the backup remote before pushing.
                #[arg(long)]
                remote: Option<String>,
                /// Persist auto-push: push after every store mutation from now on.
                #[arg(long)]
                auto_push: Option<bool>,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
        }
        NestedSchema {
            /// File attachments stored as sealed, content-addressed chunks.
            Attach {
                #[command(subcommand)]
                cmd: PassAttachCmd,
            },
            /// OTP tokens (pass-otp parity).
            Otp {
                #[command(subcommand)]
                cmd: pass_otp::PassOtpCmd,
            },
        }
        RotationSchema {
            /// Update / rotate secrets (pass-update parity). Prints new secret (human TTY).
            Update {
                #[arg(required = true)]
                names: Vec<String>,
                #[arg(short = 'l', long, default_value_t = opensesame_sealed_store::default_password_length())]
                length: usize,
                #[arg(short = 'a', long)]
                auto_length: bool,
                #[arg(short = 'n', long)]
                no_symbols: bool,
                #[arg(short = 'p', long)]
                provide: bool,
                #[arg(short = 'm', long)]
                multiline: bool,
                #[arg(short = 'i', long)]
                include: Option<String>,
                #[arg(short = 'e', long)]
                exclude: Option<String>,
                #[arg(short = 'f', long)]
                force: bool,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
            /// Rotate first-line secrets without printing plaintext unless `--reveal`.
            Rotate {
                #[arg(required = true)]
                names: Vec<String>,
                #[arg(short = 'l', long, default_value_t = opensesame_sealed_store::default_password_length())]
                length: usize,
                #[arg(short = 'a', long)]
                auto_length: bool,
                #[arg(short = 'n', long)]
                no_symbols: bool,
                #[arg(short = 'p', long)]
                provide: bool,
                #[arg(short = 'm', long)]
                multiline: bool,
                #[arg(short = 'i', long)]
                include: Option<String>,
                #[arg(short = 'e', long)]
                exclude: Option<String>,
                #[arg(short = 'f', long)]
                force: bool,
                /// Print the new secret (TTY / human only — never for agents).
                #[arg(long)]
                reveal: bool,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
        }
        HistorySchema {
            /// Show an entry's git history: sha, timestamp, subject (metadata only).
            History {
                name: String,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
            /// Restore an entry's content from a past commit as a NEW commit.
            Restore {
                name: String,
                /// Commit sha from `pass history`.
                #[arg(long)]
                rev: String,
                #[arg(long)]
                path: Option<PathBuf>,
                #[arg(long)]
                tomb: Option<String>,
            },
            /// Root-protection protectors for `.opensesame-key` (human only).
            Protect {
                #[command(subcommand)]
                cmd: pass_protect::PassProtectCmd,
            },
            /// Multi-tomb registry.
            Tomb {
                #[command(subcommand)]
                cmd: PassTombCmd,
            },
            /// Open active / named tomb (Linux Tomb mount when applicable).
            Open { name: Option<String> },
            /// Close active / named tomb.
            Close { name: Option<String> },
        }
    }
}
