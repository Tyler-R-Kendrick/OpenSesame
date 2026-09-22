use opensesame_nats_callout::fixtures::Parties;
use opensesame_nats_callout::host_client::HostDecisionRequest;
use opensesame_nats_callout::jwt::{decode_request, Expectations};
use opensesame_nats_callout::model::ClientTls;
use opensesame_nats_callout::CalloutError;

use super::*;

const PEM_A: &str = "-----BEGIN CERTIFICATE-----\nQUFBQUFBQUE=\n-----END CERTIFICATE-----";
const PEM_B: &str = "-----BEGIN CERTIFICATE-----\nQkJCQkJCQkI=\n-----END CERTIFICATE-----";

fn body_for(
    parties: &Parties,
    mutate: impl FnOnce(&mut opensesame_nats_callout::AuthorizationRequestClaims),
) -> (HostDecisionRequest, i64) {
    let now = chrono::Utc::now().timestamp();
    let mut claims = parties.request_claims(now, "");
    mutate(&mut claims);
    let raw = parties.sign_request(claims);
    let verified = decode_request(
        &raw,
        &Expectations {
            server_public_keys: vec![],
            callout_subject: None,
            now,
        },
    )
    .expect("fixture verifies");
    (HostDecisionRequest::from_verified(&verified), now)
}

fn pins(parties: &Parties) -> Vec<String> {
    vec![parties.server.public_key()]
}

#[test]
fn a_pinned_server_verifies_and_an_unpinned_one_does_not() {
    let parties = Parties::generate();
    let (body, now) = body_for(&parties, |_| {});
    let subject = parties.account.public_key();
    assert!(verify_request(&body, &pins(&parties), Some(&subject), now).is_ok());
    // AT-CALLOUT-PROVENANCE: another server's envelope, however well formed.
    let other = Parties::generate();
    let (forged, now) = body_for(&other, |claims| {
        claims.sub = subject.clone();
    });
    assert_eq!(
        verify_request(&forged, &pins(&parties), Some(&subject), now).unwrap_err(),
        CalloutError::ServerUnknown
    );
    // No pins at all: nothing is provenance.
    assert_eq!(
        verify_request(&body, &[], Some(&subject), now).unwrap_err(),
        CalloutError::ServerUnknown
    );
}

#[test]
fn a_posted_summary_that_disagrees_with_the_signature_is_refused() {
    let parties = Parties::generate();
    let subject = parties.account.public_key();
    let (good, now) = body_for(&parties, |_| {});
    let tamper: Vec<(&str, Box<dyn Fn(&mut HostDecisionRequest)>)> = vec![
        (
            "digest",
            Box::new(|b: &mut HostDecisionRequest| b.request_digest = "0".repeat(64)),
        ),
        (
            "user",
            Box::new(|b: &mut HostDecisionRequest| b.user_nkey = "UOTHERUSERKEY".into()),
        ),
        (
            "server",
            Box::new(|b: &mut HostDecisionRequest| b.server.id = "NOTHER".into()),
        ),
        (
            "nonce",
            Box::new(|b: &mut HostDecisionRequest| b.request_nonce = "other".into()),
        ),
        (
            "invented chain",
            Box::new(|b: &mut HostDecisionRequest| {
                b.evidence = Some(opensesame_nats_callout::evidence::ExtractedEvidence {
                    upstream_token: None,
                    tls_verified_chain: Some(vec![PEM_A.into()]),
                });
            }),
        ),
        (
            "invented token",
            Box::new(|b: &mut HostDecisionRequest| {
                b.evidence = Some(opensesame_nats_callout::evidence::ExtractedEvidence {
                    upstream_token: Some("a.b.c".into()),
                    tls_verified_chain: None,
                });
            }),
        ),
    ];
    for (name, mutate) in tamper {
        let mut body = good.clone();
        mutate(&mut body);
        assert_eq!(
            verify_request(&body, &pins(&parties), Some(&subject), now).unwrap_err(),
            CalloutError::EnvelopeMismatch,
            "{name}"
        );
    }
}

