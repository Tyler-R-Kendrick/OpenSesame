//! The approver's deployment configuration refuses what would fail at the
//! first escalation, and the per-run seam is only ever built for somebody
//! the organization (or the operator) named (ADR 0159).

use super::*;
use opensesame_storage::agent_hook_policy::approver::{
    AgentHookApproverAudit, AgentHookApproverWrite,
};

const BEARER: &str = "requester-bearer-value-never-echoed";
const HANDLE: &str = "inbox_YXBwcm92ZXI.test-tag";
const DEFAULT_HANDLE: &str = "inbox_ZGVmYXVsdA.default-tag";

fn read(pairs: &[(&str, &str)]) -> Result<Option<ApproverSettings>, ApproverConfigError> {
    ApproverSettings::from_lookup(&|name| {
        pairs
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| (*value).to_owned())
    })
}

fn complete() -> Vec<(&'static str, &'static str)> {
    vec![
        (ENV_URL, "https://identity.example.com"),
        (ENV_BEARER, BEARER),
    ]
}

#[test]
fn nothing_configured_is_no_approver_and_blank_values_are_nothing() {
    assert!(read(&[]).unwrap().is_none());
    // `.env.schema` entries left empty are unset, not partial.
    let blanks = [
        (ENV_URL, ""),
        (ENV_BEARER, "  "),
        (ENV_REF, ""),
        (ENV_TTL, ""),
    ];
    assert!(read(&blanks).unwrap().is_none());
}

#[test]
fn a_complete_configuration_reads_with_documented_defaults() {
    let settings = read(&complete()).unwrap().unwrap();
    assert_eq!(settings.ttl, Duration::from_secs(300));
    assert_eq!(settings.deadline, Duration::from_secs(300));
    assert_eq!(settings.poll_interval, DEFAULT_POLL_INTERVAL);
    assert_eq!(settings.default_ref(), None);
    let mut tuned = complete();
    tuned.extend([
        (ENV_REF, HANDLE),
        (ENV_TTL, "600"),
        (ENV_POLL, "500"),
        (ENV_DEADLINE, "120"),
    ]);
    let tuned = read(&tuned).unwrap().unwrap();
    assert_eq!(tuned.default_ref(), Some(HANDLE));
    assert_eq!(
        (tuned.ttl, tuned.poll_interval, tuned.deadline),
        (
            Duration::from_secs(600),
            Duration::from_millis(500),
            Duration::from_secs(120)
        )
    );
    assert!(tuned.approver(DEFAULT_HANDLE).is_ok());
}

#[test]
fn a_partial_configuration_refuses_to_start_naming_what_is_missing() {
    for (given, missing) in [
        (vec![(ENV_URL, "https://identity.example.com")], ENV_BEARER),
        (vec![(ENV_BEARER, BEARER)], ENV_URL),
        (vec![(ENV_REF, HANDLE)], ENV_URL),
        (vec![(ENV_TTL, "300")], ENV_URL),
        (vec![(ENV_POLL, "100")], ENV_URL),
        (vec![(ENV_DEADLINE, "60")], ENV_URL),
    ] {
        assert_eq!(
            read(&given).unwrap_err(),
            ApproverConfigError::Partial { missing },
            "{given:?}"
        );
    }
}

#[test]
fn an_unusable_value_refuses_to_start_naming_the_variable_and_never_its_value() {
    let with = |extra: (&'static str, &'static str)| {
        let mut pairs = complete();
        pairs.retain(|(name, _)| *name != extra.0);
        pairs.push(extra);
        pairs
    };
    for (extra, variable) in [
        ((ENV_URL, "http://identity.example.com"), ENV_URL),
        ((ENV_URL, "not a url"), ENV_URL),
        ((ENV_URL, "https://user:pw@identity.example.com"), ENV_URL),
        ((ENV_TTL, "29"), ENV_TTL),
        ((ENV_TTL, "3601"), ENV_TTL),
        ((ENV_TTL, "soon"), ENV_TTL),
        ((ENV_POLL, "0"), ENV_POLL),
        ((ENV_POLL, "fast"), ENV_POLL),
        ((ENV_DEADLINE, "0"), ENV_POLL),
        ((ENV_REF, "https://elsewhere.example/inbox_x"), ENV_REF),
    ] {
        let error = read(&with(extra)).unwrap_err();
        let ApproverConfigError::Invalid {
            variable: named, ..
        } = &error
        else {
            panic!("{extra:?}: {error:?}");
        };
        assert_eq!(*named, variable, "{extra:?}");
        let shown = format!("{error} {error:?}");
        assert!(!shown.contains(BEARER), "{shown}");
        assert!(!shown.contains(extra.1) || extra.1.len() < 5, "{shown}");
    }
    // Loopback http is how a test or a local stack reaches an Identity API.
    let mut loopback = complete();
    loopback[0] = (ENV_URL, "http://127.0.0.1:8788");
    assert!(read(&loopback).unwrap().is_some());
    // The bearer is never shown by the settings either.
    let settings = read(&complete()).unwrap().unwrap();
    assert!(!format!("{settings:?}").contains(BEARER));
}

