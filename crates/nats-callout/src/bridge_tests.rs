use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use opensesame_authz::CalloutPermissions;

use super::*;
use crate::fixtures::Parties;
use crate::jwt::peek_claims;
use crate::response::{ResponseClaims, UserClaims};

const NOW: i64 = 1_800_000_000;
const TOKEN: &str = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln";

/// A source that answers from a closure and counts calls.
struct Canned {
    calls: AtomicUsize,
    answer: Mutex<
        Box<dyn Fn(&HostDecisionRequest) -> Result<HostDecisionResponse, CalloutError> + Send>,
    >,
}

#[async_trait::async_trait]
impl DecisionSource for Canned {
    async fn decide(
        &self,
        req: &HostDecisionRequest,
    ) -> Result<HostDecisionResponse, CalloutError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        (self.answer.lock().unwrap())(req)
    }
}

fn allow_for(req: &HostDecisionRequest) -> HostDecisionResponse {
    HostDecisionResponse {
        decision: "allow".into(),
        principal_id: Some("prn_1".into()),
        provisional: Some(false),
        permissions: Some(CalloutPermissions {
            publish: vec!["opensesame.callout.principal.prn_1.>".into()],
            subscribe: vec!["opensesame.callout.principal.prn_1.>".into()],
        }),
        user_nkey: Some(req.user_nkey.clone()),
        server_id: Some(req.server.id.clone()),
        request_digest: Some(req.request_digest.clone()),
        exp: Some(
            chrono::DateTime::from_timestamp(NOW + 120, 0)
                .unwrap()
                .to_rfc3339(),
        ),
        enforcement: Some("verified".into()),
        ..HostDecisionResponse::default()
    }
}

fn core_with(
    p: &Parties,
    xkey: Option<CalloutXKey>,
    answer: impl Fn(&HostDecisionRequest) -> Result<HostDecisionResponse, CalloutError> + Send + 'static,
) -> (BridgeCore, Arc<Canned>) {
    let source = Arc::new(Canned {
        calls: AtomicUsize::new(0),
        answer: Mutex::new(Box::new(answer)),
    });
    let core = BridgeCore {
        signer: ResponseSigner::from_seed(&p.account.seed().unwrap(), 300).unwrap(),
        server_public_keys: vec![p.server.public_key()],
        xkey,
        target_account: "APP".into(),
        callout_subject: None,
        source: source.clone(),
    };
    (core, source)
}

fn reply(outcome: Outcome) -> ResponseClaims {
    match outcome {
        Outcome::Reply(bytes) => peek_claims(std::str::from_utf8(&bytes).unwrap()).unwrap(),
        Outcome::Dropped(err) => panic!("expected a reply, got drop {err:?}"),
    }
}

#[tokio::test]
async fn allow_is_signed_with_the_hosts_permissions_and_bound_to_the_request() {
    let p = Parties::generate();
    let (core, _) = core_with(&p, None, |req| Ok(allow_for(req)));
    let payload = p.signed_request(NOW, TOKEN);
    let resp = reply(core.handle(payload.as_bytes(), None, NOW).await);
    assert_eq!(resp.aud, p.server.public_key());
    assert_eq!(resp.sub, p.user.public_key());
    assert_eq!(resp.iss, p.account.public_key());
    let user: UserClaims = peek_claims(resp.user_jwt().unwrap()).unwrap();
    assert_eq!(user.aud, "APP");
    assert_eq!(user.sub, p.user.public_key());
    assert_eq!(
        user.exp,
        NOW + 120,
        "user JWT expiry is the Host's, not the maximum"
    );
    assert_eq!(
        user.publish_allow(),
        ["opensesame.callout.principal.prn_1.>"]
    );
    assert_eq!(user.name.as_deref(), Some("prn_1"));
}

#[tokio::test]
async fn host_failure_is_a_signed_deny_never_an_allow() {
    let p = Parties::generate();
    for err in [CalloutError::HostUnreachable, CalloutError::HostError] {
        let code = err.code();
        let (core, _) = core_with(&p, None, move |_| Err(err.clone()));
        let payload = p.signed_request(NOW, TOKEN);
        let resp = reply(core.handle(payload.as_bytes(), None, NOW).await);
        assert_eq!(resp.error(), Some(code));
        assert!(resp.user_jwt().is_none());
    }
}

#[tokio::test]
async fn host_deny_is_relayed_with_its_code() {
    let p = Parties::generate();
    let (core, _) = core_with(&p, None, |req| {
        Ok(HostDecisionResponse {
            decision: "deny".into(),
            error: Some("unmapped_principal".into()),
            user_nkey: Some(req.user_nkey.clone()),
            server_id: Some(req.server.id.clone()),
            request_digest: Some(req.request_digest.clone()),
            ..HostDecisionResponse::default()
        })
    });
    let payload = p.signed_request(NOW, TOKEN);
    let resp = reply(core.handle(payload.as_bytes(), None, NOW).await);
    assert_eq!(resp.error(), Some("unmapped_principal"));
}

