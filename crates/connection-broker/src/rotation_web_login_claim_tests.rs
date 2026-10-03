//! Who owns a web-login job: one conditional claim, a runner that is never
//! offered to the generic consumer, and a lease that recovery reads.

use chrono::{DateTime, Duration, Utc};
use opensesame_domain::OrganizationId;
use opensesame_storage::Db;
use opensesame_task_bus::{InMemoryTaskBus, TaskBus};

use super::super::super::{
    consume_rotation_events, execute_rotation, request_rotation, RotationTarget,
    EVENT_ROTATION_REQUESTED,
};
use super::super::{
    reconcile_stranded_web_login_rotation, settle_web_login_rotation, stranded_web_login_jobs,
    WebLoginSettlement, STRANDED_DETAIL,
};
use super::*;
use crate::config::BrokerConfig;

const ORIGIN: &str = "https://example.com";

fn claim(run_id: &str) -> WebLoginClaim<'_> {
    WebLoginClaim {
        run_id,
        lease: Duration::minutes(17),
    }
}

fn later() -> DateTime<Utc> {
    Utc::now() + Duration::hours(1)
}

async fn broker() -> (ConnectionBroker, InMemoryTaskBus, OrganizationId) {
    let db = Db::connect_memory().await.expect("db");
    let config = BrokerConfig::in_memory(Some([7u8; 32]), "http://127.0.0.1:8787");
    let broker = ConnectionBroker::new(db.pool().clone(), config).expect("broker");
    (broker, InMemoryTaskBus::default(), OrganizationId::new())
}

async fn scheduled(
    broker: &ConnectionBroker,
    bus: &InMemoryTaskBus,
    org: &OrganizationId,
) -> String {
    let target = RotationTarget::WebLogin {
        origin: ORIGIN.into(),
    };
    request_rotation(broker, bus, target, None, &org.to_string(), None)
        .await
        .unwrap()
        .id
}

async fn state_of(broker: &ConnectionBroker, org: &OrganizationId, id: &str) -> String {
    broker
        .get_rotation_job(&org.to_string(), id)
        .await
        .unwrap()
        .unwrap()
        .state
}

#[tokio::test]
async fn of_many_claimants_exactly_one_takes_the_job() {
    let (broker, bus, org) = broker().await;
    let id = scheduled(&broker, &bus, &org).await;
    let claims = [
        claim("run_0"),
        claim("run_1"),
        claim("run_2"),
        claim("run_3"),
    ];
    let results = tokio::join!(
        begin_web_login_rotation(&broker, &org, &id, &claims[0]),
        begin_web_login_rotation(&broker, &org, &id, &claims[1]),
        begin_web_login_rotation(&broker, &org, &id, &claims[2]),
        begin_web_login_rotation(&broker, &org, &id, &claims[3]),
    );
    let results = [results.0, results.1, results.2, results.3];
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    // The claim names the one that won.
    let winner = claim_holder(&broker, &id).await.unwrap().unwrap();
    let won = results.iter().position(Result::is_ok).unwrap();
    assert_eq!(winner, format!("run_{won}"));
}

#[tokio::test]
async fn a_claim_is_scoped_to_the_organization() {
    let (broker, bus, org) = broker().await;
    let id = scheduled(&broker, &bus, &org).await;
    let other = OrganizationId::new();
    assert!(
        begin_web_login_rotation(&broker, &other, &id, &claim("run_x"))
            .await
            .is_err()
    );
    assert!(defer_web_login_rotation(&broker, &bus, &other, &id, "no")
        .await
        .is_err());
    assert_eq!(state_of(&broker, &org, &id).await, "scheduled");
    assert!(claim_holder(&broker, &id).await.unwrap().is_none());
}

#[tokio::test]
async fn the_consumer_cannot_park_a_job_the_runner_claimed() {
    let (broker, bus, org) = broker().await;
    let id = scheduled(&broker, &bus, &org).await;
    begin_web_login_rotation(&broker, &org, &id, &claim("run_1"))
        .await
        .unwrap();
    // The generic path reads the job as scheduled only if it read it before the
    // claim; its write is conditional either way.
    assert!(execute_rotation(&broker, &bus, &org, &id).await.is_err());
    assert!(
        defer_web_login_rotation(&broker, &bus, &org, &id, "no runner")
            .await
            .is_err()
    );
    assert_eq!(state_of(&broker, &org, &id).await, "discovering");
    assert_eq!(
        claim_holder(&broker, &id).await.unwrap().as_deref(),
        Some("run_1")
    );
}

