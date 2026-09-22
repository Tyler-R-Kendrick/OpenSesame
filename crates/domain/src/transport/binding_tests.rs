use super::*;
use chrono::{DateTime, Utc};

pub(super) type Mutation<T> = Box<dyn Fn(&mut T)>;

pub(super) const HEX_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(super) const HEX_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

pub(super) fn at(s: &str) -> DateTime<Utc> {
    timestamp::parse(s).expect("test timestamp")
}

pub(super) fn now() -> DateTime<Utc> {
    at("2026-09-22T10:00:00Z")
}

pub(super) fn profile() -> TrustProfileRef {
    TrustProfileRef::new("private-root").unwrap()
}

pub(super) fn spiffe(path: &str) -> PeerIdentitySelector {
    PeerIdentitySelector::SpiffeId(format!("spiffe://example.org/{path}"))
}

pub(super) fn binding(
    id: &str,
    peer: PeerIdentitySelector,
    purpose: BindingPurpose,
) -> ServiceBinding {
    ServiceBinding {
        id: id.into(),
        revision: 1,
        enabled: true,
        revoked: false,
        scope: BindingScope::Deployment,
        trust_profile: profile(),
        peer,
        service_principal: format!("svc:{id}"),
        purpose,
        allowed_operations: vec![operations::NATS_CALLOUT_DECIDE.into()],
        allowed_audiences: vec!["host".into()],
        not_after: None,
        denied_thumbprints: vec![],
    }
}

pub(super) fn set(bindings: Vec<ServiceBinding>) -> ServiceBindingSet {
    let set = ServiceBindingSet {
        revision: 1,
        bindings,
    };
    set.validate().expect("fixture set validates");
    set
}

fn bridge() -> PeerIdentitySelector {
    spiffe("ns/prod/sa/nats-bridge")
}

fn presented() -> Vec<PeerIdentitySelector> {
    vec![
        bridge(),
        PeerIdentitySelector::LeafThumbprintSha256(HEX_A.into()),
    ]
}

fn resolve(set: &ServiceBindingSet, purpose: BindingPurpose) -> Result<String, &'static str> {
    set.resolve(&profile(), &presented(), purpose, now())
        .map(|b| b.id.clone())
        .map_err(|e| e.code())
}

#[test]
fn empty_set_binds_nobody() {
    let set = ServiceBindingSet::empty();
    assert_eq!(
        resolve(&set, BindingPurpose::NatsAuthBridge),
        Err("peer_not_bound")
    );
    assert_eq!(
        set.resolve(&profile(), &[], BindingPurpose::NatsAuthBridge, now())
            .unwrap_err()
            .code(),
        "peer_not_bound"
    );
}

#[test]
fn exact_match_resolves_and_everything_else_denies() {
    let set = set(vec![binding(
        "b1",
        bridge(),
        BindingPurpose::NatsAuthBridge,
    )]);
    assert_eq!(
        resolve(&set, BindingPurpose::NatsAuthBridge),
        Ok("b1".into())
    );
    // AT-TLS-WRONGSERVICE: same valid peer, wrong purpose.
    assert_eq!(
        resolve(&set, BindingPurpose::WorkerClient),
        Err("peer_not_bound")
    );
    // Different trust profile with the same name-shaped peer.
    let other = TrustProfileRef::new("web-pki").unwrap();
    assert_eq!(
        set.resolve(&other, &presented(), BindingPurpose::NatsAuthBridge, now())
            .unwrap_err()
            .code(),
        "peer_not_bound"
    );
    // Sibling path in the same trust domain is not the bound peer.
    let sibling = vec![spiffe("ns/prod/sa/nats-bridge-2")];
    assert_eq!(
        set.resolve(&profile(), &sibling, BindingPurpose::NatsAuthBridge, now())
            .unwrap_err()
            .code(),
        "peer_not_bound"
    );
    // Case differs → not the peer (no normalization).
    let cased = vec![PeerIdentitySelector::SpiffeId(
        "spiffe://example.org/ns/prod/sa/NATS-bridge".into(),
    )];
    assert_eq!(
        set.resolve(&profile(), &cased, BindingPurpose::NatsAuthBridge, now())
            .unwrap_err()
            .code(),
        "peer_not_bound"
    );
}

#[test]
fn disabled_revoked_and_expired_bindings_deny() {
    let mut disabled = binding("b1", bridge(), BindingPurpose::NatsAuthBridge);
    disabled.enabled = false;
    assert_eq!(
        resolve(&set(vec![disabled]), BindingPurpose::NatsAuthBridge),
        Err("binding_disabled")
    );

    let mut revoked = binding("b1", bridge(), BindingPurpose::NatsAuthBridge);
    revoked.revoked = true;
    assert_eq!(
        resolve(&set(vec![revoked]), BindingPurpose::NatsAuthBridge),
        Err("binding_disabled")
    );

    let mut expired = binding("b1", bridge(), BindingPurpose::NatsAuthBridge);
    expired.not_after = Some(at("2026-09-22T09:59:59Z"));
    assert_eq!(
        resolve(&set(vec![expired.clone()]), BindingPurpose::NatsAuthBridge),
        Err("binding_disabled")
    );
    // Boundary: not_after == now is already outside the window.
    expired.not_after = Some(now());
    assert_eq!(
        resolve(&set(vec![expired.clone()]), BindingPurpose::NatsAuthBridge),
        Err("binding_disabled")
    );
    expired.not_after = Some(at("2026-09-22T10:00:01Z"));
    assert_eq!(
        resolve(&set(vec![expired]), BindingPurpose::NatsAuthBridge),
        Ok("b1".into())
    );
}

