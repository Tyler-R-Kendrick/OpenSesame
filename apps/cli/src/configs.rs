//! Project-config secret store verbs (`opensesame config …`).
//!
//! Values travel one way: `set` reads them from a pipe or a hidden prompt
//! (never argv), `import` reads them from a dotenv file, and both send them to
//! the write-only `PUT …/secrets` intake. Every response on this surface is
//! key names + version metadata; a response carrying a credential-shaped field
//! is refused before printing (mirrors the gateway's `assert_no_secret_fields`).

use std::collections::BTreeMap;
use std::io::{self, IsTerminal, Read};
use std::path::PathBuf;

use clap::{Subcommand, ValueEnum};
use serde_json::json;

#[derive(Subcommand, Debug)]
pub enum ConfigCmd {
    /// List a project's configs.
    Ls {
        #[arg(long)]
        project: String,
    },
    /// Create a config in a project.
    Create {
        #[arg(long)]
        project: String,
        #[arg(long)]
        slug: String,
        #[arg(long = "env", value_enum)]
        env: EnvArg,
        /// Parent config id to inherit from.
        #[arg(long)]
        parent: Option<String>,
    },
    /// List a config's key names + versions (never values).
    Keys {
        #[arg(long)]
        config: String,
    },
    /// Set one secret. Value comes from piped stdin or a hidden prompt — never argv.
    Set {
        key: String,
        #[arg(long)]
        config: String,
    },
    /// Remove one secret key.
    Unset {
        key: String,
        #[arg(long)]
        config: String,
    },
    /// Import KEY=VALUE lines from a dotenv file.
    Import {
        file: PathBuf,
        #[arg(long)]
        config: String,
    },
    /// Version metadata for one key (never values).
    History {
        key: String,
        #[arg(long)]
        config: String,
    },
    /// Re-seal an old version as the new head version.
    Rollback {
        key: String,
        #[arg(long = "to")]
        to_version: u64,
        #[arg(long)]
        config: String,
    },
    /// Compare two configs: key presence + versions only.
    Diff { a: String, b: String },
    /// Branch a child config inheriting this one.
    Branch {
        config_id: String,
        #[arg(long)]
        slug: String,
    },
}

#[derive(Clone, Copy, ValueEnum, Debug)]
pub enum EnvArg {
    Development,
    Staging,
    Production,
    Custom,
}

impl EnvArg {
    fn as_str(self) -> &'static str {
        match self {
            EnvArg::Development => "development",
            EnvArg::Staging => "staging",
            EnvArg::Production => "production",
            EnvArg::Custom => "custom",
        }
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "the match is the declarative ConfigCmd-to-HTTP route catalog"
)]
pub async fn run(server: &str, output: &str, cmd: ConfigCmd) -> anyhow::Result<()> {
    let token = crate::load_access_token()?;
    let client = reqwest::Client::new();
    let base = server.trim_end_matches('/');
    let value: serde_json::Value = match cmd {
        ConfigCmd::Ls { project } => {
            client
                .get(format!("{base}/api/v1/projects/{project}/configs"))
                .bearer_auth(&token)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?
        }
        ConfigCmd::Create {
            project,
            slug,
            env,
            parent,
        } => {
            client
                .post(format!("{base}/api/v1/projects/{project}/configs"))
                .bearer_auth(&token)
                .json(&json!({
                    "slug": slug,
                    "environment": env.as_str(),
                    "parent_config_id": parent,
                }))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?
        }
        ConfigCmd::Keys { config } => {
            client
                .get(format!("{base}/api/v1/configs/{config}/secrets"))
                .bearer_auth(&token)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?
        }
        ConfigCmd::Set { key, config } => {
            if !is_valid_key(&key) {
                anyhow::bail!("invalid key {key:?} (must match [A-Za-z_][A-Za-z0-9_]*)");
            }
            let secret = read_secret_value(&key)?;
            put_secrets(&client, base, &token, &config, [(key, secret)].into()).await?
        }
        ConfigCmd::Unset { key, config } => {
            let resp = client
                .delete(format!("{base}/api/v1/configs/{config}/secrets/{key}"))
                .bearer_auth(&token)
                .send()
                .await?
                .error_for_status()?;
            json!({"removed": key, "config": config, "status": resp.status().as_u16()})
        }
        ConfigCmd::Import { file, config } => {
            let text = String::from_utf8(crate::read_bounded(&file)?)
                .map_err(|e| anyhow::anyhow!("{}: not UTF-8: {e}", file.display()))?;
            let secrets = parse_dotenv(&text)?;
            if secrets.is_empty() {
                anyhow::bail!("{}: no KEY=VALUE entries found", file.display());
            }
            put_secrets(&client, base, &token, &config, secrets).await?
        }
        ConfigCmd::History { key, config } => {
            client
                .get(format!(
                    "{base}/api/v1/configs/{config}/secrets/{key}/versions"
                ))
                .bearer_auth(&token)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?
        }
        ConfigCmd::Rollback {
            key,
            to_version,
            config,
        } => {
            client
                .post(format!(
                    "{base}/api/v1/configs/{config}/secrets/{key}/rollback"
                ))
                .bearer_auth(&token)
                .json(&json!({"to_version": to_version}))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?
        }
        ConfigCmd::Diff { a, b } => {
            client
                .get(format!("{base}/api/v1/configs/{a}/compare/{b}"))
                .bearer_auth(&token)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?
        }
        ConfigCmd::Branch { config_id, slug } => {
            client
                .post(format!("{base}/api/v1/configs/{config_id}/branch"))
                .bearer_auth(&token)
                .json(&json!({"slug": slug}))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?
        }
    };
    refuse_secret_shaped(&value)?;
    crate::print_output(output, &value)
}

