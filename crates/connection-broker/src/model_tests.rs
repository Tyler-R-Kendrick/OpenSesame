use super::*;

#[test]
fn status_vocabulary_round_trips() {
    for s in [
        ConnectionStatus::Pending,
        ConnectionStatus::Active,
        ConnectionStatus::NeedsReauth,
        ConnectionStatus::Expired,
        ConnectionStatus::Revoked,
        ConnectionStatus::Error,
    ] {
        assert_eq!(ConnectionStatus::parse(s.as_str()), s);
        assert_eq!(
            serde_json::to_value(s).unwrap(),
            serde_json::Value::String(s.as_str().into())
        );
    }
    assert_eq!(
        ConnectionStatus::parse("nonsense"),
        ConnectionStatus::Pending
    );
}

#[test]
fn binding_target_kinds_are_closed() {
    for (name, kind) in [
        ("organization", BindingTargetKind::Organization),
        ("project", BindingTargetKind::Project),
        ("agent", BindingTargetKind::Agent),
        ("group", BindingTargetKind::Group),
        ("device", BindingTargetKind::Device),
        ("identity", BindingTargetKind::Identity),
    ] {
        assert_eq!(BindingTargetKind::parse(name), Some(kind));
    }
    assert!(BindingTargetKind::parse("everything").is_none());
}

#[test]
fn event_kinds_match_the_contract() {
    let names: Vec<_> = [
        EventKind::Created,
        EventKind::AuthorizeStarted,
        EventKind::Authorized,
        EventKind::Refreshed,
        EventKind::RefreshFailed,
        EventKind::Bound,
        EventKind::Unbound,
        EventKind::PolicyUpdated,
        EventKind::Revoked,
        EventKind::Materialized,
        EventKind::Delegated,
        EventKind::DelegationRevoked,
        EventKind::DelegationBurned,
        EventKind::Error,
    ]
    .iter()
    .map(|k| k.as_str())
    .collect();
    assert_eq!(
        names,
        vec![
            "created",
            "authorize_started",
            "authorized",
            "refreshed",
            "refresh_failed",
            "bound",
            "unbound",
            "policy_updated",
            "revoked",
            "materialized",
            "delegated",
            "delegation_revoked",
            "delegation_burned",
            "error"
        ]
    );
}
