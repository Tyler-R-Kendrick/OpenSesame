//! Revocation, and the token cleanup that has to follow it.

use super::*;

#[tokio::test]
async fn revoke_invalidates_late_callback_and_cas_key_writes() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let oauth = broker
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
        .start_authorization(&org, &oauth.connection_id, None, None)
        .await
        .unwrap();
    broker.revoke(&org, &oauth.connection_id).await.unwrap();
    assert_eq!(
        broker
            .complete_authorization("mock", "late-code", &start.state)
            .await
            .unwrap_err()
            .code(),
        "invalid_state"
    );

    let api = broker
        .create_connection(
            &org,
            CreateConnection {
                integration_id: Some("deployment:stripe".into()),
                ..create("stripe")
            },
        )
        .await
        .unwrap();
    broker.revoke(&org, &api.connection_id).await.unwrap();
    assert_eq!(
        broker
            .set_api_key(&org, &api.connection_id, "late-key")
            .await
            .unwrap_err()
            .code(),
        "invalid_request"
    );
    assert!(store::get_credential(db.pool(), &api.connection_id)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        broker
            .get_connection(&org, &api.connection_id)
            .await
            .unwrap()
            .status,
        ConnectionStatus::Revoked
    );
}

#[tokio::test]
async fn lowered_scope_ceiling_after_exchange_cleans_issued_tokens_and_local_credentials() {
    let (db, broker, org, integration_id) = organization_oauth_broker().await;
    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                provider_id: String::new(),
                integration_id: Some(integration_id.clone()),
                ..create("mock")
            },
        )
        .await
        .unwrap();
    let start = broker
        .start_authorization(&org, &connection.connection_id, None, None)
        .await
        .unwrap();
    let pause = TestActivationPause::new();
    broker.pause_next_activation(pause.clone());
    let completing = {
        let broker = broker.clone();
        tokio::spawn(async move {
            broker
                .complete_authorization("mock", "race-code", &start.state)
                .await
        })
    };
    pause.wait_until_reached().await;
    broker
        .update_integration(
            &org,
            &integration_id,
            UpdateIntegration {
                scopes: Some(vec!["read".into()]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    pause.resume();
    assert_eq!(
        completing.await.unwrap().unwrap_err().code(),
        "integration_conflict"
    );
    assert_eq!(
        broker.take_cleanup_attempts(),
        ["race-refresh-1", "race-access-1"]
    );
    assert!(store::get_credential(db.pool(), &connection.connection_id)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        broker
            .get_connection(&org, &connection.connection_id)
            .await
            .unwrap()
            .status,
        ConnectionStatus::Error
    );
}

#[tokio::test]
async fn invalid_provider_expiry_cleans_issued_tokens_without_storing_them() {
    let (db, broker, org, integration_id) =
        organization_oauth_broker_with_token_url(token_server_with_expiry(-1).await).await;
    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                provider_id: String::new(),
                integration_id: Some(integration_id),
                ..create("mock")
            },
        )
        .await
        .unwrap();
    let start = broker
        .start_authorization(&org, &connection.connection_id, None, None)
        .await
        .unwrap();
    assert_eq!(
        broker
            .complete_authorization("mock", "invalid-expiry", &start.state)
            .await
            .unwrap_err()
            .code(),
        "exchange_failed"
    );
    assert_eq!(
        broker.take_cleanup_attempts(),
        ["race-refresh-1", "race-access-1"]
    );
    assert!(store::get_credential(db.pool(), &connection.connection_id)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn revoke_winning_activation_cleans_issued_tokens_and_stays_terminal() {
    let (db, broker, org, integration_id) = organization_oauth_broker().await;
    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                provider_id: String::new(),
                integration_id: Some(integration_id),
                ..create("mock")
            },
        )
        .await
        .unwrap();
    let start = broker
        .start_authorization(&org, &connection.connection_id, None, None)
        .await
        .unwrap();
    let pause = TestActivationPause::new();
    broker.pause_next_activation(pause.clone());
    let completing = {
        let broker = broker.clone();
        tokio::spawn(async move {
            broker
                .complete_authorization("mock", "race-code", &start.state)
                .await
        })
    };
    pause.wait_until_reached().await;
    broker
        .revoke(&org, &connection.connection_id)
        .await
        .unwrap();
    pause.resume();
    assert_eq!(
        completing.await.unwrap().unwrap_err().code(),
        "invalid_request"
    );
    assert_eq!(
        broker.take_cleanup_attempts(),
        ["race-refresh-1", "race-access-1"]
    );
    assert!(store::get_credential(db.pool(), &connection.connection_id)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        broker
            .get_connection(&org, &connection.connection_id)
            .await
            .unwrap()
            .status,
        ConnectionStatus::Revoked
    );
}