#[test]
fn presented_certificates_are_never_evidence_but_verified_chains_are() {
    let parties = Parties::generate();
    let subject = parties.account.public_key();
    // AT-CALLOUT-REPORTEDTLS: `certs` alone carries no chain forward.
    let (only_presented, now) = body_for(&parties, |claims| {
        claims.nats.client_tls = Some(ClientTls {
            certs: vec![PEM_A.into()],
            ..ClientTls::default()
        });
    });
    let verified = verify_request(&only_presented, &pins(&parties), Some(&subject), now).unwrap();
    assert!(verified.evidence.tls_verified_chain.is_none());
    let (with_chain, now) = body_for(&parties, |claims| {
        claims.nats.client_tls = Some(ClientTls {
            certs: vec![PEM_B.into()],
            verified_chains: vec![vec![PEM_A.into()]],
            ..ClientTls::default()
        });
    });
    let verified = verify_request(&with_chain, &pins(&parties), Some(&subject), now).unwrap();
    assert_eq!(
        verified.evidence.tls_verified_chain.as_deref(),
        Some([PEM_A.to_owned()].as_slice())
    );
}

fn verified_with_chain(chain: Option<Vec<String>>) -> VerifiedCallout {
    VerifiedCallout {
        digest: opensesame_nats_callout::RequestDigest::parse(&"a".repeat(64)).unwrap(),
        user_nkey: "UTEST".into(),
        server_id: "NTEST".into(),
        evidence: opensesame_nats_callout::evidence::ExtractedEvidence {
            upstream_token: None,
            tls_verified_chain: chain,
        },
    }
}

#[test]
fn certificate_identity_is_opt_in_and_exact() {
    let thumbprint = opensesame_nats_callout::digest::chain_entry_sha256(PEM_A);
    let peers = parse_cert_peers(&format!("{thumbprint}=https://idp.test|workload-a")).unwrap();
    let with_chain = verified_with_chain(Some(vec![PEM_A.into()]));
    // Off by default: a verified chain is reported, never authority.
    assert_eq!(
        cert_identity(&with_chain, false, &peers).unwrap(),
        CertIdentity::None
    );
    assert_eq!(
        cert_identity(&with_chain, true, &peers).unwrap(),
        CertIdentity::Bound {
            issuer: "https://idp.test".into(),
            subject: "workload-a".into()
        }
    );
    // A verified chain that is not on the allowlist is refused, not admitted
    // because it chains to the same root.
    let other = verified_with_chain(Some(vec![PEM_B.into()]));
    assert_eq!(
        cert_identity(&other, true, &peers).unwrap_err(),
        "peer_not_bound"
    );
    assert_eq!(
        cert_identity(&verified_with_chain(None), true, &peers).unwrap(),
        CertIdentity::None
    );
}

#[test]
fn a_malformed_peer_list_never_widens_into_any_certificate() {
    for bad in [
        "notahex=iss|sub",
        "=iss|sub",
        &format!("{}=iss", "a".repeat(64)),
        &format!("{}=|sub", "a".repeat(64)),
        &format!("{}=iss|", "a".repeat(64)),
    ] {
        assert!(parse_cert_peers(bad).is_err(), "{bad}");
    }
    assert!(parse_cert_peers("").unwrap().is_empty());
    let entry = format!("{}=iss|sub", "A".repeat(64));
    assert_eq!(
        parse_cert_peers(&entry).unwrap()[0].leaf_sha256,
        "a".repeat(64)
    );
}

#[test]
fn a_certificate_from_one_tenant_and_a_token_from_another_is_refused() {
    let cert = CertIdentity::Bound {
        issuer: "https://idp.test".into(),
        subject: "workload-a".into(),
    };
    let same = Some(("https://idp.test".to_owned(), "workload-a".to_owned()));
    assert_eq!(reconcile(same.clone(), &cert).unwrap(), same);
    // Credential substitution: a legitimate certificate plus somebody else's
    // token is refused rather than unioned.
    let other = Some(("https://idp.test".to_owned(), "workload-b".to_owned()));
    assert_eq!(reconcile(other, &cert).unwrap_err(), "identity_mismatch");
    let elsewhere = Some(("https://other.test".to_owned(), "workload-a".to_owned()));
    assert_eq!(
        reconcile(elsewhere, &cert).unwrap_err(),
        "identity_mismatch"
    );
    // Either alone is itself.
    assert_eq!(
        reconcile(None, &cert).unwrap(),
        Some(("https://idp.test".to_owned(), "workload-a".to_owned()))
    );
    assert_eq!(reconcile(same.clone(), &CertIdentity::None).unwrap(), same);
    assert_eq!(reconcile(None, &CertIdentity::None).unwrap(), None);
}

#[test]
fn the_replay_key_is_the_digest_and_nothing_else() {
    let digest = opensesame_nats_callout::RequestDigest::parse(&"b".repeat(64)).unwrap();
    assert_eq!(
        replay_key(&digest),
        format!("nats.callout.decision.{}", "b".repeat(64))
    );
}
