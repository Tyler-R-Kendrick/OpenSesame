//! Connection lifecycle: create, name, scope, read and isolate.

use super::*;

#[tokio::test]
async fn provider_error_consumes_state_once() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                integration_id: Some("deployment:mock".into()),
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
        .reject_authorization("mock", &start.state, "access denied")
        .await
        .unwrap();
    assert_eq!(
        broker
            .reject_authorization("mock", &start.state, "again")
            .await
            .unwrap_err()
            .code(),
        "invalid_state"
    );
}

/// sqlx gives each in-memory pool its own database; the tests below rely on it.
#[tokio::test]
async fn separate_in_memory_databases_do_not_share_state() {
    let (_a_db, a) = broker().await;
    let (_b_db, b) = broker().await;
    let org = OrganizationId::new();
    a.create_connection(&org, create("mock")).await.unwrap();
    assert_eq!(a.list_connections(&org).await.unwrap().len(), 1);
    assert!(b.list_connections(&org).await.unwrap().is_empty());
}

#[tokio::test]
async fn without_a_key_no_provider_is_configured() {
    let (_db, broker) = broker_with(BrokerConfig::in_memory(None, "http://127.0.0.1:8787")).await;
    let providers = broker.list_providers().unwrap();
    assert_eq!(providers.len(), catalog::all().unwrap().len());
    for p in &providers {
        assert!(!p.configured, "{} claimed configured", p.id);
        assert!(p
            .missing_config
            .contains(&config::ENV_CONNECTION_KEY.to_string()));
    }
}

#[tokio::test]
async fn a_created_connection_is_pending_and_named() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("github"))
        .await
        .unwrap();

    assert_eq!(view.status, ConnectionStatus::Pending);
    assert_eq!(view.provider_id, "github");
    assert_eq!(view.logical_name, "github/main");
    assert!(view.connection_ref.starts_with("conn://"));
    assert!(view.connection_ref.ends_with("github/main"));
    assert_eq!(view.requested_scopes, vec!["read:user".to_string()]);
    assert_eq!(view.egress.authorities, vec!["api.github.com".to_string()]);
    assert_eq!(view.max_invoke_level, 2);
    assert!(!view.refreshable);
    assert!(view.bindings.is_empty());
}

#[tokio::test]
async fn a_project_scoped_connection_keeps_the_project_in_its_ref() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let project = ProjectId::new();
    let view = broker
        .create_connection(
            &org,
            CreateConnection {
                project_id: Some(project.to_string()),
                ..create("github")
            },
        )
        .await
        .unwrap();
    assert!(view.connection_ref.contains(&project.to_string()));
    assert_eq!(
        view.project_id.as_deref(),
        Some(project.to_string().as_str())
    );
}

#[tokio::test]
async fn a_second_connection_to_the_same_provider_gets_its_own_name() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let first = broker
        .create_connection(&org, create("github"))
        .await
        .unwrap();
    let second = broker
        .create_connection(&org, create("github"))
        .await
        .unwrap();
    assert_eq!(first.logical_name, "github/main");
    assert_eq!(second.logical_name, "github/main-2");

    let taken = broker
        .create_connection(
            &org,
            CreateConnection {
                logical_name: Some("github/main".into()),
                ..create("github")
            },
        )
        .await
        .unwrap_err();
    assert_eq!(taken.code(), "invalid_request");
}

#[tokio::test]
async fn an_unknown_provider_is_refused() {
    let (_db, broker) = broker().await;
    let err = broker
        .create_connection(&OrganizationId::new(), create("myspace"))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "provider_unknown");
}

#[tokio::test]
async fn another_organizations_connection_reads_as_absent() {
    let (_db, broker) = broker().await;
    let mine = OrganizationId::new();
    let theirs = OrganizationId::new();
    let view = broker
        .create_connection(&mine, create("mock"))
        .await
        .unwrap();

    let err = broker
        .get_connection(&theirs, &view.connection_id)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "connection_not_found");
    assert!(broker.list_connections(&theirs).await.unwrap().is_empty());
}

#[tokio::test]
async fn authorize_refuses_a_provider_the_deployment_cannot_use() {
    let (_db, broker) =
        broker_with(BrokerConfig::in_memory(Some(KEY), "http://127.0.0.1:8787")).await;
    let org = OrganizationId::new();
    // PAT providers may create a pending connection without an OAuth App.
    let view = broker
        .create_connection(&org, create("github"))
        .await
        .expect("github pending connection without OAuth App");
    let err = broker
        .start_authorization(&org, &view.connection_id, None, None)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "provider_unconfigured");
}

