//! Credential recognition. Every fixture is assembled at run time so the
//! source never holds a string a secret scanner would flag.

use opensesame_agent_hooks::secrets::{self, CredentialKind};
use serde_json::json;

fn fake(prefix: &str, body: char, len: usize) -> String {
    format!("{prefix}{}", body.to_string().repeat(len))
}

fn kinds_of(text: &str) -> Vec<CredentialKind> {
    secrets::scan(&json!(text)).kinds().collect()
}

#[test]
fn recognizes_each_shape_by_its_issuer_prefix() {
    let cases = [
        (fake("ghp_", 'a', 36), CredentialKind::GithubToken),
        (fake("github_pat_", 'B', 40), CredentialKind::GithubToken),
        (fake("glpat-", 'c', 20), CredentialKind::GitlabToken),
        (fake("AKIA", 'Q', 16), CredentialKind::AwsAccessKeyId),
        (fake("xoxb-", '1', 24), CredentialKind::SlackToken),
        (fake("sk_live_", 'd', 24), CredentialKind::StripeSecretKey),
        (fake("sk-ant-", 'e', 40), CredentialKind::AnthropicApiKey),
        (fake("sk-proj-", 'f', 40), CredentialKind::OpenaiApiKey),
        (fake("AIza", 'g', 35), CredentialKind::GoogleApiKey),
        (fake("npm_", 'h', 36), CredentialKind::NpmToken),
        (
            "secret://acme/prod/db".to_owned(),
            CredentialKind::SecretRef,
        ),
    ];
    for (token, kind) in cases {
        let text = format!("the value is {token} ok");
        assert_eq!(kinds_of(&text), vec![kind], "{}", kind.as_str());
    }
}

#[test]
fn recognizes_a_jwt_and_a_pem_block() {
    let jwt = format!(
        "eyJ{}.eyJ{}.{}",
        "h".repeat(12),
        "p".repeat(20),
        "s".repeat(16)
    );
    assert_eq!(kinds_of(&jwt), vec![CredentialKind::Jwt]);

    let begin = ["-----BEGIN", " RSA PRIVATE", " KEY-----"].concat();
    let end = ["-----END", " RSA PRIVATE", " KEY-----"].concat();
    let pem = format!("{begin}\nMIIE{}\n{end}\n", "A".repeat(64));
    let (redacted, findings) = secrets::redact(&json!(pem));
    assert_eq!(
        findings.kinds().collect::<Vec<_>>(),
        vec![CredentialKind::PrivateKey]
    );
    assert_eq!(redacted, json!("[redacted:private_key]\n"));

    // A block cut off before its END line is still a key.
    let truncated = format!("{begin}\nMIIE{}", "A".repeat(64));
    assert_eq!(kinds_of(&truncated), vec![CredentialKind::PrivateKey]);
}

#[test]
fn an_anthropic_key_is_not_also_an_openai_key() {
    let findings = secrets::scan(&json!(fake("sk-ant-api03-", 'x', 60)));
    assert_eq!(findings.total(), 1);
    assert_eq!(findings.summary(), "anthropic_api_key×1");
}

#[test]
fn ordinary_code_and_prose_pass_untouched() {
    let benign = json!({
        "code": "let password = read_password(); token = session.token",
        "prose": "Use a ConnectionRef such as conn://acme/github, never the key.",
        "near_misses": [
            fake("ghp_", 'a', 12),
            fake("AKIA", 'q', 16),
            "sk-short",
            "AIza-too-short",
            "eyJhbGciOiJIUzI1NiJ9",
        ],
        "numbers": [1, 2.5, null, true],
    });
    let (redacted, findings) = secrets::redact(&benign);
    assert!(findings.is_empty(), "{}", findings.summary());
    assert_eq!(redacted, benign);
}

#[test]
fn redaction_walks_arrays_objects_and_keys() {
    let token = fake("ghp_", 'z', 36);
    let value = json!({
        "messages": [
            {"role": "user", "content": format!("use {token} and {token}")},
            {"role": "tool", "content": {"headers": {"x-api-key": fake("sk-proj-", 'k', 40)}}},
        ],
        token.clone(): "a credential used as a key",
    });
    let (redacted, findings) = secrets::redact(&value);
    assert_eq!(findings.summary(), "github_token×3, openai_api_key×1");
    let text = redacted.to_string();
    assert!(!text.contains(&token));
    assert!(text.contains("use [redacted:github_token] and [redacted:github_token]"));
    assert!(text.contains("[redacted:openai_api_key]"));
    assert_eq!(
        redacted["[redacted:github_token]"],
        "a credential used as a key"
    );
}

#[test]
fn findings_never_carry_the_value() {
    let token = fake("xoxp-", '9', 30);
    let findings = secrets::scan(&json!([token.clone(), token.clone()]));
    let rendered = format!("{findings:?} {}", findings.summary());
    assert!(!rendered.contains(&token));
    assert_eq!(findings.summary(), "slack_token×2");
}
