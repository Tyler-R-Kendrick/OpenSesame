//! `opensesame bridge bitwarden` — move people onto the Host's
//! Bitwarden-compatible server (ADR 0148).
//!
//! The verbs exist in every build so `--help` shows them; they run only in a
//! build with the `bitwarden-compat` feature, and say how to get one
//! otherwise.
//!
//! Nothing here prints a secret. A live account's master password and any
//! second-factor code are read from the terminal without echo, used for one
//! sign-in, and dropped.

use std::path::PathBuf;

use clap::Subcommand;

/// The Host database the Bitwarden server keeps its accounts in.
#[derive(clap::Args, Debug)]
pub struct Target {
    /// The Host's database, as `opensesame host run` is given it.
    #[arg(
        long = "db",
        env = "OPENSESAME_DB",
        default_value = ".tools/run/opensesame.db"
    )]
    pub database: String,
    /// Replace an account already at the same email, with everything it holds.
    #[arg(long, default_value_t = false)]
    pub replace: bool,
    /// Read and check everything, and report; write nothing.
    #[arg(long, default_value_t = false)]
    pub dry_run: bool,
}

/// Verbs of the Bitwarden bridge.
#[derive(Subcommand, Debug)]
pub enum BitwardenCmd {
    /// Move accounts onto the Host: master passwords, keys and vaults unchanged.
    Import {
        #[command(subcommand)]
        from: ImportSource,
    },
}

#[derive(Subcommand, Debug)]
pub enum ImportSource {
    /// Every registered account of a vaultwarden server, from its `SQLite` file
    /// (opened read-only; stop vaultwarden first for a consistent copy).
    Vaultwarden {
        /// vaultwarden's `db.sqlite3`.
        #[arg(long = "from")]
        path: PathBuf,
        /// vaultwarden's data folder, holding `attachments/` and `sends/`;
        /// defaults to the database's own folder.
        #[arg(long = "data")]
        data: Option<PathBuf>,
        #[command(flatten)]
        target: Target,
    },
    /// One person's account from a live Bitwarden server (bitwarden.com,
    /// bitwarden.eu, self-hosted Bitwarden or vaultwarden). Asks for the
    /// master password, and a second-factor code if the server wants one.
    Account {
        /// The server URL a Bitwarden client is configured with.
        #[arg(long = "from")]
        server: String,
        #[arg(long)]
        email: String,
        #[command(flatten)]
        target: Target,
    },
}

/// Run a Bitwarden bridge verb.
///
/// # Errors
///
/// Fails when this build has no Bitwarden bridge, or the import fails.
// Without the bridge there is nothing to await, but the signature is the
// same in every build so the dispatcher needs no `cfg` of its own.
#[cfg_attr(not(feature = "bitwarden-compat"), allow(clippy::unused_async))]
pub async fn run(cmd: BitwardenCmd) -> anyhow::Result<()> {
    #[cfg(feature = "bitwarden-compat")]
    {
        imp::run(cmd).await
    }
    #[cfg(not(feature = "bitwarden-compat"))]
    {
        let _ = cmd;
        anyhow::bail!(
            "this opensesame was built without the Bitwarden bridge; rebuild with \
             `cargo build -p opensesame-cli --features bitwarden-compat`"
        )
    }
}

#[cfg(feature = "bitwarden-compat")]
mod imp {
    use anyhow::Context as _;
    use opensesame_bitwarden_server::hashing::HashRegistry;
    use opensesame_bitwarden_server::import::account::{
        self, AccountRequest, Answer, Ask, Challenge,
    };
    use opensesame_bitwarden_server::import::{
        self, vaultwarden, AccountReport, SharedReport, Source, WriteOptions, Written,
    };
    use opensesame_storage::Db;
    use zeroize::Zeroizing;

    use super::{BitwardenCmd, ImportSource, Target};
    use crate::store::prompt_secret_hidden;

    /// Asks the person at the terminal.
    struct Terminal;

