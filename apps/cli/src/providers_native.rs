//! Native (non-shelling) execution of `HumanProviderPlan` variants.
//!
//! `connector_host::execute_human_plan` is a *synchronous* executor that
//! shells argv-only commands. Some providers cannot be served that way: they
//! need an async HTTP client, a TTY ceremony, or key material the planner must
//! never hold. Those plans are returned by `human_plan` and **refused** by the
//! sync executor; this module is the smarter async call site that performs
//! them — the same split `github.rs` already uses for `GitHubApp`.
//!
//! Today it owns `HumanProviderPlan::Bitwarden`: a native Bitwarden /
//! Vaultwarden read that replaces shelling to the Node-based `bw` CLI.
//!
//! # Plane (constitution C1/C2)
//!
//! Human plane only. The master password is prompted here, on a TTY, held in
//! a `SecretString`, zeroized on drop, and **never** stored, never placed in
//! argv, and never read from an environment variable this code invented. The
//! resulting session is in-memory and TTL-bound; nothing is written to disk.
//! Agent surfaces cannot reach this module — they get
//! `ProviderExecutionError::Unavailable` from the sync executor instead.

use std::io::{self, IsTerminal, Write};

use anyhow::Context;
use opensesame_connector_host::providers::{HumanProviderOperation, HumanProviderPlan};
use opensesame_provider_bitwarden::{BitwardenClient, Config};
use secrecy::SecretString;

/// Environment variables the *user's* own tooling already defines, checked
/// only for the account address — never for the master password.
const EMAIL_ENV: [&str; 2] = ["OPENSESAME_BITWARDEN_EMAIL", "BW_EMAIL"];

/// How the human is asked for what a native plan needs. Injected so tests can
/// drive the executor without a terminal.
pub trait CredentialPrompt {
    /// The vault account address.
    fn email(&self, server_url: &str) -> anyhow::Result<String>;
    /// The master password. Returned in a `SecretString` so it is zeroized on
    /// drop and cannot be printed.
    fn master_password(&self, email: &str) -> anyhow::Result<SecretString>;
}

/// The real prompt: environment for the address (a convenience, not a
/// secret), TTY for the master password.
pub struct TtyPrompt;

impl CredentialPrompt for TtyPrompt {
    fn email(&self, server_url: &str) -> anyhow::Result<String> {
        for name in EMAIL_ENV {
            if let Ok(value) = std::env::var(name) {
                if !value.trim().is_empty() {
                    return Ok(value.trim().to_owned());
                }
            }
        }
        let value = prompt_line(&format!("Bitwarden email for {server_url}"))?;
        if value.is_empty() {
            anyhow::bail!(
                "a Bitwarden account address is required — set OPENSESAME_BITWARDEN_EMAIL \
                 or answer the prompt"
            );
        }
        Ok(value)
    }

    fn master_password(&self, email: &str) -> anyhow::Result<SecretString> {
        // Deliberately *not* read from the environment. A master password in
        // the environment is inherited by every child process and lands in
        // shell history; the whole point of the native client is that it does
        // not need a long-lived `BW_SESSION` lying around.
        let secret = prompt_secret_hidden(&format!("Master password for {email}"))?;
        if secret.is_empty() {
            anyhow::bail!("master password is required");
        }
        Ok(SecretString::from(secret))
    }
}

/// Execute a plan the sync executor refuses.
///
/// Returns `Ok(Some(value))` when this module owned the plan, and `Ok(None)`
/// when it did not — so the caller falls through to
/// `connector_host::execute_human_plan` unchanged.
pub async fn execute_native_plan(plan: &HumanProviderPlan) -> anyhow::Result<Option<String>> {
    execute_native_plan_with(plan, &TtyPrompt).await
}

/// Seam-injected form of [`execute_native_plan`], for tests.
pub async fn execute_native_plan_with(
    plan: &HumanProviderPlan,
    prompt: &dyn CredentialPrompt,
) -> anyhow::Result<Option<String>> {
    let HumanProviderPlan::Bitwarden {
        server_url,
        resource,
        operation,
    } = plan
    else {
        return Ok(None);
    };

    // Refuse an operation this provider can never serve *before* dialing a
    // server or asking a human for a master password. Password managers never
    // MINT (ADR 0049): a vault holds credentials, it does not issue them.
    if matches!(
        operation,
        HumanProviderOperation::Lease | HumanProviderOperation::Revoke
    ) {
        anyhow::bail!(
            "bitwarden/vaultwarden connections cannot lease or revoke — a password manager \
             stores credentials, it does not mint them"
        );
    }

    let config = Config::from_server_url(server_url)
        .with_context(|| format!("bitwarden server URL `{server_url}`"))?;
    let email = prompt.email(server_url)?;
    let master_password = prompt.master_password(&email)?;
    let mut client = BitwardenClient::unlock(config, &email, &master_password)
        .await
        .with_context(|| format!("unlocking the bitwarden vault at {server_url}"))?;

    let value = match operation {
        HumanProviderOperation::Read => client
            .read(resource)
            .await
            .with_context(|| format!("reading `{resource}`"))?
            .to_string(),
        HumanProviderOperation::List => client.list().await.context("listing vault items")?,
        // Unreachable: refused above, before any prompt or socket.
        HumanProviderOperation::Lease | HumanProviderOperation::Revoke => unreachable!(
            "lease and revoke are refused before the vault is unlocked"
        ),
    };
    Ok(Some(value))
}