#[tokio::test]
async fn tampered_echo_on_any_field_is_denied() {
    let p = Parties::generate();
    let tamper: Vec<(&str, Box<dyn Fn(&mut HostDecisionResponse) + Send + Sync>)> = vec![
        (
            "digest",
            Box::new(|r| r.request_digest = Some("f".repeat(64))),
        ),
        (
            "user",
            Box::new(|r| r.user_nkey = Some(nkeys::KeyPair::new_user().public_key())),
        ),
        (
            "server",
            Box::new(|r| r.server_id = Some(nkeys::KeyPair::new_server().public_key())),
        ),
        ("permissions", Box::new(|r| r.permissions = None)),
        (
            "enforcement",
            Box::new(|r| r.enforcement = Some("unverified_dev".into())),
        ),
        ("exp", Box::new(|r| r.exp = None)),
    ];
    for (name, mutate) in tamper {
        let mutate = Arc::new(mutate);
        let m = mutate.clone();
        let (core, _) = core_with(&p, None, move |req| {
            let mut r = allow_for(req);
            m(&mut r);
            Ok(r)
        });
        let payload = p.signed_request(NOW, TOKEN);
        let resp = reply(core.handle(payload.as_bytes(), None, NOW).await);
        assert_eq!(resp.error(), Some("response_mismatch"), "{name}");
        assert!(resp.user_jwt().is_none(), "{name}");
    }
}

#[tokio::test]
async fn unverifiable_payloads_are_dropped_without_a_host_call() {
    let p = Parties::generate();
    let (core, source) = core_with(&p, None, |req| Ok(allow_for(req)));
    // Signed by an unpinned server.
    let other = Parties::generate();
    let foreign = other.signed_request(NOW, TOKEN);
    assert!(matches!(
        core.handle(foreign.as_bytes(), None, NOW).await,
        Outcome::Dropped(CalloutError::ServerUnknown)
    ));
    // Stale.
    let stale = p.signed_request(NOW - 600, TOKEN);
    assert!(matches!(
        core.handle(stale.as_bytes(), None, NOW).await,
        Outcome::Dropped(CalloutError::OutsideWindow)
    ));
    // Garbage.
    assert!(matches!(
        core.handle(b"not a jwt", None, NOW).await,
        Outcome::Dropped(CalloutError::MalformedRequest(_))
    ));
    // Sealed but no xkey configured.
    assert!(matches!(
        core.handle(b"xkv1....", Some("X"), NOW).await,
        Outcome::Dropped(CalloutError::XkeyRequired)
    ));
    assert_eq!(source.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn sealed_requests_round_trip_and_the_header_must_match_the_claims() {
    let p = Parties::generate();
    let server_x = CalloutXKey::generate();
    let service_x = CalloutXKey::generate();
    let (core, _) = core_with(
        &p,
        Some(CalloutXKey::from_seed(&service_x.seed().unwrap()).unwrap()),
        |req| Ok(allow_for(req)),
    );
    let mut claims = p.request_claims(NOW, TOKEN);
    claims.nats.server_id.xkey = Some(server_x.public_key());
    let jwt = p.sign_request(claims.clone());
    let sealed = server_x
        .seal(jwt.as_bytes(), &service_x.public_key())
        .unwrap();
    let Outcome::Reply(bytes) = core
        .handle(&sealed, Some(&server_x.public_key()), NOW)
        .await
    else {
        panic!("expected a sealed reply");
    };
    assert!(is_sealed(&bytes));
    let opened = server_x.open(&bytes, &service_x.public_key()).unwrap();
    let resp: ResponseClaims = peek_claims(std::str::from_utf8(&opened).unwrap()).unwrap();
    assert!(resp.user_jwt().is_some());
    // A header naming a different sender than the claims is refused.
    let other_x = CalloutXKey::generate();
    let sealed_other = other_x
        .seal(jwt.as_bytes(), &service_x.public_key())
        .unwrap();
    assert!(matches!(
        core.handle(&sealed_other, Some(&other_x.public_key()), NOW)
            .await,
        Outcome::Dropped(CalloutError::EnvelopeMismatch)
    ));
    // No header at all: cannot open.
    assert!(matches!(
        core.handle(&sealed, None, NOW).await,
        Outcome::Dropped(CalloutError::XkeyOpenFailed)
    ));
}

#[tokio::test]
async fn the_same_request_yields_the_same_decision_request_digest() {
    let p = Parties::generate();
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let s = seen.clone();
    let (core, source) = core_with(&p, None, move |req| {
        s.lock().unwrap().push(req.request_digest.clone());
        Ok(allow_for(req))
    });
    let payload = p.signed_request(NOW, TOKEN);
    reply(core.handle(payload.as_bytes(), None, NOW).await);
    reply(core.handle(payload.as_bytes(), None, NOW + 1).await);
    assert_eq!(source.calls.load(Ordering::SeqCst), 2);
    let digests = seen.lock().unwrap();
    assert_eq!(
        digests[0], digests[1],
        "a replayed request has one immutable digest"
    );
    // Same nonce and user key, a different token: a different digest.
    let mut claims = p.request_claims(NOW, "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIyIn0.c2ln");
    claims.nats.request_nonce = "request-nonce-1".into();
    let changed = p.sign_request(claims);
    drop(digests);
    reply(core.handle(changed.as_bytes(), None, NOW).await);
    let digests = seen.lock().unwrap();
    assert_ne!(digests[0], digests[2]);
}