async fn put_secrets(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    config: &str,
    secrets: BTreeMap<String, String>,
) -> anyhow::Result<serde_json::Value> {
    Ok(client
        .put(format!("{base}/api/v1/configs/{config}/secrets"))
        .bearer_auth(token)
        .json(&json!({"secrets": secrets}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

/// This surface is write-only for values: refuse to print any response that
/// grew a credential-shaped field, whatever the server said.
fn refuse_secret_shaped(value: &serde_json::Value) -> anyhow::Result<()> {
    let text = value.to_string().to_ascii_lowercase();
    for leak in [
        "\"secret\"",
        "\"secrets\"",
        "\"value\"",
        "\"plaintext\"",
        "\"password\"",
        "\"access_token\"",
        "\"refresh_token\"",
    ] {
        if text.contains(leak) {
            anyhow::bail!("config response refused: credential-shaped field {leak}");
        }
    }
    Ok(())
}

/// Read the secret value for `set`: whole piped stdin when not a TTY (a single
/// trailing newline is stripped so `printf`/heredocs behave), else the same
/// hidden no-echo prompt `pass insert` uses. Never argv, never echoed.
fn read_secret_value(key: &str) -> anyhow::Result<String> {
    let value = if io::stdin().is_terminal() {
        crate::store::prompt_secret_hidden(&format!("Enter value for {key}"))?
    } else {
        let mut buf = String::new();
        io::stdin().read_to_string(&mut buf)?;
        strip_one_trailing_newline(&buf).to_string()
    };
    if value.is_empty() {
        anyhow::bail!("empty value for {key}; pipe the value on stdin or type it at the prompt");
    }
    Ok(value)
}

fn strip_one_trailing_newline(raw: &str) -> &str {
    raw.strip_suffix("\r\n")
        .or_else(|| raw.strip_suffix('\n'))
        .unwrap_or(raw)
}

fn is_valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Minimal plain-dotenv parser (crates/env-spec is a consumer of the
/// `@env-spec/parser` schema bridge, not a value parser, so it does not fit).
///
/// Supports comments, blank lines, an optional `export ` prefix, and single-
/// or double-quoted values (double quotes honor `\n` `\r` `\t` `\"` `\\`;
/// single quotes are literal). Inline `# comments` are recognized only after a
/// closing quote — an unquoted value keeps its `#` characters. Later
/// assignments to the same key win. Keys must match `[A-Za-z_][A-Za-z0-9_]*`.
pub(crate) fn parse_dotenv(text: &str) -> anyhow::Result<BTreeMap<String, String>> {
    let mut map = BTreeMap::new();
    for (idx, raw) in text.lines().enumerate() {
        let line_no = idx + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = match line.strip_prefix("export ") {
            Some(rest) => rest.trim_start(),
            None => line,
        };
        let Some((key, rest)) = line.split_once('=') else {
            anyhow::bail!("line {line_no}: expected KEY=VALUE");
        };
        let key = key.trim();
        if !is_valid_key(key) {
            anyhow::bail!(
                "line {line_no}: invalid key {key:?} (must match [A-Za-z_][A-Za-z0-9_]*)"
            );
        }
        map.insert(key.to_string(), parse_value(rest.trim(), line_no)?);
    }
    Ok(map)
}

fn parse_value(raw: &str, line_no: usize) -> anyhow::Result<String> {
    if let Some(rest) = raw.strip_prefix('"') {
        let mut out = String::new();
        let mut chars = rest.chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' => push_escaped(&mut out, chars.next(), line_no)?,
                '"' => return finish_quoted(out, chars.as_str(), line_no),
                other => out.push(other),
            }
        }
        anyhow::bail!("line {line_no}: unterminated double-quoted value");
    }
    if let Some(rest) = raw.strip_prefix('\'') {
        let Some((value, tail)) = rest.split_once('\'') else {
            anyhow::bail!("line {line_no}: unterminated single-quoted value");
        };
        let tail = tail.trim();
        if tail.is_empty() || tail.starts_with('#') {
            return Ok(value.to_string());
        }
        anyhow::bail!("line {line_no}: unexpected content after closing quote");
    }
    Ok(raw.to_string())
}

fn finish_quoted(value: String, tail: &str, line_no: usize) -> anyhow::Result<String> {
    let tail = tail.trim();
    if tail.is_empty() || tail.starts_with('#') {
        Ok(value)
    } else {
        anyhow::bail!("line {line_no}: unexpected content after closing quote");
    }
}

fn push_escaped(out: &mut String, escaped: Option<char>, line_no: usize) -> anyhow::Result<()> {
    match escaped {
        Some('n') => out.push('\n'),
        Some('r') => out.push('\r'),
        Some('t') => out.push('\t'),
        Some('"') => out.push('"'),
        Some('\\') => out.push('\\'),
        Some(other) => {
            out.push('\\');
            out.push(other);
        }
        None => anyhow::bail!("line {line_no}: unterminated escape"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn dotenv_comments_blanks_and_plain_pairs() {
        let map = parse_dotenv("# heading\n\nA=1\n  B = two words \nexport C=3\n").unwrap();
        assert_eq!(map.get("A").unwrap(), "1");
        assert_eq!(map.get("B").unwrap(), "two words");
        assert_eq!(map.get("C").unwrap(), "3");
        assert_eq!(map.len(), 3);
    }

    #[test]
    fn dotenv_quoted_values_and_escapes() {
        let map = parse_dotenv(concat!(
            "DQ=\"line1\\nline2 # not a comment\"  # trailing comment\n",
            "SQ='literal \\n stays'\n",
            "EMPTY=\"\"\n",
            "HASH=un#quoted#kept\n",
        ))
        .unwrap();
        assert_eq!(map.get("DQ").unwrap(), "line1\nline2 # not a comment");
        assert_eq!(map.get("SQ").unwrap(), "literal \\n stays");
        assert_eq!(map.get("EMPTY").unwrap(), "");
        assert_eq!(map.get("HASH").unwrap(), "un#quoted#kept");
    }

    #[test]
    fn dotenv_last_assignment_wins() {
        let map = parse_dotenv("A=first\nA=second\n").unwrap();
        assert_eq!(map.get("A").unwrap(), "second");
    }

    #[test]
    fn dotenv_refuses_invalid_keys_and_shapes() {
        for (bad, needle) in [
            ("1BAD=x\n", "invalid key"),
            ("SPACED KEY=x\n", "invalid key"),
            ("MY-KEY=x\n", "invalid key"),
            ("NOEQUALS\n", "KEY=VALUE"),
            ("OPEN=\"never closed\n", "unterminated"),
            ("TAIL=\"v\" junk\n", "after closing quote"),
        ] {
            let err = parse_dotenv(bad).unwrap_err().to_string();
            assert!(err.contains(needle), "{bad:?} -> {err}");
            assert!(err.contains("line 1"), "{bad:?} -> {err}");
        }
    }

    #[test]
    fn key_charset_is_env_var_shaped() {
        assert!(is_valid_key("_UNDER"));
        assert!(is_valid_key("API_KEY2"));
        assert!(!is_valid_key(""));
        assert!(!is_valid_key("2FA"));
        assert!(!is_valid_key("A.B"));
    }

    #[test]
    fn refuse_secret_shaped_blocks_value_fields() {
        assert!(refuse_secret_shaped(&serde_json::json!({
            "keys": [{"key_name": "A", "version": 1}]
        }))
        .is_ok());
        for leaky in [
            serde_json::json!({"keys": [{"key_name": "A", "value": "sw0rdf1sh"}]}),
            serde_json::json!({"secrets": {"A": "x"}}),
            serde_json::json!({"nested": {"password": "x"}}),
        ] {
            assert!(refuse_secret_shaped(&leaky).is_err());
        }
    }

    #[test]
    fn one_trailing_newline_is_stripped_from_piped_values() {
        assert_eq!(strip_one_trailing_newline("v\n"), "v");
        assert_eq!(strip_one_trailing_newline("v\r\n"), "v");
        assert_eq!(strip_one_trailing_newline("multi\nline\n"), "multi\nline");
        assert_eq!(strip_one_trailing_newline("bare"), "bare");
    }

    #[test]
    fn set_takes_no_value_in_argv() {
        // The only positional is KEY — a value on the command line is a parse
        // error, so a secret can never ride argv / the process list.
        assert!(crate::Cli::try_parse_from([
            "opensesame",
            "config",
            "set",
            "API_KEY",
            "--config",
            "cfg_1"
        ])
        .is_ok());
        assert!(crate::Cli::try_parse_from([
            "opensesame",
            "config",
            "set",
            "API_KEY",
            "sw0rdf1sh",
            "--config",
            "cfg_1"
        ])
        .is_err());
    }

    #[test]
    fn config_verbs_parse_as_specified() {
        for argv in [
            vec!["opensesame", "config", "ls", "--project", "proj-1"],
            vec![
                "opensesame",
                "config",
                "create",
                "--project",
                "proj-1",
                "--slug",
                "dev",
                "--env",
                "development",
            ],
            vec![
                "opensesame",
                "config",
                "create",
                "--project",
                "proj-1",
                "--slug",
                "dev",
                "--env",
                "custom",
                "--parent",
                "cfg_1",
            ],
            vec!["opensesame", "config", "keys", "--config", "cfg_1"],
            vec![
                "opensesame",
                "config",
                "unset",
                "API_KEY",
                "--config",
                "cfg_1",
            ],
            vec![
                "opensesame",
                "config",
                "import",
                ".env",
                "--config",
                "cfg_1",
            ],
            vec![
                "opensesame",
                "config",
                "history",
                "API_KEY",
                "--config",
                "cfg_1",
            ],
            vec![
                "opensesame",
                "config",
                "rollback",
                "API_KEY",
                "--to",
                "2",
                "--config",
                "cfg_1",
            ],
            vec!["opensesame", "config", "diff", "cfg_1", "cfg_2"],
            vec![
                "opensesame",
                "config",
                "branch",
                "cfg_1",
                "--slug",
                "dev-alice",
            ],
        ] {
            assert!(crate::Cli::try_parse_from(&argv).is_ok(), "{argv:?}");
        }
        // Environment is a closed enum.
        assert!(crate::Cli::try_parse_from([
            "opensesame",
            "config",
            "create",
            "--project",
            "p",
            "--slug",
            "s",
            "--env",
            "prod2"
        ])
        .is_err());
    }

    #[test]
    fn env_arg_serializes_to_wire_strings() {
        assert_eq!(EnvArg::Development.as_str(), "development");
        assert_eq!(EnvArg::Staging.as_str(), "staging");
        assert_eq!(EnvArg::Production.as_str(), "production");
        assert_eq!(EnvArg::Custom.as_str(), "custom");
    }
}
