use super::*;
use axum::{body::Body, http::Request};
use futures::StreamExt;
use opensesame_storage::ObservationAppend;
use tower::ServiceExt;

#[tokio::test]
async fn open_stream_stops_before_buffered_events_after_authority_changes() {
    for change in ["revoke", "expire", "membership", "owner"] {
        let f = tests::fixture().await;
        let list_path = "/api/v1/agent/runs";
        assert_eq!(
            f.browser.send(&f.app, "GET", list_path, None).await.0,
            StatusCode::OK
        );
        let headers = f.browser.headers("GET", list_path);
        let (_, claims) = crate::middleware::auth::require_session(&f.state, &headers).unwrap();
        let run = tests::seed(
            "stream-run",
            &claims.principal_id.to_string(),
            &f.org,
            "awaiting_human",
        );
        f.state.db.create_observation_run(&run).await.unwrap();
        for _ in 0..3 {
            f.state
                .db
                .append_observation_event(&ObservationAppend {
                    organization_id: &f.org,
                    run_id: &run.id,
                    lane: "action",
                    of_step: None,
                    layout_epoch: None,
                    payload: &[1, 2, 3],
                    recorded_at: &Utc::now().to_rfc3339(),
                })
                .await
                .unwrap();
        }
        let path = format!("/api/v1/agent/runs/{}/observe", run.id);
        let mut request = Request::builder().method("GET").uri(&path);
        *request.headers_mut().unwrap() = f.browser.headers("GET", &path);
        let response = f
            .app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut stream = response.into_body().into_data_stream();
        let first = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .unwrap();
        assert!(first.unwrap().is_ok());
        match change {
            "revoke" => {
                assert!(f
                    .state
                    .db
                    .revoke_browser_client(
                        &claims.client_id,
                        &claims.principal_id.to_string(),
                        &f.org,
                        Utc::now().timestamp()
                    )
                    .await
                    .unwrap());
            }
            "expire" => {
                sqlx::query("UPDATE browser_grants SET expires_at=? WHERE client_id=?")
                    .bind(Utc::now().timestamp())
                    .bind(&claims.client_id)
                    .execute(f.state.db.pool())
                    .await
                    .unwrap();
            }
            "membership" => {
                sqlx::query("UPDATE config_authorization_roles SET role=NULL WHERE organization_id=? AND principal_id=?")
                    .bind(&f.org).bind(claims.principal_id.to_string()).execute(f.state.db.pool()).await.unwrap();
            }
            "owner" => {
                sqlx::query("UPDATE observation_runs SET owner_principal_id=? WHERE id=?")
                    .bind(opensesame_domain::PrincipalId::new().to_string())
                    .bind(&run.id)
                    .execute(f.state.db.pool())
                    .await
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let next = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .unwrap();
        assert!(next.is_none(), "buffered ciphertext escaped after {change}");
    }
}