    fn provider_name(provider: u32) -> &'static str {
        match provider {
            0 => "authenticator app",
            1 => "email",
            2 => "Duo",
            3 => "YubiKey",
            7 => "security key",
            _ => "another method",
        }
    }

    impl Ask for Terminal {
        fn ask(&mut self, challenge: &Challenge) -> Option<Answer> {
            let (provider, prompt) = match challenge {
                Challenge::TwoFactor { providers } => {
                    // A code-based method the terminal can answer, first choice first.
                    let provider = [0, 1, 3]
                        .into_iter()
                        .find(|p| providers.contains(p))
                        .or_else(|| providers.first().copied())?;
                    (
                        Some(provider),
                        format!("Two-step login code ({})", provider_name(provider)),
                    )
                }
                Challenge::NewDevice => (None, "Code the server emailed for this device".into()),
            };
            let code = prompt_secret_hidden(&prompt).ok()?;
            Some(Answer {
                provider,
                code: Zeroizing::new(code.trim().to_owned()),
            })
        }
    }

    fn outcome(written: Written) -> &'static str {
        match written {
            Written::Created => "moved",
            Written::Replaced => "moved, replacing the account that was here",
            Written::EmailTaken => {
                "not moved: an account with this email is already here (--replace)"
            }
            Written::IdTaken => "not moved: it or one of its ids is already here (--replace)",
            Written::DryRun => "checked (dry run, nothing written)",
        }
    }

    fn print(reports: &[AccountReport]) {
        for report in reports {
            println!(
                "{}: {} — {} folders, {} items, {} attachments, {} Sends",
                report.email,
                outcome(report.written),
                report.folders,
                report.ciphers,
                report.attachments,
                report.sends
            );
            for (kind, count) in &report.left_behind {
                println!("  left behind: {count} {kind}");
            }
        }
    }

    fn print_shared(shared: &SharedReport) {
        for org in &shared.organizations {
            println!(
                "organization {}: {} — {} members, {} collections, {} items, {} attachments",
                org.name,
                outcome(org.written),
                org.members,
                org.collections,
                org.ciphers,
                org.attachments
            );
            for (kind, count) in &org.left_behind {
                println!("  left behind: {count} {kind}");
            }
        }
        if shared.emergency_read > 0 {
            println!(
                "emergency contacts: {} of {} moved",
                shared.emergency_written, shared.emergency_read
            );
        }
    }

    fn print_rest(source: &Source) {
        for skipped in &source.skipped {
            println!("{}: skipped — {}", skipped.email, skipped.reason);
        }
        for (kind, count) in &source.left_behind {
            println!("server: left behind {count} {kind}");
        }
    }

    async fn write(target: &Target, source: &Source) -> anyhow::Result<()> {
        let db = Db::connect_sqlite(&target.database)
            .await
            .with_context(|| format!("open the Host database {}", target.database))?;
        let options = WriteOptions {
            replace: target.replace,
            dry_run: target.dry_run,
        };
        let reports = import::write(&db, source, options).await?;
        print(&reports);
        let shared = import::write_shared(&db, source, options).await?;
        print_shared(&shared);
        print_rest(source);
        Ok(())
    }

    pub async fn run(cmd: BitwardenCmd) -> anyhow::Result<()> {
        let BitwardenCmd::Import { from } = cmd;
        match from {
            ImportSource::Vaultwarden { path, data, target } => {
                let source = vaultwarden::read_with(&path, data.as_deref()).await?;
                write(&target, &source).await
            }
            ImportSource::Account {
                server,
                email,
                target,
            } => {
                let password = Zeroizing::new(prompt_secret_hidden("Master password")?);
                let source = account::read(
                    &AccountRequest {
                        server_url: &server,
                        email: &email,
                        master_password: password.as_bytes(),
                    },
                    &HashRegistry::default(),
                    &mut Terminal,
                )
                .await?;
                drop(password);
                write(&target, &source).await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser as _;

    use super::*;

    fn parse(args: &[&str]) -> BitwardenCmd {
        let cli = crate::Cli::try_parse_from(args).unwrap();
        let crate::Commands::Bridge {
            cmd: crate::bridge::BridgeCmd::Bitwarden { cmd },
        } = cli.command
        else {
            panic!("not a bitwarden bridge verb");
        };
        cmd
    }

    #[test]
    fn both_import_sources_parse_with_their_options() {
        let BitwardenCmd::Import {
            from: ImportSource::Vaultwarden { path, target, .. },
        } = parse(&[
            "opensesame",
            "bridge",
            "bitwarden",
            "import",
            "vaultwarden",
            "--from",
            "/srv/vw/db.sqlite3",
            "--db",
            "/var/lib/os.db",
            "--dry-run",
        ])
        else {
            panic!("expected a vaultwarden import");
        };
        assert_eq!(path, PathBuf::from("/srv/vw/db.sqlite3"));
        assert_eq!(target.database, "/var/lib/os.db");
        assert!(target.dry_run && !target.replace);

        let BitwardenCmd::Import {
            from:
                ImportSource::Account {
                    server,
                    email,
                    target,
                },
        } = parse(&[
            "opensesame",
            "bridge",
            "bitwarden",
            "import",
            "account",
            "--from",
            "https://vault.bitwarden.com",
            "--email",
            "me@example.com",
            "--replace",
        ])
        else {
            panic!("expected an account import");
        };
        assert_eq!(server, "https://vault.bitwarden.com");
        assert_eq!(email, "me@example.com");
        assert!(target.replace);
    }

    #[cfg(not(feature = "bitwarden-compat"))]
    #[tokio::test]
    async fn a_build_without_the_bridge_says_how_to_get_one() {
        let cmd = parse(&[
            "opensesame",
            "bridge",
            "bitwarden",
            "import",
            "vaultwarden",
            "--from",
            "x",
        ]);
        let refused = run(cmd).await.unwrap_err();
        assert!(refused.to_string().contains("--features bitwarden-compat"));
    }

    #[cfg(feature = "bitwarden-compat")]
    #[tokio::test]
    async fn a_vaultwarden_file_is_read_and_its_unmovable_accounts_reported() {
        use sqlx::sqlite::SqliteConnectOptions;
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("db.sqlite3");
        let pool = sqlx::SqlitePool::connect_with(
            SqliteConnectOptions::new()
                .filename(&source)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        for statement in [
            "CREATE TABLE users (uuid TEXT, email TEXT, password_hash BLOB, salt BLOB, \
             password_iterations INTEGER, akey TEXT)",
            "CREATE TABLE ciphers (uuid TEXT, user_uuid TEXT, atype INTEGER, name TEXT, data TEXT)",
            "CREATE TABLE folders (uuid TEXT, user_uuid TEXT, name TEXT)",
            "INSERT INTO users VALUES ('u', 'invited@example.test', x'', x'', 0, '')",
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        pool.close().await;
        let host = dir.path().join("host.db");
        std::fs::File::create(&host).unwrap();
        let cmd = parse(&[
            "opensesame",
            "bridge",
            "bitwarden",
            "import",
            "vaultwarden",
            "--from",
            source.to_str().unwrap(),
            "--db",
            host.to_str().unwrap(),
        ]);
        run(cmd).await.unwrap();
        let db = opensesame_storage::Db::connect_sqlite(host.to_str().unwrap())
            .await
            .unwrap();
        assert!(db
            .bitwarden_user_by_email("invited@example.test")
            .await
            .unwrap()
            .is_none());
    }
}