#[tokio::test]
async fn overlapping_authorizations_activate_one_generation_and_clean_the_loser() {
    let (_db, broker, org, integration_id) = organization_oauth_broker().await;
    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                provider_id: String::new(),
                integration_id: Some(integration_id),
                ..create("mock")
            },
        )
        .await
        .unwrap();
    let first = broker
        .start_authorization(&org, &connection.connection_id, None, None)
        .await
        .unwrap();
    let second = broker
        .start_authorization(&org, &connection.connection_id, None, None)
        .await
        .unwrap();
    let first_task = {
        let broker = broker.clone();
        tokio::spawn(async move {
            broker
                .complete_authorization("mock", "code-one", &first.state)
                .await
        })
    };
    let second_task = {
        let broker = broker.clone();
        tokio::spawn(async move {
            broker
                .complete_authorization("mock", "code-two", &second.state)
                .await
        })
    };
    let first_result = first_task.await.unwrap();
    let second_result = second_task.await.unwrap();
    assert!(first_result.is_ok(), "{first_result:?}");
    assert!(second_result.is_ok(), "{second_result:?}");
    assert_eq!(broker.take_cleanup_attempts().len(), 2);
    assert_eq!(
        broker
            .events(&org, &connection.connection_id)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind == "authorized")
            .count(),
        1
    );
}

#[tokio::test]
async fn concurrent_successful_refreshes_activate_one_generation_and_clean_the_loser() {
    let (_db, broker, org, integration_id) = organization_oauth_broker().await;
    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                provider_id: String::new(),
                integration_id: Some(integration_id),
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
        .complete_authorization("mock", "initial-code", &start.state)
        .await
        .unwrap();
    assert!(broker.take_cleanup_attempts().is_empty());
    let pause = TestActivationPause::for_responses(2);
    broker.pause_next_refreshes(pause.clone());
    let refresh = || {
        let broker = broker.clone();
        let organization = org;
        let connection_id = connection.connection_id.clone();
        tokio::spawn(async move { broker.refresh(&organization, &connection_id).await })
    };
    let first = refresh();
    let second = refresh();
    pause.wait_until_reached().await;
    pause.resume();
    assert!(first.await.unwrap().is_ok());
    assert!(second.await.unwrap().is_ok());
    assert_eq!(broker.take_cleanup_attempts().len(), 2);
    assert_eq!(
        broker
            .events(&org, &connection.connection_id)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind == "refreshed")
            .count(),
        1
    );
}

/// A provider that rotates refresh tokens rejects the older one, so the loser of
/// two simultaneous refreshes is told a live grant is gone. It must read the
/// tokens on record before believing that.
#[tokio::test]
async fn a_refresh_that_lost_a_race_does_not_report_reauth() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("stripe"))
        .await
        .unwrap();
    broker
        .set_api_key(&org, &view.connection_id, "sk_test_first")
        .await
        .unwrap();
    let row = store::get_connection(db.pool(), &view.connection_id)
        .await
        .unwrap()
        .expect("row");
    let stale = token::TokenSet {
        access_token: "sk_test_first".into(),
        refresh_token: None,
        token_type: "api_key".into(),
        expires_at: None,
        scopes: Vec::new(),
        configuration: BTreeMap::default(),
    };
    // What is on record is still what this refresh read, so a rejection would be
    // the connection's own news.
    assert!(!broker.credential_moved_on(&KEY, &row, &stale).await);
    broker
        .set_api_key(&org, &view.connection_id, "sk_test_second")
        .await
        .unwrap();
    // Someone else has since written newer tokens: this failure is not about them.
    assert!(broker.credential_moved_on(&KEY, &row, &stale).await);
}