#[tokio::test]
async fn authorize_refuses_before_a_consent_it_could_not_store() {
    let config = BrokerConfig::in_memory(None, "http://127.0.0.1:8787").with_provider(
        "mock",
        ProviderConfig {
            client_id: Some("mock-client".into()),
            client_secret: Some("mock-secret".into()),
            ..Default::default()
        },
    );
    let (_db, broker) = broker_with(config).await;
    let org = OrganizationId::new();
    let err = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "integration_not_found");
}

#[tokio::test]
async fn authorize_returns_a_pkce_bound_url() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap();
    let start = broker
        .start_authorization(&org, &view.connection_id, None, Some(vec!["read".into()]))
        .await
        .unwrap();

    let url = url::Url::parse(&start.authorization_url).unwrap();
    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["state"], start.state);
    assert_eq!(q["scope"], "read");
    assert_eq!(
        q["redirect_uri"],
        "http://127.0.0.1:8787/api/v1/oauth/callback/mock"
    );
    assert!(!q["code_challenge"].is_empty());
    // The verifier itself must never appear in what the browser is handed.
    assert!(!start.authorization_url.contains("code_verifier"));
    let stored = sqlx::query(
        "SELECT state, code_verifier, verifier_nonce FROM connection_authorizations WHERE connection_id = ?",
    )
    .bind(&view.connection_id)
    .fetch_one(db.pool())
    .await
    .unwrap();
    let stored_state: String = stored.get("state");
    assert_ne!(stored_state, start.state);
    assert_eq!(stored_state.len(), 64);
    assert_eq!(stored.get::<Vec<u8>, _>("verifier_nonce").len(), 24);
    assert!(!stored.get::<Vec<u8>, _>("code_verifier").is_empty());

    let events = broker.events(&org, &view.connection_id).await.unwrap();
    assert_eq!(
        events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(),
        vec!["created", "authorize_started"]
    );
}

#[tokio::test]
async fn a_replayed_state_is_rejected() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap();
    let start = broker
        .start_authorization(&org, &view.connection_id, None, None)
        .await
        .unwrap();

    // The exchange cannot reach the (deliberately dead) token endpoint, but the
    // state is consumed regardless: a code arriving twice must not be tried twice.
    let first = broker
        .complete_authorization("mock", "code-1", &start.state)
        .await
        .unwrap_err();
    assert_eq!(first.code(), "exchange_failed");

    let replay = broker
        .complete_authorization("mock", "code-1", &start.state)
        .await
        .unwrap_err();
    assert_eq!(replay.code(), "invalid_state");

    let unknown = broker
        .complete_authorization("mock", "code-1", "never-issued")
        .await
        .unwrap_err();
    assert_eq!(unknown.code(), "invalid_state");
}

#[tokio::test]
async fn an_expired_state_is_rejected() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap();

    store::insert_authorization(
        db.pool(),
        &store::AuthorizationRow {
            state: "stale-state".into(),
            connection_id: view.connection_id.clone(),
            code_verifier: crypto::seal(&KEY, &view.connection_id, &org.to_string(), b"verifier")
                .unwrap(),
            redirect_uri: "http://127.0.0.1:8787/api/v1/oauth/callback/mock".into(),
            scopes: vec!["read".into()],
            expires_at: Utc::now() - Duration::seconds(1),
            credential_version: None,
        },
    )
    .await
    .unwrap();

    let err = broker
        .complete_authorization("mock", "code-1", "stale-state")
        .await
        .unwrap_err();
    assert_eq!(err.code(), "state_expired");

    // Expiry is terminal, and it takes the verifier with it.
    let again = broker
        .complete_authorization("mock", "code-1", "stale-state")
        .await
        .unwrap_err();
    assert_eq!(again.code(), "invalid_state");
}

#[tokio::test]
async fn a_state_belongs_to_the_provider_that_issued_it() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap();
    let start = broker
        .start_authorization(&org, &view.connection_id, None, None)
        .await
        .unwrap();
    let err = broker
        .complete_authorization("github", "code-1", &start.state)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "invalid_state");
}

#[tokio::test]
async fn a_redirect_off_the_allowlist_is_refused() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap();
    let err = broker
        .start_authorization(
            &org,
            &view.connection_id,
            Some("https://evil.example/steal".into()),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "redirect_not_allowed");
}