#[test]
fn two_live_matches_are_ambiguous_not_first_wins() {
    let set = set(vec![
        binding("b1", bridge(), BindingPurpose::NatsAuthBridge),
        binding("b2", bridge(), BindingPurpose::NatsAuthBridge),
    ]);
    assert_eq!(
        resolve(&set, BindingPurpose::NatsAuthBridge),
        Err("ambiguous_binding")
    );
    // A thumbprint binding and a name binding for the same leaf are also two.
    let set = set_of_thumb_and_name();
    assert_eq!(
        resolve(&set, BindingPurpose::NatsAuthBridge),
        Err("ambiguous_binding")
    );
    // Once one is disabled the other resolves alone.
    let mut one_off = set_of_thumb_and_name();
    one_off.bindings[0].enabled = false;
    assert_eq!(
        resolve(&one_off, BindingPurpose::NatsAuthBridge),
        Ok("by-name".into())
    );
}

fn set_of_thumb_and_name() -> ServiceBindingSet {
    set(vec![
        binding(
            "by-thumb",
            PeerIdentitySelector::LeafThumbprintSha256(HEX_A.into()),
            BindingPurpose::NatsAuthBridge,
        ),
        binding("by-name", bridge(), BindingPurpose::NatsAuthBridge),
    ])
}

#[test]
fn denied_thumbprint_revokes_a_leaf_even_under_a_name_binding() {
    let mut b = binding("b1", bridge(), BindingPurpose::NatsAuthBridge);
    b.denied_thumbprints = vec![HEX_A.into()];
    let set = set(vec![b]);
    assert_eq!(
        resolve(&set, BindingPurpose::NatsAuthBridge),
        Err("evidence_revoked")
    );
    // A different leaf under the same name is fine.
    let fresh = vec![
        bridge(),
        PeerIdentitySelector::LeafThumbprintSha256(HEX_B.into()),
    ];
    assert_eq!(
        set.resolve(&profile(), &fresh, BindingPurpose::NatsAuthBridge, now())
            .unwrap()
            .id,
        "b1"
    );
    // The denial wins over disabled state and over a second live binding.
    let mut disabled = set.bindings[0].clone();
    disabled.enabled = false;
    let set = self::set(vec![
        disabled,
        binding("b2", bridge(), BindingPurpose::NatsAuthBridge),
    ]);
    assert_eq!(
        resolve(&set, BindingPurpose::NatsAuthBridge),
        Err("evidence_revoked")
    );
}

#[test]
fn tenant_scopes_are_disjoint_unless_explicitly_scoped() {
    let mut org = binding("org-b", bridge(), BindingPurpose::NatsAuthBridge);
    org.scope = BindingScope::Organization {
        organization_id: "org-a".into(),
    };
    let set = set(vec![
        org,
        binding(
            "dep-b",
            spiffe("ns/prod/sa/worker"),
            BindingPurpose::WorkerClient,
        ),
    ]);
    // Deployment lookup does not see the organization binding.
    assert_eq!(
        resolve(&set, BindingPurpose::NatsAuthBridge),
        Err("peer_not_bound")
    );
    // The organization lookup does, and only for its own id.
    let scope_a = BindingScope::Organization {
        organization_id: "org-a".into(),
    };
    let scope_b = BindingScope::Organization {
        organization_id: "org-b".into(),
    };
    assert_eq!(
        set.resolve_scoped(
            &scope_a,
            &profile(),
            &presented(),
            BindingPurpose::NatsAuthBridge,
            now()
        )
        .unwrap()
        .id,
        "org-b"
    );
    assert_eq!(
        set.resolve_scoped(
            &scope_b,
            &profile(),
            &presented(),
            BindingPurpose::NatsAuthBridge,
            now()
        )
        .unwrap_err()
        .code(),
        "peer_not_bound"
    );
    // An organization lookup does not see deployment bindings either.
    let worker = vec![spiffe("ns/prod/sa/worker")];
    assert_eq!(
        set.resolve_scoped(
            &scope_a,
            &profile(),
            &worker,
            BindingPurpose::WorkerClient,
            now()
        )
        .unwrap_err()
        .code(),
        "peer_not_bound"
    );
    assert_eq!(
        set.resolve(&profile(), &worker, BindingPurpose::WorkerClient, now())
            .unwrap()
            .id,
        "dep-b"
    );
}
