use super::*;

fn caller(token: &str) -> Caller {
    Caller {
        origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop".into(),
        token: token.into(),
    }
}

#[test]
fn an_operator_grant_is_bound_to_caller_site_entry_and_field_and_spent_once() {
    let approvals = Approvals::default();
    let who = caller("first-token");
    let now = Utc::now();
    let value = Some(("Web/example", Field::Password));
    assert!(!approvals.admit(&who, "https://example.com", value, now));
    let request = approvals.list(now).remove(0);
    assert!(approvals.approve(&request.id, now).is_some());
    for (other, origin, reference, field) in [
        (
            caller("other-token"),
            "https://example.com",
            "Web/example",
            Field::Password,
        ),
        (
            caller("first-token"),
            "https://evil.test",
            "Web/example",
            Field::Password,
        ),
        (
            caller("first-token"),
            "https://example.com",
            "Web/other",
            Field::Password,
        ),
        (
            caller("first-token"),
            "https://example.com",
            "Web/example",
            Field::Username,
        ),
    ] {
        assert!(!approvals.admit(&other, origin, Some((reference, field)), now));
    }
    assert!(approvals.admit(&who, "https://example.com", value, now));
    assert!(!approvals.admit(&who, "https://example.com", value, now));
    assert!(approvals.approve(&request.id, now).is_none());
}

#[test]
fn expiry_and_restart_revoke_grants_and_names_never_admit_values() {
    let approvals = Approvals::default();
    let who = caller("first-token");
    let now = Utc::now();
    assert!(!approvals.admit(&who, "https://example.com", None, now));
    let request = approvals.list(now).remove(0);
    approvals.approve(&request.id, now).unwrap();
    assert!(approvals.admit(&who, "https://example.com", None, now));
    assert!(!approvals.admit(
        &who,
        "https://example.com",
        Some(("Web/example", Field::Password)),
        now
    ));
    assert!(!approvals.admit(
        &who,
        "https://example.com",
        None,
        now + Duration::seconds(TTL_SECS)
    ));
    assert!(!Approvals::default().admit(&who, "https://example.com", None, now));
}

#[test]
fn pending_work_is_bounded_and_never_serializes_bearer_or_digest() {
    let approvals = Approvals::default();
    let who = caller("private-token");
    let now = Utc::now();
    for n in 0..100 {
        assert!(!approvals.admit(&who, &format!("https://site-{n}.test"), None, now));
    }
    let requests = approvals.list(now);
    assert_eq!(requests.len(), PER_CALLER);
    let serialized = serde_json::to_string(&requests).unwrap();
    assert!(!serialized.contains("private-token"));
    assert!(!serialized.contains(&digest_hex("private-token")));
}

#[test]
fn a_rate_limited_release_keeps_the_approved_grant() {
    let approvals = Approvals::default();
    let who = caller("first-token");
    let now = Utc::now();
    let value = Some(("Web/example", Field::Password));
    assert!(!approvals.admit(&who, "https://example.com", value, now));
    let request = approvals.list(now).remove(0);
    approvals.approve(&request.id, now).unwrap();
    assert_eq!(
        approvals.admit_with_budget(&who, "https://example.com", value, now, || Err(2)),
        Err(2),
    );
    assert!(approvals.admit(&who, "https://example.com", value, now));
    assert!(!approvals.admit(&who, "https://example.com", value, now));
}

#[test]
fn revoking_a_pairing_also_forgets_pending_and_approved_operation_authority() {
    let approvals = Approvals::default();
    let who = caller("first-token");
    let now = Utc::now();
    let value = Some(("Web/example", Field::Password));
    approvals.admit(&who, "https://example.com", value, now);
    let id = approvals.list(now).remove(0).id;
    approvals.approve(&id, now).unwrap();
    approvals.revoke_origin(&who.origin);
    assert!(approvals.list(now).is_empty());
    assert!(!approvals.admit(&who, "https://example.com", value, now));
    assert!(approvals.approve(&id, now).is_none());
}

#[test]
fn concurrent_retries_cannot_spend_one_approval_twice() {
    let approvals = std::sync::Arc::new(Approvals::default());
    let who = caller("first-token");
    let now = Utc::now();
    let value = Some(("Web/example", Field::Password));
    approvals.admit(&who, "https://example.com", value, now);
    let id = approvals.list(now).remove(0).id;
    approvals.approve(&id, now).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let approvals = std::sync::Arc::clone(&approvals);
            let barrier = std::sync::Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                approvals.admit(&caller("first-token"), "https://example.com", value, now)
            })
        })
        .collect();
    let releases = workers
        .into_iter()
        .map(|worker| usize::from(worker.join().unwrap()))
        .sum::<usize>();
    assert_eq!(releases, 1);
}