#[tokio::test]
async fn an_api_key_connection_activates_without_a_consent_screen() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("stripe"))
        .await
        .unwrap();
    let err = broker
        .start_authorization(&org, &view.connection_id, None, None)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "unsupported_credential");

    let active = broker
        .set_api_key(&org, &view.connection_id, "sk_test_do_not_leak")
        .await
        .unwrap();
    assert_eq!(active.status, ConnectionStatus::Active);
    assert_eq!(
        active.configured_fields,
        vec![ConfiguredFieldView {
            name: "api_key".into(),
            hint: Some("configured".into()),
        }]
    );
    assert!(!active.refreshable);
    assert!(active.expires_at.is_none());

    let rendered = serde_json::to_string(&active).unwrap();
    assert!(!rendered.contains("sk_test_do_not_leak"));

    let refresh = broker.refresh(&org, &view.connection_id).await.unwrap_err();
    assert_eq!(refresh.code(), "not_refreshable");

    let empty = broker
        .set_api_key(&org, &view.connection_id, "   ")
        .await
        .unwrap_err();
    assert_eq!(empty.code(), "invalid_request");

    let cleared = broker
        .set_connection_configuration(
            &org,
            &view.connection_id,
            BTreeMap::default(),
            vec!["api_key".into()],
        )
        .await
        .unwrap();
    assert_eq!(cleared.status, ConnectionStatus::Pending);
    assert!(cleared.configured_fields.is_empty());
}

#[tokio::test]
async fn a_fnox_provider_seals_its_declared_configuration() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("azure-sm"))
        .await
        .unwrap();

    let active = broker
        .set_connection_configuration(
            &org,
            &view.connection_id,
            std::collections::BTreeMap::from([
                (
                    "vault_url".into(),
                    "https://example.vault.azure.net/".into(),
                ),
                ("tenant_id".into(), "tenant-1234".into()),
                ("client_id".into(), "client-1234".into()),
                ("client_secret".into(), "do-not-return".into()),
            ]),
            vec![],
        )
        .await
        .unwrap();

    assert_eq!(active.status, ConnectionStatus::Active);
    assert!(active
        .configured_fields
        .iter()
        .any(|field| field.name == "client_secret" && field.hint.as_deref() == Some("configured")));
    assert!(!serde_json::to_string(&active)
        .unwrap()
        .contains("do-not-return"));
}

#[tokio::test]
async fn certificate_actor_can_open_only_an_active_issuer_connection() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let issuer = broker
        .create_connection(&org, create("zerossl"))
        .await
        .unwrap();

    let pending = broker
        .certificate_issuer_configuration(&org, &issuer.connection_id)
        .await
        .unwrap_err();
    assert_eq!(pending.code(), "needs_reauth");

    broker
        .set_connection_configuration(
            &org,
            &issuer.connection_id,
            BTreeMap::from([
                ("eab_kid".into(), "kid-1".into()),
                ("eab_hmac_key".into(), "do-not-return".into()),
            ]),
            vec![],
        )
        .await
        .unwrap();

    let opened = broker
        .certificate_issuer_configuration(&org, &issuer.connection_id)
        .await
        .unwrap();
    assert_eq!(opened.provider_id, "zerossl");
    assert_eq!(opened.values["eab_kid"], "kid-1");
    assert_eq!(opened.values["eab_hmac_key"], "do-not-return");
    assert!(!format!("{opened:?}").contains("do-not-return"));

    let ordinary = broker
        .create_connection(&org, create("azure-sm"))
        .await
        .unwrap();
    let refused = broker
        .certificate_issuer_configuration(&org, &ordinary.connection_id)
        .await
        .unwrap_err();
    assert_eq!(refused.code(), "invalid_request");
}

#[tokio::test]
async fn an_oauth_provider_refuses_a_pasted_api_key() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap();
    let err = broker
        .set_api_key(&org, &view.connection_id, "whatever")
        .await
        .unwrap_err();
    assert_eq!(err.code(), "unsupported_credential");
}

#[tokio::test]
async fn revoking_keeps_the_row_and_drops_the_credential() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("stripe"))
        .await
        .unwrap();
    broker
        .set_api_key(&org, &view.connection_id, "sk_test_x")
        .await
        .unwrap();

    let outcome = broker.revoke(&org, &view.connection_id).await.unwrap();
    assert!(outcome.revoked);
    assert_eq!(outcome.provider_revocation, ProviderRevocation::Unsupported);

    let after = broker
        .get_connection(&org, &view.connection_id)
        .await
        .unwrap();
    assert_eq!(after.status, ConnectionStatus::Revoked);
    assert!(store::get_credential(db.pool(), &view.connection_id)
        .await
        .unwrap()
        .is_none());

    let err = broker
        .start_authorization(&org, &view.connection_id, None, None)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "invalid_request");
}