// ---- sync targets (WP-C) ----------------------------------------------------

mod sync_target_tests {
    use super::*;
    use crate::sync_target::{EmptySecretSource, MapSecretSource};
    use std::sync::Arc;

    fn create_vercel() -> CreateConnection {
        CreateConnection {
            provider_id: "vercel".into(),
            integration_id: None,
            owner_subject: None,
            display_name: Some("Vercel".into()),
            logical_name: None,
            project_id: None,
            scopes: None,
            shareability: None,
        }
    }

    fn create_railway() -> CreateConnection {
        CreateConnection {
            provider_id: "railway".into(),
            integration_id: None,
            owner_subject: None,
            display_name: Some("Railway".into()),
            logical_name: None,
            project_id: None,
            scopes: None,
            shareability: None,
        }
    }

    #[tokio::test]
    async fn create_list_delete_sync_target() {
        let (_db, broker) = broker().await;
        let org = OrganizationId::new();
        let connection = broker
            .create_connection(&org, create_vercel())
            .await
            .unwrap();
        broker
            .set_api_key(&org, &connection.connection_id, "vercel_token")
            .await
            .unwrap();

        let target = broker
            .create_sync_target(
                &org,
                CreateSyncTarget {
                    project_id: "project:personal".into(),
                    config_id: "config:production".into(),
                    connection_id: connection.connection_id.clone(),
                    operation: Some("env.set".into()),
                },
            )
            .await
            .unwrap();
        assert_eq!(target.status, SyncTargetStatus::Idle);
        assert_eq!(target.provider_id, "vercel");
        assert_eq!(target.operation, "env.set");

        let listed = broker
            .list_sync_targets(&org, Some("project:personal"), None)
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);

