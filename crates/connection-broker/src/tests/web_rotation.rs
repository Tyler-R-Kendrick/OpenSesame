//! The web-login rotation state machine (ADR 0076).

use super::*;

#[tokio::test]
async fn rotation_happy_path_completes_the_machine_and_wakes_dependents() {
    let fixture = rotation_fixture().await;
    let bus = opensesame_task_bus::InMemoryTaskBus::default();
    let job = request_rotation(
        &fixture.broker,
        &bus,
        RotationTarget::Connection {
            connection_id: fixture.connection_id,
        },
        Some("proj-rot".into()),
        &fixture.organization.to_string(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(job.state, "scheduled");

    let done = execute_connection_rotation(&fixture.broker, &bus, &fixture.organization, &job.id)
        .await
        .unwrap();
    assert_eq!(done.state, "completed", "{done:?}");
    assert_eq!(done.status, RotationStatus::Succeeded);
    // Verification is honestly skipped (no provider no-op invoke) and the
    // skip note survives the later transitions.
    assert!(done
        .detail
        .as_deref()
        .unwrap_or_default()
        .contains("verify_skipped"));

    // The durable row holds the terminal machine state.
    let persisted = fixture
        .broker
        .get_rotation_job(&fixture.organization.to_string(), &job.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(persisted.state, "completed");

    // DependentsUpdated appended exactly one sync wake for the config.
    let dirty: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM config_sync_outbox WHERE config_id = ? \
         AND event_type = 'sync.config.dirty'",
    )
    .bind(&fixture.config_id)
    .fetch_one(fixture.db.pool())
    .await
    .unwrap();
    assert_eq!(dirty, 1);

    // Frozen changelog vocabulary only; requested + succeeded recorded; no
    // token material anywhere near the changelog or the bus.
    let entries = fixture
        .broker
        .list_changelog(&fixture.organization.to_string(), "proj-rot", 20, None)
        .await
        .unwrap();
    assert!(entries
        .iter()
        .any(|e| e.event_type == EVENT_ROTATION_REQUESTED));
    assert!(entries
        .iter()
        .any(|e| e.event_type == EVENT_ROTATION_SUCCEEDED));
    for entry in &entries {
        assert!(is_allowed_changelog_event_type(&entry.event_type));
        let text = serde_json::to_string(entry).unwrap();
        assert!(!text.contains("race-access"));
        assert!(!text.contains("race-refresh"));
    }
    let events = bus.drain(20).await.unwrap();
    assert!(events.iter().any(|e| e.r#type == EVENT_ROTATION_SUCCEEDED));
    for event in &events {
        let text = event.data.to_string();
        assert!(!text.contains("race-access"));
        assert!(!text.contains("race-refresh"));
    }
}

/// Coverage for `authorized_bytes`, the credential-injecting upload path
/// (ADR 0054). Every test here drives a real local server through the `mock`
/// provider, whose catalog egress allows `127.0.0.1` over http.
mod authorized_bytes_tests {
    use super::*;
    use axum::{
        body::Bytes,
        http::{HeaderMap, StatusCode},
        response::{IntoResponse, Response},
        routing::post as axum_post,
    };
    use std::sync::Mutex as StdMutex;

    /// How the mock server answers, shared with the handler.
    type Answer = Arc<dyn Fn() -> Response + Send + Sync>;
    /// Handler state: what has been seen, and how to reply.
    type MockState = State<(Arc<StdMutex<Seen>>, Answer)>;

    /// What a request actually carried, so a test can assert on the wire and
    /// not on what the code claims to have sent.
    #[derive(Default)]
    struct Seen {
        bodies: Vec<Vec<u8>>,
        auth: Vec<String>,
        extra: Vec<String>,
    }

    async fn handle_upload(
        State((sink, answer)): MockState,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        let mut seen = sink.lock().unwrap();
        seen.bodies.push(body.to_vec());
        seen.auth.push(
            headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
        );
        seen.extra.push(
            headers
                .get("dropbox-api-arg")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
        );
        drop(seen);
        answer()
    }

    /// An activated `mock` connection: Active, with a real sealed credential.
    async fn active_mock_connection() -> (Arc<ConnectionBroker>, OrganizationId, String) {
        let (_db, broker, org, integration) =
            organization_oauth_broker_with_token_url(token_server().await).await;
        let connection = broker
            .create_connection(
                &org,
                CreateConnection {
                    integration_id: Some(integration),
                    ..create("mock")
                },
            )
            .await
            .unwrap();
        let start = broker
            .start_authorization(&org, &connection.connection_id, None, None)
            .await
            .unwrap();
        broker
            .complete_authorization("mock", "the-code", &start.state)
            .await
            .unwrap();
        (broker, org, connection.connection_id)
    }

    /// A server that records what it received and answers however the test asks.
    async fn recording_server(
        answer: impl Fn() -> Response + Clone + Send + Sync + 'static,
    ) -> (String, Arc<StdMutex<Seen>>) {
        let seen = Arc::new(StdMutex::new(Seen::default()));
        let sink = seen.clone();
        let answer: Answer = Arc::new(answer);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                Router::new()
                    .route("/upload", axum_post(handle_upload))
                    .route("/elsewhere", axum_post(handle_upload))
                    .with_state((sink, answer)),
            )
            .await;
        });
        (format!("http://{address}"), seen)
    }

    #[tokio::test]
    async fn uploads_bytes_with_the_credential_injected() {
        let (broker, org, connection) = active_mock_connection().await;
        let (base, seen) = recording_server(|| (StatusCode::OK, "{}").into_response()).await;

        broker
            .authorized_bytes(
                &org,
                &connection,
                &format!("{base}/upload"),
                &[(
                    "Dropbox-API-Arg".to_string(),
                    "{\"path\":\"/x\"}".to_string(),
                )],
                b"sealed ciphertext".to_vec(),
            )
            .await
            .expect("upload should succeed");

        let seen = seen.lock().unwrap();
        assert_eq!(seen.bodies, vec![b"sealed ciphertext".to_vec()]);
        assert!(
            seen.auth[0].starts_with("Bearer "),
            "the credential must be injected: {:?}",
            seen.auth[0]
        );
        assert!(!seen.auth[0].contains("Bearer Bearer"));
        assert_eq!(seen.extra[0], "{\"path\":\"/x\"}");
    }

    #[tokio::test]
    async fn refuses_a_url_outside_the_connections_egress_allowlist() {
        let (broker, org, connection) = active_mock_connection().await;
        // The mock provider's catalog egress is 127.0.0.1 over http only.
        for hostile in [
            "https://evil.example.com/upload",
            "http://169.254.169.254/latest/meta-data/",
            "http://127.0.0.1.evil.com/upload",
        ] {
            let error = broker
                .authorized_bytes(&org, &connection, hostile, &[], b"x".to_vec())
                .await
                .expect_err("egress allowlist must refuse this");
            assert_eq!(error.code(), "invalid_request", "for {hostile}");
        }
    }

    #[tokio::test]
    async fn never_follows_a_redirect_and_never_replays_the_token() {
        // The property the dedicated no-redirect client exists for. A default
        // reqwest client would follow this and hand the bearer token to the
        // redirect target — so the assertion that matters is not just that the
        // call failed, but that the second endpoint was never contacted.
        let (broker, org, connection) = active_mock_connection().await;
        let (base, seen) = recording_server(|| {
            Response::builder()
                .status(StatusCode::FOUND)
                .header("location", "/elsewhere")
                .body(axum::body::Body::empty())
                .unwrap()
        })
        .await;

        let error = broker
            .authorized_bytes(
                &org,
                &connection,
                &format!("{base}/upload"),
                &[],
                b"x".to_vec(),
            )
            .await
            .expect_err("a redirect must not be followed");
        assert!(
            error.to_string().contains("redirect"),
            "the refusal should say why: {error}"
        );

        let seen = seen.lock().unwrap();
        assert_eq!(
            seen.auth.len(),
            1,
            "the token must reach the original host once and nowhere else"
        );
    }

    #[tokio::test]
    async fn refuses_caller_headers_the_broker_owns() {
        let (broker, org, connection) = active_mock_connection().await;
        let (base, seen) = recording_server(|| (StatusCode::OK, "{}").into_response()).await;

        for reserved in ["Authorization", "authorization", "Content-Type"] {
            let error = broker
                .authorized_bytes(
                    &org,
                    &connection,
                    &format!("{base}/upload"),
                    &[(reserved.to_string(), "attacker".to_string())],
                    b"x".to_vec(),
                )
                .await
                .expect_err("a reserved header must be refused");
            assert_eq!(error.code(), "invalid_request", "for {reserved}");
        }
        assert!(
            seen.lock().unwrap().auth.is_empty(),
            "refusal must happen before anything is sent"
        );
    }

    #[tokio::test]
    async fn an_upstream_error_is_capped_and_carries_no_credential() {
        let (broker, org, connection) = active_mock_connection().await;
        // A hostile upstream echoing a huge body, including something that
        // looks like the caller's own Authorization header.
        let (base, _seen) = recording_server(|| {
            let mut body = "Bearer leaked-token-should-not-propagate ".to_string();
            body.push_str(&"A".repeat(50_000));
            (StatusCode::BAD_REQUEST, body).into_response()
        })
        .await;

        let error = broker
            .authorized_bytes(
                &org,
                &connection,
                &format!("{base}/upload"),
                &[],
                b"x".to_vec(),
            )
            .await
            .expect_err("a 400 must surface as an error");
        let text = error.to_string();
        assert!(
            text.len() < 1_000,
            "the snippet must be capped, got {} chars",
            text.len()
        );
        // The real credential never appears; only whatever the upstream chose
        // to echo, which is its own content and not ours.
        assert!(!text.contains("race-access"));
    }

    #[tokio::test]
    async fn a_connection_without_an_active_credential_cannot_upload() {
        let (_db, broker, org, integration) =
            organization_oauth_broker_with_token_url(token_server().await).await;
        let pending = broker
            .create_connection(
                &org,
                CreateConnection {
                    integration_id: Some(integration),
                    ..create("mock")
                },
            )
            .await
            .unwrap();
        let (base, seen) = recording_server(|| (StatusCode::OK, "{}").into_response()).await;

        let error = broker
            .authorized_bytes(
                &org,
                &pending.connection_id,
                &format!("{base}/upload"),
                &[],
                b"x".to_vec(),
            )
            .await
            .expect_err("a pending connection has no credential to inject");
        assert_eq!(error.code(), "needs_reauth");
        assert!(
            seen.lock().unwrap().auth.is_empty(),
            "nothing may be sent without a credential"
        );
    }

    #[tokio::test]
    async fn another_organization_cannot_use_this_connection() {
        let (broker, _org, connection) = active_mock_connection().await;
        let (base, seen) = recording_server(|| (StatusCode::OK, "{}").into_response()).await;

        let error = broker
            .authorized_bytes(
                &OrganizationId::new(),
                &connection,
                &format!("{base}/upload"),
                &[],
                b"x".to_vec(),
            )
            .await
            .expect_err("a connection in another org must not be reachable");
        assert_eq!(error.code(), "connection_not_found");
        assert!(seen.lock().unwrap().auth.is_empty());
    }
}

// ---- delegation (ADR 0044) --------------------------------------------------

mod delegation_tests {
    use super::*;
    use crate::delegation::{
        ClaimOfferRequest, MintOfferRequest, OfferItemSpec, BUDGET_INVOCATIONS,
    };
    use opensesame_domain::Shareability;
    use std::collections::BTreeMap;

    const PEPPER: &str = "test-pepper";
    const OWNER: &str = "user:owner";
    const GUEST: &str = "user:guest";

    fn delegable_config() -> BrokerConfig {
        key_config().with_detected_connection(
            "workos",
            BTreeMap::from([(
                "api_key".into(),
                "PLANTED-WORKOS-VALUE-MUST-NOT-ESCAPE".into(),
            )]),
        )
    }

    async fn active_delegable_connection(
        broker: &ConnectionBroker,
        organization: &OrganizationId,
        owner: &str,
    ) -> String {
        let view = broker
            .create_connection(
                organization,
                CreateConnection {
                    owner_subject: Some(owner.into()),
                    shareability: Some(Shareability::Delegable),
                    display_name: Some("WorkOS".into()),
                    ..create("workos")
                },
            )
            .await
            .expect("active connection");
        assert_eq!(view.status, ConnectionStatus::Active);
        view.connection_id
    }

    fn one_item(connection_id: &str) -> MintOfferRequest {
        MintOfferRequest {
            items: vec![OfferItemSpec {
                connection_id: connection_id.into(),
                actions: None,
                resources: None,
                expires_in_seconds: None,
                budgets: None,
                execution_mode: opensesame_relay::ExecutionMode::Broker,
                required: true,
                dependencies: vec![],
            }],
            ttl_seconds: None,
        }
    }

    #[tokio::test]
    async fn contract_mint_present_claim_delegates_a_connection() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;

        let minted = broker
            .mint_delegation_offer(&organization, OWNER, one_item(&connection), PEPPER)
            .await
            .expect("mint");
        assert!(minted.claim_token.starts_with("osc_dlg_"));
        assert_eq!(minted.offer.state, "pending");
        assert_eq!(minted.offer.items.len(), 1);
        // The default delegate set is the provider vocabulary minus mutating
        // operations; workos has none to remove.
        assert_eq!(
            minted.offer.items[0].actions,
            vec!["user.read", "organization.read", "directory.read"]
        );

        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        assert_eq!(manifest.state, "presented");

        let delegations = broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .expect("claim");
        assert_eq!(delegations.len(), 1);
        assert_eq!(delegations[0].claimant_subject, GUEST);

        let resolved = broker
            .find_live_delegation(GUEST, &connection)
            .await
            .expect("lookup")
            .expect("live delegation");
        assert_eq!(resolved.grant.actions, manifest.items[0].actions);
        assert!(resolved.grant.parent_grant_id.is_some());
        assert_eq!(resolved.grant.delegation_depth, 1);
        // Nobody else resolves it.
        assert!(broker
            .find_live_delegation("user:stranger", &connection)
            .await
            .expect("lookup")
            .is_none());
    }

    #[tokio::test]
    async fn adversarial_a_second_present_burns_the_offer_and_its_delegations() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let minted = broker
            .mint_delegation_offer(&organization, OWNER, one_item(&connection), PEPPER)
            .await
            .expect("mint");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .expect("claim");

        // The token surfaces again: whoever holds it now, the link leaked.
        assert!(broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .is_err());
        // The delegation minted from the offer died with it.
        assert!(broker
            .find_live_delegation(GUEST, &connection)
            .await
            .expect("lookup")
            .is_none());
    }

    #[tokio::test]
    async fn adversarial_private_connections_refuse_offers() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let view = broker
            .create_connection(
                &organization,
                CreateConnection {
                    owner_subject: Some(OWNER.into()),
                    display_name: Some("WorkOS".into()),
                    ..create("workos")
                },
            )
            .await
            .expect("active connection");
        assert!(broker
            .mint_delegation_offer(&organization, OWNER, one_item(&view.connection_id), PEPPER)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn adversarial_minting_someone_elses_connection_is_not_found() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        assert!(matches!(
            broker
                .mint_delegation_offer(&organization, "user:thief", one_item(&connection), PEPPER)
                .await,
            Err(BrokerError::ConnectionNotFound)
        ));
    }

    #[tokio::test]
    async fn adversarial_wrong_user_codes_burn_the_offer_at_the_cap() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let minted = broker
            .mint_delegation_offer(&organization, OWNER, one_item(&connection), PEPPER)
            .await
            .expect("mint");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        for _ in 0..5 {
            assert!(broker
                .claim_delegation_offer(
                    ClaimOfferRequest {
                        claim_token: minted.claim_token.clone(),
                        user_code: "WRNG-CODE".into(),
                        accepted_item_ids: vec![manifest.items[0].id.clone()],
                    },
                    GUEST,
                    PEPPER,
                )
                .await
                .is_err());
        }
        // The real code no longer helps: the offer burned, not lapsed.
        assert!(broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn adversarial_the_owner_cannot_claim_their_own_offer() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let minted = broker
            .mint_delegation_offer(&organization, OWNER, one_item(&connection), PEPPER)
            .await
            .expect("mint");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        assert!(broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                OWNER,
                PEPPER,
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn contract_bundles_are_dependency_closed_and_all_or_nothing() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let first = active_delegable_connection(&broker, &organization, OWNER).await;
        let second = broker
            .create_connection(
                &organization,
                CreateConnection {
                    owner_subject: Some(OWNER.into()),
                    shareability: Some(Shareability::Delegable),
                    display_name: Some("WorkOS second".into()),
                    logical_name: Some("workos-second".into()),
                    ..create("workos")
                },
            )
            .await
            .expect("second connection")
            .connection_id;

        // Item 1 is optional but depends on item 0.
        let minted = broker
            .mint_delegation_offer(
                &organization,
                OWNER,
                MintOfferRequest {
                    items: vec![
                        OfferItemSpec {
                            connection_id: first.clone(),
                            actions: None,
                            resources: None,
                            expires_in_seconds: None,
                            budgets: None,
                            execution_mode: opensesame_relay::ExecutionMode::Broker,
                            required: false,
                            dependencies: vec![],
                        },
                        OfferItemSpec {
                            connection_id: second.clone(),
                            actions: None,
                            resources: None,
                            expires_in_seconds: None,
                            budgets: None,
                            execution_mode: opensesame_relay::ExecutionMode::Broker,
                            required: false,
                            dependencies: vec![0],
                        },
                    ],
                    ttl_seconds: None,
                },
                PEPPER,
            )
            .await
            .expect("mint bundle");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        let dependent = manifest
            .items
            .iter()
            .find(|item| !item.dependencies.is_empty())
            .expect("dependent item");

        // Accepting the dependent item without its dependency is refused —
        // and the refusal must not spend the offer.
        assert!(broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![dependent.id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .is_err());

        let all_ids: Vec<String> = manifest.items.iter().map(|item| item.id.clone()).collect();
        let delegations = broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: all_ids,
                },
                GUEST,
                PEPPER,
            )
            .await
            .expect("claim whole bundle");
        assert_eq!(delegations.len(), 2);
        // One set id groups them; each member resolves independently.
        assert_eq!(delegations[0].offer_id, delegations[1].offer_id);
        assert!(broker
            .find_live_delegation(GUEST, &first)
            .await
            .expect("lookup")
            .is_some());
        assert!(broker
            .find_live_delegation(GUEST, &second)
            .await
            .expect("lookup")
            .is_some());
    }

    #[tokio::test]
    async fn adversarial_mint_refuses_what_the_owner_grant_cannot_honor() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let mut request = one_item(&connection);
        request.items[0].actions = Some(vec!["admin.impersonate".into()]);
        assert!(broker
            .mint_delegation_offer(&organization, OWNER, request, PEPPER)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn contract_revoking_the_offer_kills_every_member() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let minted = broker
            .mint_delegation_offer(&organization, OWNER, one_item(&connection), PEPPER)
            .await
            .expect("mint");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .expect("claim");
        broker
            .revoke_delegation_offer(&organization, OWNER, &minted.offer.id)
            .await
            .expect("revoke set");
        assert!(broker
            .find_live_delegation(GUEST, &connection)
            .await
            .expect("lookup")
            .is_none());
    }

    #[tokio::test]
    async fn contract_a_claimant_may_drop_their_own_but_not_someone_elses() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let minted = broker
            .mint_delegation_offer(&organization, OWNER, one_item(&connection), PEPPER)
            .await
            .expect("mint");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        let delegations = broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .expect("claim");
        let delegation_id = &delegations[0].id;
        assert!(matches!(
            broker
                .revoke_delegation(&organization, "user:stranger", delegation_id)
                .await,
            Err(BrokerError::ConnectionNotFound)
        ));
        broker
            .revoke_delegation(&organization, GUEST, delegation_id)
            .await
            .expect("claimant drops their own");
        assert!(broker
            .find_live_delegation(GUEST, &connection)
            .await
            .expect("lookup")
            .is_none());
    }

    #[tokio::test]
    async fn contract_narrowing_replaces_the_grant_and_widening_is_refused() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let minted = broker
            .mint_delegation_offer(&organization, OWNER, one_item(&connection), PEPPER)
            .await
            .expect("mint");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        let delegations = broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .expect("claim");
        let delegation_id = delegations[0].id.clone();
        let old_grant_id = delegations[0].grant_id.clone();

        let narrowed = broker
            .narrow_delegation(
                &organization,
                OWNER,
                &delegation_id,
                Some(vec!["user.read".into()]),
                None,
                None,
            )
            .await
            .expect("narrow");
        assert_ne!(narrowed.grant_id, old_grant_id);
        assert_eq!(narrowed.actions, vec!["user.read"]);

        let resolved = broker
            .find_live_delegation(GUEST, &connection)
            .await
            .expect("lookup")
            .expect("still live");
        assert_eq!(resolved.grant.actions, vec!["user.read"]);

        // Growing back what was narrowed away is not an edit.
        assert!(broker
            .narrow_delegation(
                &organization,
                OWNER,
                &delegation_id,
                Some(vec!["user.read".into(), "organization.read".into()]),
                None,
                None,
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn property_budget_spend_denies_at_zero() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let mut request = one_item(&connection);
        request.items[0].budgets = Some(BTreeMap::from([(BUDGET_INVOCATIONS.into(), 2)]));
        let minted = broker
            .mint_delegation_offer(&organization, OWNER, request, PEPPER)
            .await
            .expect("mint");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        let delegations = broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .expect("claim");
        let id = &delegations[0].id;
        broker
            .spend_delegation_budget(id, BUDGET_INVOCATIONS)
            .await
            .expect("first spend");
        broker
            .spend_delegation_budget(id, BUDGET_INVOCATIONS)
            .await
            .expect("second spend");
        assert!(broker
            .spend_delegation_budget(id, BUDGET_INVOCATIONS)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn adversarial_no_response_carries_a_planted_credential() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let minted = broker
            .mint_delegation_offer(&organization, OWNER, one_item(&connection), PEPPER)
            .await
            .expect("mint");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        let delegations = broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .expect("claim");
        for rendered in [
            serde_json::to_string(&minted.offer).expect("offer"),
            serde_json::to_string(&manifest).expect("manifest"),
            serde_json::to_string(&delegations).expect("delegations"),
        ] {
            assert!(!rendered.contains("PLANTED-WORKOS-VALUE-MUST-NOT-ESCAPE"));
        }
    }
}

mod custom_providers {
    use super::*;

    fn oauth_def(id: &str) -> CreateCustomProvider {
        CreateCustomProvider {
            id: id.into(),
            display_name: "Acme MCP".into(),
            base_url: "https://mcp.acme.dev".into(),
            docs_url: None,
            auth: CustomAuthSpec::Oauth2AuthorizationCode {
                authorize_url: "https://mcp.acme.dev/oauth/authorize".into(),
                token_url: "https://mcp.acme.dev/oauth/token".into(),
                supports_refresh: true,
                scopes: vec!["tools:read".into()],
            },
        }
    }

    fn api_key_def(id: &str) -> CreateCustomProvider {
        CreateCustomProvider {
            id: id.into(),
            display_name: "Internal API".into(),
            base_url: "https://api.internal.dev/v1".into(),
            docs_url: None,
            auth: CustomAuthSpec::ApiKey {
                header: "Authorization".into(),
                value_prefix: "Bearer ".into(),
            },
        }
    }

    #[tokio::test]
    async fn definitions_are_org_scoped_and_merge_into_the_catalog() {
        let (_db, broker) = broker().await;
        let org_a = OrganizationId::new();
        let org_b = OrganizationId::new();
        broker
            .create_custom_provider(&org_a, oauth_def("custom-acme-mcp"), "principal:admin")
            .await
            .unwrap();

        let for_a = broker.list_providers_for(&org_a).await.unwrap();
        let custom = for_a
            .iter()
            .find(|p| p.id == "custom-acme-mcp")
            .expect("custom provider listed for its org");
        assert_eq!(custom.category.as_str(), "custom");
        assert_eq!(custom.auth_kind, "oauth2_authorization_code");
        // No deployment env client exists, so the UI must offer client setup.
        assert!(!custom.configured);
        assert!(custom
            .callback_url
            .as_deref()
            .unwrap_or_default()
            .ends_with("/api/v1/oauth/callback/custom-acme-mcp"));

        let for_b = broker.list_providers_for(&org_b).await.unwrap();
        assert!(for_b.iter().all(|p| p.id != "custom-acme-mcp"));
        assert!(broker
            .list_providers()
            .unwrap()
            .iter()
            .all(|p| p.id != "custom-acme-mcp"));

        // Duplicate ids are refused.
        assert!(matches!(
            broker
                .create_custom_provider(&org_a, oauth_def("custom-acme-mcp"), "principal:admin")
                .await,
            Err(BrokerError::Invalid(_))
        ));
    }

    #[tokio::test]
    async fn api_key_custom_connector_seals_a_key_inside_derived_egress() {
        let (db, broker) = broker().await;
        let org = OrganizationId::new();
        broker
            .create_custom_provider(&org, api_key_def("custom-internal"), "principal:admin")
            .await
            .unwrap();

        let connection = broker
            .create_connection(
                &org,
                CreateConnection {
                    owner_subject: Some("principal:admin".into()),
                    ..create("custom-internal")
                },
            )
            .await
            .unwrap();
        // The credential can only ever be attached inside the base origin.
        assert_eq!(connection.egress.scheme, "https");
        assert_eq!(connection.egress.authorities, vec!["api.internal.dev"]);
        assert_eq!(connection.egress.path_prefixes, vec!["/v1"]);

        let sealed = broker
            .set_api_key(&org, &connection.connection_id, "shhh-key")
            .await
            .unwrap();
        assert_eq!(sealed.status, ConnectionStatus::Active);
        assert!(store::get_credential(db.pool(), &connection.connection_id)
            .await
            .unwrap()
            .is_some());

        // In use: the definition cannot be deleted out from under it.
        assert!(matches!(
            broker.delete_custom_provider(&org, "custom-internal").await,
            Err(BrokerError::Invalid(_))
        ));
        broker
            .revoke(&org, &connection.connection_id)
            .await
            .unwrap();
        broker
            .delete_custom_provider(&org, "custom-internal")
            .await
            .unwrap();
        assert!(matches!(
            broker.delete_custom_provider(&org, "custom-internal").await,
            Err(BrokerError::ProviderUnknown(_))
        ));
    }

    #[tokio::test]
    async fn oauth_custom_connector_authorizes_through_a_sealed_org_client() {
        let (_db, broker) = broker().await;
        let org = OrganizationId::new();
        broker
            .create_custom_provider(&org, oauth_def("custom-acme-mcp"), "principal:admin")
            .await
            .unwrap();
        broker
            .create_integration(
                &org,
                CreateIntegration {
                    key: "custom-acme-mcp-oauth".into(),
                    provider_id: "custom-acme-mcp".into(),
                    display_name: "Acme MCP OAuth client".into(),
                    scopes: vec!["tools:read".into()],
                    client_id: Some("acme-client".into()),
                    client_secret: Some("acme-secret".into()),
                    configuration: BTreeMap::default(),
                    created_by: "principal:admin".into(),
                },
            )
            .await
            .unwrap();

        let connection = broker
            .create_connection(
                &org,
                CreateConnection {
                    owner_subject: Some("principal:admin".into()),
                    ..create("custom-acme-mcp")
                },
            )
            .await
            .unwrap();
        let start = broker
            .start_authorization(&org, &connection.connection_id, None, None)
            .await
            .unwrap();
        assert!(
            start
                .authorization_url
                .starts_with("https://mcp.acme.dev/oauth/authorize?"),
            "{}",
            start.authorization_url
        );
        assert!(start.authorization_url.contains("client_id=acme-client"));
    }
}
