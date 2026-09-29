//! Credential-shaped strings, found and redacted without ever being repeated.
//!
//! Every recognizer here matches a credential by a shape its issuer made
//! distinctive on purpose — a registered prefix, a fixed length, a PEM
//! armour line. Nothing matches on a label (`password=`, `token:`): model
//! messages and tool results are full of code, and a label rule would rewrite
//! `password = read_password()` in the middle of the agent's own work. The
//! audit redactor (`opensesame-redaction`) keeps its label rules because it
//! scrubs log lines; this guard runs over what an agent reads and writes, so
//! precision wins.
//!
//! [`Findings`] is value-blind: a kind and a count, never the matched text and
//! never where it was, so a finding can go into a verdict `message`, a record,
//! or a log without becoming the leak it reports.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

/// A credential the guard recognizes by shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CredentialKind {
    /// A PEM private key block (`-----BEGIN … PRIVATE KEY-----`).
    PrivateKey,
    /// A signed JWT: three base64url segments, header and payload both JSON.
    Jwt,
    /// A GitHub token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`).
    GithubToken,
    /// A GitLab personal access token (`glpat-`).
    GitlabToken,
    /// An AWS access key id (`AKIA…` long-term, `ASIA…` session).
    AwsAccessKeyId,
    /// A Slack token (`xoxb-`, `xoxp-`, …).
    SlackToken,
    /// A Stripe live secret or restricted key (`sk_live_`, `rk_live_`).
    StripeSecretKey,
    /// An Anthropic API key (`sk-ant-`).
    AnthropicApiKey,
    /// An `OpenAI` API key (`sk-`, `sk-proj-`, …).
    OpenaiApiKey,
    /// A Google API key (`AIza…`).
    GoogleApiKey,
    /// An npm access token (`npm_`).
    NpmToken,
    /// An `OpenSesame` `SecretRef` URI (`secret://…`). Not a value, but an agent
    /// holds `ConnectionRef`s only (ADR 0005); naming a secret directly is the
    /// first step of asking for it.
    SecretRef,
}

impl CredentialKind {
    /// Stable wire name, used in redaction markers and verdict messages.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PrivateKey => "private_key",
            Self::Jwt => "jwt",
            Self::GithubToken => "github_token",
            Self::GitlabToken => "gitlab_token",
            Self::AwsAccessKeyId => "aws_access_key_id",
            Self::SlackToken => "slack_token",
            Self::StripeSecretKey => "stripe_secret_key",
            Self::AnthropicApiKey => "anthropic_api_key",
            Self::OpenaiApiKey => "openai_api_key",
            Self::GoogleApiKey => "google_api_key",
            Self::NpmToken => "npm_token",
            Self::SecretRef => "secret_ref",
        }
    }
}

struct Recognizer {
    kind: CredentialKind,
    pattern: Regex,
}

/// Ordered most specific first: a later pattern only ever sees what an
/// earlier one left, so `sk-ant-…` is an Anthropic key and never also an
/// `OpenAI` one, and a PEM block is gone before anything scans its body.
static RECOGNIZERS: LazyLock<Vec<Recognizer>> = LazyLock::new(|| {
    [
        (
            CredentialKind::PrivateKey,
            r"-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----(?s:.*?)(?:-----END[A-Z0-9 ]*PRIVATE KEY-----|\z)",
        ),
        (
            CredentialKind::Jwt,
            r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
        ),
        (
            CredentialKind::GithubToken,
            r"\b(?:gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9_]{22,255})\b",
        ),
        (CredentialKind::GitlabToken, r"\bglpat-[A-Za-z0-9_-]{20,}"),
        (CredentialKind::AwsAccessKeyId, r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
        (CredentialKind::SlackToken, r"\bxox[abposr]-[A-Za-z0-9-]{10,}"),
        (
            CredentialKind::StripeSecretKey,
            r"\b(?:sk|rk)_live_[A-Za-z0-9]{16,}",
        ),
        (CredentialKind::AnthropicApiKey, r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
        (
            CredentialKind::OpenaiApiKey,
            r"\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}",
        ),
        (CredentialKind::GoogleApiKey, r"\bAIza[0-9A-Za-z_-]{35}"),
        (CredentialKind::NpmToken, r"\bnpm_[A-Za-z0-9]{36}\b"),
        (CredentialKind::SecretRef, r#"\bsecret://[^\s"'<>]+"#),
    ]
    .into_iter()
    .map(|(kind, pattern)| Recognizer {
        kind,
        pattern: Regex::new(pattern).expect("static credential pattern"),
    })
    .collect()
});

/// What a scan found: how many of each kind. Never a value, never a position.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Findings {
    counts: BTreeMap<CredentialKind, usize>,
}

impl Findings {
    /// True when nothing credential-shaped was found.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.counts.is_empty()
    }

    /// How many credential-shaped strings were found, of every kind.
    #[must_use]
    pub fn total(&self) -> usize {
        self.counts.values().sum()
    }

    /// The kinds found, in a stable order.
    pub fn kinds(&self) -> impl Iterator<Item = CredentialKind> + '_ {
        self.counts.keys().copied()
    }

    /// `github_token×2, jwt×1` — safe to put in a verdict message.
    #[must_use]
    pub fn summary(&self) -> String {
        let mut out = String::new();
        for (kind, count) in &self.counts {
            if !out.is_empty() {
                out.push_str(", ");
            }
            let _ = write!(out, "{}×{count}", kind.as_str());
        }
        out
    }

    fn add(&mut self, kind: CredentialKind, count: usize) {
        if count > 0 {
            *self.counts.entry(kind).or_default() += count;
        }
    }
}

/// The marker a redacted credential is replaced with.
#[must_use]
pub fn marker(kind: CredentialKind) -> String {
    format!("[redacted:{}]", kind.as_str())
}

fn redact_str(input: &str, findings: &mut Findings) -> String {
    let mut text = input.to_owned();
    for recognizer in RECOGNIZERS.iter() {
        let count = recognizer.pattern.find_iter(&text).count();
        if count == 0 {
            continue;
        }
        findings.add(recognizer.kind, count);
        text = recognizer
            .pattern
            .replace_all(&text, marker(recognizer.kind).as_str())
            .into_owned();
    }
    text
}

fn redact_into(value: &Value, findings: &mut Findings) -> Value {
    match value {
        Value::String(s) => Value::String(redact_str(s, findings)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| redact_into(item, findings))
                .collect(),
        ),
        // Keys are scanned too: a credential used as a map key is still a
        // credential. Two keys that redact to the same marker collapse into
        // one member — lossy, and the right way round for a guard.
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (redact_str(key, findings), redact_into(item, findings)))
                .collect::<Map<_, _>>(),
        ),
        other => other.clone(),
    }
}

/// A copy of `value` with every credential-shaped string replaced by its
/// [`marker`], and what was replaced.
#[must_use]
pub fn redact(value: &Value) -> (Value, Findings) {
    let mut findings = Findings::default();
    let redacted = redact_into(value, &mut findings);
    (redacted, findings)
}

/// What [`redact`] would replace, without keeping the copy.
#[must_use]
pub fn scan(value: &Value) -> Findings {
    redact(value).1
}
