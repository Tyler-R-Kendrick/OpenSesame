mod support;
use opensesame_broker::InvokeInput;
use serde_json::json;
use support::{sample_grant, sample_intent, setup};

#[tokio::test]
async fn reserved_controlled_refs_never_reach_a_production_executor() {
    let (broker, org, principal, actor) = setup().await;
    for reference in [
        "oscanary:v1:malformed",
        "oscanary:v2:forged",
        "oscanary:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ] {
        let params = json!({});
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let result = broker
            .invoke_with(
                InvokeInput {
                    intent: sample_intent(
                        org,
                        principal,
                        actor,
                        "repository.read",
                        reference,
                        &params,
                    ),
                    grant: sample_grant(org, principal),
                    subject: "user:demo".into(),
                    connection_policy_id: reference.into(),
                    parameters: params,
                    lineage: None,
                },
                || async {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Err(opensesame_connector_host::HostError::InvokeLevelDenied)
                },
            )
            .await;
        assert!(result.is_err());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn a_registered_canary_records_bounded_evidence_without_production_execution() {
    let (broker, org, principal, actor) = setup().await;
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/app-core/src/lib/credential-canaries/protocol-vectors.json"
    ))
    .unwrap();
    let vector = &vectors["vectors"][0];
    let artifact = serde_json::from_value(json!({
        "id": "00000000-0000-4000-8000-000000000072",
        "context": vector["context"],
        "digestB64": vector["digestB64"],
        "state": "bait",
        "createdAt": "2026-10-06T00:00:00Z"
    }))
    .unwrap();
    broker
        .db
        .register_controlled_canary(
            &opensesame_storage::credential_canaries::HostCanaryBinding {
                organization_id: org,
                tomb: "personal".into(),
                vault_identity: "public-vector-vault".into(),
            },
            &artifact,
        )
        .await
        .unwrap();
    let reference = format!("oscanary:v1:{}", vector["presentedId"].as_str().unwrap());
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let params = json!({});
    let result = broker
        .invoke_with(
            InvokeInput {
                intent: sample_intent(
                    org,
                    principal,
                    actor,
                    "repository.read",
                    "registered-canary",
                    &params,
                ),
                grant: sample_grant(org, principal),
                subject: "user:demo".into(),
                connection_policy_id: reference,
                parameters: params,
                lineage: None,
            },
            || async {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Err(opensesame_connector_host::HostError::InvokeLevelDenied)
            },
        )
        .await;
    assert!(result.is_err());
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    let status = broker
        .db
        .controlled_canary_status(&org, "personal")
        .await
        .unwrap();
    assert_eq!(status.events.len(), 1);
    assert_eq!(
        status.events[0].artifact_id,
        "00000000-0000-4000-8000-000000000072"
    );
}
