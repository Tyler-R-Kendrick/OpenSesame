//! What an Interaction-backed approver refuses to be built with.

mod interaction_mock;

use std::time::Duration;

use interaction_mock::config;
use opensesame_agent_hooks::{InteractionApprover, InteractionConfigError};

fn build(
    edit: impl FnOnce(&mut opensesame_agent_hooks::InteractionApproverConfig),
) -> Result<InteractionApprover, InteractionConfigError> {
    let mut cfg = config("https://identity.example", Duration::from_secs(60));
    edit(&mut cfg);
    InteractionApprover::new(cfg)
}

#[test]
fn https_and_loopback_http_are_accepted() {
    for url in [
        "https://identity.example",
        "https://identity.example/base/",
        "http://127.0.0.1:8788",
        "http://[::1]:8788",
        "http://localhost:8788",
    ] {
        assert!(build(|c| c.identity_api_url = url.into()).is_ok(), "{url}");
    }
}

#[test]
fn plain_http_elsewhere_and_odd_urls_are_refused() {
    let cases = [
        (
            "http://identity.example",
            InteractionConfigError::InsecureUrl,
        ),
        ("http://10.0.0.1:8788", InteractionConfigError::InsecureUrl),
        (
            "ftp://identity.example",
            InteractionConfigError::InsecureUrl,
        ),
        (
            "https://user:pass@identity.example",
            InteractionConfigError::InvalidUrl,
        ),
        (
            "https://identity.example/?token=x",
            InteractionConfigError::InvalidUrl,
        ),
        (
            "https://identity.example/#x",
            InteractionConfigError::InvalidUrl,
        ),
        ("not a url", InteractionConfigError::InvalidUrl),
    ];
    for (url, expected) in cases {
        let refused = build(|c| c.identity_api_url = url.into()).expect_err(url);
        assert_eq!(refused, expected, "{url}");
        // Errors name the field, never its value.
        assert!(!refused.to_string().contains(url));
    }
}

#[test]
fn the_approver_handle_must_be_an_inbox_handle() {
    for handle in [
        "",
        "inbox_",
        "principal-123",
        &format!("inbox_{}", "a".repeat(260)),
    ] {
        let refused = build(|c| c.approver_ref = handle.to_owned()).expect_err(handle);
        assert_eq!(refused, InteractionConfigError::InvalidApproverRef);
    }
}

#[test]
fn an_empty_bearer_is_refused() {
    let refused = build(|c| c.bearer = String::new().into()).expect_err("empty bearer");
    assert_eq!(refused, InteractionConfigError::EmptyBearer);
}

#[test]
fn the_window_stays_inside_the_identity_apis_bounds() {
    for ttl in [
        Duration::from_secs(29),
        Duration::from_secs(3601),
        Duration::from_millis(30_500),
    ] {
        let refused = build(|c| c.ttl = ttl).expect_err("ttl");
        assert_eq!(refused, InteractionConfigError::TtlOutOfRange);
    }
    assert!(build(|c| c.ttl = Duration::from_secs(30)).is_ok());
    assert!(build(|c| c.ttl = Duration::from_secs(3600)).is_ok());
}

#[test]
fn timing_must_be_usable() {
    let zero_poll = build(|c| c.poll_interval = Duration::ZERO).expect_err("zero poll");
    assert_eq!(zero_poll, InteractionConfigError::InvalidTiming);
    let zero_deadline = build(|c| c.deadline = Duration::ZERO).expect_err("zero deadline");
    assert_eq!(zero_deadline, InteractionConfigError::InvalidTiming);
    let slow = build(|c| {
        c.poll_interval = Duration::from_secs(10);
        c.deadline = Duration::from_secs(5);
    })
    .expect_err("interval past deadline");
    assert_eq!(slow, InteractionConfigError::InvalidTiming);
}

#[test]
fn debug_never_prints_the_bearer() {
    let approver = build(|_| {}).expect("valid");
    let printed = format!("{approver:?}");
    assert!(!printed.contains(interaction_mock::BEARER), "{printed}");
}