#[tokio::test]
async fn the_runner_cannot_claim_a_job_the_consumer_parked() {
    let (broker, bus, org) = broker().await;
    let id = scheduled(&broker, &bus, &org).await;
    execute_rotation(&broker, &bus, &org, &id).await.unwrap();
    assert_eq!(
        state_of(&broker, &org, &id).await,
        "reconciliation_required"
    );
    assert!(
        begin_web_login_rotation(&broker, &org, &id, &claim("run_1"))
            .await
            .is_err()
    );
    assert!(
        claim_holder(&broker, &id).await.unwrap().is_none(),
        "no claim left behind"
    );
    assert_eq!(
        state_of(&broker, &org, &id).await,
        "reconciliation_required"
    );
}

#[tokio::test]
async fn a_job_the_runner_requests_is_never_offered_to_the_consumer() {
    let (broker, bus, org) = broker().await;
    let job = request_claimed_web_login_rotation(&broker, &org, ORIGIN, None, &claim("run_1"))
        .await
        .unwrap();
    assert_eq!(job.state, "discovering");
    assert_eq!(
        claim_holder(&broker, &job.id).await.unwrap().as_deref(),
        Some("run_1")
    );
    // Nothing for the consumer to drain...
    let events = bus.drain(10).await.unwrap();
    assert!(events.iter().all(|e| e.r#type != EVENT_ROTATION_REQUESTED));
    // ...and a consumer handed the event anyway takes nothing.
    bus.publish(super::super::super::bus_event(
        EVENT_ROTATION_REQUESTED,
        super::super::super::job_event_data(&job),
    ))
    .await
    .unwrap();
    consume_rotation_events(&broker, &bus, 10).await.unwrap();
    assert_eq!(state_of(&broker, &org, &job.id).await, "discovering");
}

#[tokio::test]
async fn a_claimed_job_parks_only_for_the_run_that_holds_it() {
    let (broker, bus, org) = broker().await;
    let job = request_claimed_web_login_rotation(&broker, &org, ORIGIN, None, &claim("run_1"))
        .await
        .unwrap();
    assert!(
        park_claimed_web_login_rotation(&broker, &bus, &org, &job.id, "run_other", "no recipe")
            .await
            .is_err(),
        "another run's id does not hold the claim"
    );
    let parked =
        park_claimed_web_login_rotation(&broker, &bus, &org, &job.id, "run_1", "no recipe")
            .await
            .unwrap();
    assert_eq!(parked.state, "reconciliation_required");
    assert_eq!(parked.detail.as_deref(), Some("no recipe"));
    assert!(claim_holder(&broker, &job.id).await.unwrap().is_none());
}

#[tokio::test]
async fn recovery_reads_the_lease_not_a_guess() {
    let (broker, _bus, org) = broker().await;
    let job = request_claimed_web_login_rotation(&broker, &org, ORIGIN, None, &claim("run_1"))
        .await
        .unwrap();

    // Inside the lease the job is a live run's, however old `untouched_since`
    // would make it look.
    let now = Utc::now() + Duration::minutes(5);
    assert!(stranded_web_login_jobs(&broker, &org, now, later())
        .await
        .unwrap()
        .is_empty());

    // Past it, the job is stranded, and the listing names the run.
    let found = stranded_web_login_jobs(&broker, &org, later(), Utc::now() - Duration::days(1))
        .await
        .unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].job.id, job.id);
    assert_eq!(found[0].run_id.as_deref(), Some("run_1"));
}

#[tokio::test]
async fn a_job_with_no_claim_on_record_falls_back_to_when_it_was_last_touched() {
    let (broker, bus, org) = broker().await;
    let id = scheduled(&broker, &bus, &org).await;
    begin_web_login_rotation(&broker, &org, &id, &claim("run_1"))
        .await
        .unwrap();
    sqlx::query("DELETE FROM web_login_job_claims")
        .execute(&broker.pool)
        .await
        .unwrap();
    // Touched just now: not stranded, whatever the clock says.
    assert!(
        stranded_web_login_jobs(&broker, &org, later(), Utc::now() - Duration::hours(1))
            .await
            .unwrap()
            .is_empty()
    );
    let found = stranded_web_login_jobs(&broker, &org, later(), later())
        .await
        .unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].run_id, None);
}

#[tokio::test]
async fn a_settlement_is_refused_once_the_reaper_has_parked_the_job() {
    let (broker, bus, org) = broker().await;
    let job = request_claimed_web_login_rotation(&broker, &org, ORIGIN, None, &claim("run_1"))
        .await
        .unwrap();
    let stranded = stranded_web_login_jobs(&broker, &org, later(), later())
        .await
        .unwrap();
    reconcile_stranded_web_login_rotation(&broker, &bus, &stranded[0].job, STRANDED_DETAIL)
        .await
        .unwrap()
        .expect("parked");
    assert!(
        settle_web_login_rotation(&broker, &bus, &org, &job.id, WebLoginSettlement::Completed)
            .await
            .is_err(),
        "the reaper's parking is not overwritten by a late settlement"
    );
    assert_eq!(
        state_of(&broker, &org, &job.id).await,
        "reconciliation_required"
    );
}