#[test]
fn a_handle_must_look_like_an_inbox_handle() {
    for good in [HANDLE, DEFAULT_HANDLE, "inbox_abcdef", "inbox_A-b_c.D"] {
        assert!(valid_approver_ref(good), "{good}");
    }
    let long = format!("inbox_{}", "a".repeat(251));
    for bad in [
        "",
        "inbox_",
        "inbox_a",
        "inbox_has space",
        "inbox_https://x",
        "inbox_a\nb",
        "Inbox_abcdef",
        "abcdefghij",
        long.as_str(),
    ] {
        assert!(!valid_approver_ref(bad), "{bad:?}");
    }
}

async fn state_with(default_ref: Option<&str>) -> AppState {
    let mut state = crate::app_state::test_demo_state().await;
    let mut pairs = complete();
    pairs[0] = (ENV_URL, "http://127.0.0.1:9");
    if let Some(handle) = default_ref {
        pairs.push((ENV_REF, handle));
    }
    state.agent_hook_approver = read(&pairs).unwrap().map(Into::into);
    state
}

async fn store(state: &AppState, handle: Option<&str>, expected: i64) {
    let org = state.connection_organization.to_string();
    state
        .db
        .put_agent_hook_approver(
            &AgentHookApproverWrite {
                organization_id: &org,
                approver_ref: handle,
                expected_version: expected,
                updated_by: "operator",
            },
            &AgentHookApproverAudit {
                event_type: EVENT_APPROVER_UPDATED,
                payload_json: "{}",
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn a_run_gets_a_seam_only_for_somebody_named() {
    let org = crate::app_state::test_demo_state()
        .await
        .connection_organization;

    // No deployment configuration: nobody is ever asked.
    let mut none = crate::app_state::test_demo_state().await;
    none.agent_hook_approver = None;
    store(&none, Some(HANDLE), 0).await;
    assert!(resolver_for(&none, &org).await.is_none());

    // Configured, but nobody named by the organization or the operator.
    let nobody = state_with(None).await;
    assert!(resolver_for(&nobody, &nobody.connection_organization)
        .await
        .is_none());

    // The organization's own handle.
    let named = state_with(None).await;
    store(&named, Some(HANDLE), 0).await;
    assert!(resolver_for(&named, &named.connection_organization)
        .await
        .is_some());

    // The operator's default when the organization has no row...
    let defaulted = state_with(Some(DEFAULT_HANDLE)).await;
    assert!(resolver_for(&defaulted, &defaulted.connection_organization)
        .await
        .is_some());
    // ...but a row that clears the handle asks nobody, default or not.
    store(&defaulted, None, 0).await;
    assert!(resolver_for(&defaulted, &defaulted.connection_organization)
        .await
        .is_none());

    // Another organization does not inherit this one's handle.
    assert!(resolver_for(&named, &OrganizationId::new()).await.is_none());
}

#[tokio::test]
async fn an_unreadable_store_asks_nobody() {
    let state = state_with(Some(DEFAULT_HANDLE)).await;
    sqlx::query("DROP TABLE agent_hook_approvers")
        .execute(state.db.pool())
        .await
        .unwrap();
    assert!(resolver_for(&state, &state.connection_organization)
        .await
        .is_none());
}

/// Startup reads the process environment, so a half-configured approver
/// stops the Host from coming up at all — not the first escalation, hours
/// into a rotation.
#[tokio::test]
async fn a_partial_approver_refuses_to_build_the_host() {
    let _guard = crate::app_state::test_env::lock();
    std::env::set_var("OPENSESAME_TASKBUS", "memory");
    let args = || crate::config::Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: "https://opensesame.test".into(),
        issuer: "https://identity.test".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
        profile: crate::config::GatewayProfile::Host,
    };

    std::env::set_var(ENV_URL, "https://identity.example.com");
    let partial = crate::app_state::build_test(args()).await;
    std::env::set_var(ENV_BEARER, BEARER);
    let complete = crate::app_state::build_test(args()).await;
    std::env::set_var(ENV_URL, "http://identity.example.com");
    let insecure = crate::app_state::build_test(args()).await;
    for name in [ENV_URL, ENV_BEARER] {
        std::env::remove_var(name);
    }

    let refused = partial.err().expect("a URL without a bearer is refused");
    assert!(refused.to_string().contains(ENV_BEARER), "{refused}");
    assert!(complete.unwrap().agent_hook_approver.is_some());
    let refused = insecure
        .err()
        .expect("plain http to a real host is refused");
    assert!(refused.to_string().contains(ENV_URL), "{refused}");
    assert!(!refused.to_string().contains(BEARER), "{refused}");
}