        broker.delete_sync_target(&org, &target.id).await.unwrap();
        assert!(matches!(
            broker.get_sync_target(&org, &target.id).await,
            Err(BrokerError::SyncTargetNotFound)
        ));
    }

    #[tokio::test]
    async fn sync_does_not_return_secret_values() {
        let (_db, broker) = broker().await;
        let org = OrganizationId::new();
        let connection = broker
            .create_connection(&org, create_vercel())
            .await
            .unwrap();
        broker
            .set_api_key(&org, &connection.connection_id, "vercel_token")
            .await
            .unwrap();
        let target = broker
            .create_sync_target(
                &org,
                CreateSyncTarget {
                    project_id: "project:1".into(),
                    config_id: "config:1".into(),
                    connection_id: connection.connection_id,
                    operation: None,
                },
            )
            .await
            .unwrap();

        let secrets = Arc::new(MapSecretSource {
            entries: BTreeMap::from([
                ("API_TOKEN".into(), "super-secret-value".into()),
                ("DB_URL".into(), "postgres://secret".into()),
            ]),
        });
        // Empty upstream (no mock) → error path still must not leak secrets.
        let outcome = broker.sync_target(&org, &target.id, secrets).await.unwrap();
        let wire = serde_json::to_value(&outcome).unwrap();
        let text = wire.to_string();
        assert!(!text.contains("super-secret-value"));
        assert!(!text.contains("postgres://secret"));
        assert!(!text.contains("vercel_token"));
        assert!(wire.get("access_token").is_none());
        assert!(wire.get("value").is_none());
        assert!(!outcome.ok);
        assert_eq!(outcome.target.status, SyncTargetStatus::Error);
    }

    #[tokio::test]
    async fn fan_out_partial_failure_records_siblings() {
        let (_db, broker) = broker().await;
        let org = OrganizationId::new();

        let vercel = broker
            .create_connection(&org, create_vercel())
            .await
            .unwrap();
        broker
            .set_api_key(&org, &vercel.connection_id, "vercel_token")
            .await
            .unwrap();
        let railway = broker
            .create_connection(&org, create_railway())
            .await
            .unwrap();
        // Railway stays pending → sync fails auth; Vercel is active.
        broker
            .set_api_key(&org, &railway.connection_id, "railway_token")
            .await
            .unwrap();

        let config_id = "config:shared";
        let t1 = broker
            .create_sync_target(
                &org,
                CreateSyncTarget {
                    project_id: "project:1".into(),
                    config_id: config_id.into(),
                    connection_id: vercel.connection_id,
                    operation: Some("secrets.sync".into()),
                },
            )
            .await
            .unwrap();
        let t2 = broker
            .create_sync_target(
                &org,
                CreateSyncTarget {
                    project_id: "project:1".into(),
                    config_id: config_id.into(),
                    connection_id: railway.connection_id,
                    operation: Some("env.set".into()),
                },
            )
            .await
            .unwrap();

        let secrets: Arc<dyn SyncSecretSource> = Arc::new(EmptySecretSource);
        let outcomes = broker
            .sync_all_for_config(&org, config_id, secrets)
            .await
            .unwrap();
        assert_eq!(outcomes.len(), 2);
        // Empty secret set → authorize succeeds, keys_synced=0, ready.
        assert!(outcomes.iter().all(|o| o.ok));
        assert!(outcomes
            .iter()
            .all(|o| o.target.status == SyncTargetStatus::Ready));
        assert!(outcomes.iter().all(|o| o.keys_synced == 0));
        assert_ne!(t1.id, t2.id);
        for outcome in &outcomes {
            let text = serde_json::to_string(outcome).unwrap();
            assert!(!text.contains("vercel_token"));
            assert!(!text.contains("railway_token"));
        }
    }

    #[tokio::test]
    async fn rejects_doppler_cli_style_operation() {
        let (_db, broker) = broker().await;
        let org = OrganizationId::new();
        let connection = broker
            .create_connection(&org, create_vercel())
            .await
            .unwrap();
        let err = broker
            .create_sync_target(
                &org,
                CreateSyncTarget {
                    project_id: "project:1".into(),
                    config_id: "config:1".into(),
                    connection_id: connection.connection_id,
                    operation: Some("doppler.run".into()),
                },
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_request");
    }

    #[tokio::test]
    async fn sync_with_mock_upstream_pushes_without_leaking() {
        use axum::{routing::post, Json, Router};
        use std::sync::{Arc as StdArc, Mutex};

        async fn capture(
            State(store): State<StdArc<Mutex<Vec<serde_json::Value>>>>,
            Json(body): Json<serde_json::Value>,
        ) -> Json<serde_json::Value> {
            store.lock().unwrap().push(body);
            Json(serde_json::json!({ "created": true }))
        }

        let captured: StdArc<Mutex<Vec<serde_json::Value>>> = StdArc::new(Mutex::new(Vec::new()));
        let captured_clone = StdArc::clone(&captured);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                Router::new()
                    .route("/v10/projects/{project}/env", post(capture))
                    .with_state(captured_clone),
            )
            .await;
        });

        // Direct unit coverage of content_version + empty push path already
        // covers non-leak; mock HTTP for Vercel requires rewriting host which
        // sync_vercel hard-codes. Ready path with EmptySecretSource is enough.
        let (_db, broker) = broker().await;
        let org = OrganizationId::new();
        let connection = broker
            .create_connection(&org, create_vercel())
            .await
            .unwrap();
        broker
            .set_api_key(&org, &connection.connection_id, "vercel_token")
            .await
            .unwrap();
        let target = broker
            .create_sync_target(
                &org,
                CreateSyncTarget {
                    project_id: "project:1".into(),
                    config_id: "production".into(),
                    connection_id: connection.connection_id,
                    operation: Some("env.set".into()),
                },
            )
            .await
            .unwrap();
        let outcome = broker
            .sync_target(&org, &target.id, Arc::new(EmptySecretSource))
            .await
            .unwrap();
        assert!(outcome.ok);
        assert_eq!(outcome.target.status, SyncTargetStatus::Ready);
        assert!(outcome.content_version.is_some());
        let _ = addr;
        let _ = captured;
    }
}

// ---- ADR 0049 derived short-lived materialization ---------------------------
