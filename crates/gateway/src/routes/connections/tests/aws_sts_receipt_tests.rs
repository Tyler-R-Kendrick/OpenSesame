//! What an AWS mint leaves behind (ADR 0217): a receipt event naming the grant
//! and STS's request id, a log line with the same, none of them carrying the
//! source credential or the minted secret, and a deadline on the lifecycle
//! feed that lapses into `lifecycle.expiry.expired`.

use opensesame_lifecycle::{evaluate, SubjectKind, Watermarks, EVENT_EXPIRY_EXPIRED};

use super::*;

#[tokio::test]
async fn a_mint_leaves_a_receipt_a_log_line_and_a_lifecycle_deadline() {
    let logs = Logs::default();
    let _guard = tracing::subscriber::set_default(logs.clone());
    let (state, _stand_in) = aws_harness(Reply::Assume { expires_in: 900 }).await;
    let id = bound_connection(&state).await;
    let (status, minted) = call(
        &state,
        "POST",
        &format!("/api/v1/connections/{id}/mint"),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{minted}");
    let grant = minted["receipt"]["grant_id"].as_str().unwrap().to_string();

    let (_, events) = call(
        &state,
        "GET",
        &format!("/api/v1/connections/{id}/events"),
        None,
    )
    .await;
    let events = events.to_string();
    assert_no_source("connection events", &events);
    assert!(
        events.contains(&grant) && events.contains(stand_in::REQUEST_ID),
        "receipt event: {events}"
    );
    assert!(
        !events.contains(stand_in::MINTED_SECRET),
        "the receipt carries the minted secret"
    );
    let logged = logs.0.lock().unwrap().clone();
    assert!(
        logged.contains(&grant),
        "log capture saw the mint: {logged}"
    );
    assert_no_source("log lines", &logged);
    assert!(
        !logged.contains(stand_in::MINTED_SECRET),
        "a log line carries the minted secret"
    );

    // The deadline is on the lifecycle feed, and lapses into `expired`.
    let now = chrono::Utc::now();
    let subjects =
        crate::lifecycle::subjects::collect(&state, &state.connection_organization, now).await;
    let subject = subjects
        .iter()
        .find(|subject| subject.subject_id == format!("aws-sts-mint:{grant}"))
        .expect("the mint is a lifecycle subject");
    assert_eq!(subject.kind, SubjectKind::ConnectionCredential);
    assert!(!subject.auto_respond);
    let after = subject.expires_at + chrono::Duration::seconds(1);
    let fired = evaluate(subject, Watermarks::default(), after);
    assert!(
        fired
            .iter()
            .any(|event| event.event_type == EVENT_EXPIRY_EXPIRED),
        "{fired:?}"
    );
}