#[tokio::test]
async fn bindings_are_unique_per_target_and_removable() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap();

    let bound = broker
        .bind(
            &org,
            &view.connection_id,
            BindRequest {
                target_kind: BindingTargetKind::Agent,
                target_id: "agent:1".into(),
                target_label: Some("release bot".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(bound.bindings.len(), 1);
    assert_eq!(bound.bindings[0].target_kind, BindingTargetKind::Agent);

    let duplicate = broker
        .bind(
            &org,
            &view.connection_id,
            BindRequest {
                target_kind: BindingTargetKind::Agent,
                target_id: "agent:1".into(),
                target_label: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(duplicate.code(), "binding_exists");

    let unbound = broker
        .unbind(&org, &view.connection_id, &bound.bindings[0].id)
        .await
        .unwrap();
    assert!(unbound.bindings.is_empty());

    let missing = broker
        .unbind(&org, &view.connection_id, "not-a-binding")
        .await
        .unwrap_err();
    assert_eq!(missing.code(), "binding_not_found");
}

#[tokio::test]
async fn access_targets_and_policy_changes_round_trip() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap();

    for (kind, id) in [
        (BindingTargetKind::Identity, "identity:alice"),
        (BindingTargetKind::Group, "group:security"),
        (BindingTargetKind::Device, "device:laptop"),
    ] {
        let bound = broker
            .bind(
                &org,
                &view.connection_id,
                BindRequest {
                    target_kind: kind,
                    target_id: id.into(),
                    target_label: None,
                },
            )
            .await
            .unwrap();
        assert!(bound.bindings.iter().any(|binding| binding.target_id == id));
    }

    let updated = broker
        .update_policy(
            &org,
            &view.connection_id,
            Shareability::OrganizationWide,
            1,
            None,
        )
        .await
        .unwrap();
    assert_eq!(updated.shareability, Shareability::OrganizationWide);
    assert_eq!(updated.max_invoke_level, 1);
    assert_eq!(
        broker
            .events(&org, &view.connection_id)
            .await
            .unwrap()
            .last()
            .unwrap()
            .kind,
        "policy_updated"
    );

    let invalid = broker
        .update_policy(&org, &view.connection_id, Shareability::Private, 3, None)
        .await
        .unwrap_err();
    assert_eq!(invalid.code(), "invalid_request");
}

#[tokio::test]
async fn every_mutation_leaves_an_event() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("stripe"))
        .await
        .unwrap();
    broker
        .set_api_key(&org, &view.connection_id, "sk_test_x")
        .await
        .unwrap();
    let bound = broker
        .bind(
            &org,
            &view.connection_id,
            BindRequest {
                target_kind: BindingTargetKind::Project,
                target_id: "project:1".into(),
                target_label: None,
            },
        )
        .await
        .unwrap();
    broker
        .unbind(&org, &view.connection_id, &bound.bindings[0].id)
        .await
        .unwrap();
    broker.revoke(&org, &view.connection_id).await.unwrap();

    let kinds: Vec<_> = broker
        .events(&org, &view.connection_id)
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.kind)
        .collect();
    assert_eq!(
        kinds,
        vec!["created", "authorized", "bound", "unbound", "revoked"]
    );
}

/// The stored credential is sealed, so the row is useless without the key — and
/// useless with the key under another tenant's ids.
#[tokio::test]
async fn a_stored_credential_is_unreadable_in_the_database() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("stripe"))
        .await
        .unwrap();
    broker
        .set_api_key(&org, &view.connection_id, "sk_test_do_not_leak")
        .await
        .unwrap();

    let credential = store::get_credential(db.pool(), &view.connection_id)
        .await
        .unwrap()
        .expect("credential");
    let raw = String::from_utf8_lossy(&credential.sealed.ciphertext).to_string();
    assert!(!raw.contains("sk_test_do_not_leak"));
    assert!(crypto::open(
        &KEY,
        &view.connection_id,
        &OrganizationId::new().to_string(),
        &credential.sealed
    )
    .is_err());
    let opened = crypto::open(
        &KEY,
        &view.connection_id,
        &org.to_string(),
        &credential.sealed,
    )
    .unwrap();
    let tokens: token::TokenSet = serde_json::from_slice(&opened).unwrap();
    assert_eq!(tokens.access_token, "sk_test_do_not_leak");
}