// TODO(dedupe): `store.rs` has the same two prompt helpers, private to that
// module. Lift them into one shared CLI helper when `store.rs` next changes
// hands; duplicating ~20 lines beats two agents editing the same file.

fn prompt_line(prompt: &str) -> anyhow::Result<String> {
    eprint!("{prompt}: ");
    let _ = io::stderr().flush();
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

/// Read a secret without echoing it. Non-TTY stdin (a pipe, a heredoc) falls
/// back to a plain line read, since nothing echoes there anyway — the same
/// rule `opensesame pass` already follows.
fn prompt_secret_hidden(prompt: &str) -> anyhow::Result<String> {
    use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
    if !io::stdin().is_terminal() {
        return prompt_line(prompt);
    }
    eprint!("{prompt}: ");
    let _ = io::stderr().flush();
    crossterm::terminal::enable_raw_mode()?;
    let mut buf = String::new();
    let outcome = loop {
        match crossterm::event::read() {
            Ok(Event::Key(key)) if key.kind != KeyEventKind::Release => match key.code {
                KeyCode::Enter => break Ok(buf.clone()),
                KeyCode::Backspace => {
                    buf.pop();
                }
                KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    break Err(anyhow::anyhow!("interrupted"));
                }
                KeyCode::Char(c) => buf.push(c),
                _ => {}
            },
            Ok(_) => {}
            Err(error) => break Err(error.into()),
        }
    };
    let _ = crossterm::terminal::disable_raw_mode();
    eprintln!();
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use http_body_util::Full;
    use hyper::body::Bytes;
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;
    use opensesame_provider_bitwarden::{Kdf, MasterKey, SymmetricKey};

    const EMAIL: &str = "cli-user@example.test";
    const MASTER_PASSWORD: &str = "correct horse battery staple";
    const PASSWORD: &str = "s3cr3t-github-password";

    /// Records what the executor asked a human for, so tests can assert it
    /// asked *nothing* on the paths that must not prompt.
    #[derive(Default)]
    struct StubPrompt {
        calls: Mutex<Vec<String>>,
    }

    impl CredentialPrompt for StubPrompt {
        fn email(&self, server_url: &str) -> anyhow::Result<String> {
            self.calls.lock().unwrap().push(format!("email:{server_url}"));
            Ok(EMAIL.to_owned())
        }
        fn master_password(&self, email: &str) -> anyhow::Result<SecretString> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("master_password:{email}"));
            Ok(SecretString::from(MASTER_PASSWORD.to_owned()))
        }
    }

    /// A minimal vaultwarden-shaped stub built from real crypto: the same
    /// ladder the provider crate implements, so nothing is faked but the
    /// transport. No network — `127.0.0.1:0` only.
    async fn spawn_vaultwarden_stub() -> String {
        let kdf = Kdf::Pbkdf2 { iterations: 10_000 };
        let master = MasterKey::derive(MASTER_PASSWORD.as_bytes(), EMAIL, &kdf).unwrap();
        let user_key_bytes: Vec<u8> = (0u8..64).map(|i| i.wrapping_mul(31).wrapping_add(5)).collect();
        let user_key = SymmetricKey::from_bytes(&user_key_bytes).unwrap();
        let wrapped = master
            .stretch()
            .encrypt_with_iv(&user_key_bytes, [0x11; 16])
            .unwrap()
            .to_string();
        let enc = |plaintext: &str, iv: u8| {
            user_key
                .encrypt_with_iv(plaintext.as_bytes(), [iv; 16])
                .unwrap()
                .to_string()
        };

        let routes: BTreeMap<String, String> = BTreeMap::from([
            (
                "/identity/accounts/prelogin".to_owned(),
                serde_json::json!({ "kdf": 0, "kdfIterations": 10_000 }).to_string(),
            ),
            (
                "/identity/connect/token".to_owned(),
                serde_json::json!({
                    "access_token": "stub-access-token",
                    "expires_in": 3600,
                    "Key": wrapped,
                })
                .to_string(),
            ),
            (
                "/api/sync".to_owned(),
                serde_json::json!({
                    "profile": { "email": EMAIL, "key": wrapped },
                    "folders": [{ "id": "f1", "name": enc("Work", 2) }],
                    "ciphers": [{
                        "id": "c1",
                        "folderId": "f1",
                        "type": 1,
                        "name": enc("GitHub", 3),
                        "login": {
                            "username": enc("octocat", 4),
                            "password": enc(PASSWORD, 5),
                            "uris": [{ "uri": enc("https://github.com", 6), "match": null }]
                        },
                        "fields": []
                    }]
                })
                .to_string(),
            ),
        ]);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let routes = Arc::new(routes);
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let io = TokioIo::new(stream);
                let routes = routes.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                        let routes = routes.clone();
                        async move {
                            let body = routes
                                .get(req.uri().path())
                                .cloned()
                                .unwrap_or_else(|| r#"{"message":"not found"}"#.to_owned());
                            Ok::<_, std::convert::Infallible>(
                                hyper::Response::builder()
                                    .status(if routes.contains_key(req.uri().path()) {
                                        200
                                    } else {
                                        404
                                    })
                                    .header("content-type", "application/json")
                                    .body(Full::new(Bytes::from(body)))
                                    .unwrap(),
                            )
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, service)
                        .await;
                });
            }
        });
        format!("http://127.0.0.1:{}", addr.port())
    }

    fn bitwarden_plan(server_url: &str, operation: HumanProviderOperation) -> HumanProviderPlan {
        HumanProviderPlan::Bitwarden {
            server_url: server_url.to_owned(),
            resource: "Work/GitHub".to_owned(),
            operation,
        }
    }

    #[tokio::test]
    async fn plans_this_module_does_not_own_fall_through_untouched() {
        let prompt = StubPrompt::default();
        let others = vec![
            HumanProviderPlan::Environment("HOME".into()),
            HumanProviderPlan::Command {
                executable: "bw".into(),
                args: vec!["get".into(), "password".into(), "x".into(), "--raw".into()],
            },
            HumanProviderPlan::SealedStore {
                operation: HumanProviderOperation::List,
                store_dir: PathBuf::from("/nonexistent"),
                name: "x".into(),
            },
            HumanProviderPlan::GitHubApp {
                app_id: None,
                installation_id: None,
                private_key_path: None,
            },
        ];
        for plan in others {
            let outcome = execute_native_plan_with(&plan, &prompt).await.unwrap();
            assert!(
                outcome.is_none(),
                "{plan:?} must fall through to the sync executor"
            );
        }
        assert!(
            prompt.calls.lock().unwrap().is_empty(),
            "a plan this module does not own must never prompt a human"
        );
    }

    #[tokio::test]
    async fn a_bitwarden_read_plan_returns_the_password() {
        let base = spawn_vaultwarden_stub().await;
        let prompt = StubPrompt::default();
        let value = execute_native_plan_with(
            &bitwarden_plan(&base, HumanProviderOperation::Read),
            &prompt,
        )
        .await
        .unwrap();
        assert_eq!(value.as_deref(), Some(PASSWORD));
        assert_eq!(
            *prompt.calls.lock().unwrap(),
            vec![
                format!("email:{base}"),
                format!("master_password:{EMAIL}"),
            ]
        );
    }

    #[tokio::test]
    async fn a_bitwarden_list_plan_returns_a_secret_free_listing() {
        let base = spawn_vaultwarden_stub().await;
        let listing = execute_native_plan_with(
            &bitwarden_plan(&base, HumanProviderOperation::List),
            &StubPrompt::default(),
        )
        .await
        .unwrap()
        .expect("the list plan is owned here");
        assert!(listing.contains("GitHub"), "{listing}");
        assert!(listing.contains("octocat"), "{listing}");
        assert!(
            !listing.contains(PASSWORD),
            "a listing must never carry a password: {listing}"
        );
    }

    #[tokio::test]
    async fn a_password_manager_can_never_mint_a_lease() {
        let prompt = StubPrompt::default();
        for operation in [HumanProviderOperation::Lease, HumanProviderOperation::Revoke] {
            let error = execute_native_plan_with(
                &bitwarden_plan("https://vault.example.com", operation),
                &prompt,
            )
            .await
            .expect_err("password managers do not mint");
            assert!(format!("{error:#}").contains("does not mint"), "{error:#}");
        }
        assert!(
            prompt.calls.lock().unwrap().is_empty(),
            "an operation we will refuse must not prompt for a master password first"
        );
    }

    #[tokio::test]
    async fn a_bad_server_url_is_refused_before_a_human_is_prompted() {
        let prompt = StubPrompt::default();
        for server_url in [
            "ftp://vault.example.com",
            "http://vault.example.com",
            "not a url",
            "https://user:pass@vault.example.com",
        ] {
            let error = execute_native_plan_with(
                &bitwarden_plan(server_url, HumanProviderOperation::Read),
                &prompt,
            )
            .await
            .expect_err("the URL must be validated first");
            assert!(format!("{error:#}").contains(server_url), "{error:#}");
        }
        assert!(
            prompt.calls.lock().unwrap().is_empty(),
            "a master password must never be asked for a server we would refuse to dial"
        );
    }

    #[tokio::test]
    async fn a_wrong_resource_is_a_named_error_not_an_empty_string() {
        let base = spawn_vaultwarden_stub().await;
        let error = execute_native_plan_with(
            &HumanProviderPlan::Bitwarden {
                server_url: base,
                resource: "Nope".into(),
                operation: HumanProviderOperation::Read,
            },
            &StubPrompt::default(),
        )
        .await
        .expect_err("missing item");
        let rendered = format!("{error:#}");
        assert!(rendered.contains("Nope"), "{rendered}");
        assert!(!rendered.contains(MASTER_PASSWORD), "{rendered}");
    }
}
