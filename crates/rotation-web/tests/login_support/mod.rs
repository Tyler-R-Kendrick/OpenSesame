//! Shared fixtures for the login-substitution suites: one declared login, and
//! requests built the way a runner's egress hook would see them.
#![allow(dead_code)] // each test crate uses a different slice of the fixtures

use opensesame_plugin_settings::PluginState;
use opensesame_rotation_web::{
    ArmedSubstitution, FieldSnapshot, LoginRequest, LoginRoad, LoginSubstitution,
    LoginSubstitutionSpec, Refusal, RefusalCode, Substituted, SUBSTITUTION_PLUGIN,
};
use secrecy::SecretString;

pub const ORIGIN: &str = "https://login.example";
pub const ACTION: &str = "/session";
pub const URL: &str = "https://login.example/session";
pub const ENTROPY: [u8; 16] = [
    0x0f, 0x1e, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0x87, 0x96, 0xa5, 0xb4, 0xc3, 0xd2, 0xe1, 0xf0,
];
/// The surrogate `ENTROPY` issues.
pub const SURROGATE: &str = "osr_0f1e2d3c4b5a69788796a5b4c3d2e1f0";
/// Every byte form encoding and JSON escaping can mangle.
pub const SECRET: &str = "pa&ss=wo%rd+ \"q\\ é";

pub fn control(selector: &str, autocomplete: Option<&str>) -> FieldSnapshot {
    FieldSnapshot {
        selector: selector.into(),
        input_type: Some("password".into()),
        autocomplete: autocomplete.map(Into::into),
        is_credential_target: true,
        has_box: true,
    }
}

pub fn spec(field: &str) -> LoginSubstitutionSpec {
    LoginSubstitutionSpec {
        origin: ORIGIN.into(),
        action_path: ACTION.into(),
        field: field.into(),
        control: control("#password", Some("current-password")),
    }
}

/// The `surrogate-proxy` plugin installed and switched on: the only state
/// that arms a declared substitution.
pub fn plugin_on() -> PluginState {
    PluginState {
        id: SUBSTITUTION_PLUGIN.into(),
        capability: "agents.surrogate-credentials".into(),
        installed: true,
        version: Some("1.0.0".into()),
        enabled: true,
        forced_off: false,
        active: true,
    }
}

/// The declared login, armed by the plugin's switch.
pub fn declared() -> ArmedSubstitution {
    let substitution = LoginSubstitution::declare(spec("password"), ENTROPY).unwrap();
    assert_eq!(substitution.surrogate().as_str(), SURROGATE);
    match LoginRoad::choose(Some(substitution), &plugin_on()) {
        LoginRoad::Substitute(armed) => armed,
        LoginRoad::CdpFill(why) => panic!("not armed: {why:?}"),
    }
}

pub fn secret() -> SecretString {
    SecretString::from(SECRET.to_string())
}

pub fn headers(content_type: &str) -> Vec<(String, String)> {
    vec![
        ("Content-Type".into(), content_type.into()),
        ("Accept".into(), "text/html".into()),
    ]
}

pub fn form() -> Vec<(String, String)> {
    headers("application/x-www-form-urlencoded")
}

pub fn json() -> Vec<(String, String)> {
    headers("application/json")
}

pub fn post<'a>(url: &'a str, headers: &'a [(String, String)], body: &'a [u8]) -> LoginRequest<'a> {
    LoginRequest {
        method: "POST",
        url,
        headers,
        body,
    }
}

/// Substitute a body posted to the declared action with `headers`.
pub fn run(headers: &[(String, String)], body: &str) -> Result<Substituted, Refusal> {
    declared().substitute(&post(URL, headers, body.as_bytes()), &secret())
}

/// Assert `result` was refused with `code`, and that the refusal carries
/// neither the surrogate nor the secret.
pub fn assert_refused(result: Result<Substituted, Refusal>, code: RefusalCode) -> Refusal {
    let refusal = result.expect_err("the request must be refused");
    assert_eq!(refusal.code, code, "{refusal:?}");
    let shown = format!("{refusal:?} {refusal}");
    assert!(!shown.contains(SURROGATE), "{shown}");
    assert!(!shown.contains(SECRET), "{shown}");
    refusal
}