/// One gateway serves many callers out of a single organization, so listing has
/// to be able to answer for one of them: an owner sees its own connection and
/// nobody else's, and an unowned row belongs to no session at all.
#[tokio::test]
async fn listing_can_be_narrowed_to_one_owner() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let mut mine = create("stripe");
    mine.owner_subject = Some("user:alice".into());
    let mine = broker.create_connection(&org, mine).await.unwrap();
    let mut theirs = create("stripe");
    theirs.owner_subject = Some("user:bob".into());
    let theirs = broker.create_connection(&org, theirs).await.unwrap();
    let unowned = broker
        .create_connection(&org, create("stripe"))
        .await
        .unwrap();

    let alice = broker
        .list_connections_for(&org, Some("user:alice"))
        .await
        .unwrap();
    assert_eq!(
        alice
            .iter()
            .map(|c| c.connection_id.clone())
            .collect::<Vec<_>>(),
        vec![mine.connection_id.clone()]
    );
    assert_eq!(
        broker
            .owner_subject(&org, &theirs.connection_id)
            .await
            .unwrap(),
        Some("user:bob".to_string())
    );
    assert_eq!(
        broker
            .owner_subject(&org, &unowned.connection_id)
            .await
            .unwrap(),
        None
    );
    // Unnarrowed still means the whole organization.
    assert_eq!(broker.list_connections(&org).await.unwrap().len(), 3);
}

#[tokio::test]
async fn materialization_defaults_to_deny_and_fails_closed() {
    let (_db, broker) = broker().await;
    let organization = OrganizationId::new();
    let connection = broker
        .create_connection(&organization, create("stripe"))
        .await
        .unwrap();
    assert_eq!(connection.materialization, MaterializationPolicy::Deny);

    let denied = broker
        .mint_derived_token(&organization, &connection.connection_id, "user:alice", None)
        .await
        .unwrap_err();
    assert_eq!(denied.code(), "materialization_denied");
    assert_eq!(denied.http_status(), 403);

    // A stored value nobody recognizes is a deny, never a permit.
    assert_eq!(
        parse_materialization("garbage"),
        MaterializationPolicy::Deny
    );
    assert_eq!(
        parse_materialization("derived_short_lived"),
        MaterializationPolicy::DerivedShortLived
    );
}

#[tokio::test]
async fn providers_without_a_mint_path_fail_closed() {
    let (_db, broker) = broker().await;
    let organization = OrganizationId::new();
    for provider_id in ["stripe", "aws", "aws-kms", "aws-ps", "aws-bedrock"] {
        let connection = broker
            .create_connection(&organization, create(provider_id))
            .await
            .unwrap();
        let opted_in = broker
            .update_policy(
                &organization,
                &connection.connection_id,
                Shareability::Private,
                2,
                Some(MaterializationPolicy::DerivedShortLived),
            )
            .await
            .unwrap();
        assert_eq!(
            opted_in.materialization,
            MaterializationPolicy::DerivedShortLived
        );
        let error = broker
            .mint_derived_token(&organization, &connection.connection_id, "user:alice", None)
            .await
            .unwrap_err();
        assert_eq!(error.code(), "unmintable", "{provider_id}");
        assert_eq!(error.http_status(), 422, "{provider_id}");
    }
}

#[tokio::test]
async fn a_web_login_policy_round_trips_and_parks_without_a_runner() {
    let fixture = rotation_fixture().await;
    let bus = opensesame_task_bus::InMemoryTaskBus::default();
    let target = RotationTarget::WebLogin {
        origin: "https://example.com".into(),
    };
    assert_eq!(target.kind(), "web_login");
    assert_eq!(
        RotationTarget::from_parts("web_login", "https://example.com"),
        Some(target.clone())
    );

    // The widened target_kind CHECK admits the row, so a policy for a consumer
    // web login is schedulable rather than rejected at the storage layer.
    let job = request_rotation(
        &fixture.broker,
        &bus,
        target,
        None,
        &fixture.organization.to_string(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(job.state, "scheduled");

    // With no sandbox runner configured, ADR 0076 T5 applies: park loudly, and
    // never report a password change that did not happen.
    let parked = execute_rotation(&fixture.broker, &bus, &fixture.organization, &job.id)
        .await
        .unwrap();
    assert_eq!(parked.state, "reconciliation_required", "{parked:?}");
    assert!(parked
        .detail
        .as_deref()
        .unwrap_or_default()
        .contains("sandbox runner"));
}
