//! Schedule exploration of the broker's production idempotency store.
//!
//! The broker persists intents through [`opensesame_storage::Db`], whose
//! organization-scoped idempotency constraint is the enforcement boundary.

#![cfg(feature = "concurrency-test")]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;

use chrono::{Duration, Utc};
use opensesame_domain::{ActorId, DetachedProof, Intent, IntentId, OrganizationId, PrincipalId};
use opensesame_storage::Db;
use shuttle::sync::{Arc, Mutex};

const DEFAULT_ITERATIONS: usize = 1_000;

type InsertResults = (anyhow::Result<()>, anyhow::Result<()>);

struct InsertBatch {
    first: Intent,
    second: Intent,
    completed: mpsc::Sender<InsertResults>,
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("test runtime")
}

fn intent(organization_id: OrganizationId, idempotency_key: &str) -> Intent {
    let now = Utc::now();
    Intent {
        id: IntentId::new(),
        organization_id,
        project_id: None,
        principal_id: PrincipalId::new(),
        actor_id: ActorId::new(),
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: None,
        operation: "repository.read".into(),
        resource: "repo:acme/catalog".into(),
        audience: "https://api.github.com".into(),
        normalized_parameters_hash: Intent::parameters_hash(&serde_json::json!({})).unwrap(),
        body_hash: None,
        nonce: uuid::Uuid::new_v4().to_string(),
        idempotency_key: idempotency_key.into(),
        issued_at: now,
        expires_at: now + Duration::minutes(5),
        parent_invocation_id: None,
        delegation_chain: vec![],
        proof: DetachedProof {
            algorithm: "EdDSA".into(),
            key_thumbprint: "test-thumbprint".into(),
            signature: "test-signature".into(),
        },
    }
}

fn serve_store(organization_id: OrganizationId, batches: &mpsc::Receiver<InsertBatch>) {
    let runtime = runtime();
    let db = runtime
        .block_on(Db::connect_memory())
        .expect("test database");
    runtime
        .block_on(db.create_organization(&organization_id, "shuttle"))
        .expect("test organization");
    while let Ok(batch) = batches.recv() {
        let results = runtime.block_on(async {
            tokio::join!(
                db.insert_intent(&batch.first),
                db.insert_intent(&batch.second)
            )
        });
        batch.completed.send(results).expect("test receiver");
    }
}

fn await_results(completed: &mpsc::Receiver<InsertResults>) -> InsertResults {
    loop {
        match completed.try_recv() {
            Ok(results) => return results,
            Err(mpsc::TryRecvError::Empty) => shuttle::thread::yield_now(),
            Err(mpsc::TryRecvError::Disconnected) => panic!("store worker stopped"),
        }
    }
}

#[test]
fn concurrent_same_key_never_double_executes() {
    let iterations = std::env::var("SHUTTLE_ITERATIONS").map_or(DEFAULT_ITERATIONS, |raw| {
        raw.parse().expect("SHUTTLE_ITERATIONS must be a usize")
    });
    let organization_id = OrganizationId::new();

    let (batches, pending_batches) = mpsc::channel();
    let worker = std::thread::spawn(move || serve_store(organization_id, &pending_batches));
    let scheduled_batches = batches.clone();
    let sequence = AtomicUsize::new(0);
    shuttle::check_random(
        move || {
            let iteration = sequence.fetch_add(1, Ordering::Relaxed);
            let idempotency_key = format!("shuttle-idem-{iteration}");
            let requests = Arc::new(Mutex::new(Vec::with_capacity(2)));
            let a = shuttle::thread::spawn({
                let requests = Arc::clone(&requests);
                let idempotency_key = idempotency_key.clone();
                move || {
                    shuttle::thread::yield_now();
                    requests
                        .lock()
                        .unwrap()
                        .push(intent(organization_id, &idempotency_key));
                }
            });
            let b = shuttle::thread::spawn({
                let requests = Arc::clone(&requests);
                let idempotency_key = idempotency_key.clone();
                move || {
                    shuttle::thread::yield_now();
                    requests
                        .lock()
                        .unwrap()
                        .push(intent(organization_id, &idempotency_key));
                }
            });
            a.join().unwrap();
            b.join().unwrap();
            let mut requests = requests.lock().unwrap();
            let second = requests.pop().expect("second request");
            let first = requests.pop().expect("first request");
            drop(requests);
            let (completed, completion) = mpsc::channel();
            scheduled_batches
                .send(InsertBatch {
                    first,
                    second,
                    completed,
                })
                .expect("store worker");
            let (first_result, second_result) = await_results(&completion);
            let accepted = usize::from(first_result.is_ok()) + usize::from(second_result.is_ok());
            assert_eq!(
                accepted, 1,
                "exactly one intent with an organization-scoped idempotency key may be inserted: \
                 first={first_result:?}, second={second_result:?}"
            );
        },
        iterations,
    );
    drop(batches);
    worker.join().unwrap();
}
