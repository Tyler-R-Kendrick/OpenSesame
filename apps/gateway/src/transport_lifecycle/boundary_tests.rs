//! The source contract for AT-CUSTODY-HUMAN: nothing an agent, a route DTO
//! or a status struct can reach returns private key material.
//!
//! Two kinds of check, because either alone is weak. The **source** checks
//! read the files that make up the lifecycle's public surface and assert that
//! only the two functions allowed to touch a sealed key name it, and that no
//! route hands one out. The **value** checks render every status and outcome
//! type's `Debug` and serialization and look for key bytes.

use std::sync::Arc;

use chrono::Utc;
use opensesame_domain::transport::IdentitySourceKind;
use opensesame_transport_security::testkit::DisposableCa;

use crate::transport_lifecycle::test_support as support;

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/transport_lifecycle");

fn read(name: &str) -> String {
    std::fs::read_to_string(format!("{DIR}/{name}")).unwrap_or_else(|e| panic!("{name}: {e}"))
}

#[test]
fn only_the_custody_module_opens_a_sealed_managed_key() {
    // `open_scoped` with the managed-leaf scope appears in exactly one place
    // in the gateway's TLS path: `managed_certs_tls::tls_identity_for`, which
    // returns a TlsIdentity. Everything else goes through it.
    let tls = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/managed_certs_tls.rs"
    ))
    .expect("managed_certs_tls.rs");
    assert_eq!(
        tls.matches("open_scoped(").count(),
        1,
        "the TLS custody seam opens the sealed blob exactly once",
    );
    for name in [
        "routes.rs",
        "custody.rs",
        "activation.rs",
        "renewal.rs",
        "revocation.rs",
        "trust.rs",
        "issuance.rs",
        "facts.rs",
        "crl.rs",
        "minting.rs",
    ] {
        let source = read(name);
        assert!(
            !source.contains("open_scoped("),
            "{name} must not open a sealed key itself",
        );
    }
}

#[test]
fn no_lifecycle_route_reaches_the_human_only_reveal() {
    let routes = read("routes.rs");
    assert!(
        !routes.contains("reveal_managed_key"),
        "the operator transport routes must not expose the human-only reveal",
    );
    assert!(
        !routes.contains("private_key"),
        "no route body names a private key field",
    );
    assert!(
        !routes.contains("tls_identity_for"),
        "a route never resolves an identity for a caller",
    );
}

#[test]
fn every_public_dto_in_this_module_is_strict_about_unknown_fields() {
    for name in [
        "issuance.rs",
        "revocation.rs",
        "trust.rs",
        "facts.rs",
        "crl.rs",
    ] {
        let source = read(name);
        let derives = source.matches("Deserialize").count();
        let strict = source.matches("deny_unknown_fields").count();
        assert!(
            strict > 0 && strict >= derives.saturating_sub(strict),
            "{name}: {derives} Deserialize mentions but only {strict} deny_unknown_fields",
        );
    }
}

#[test]
fn the_issuance_response_carries_public_material_and_no_key_field() {
    let issuance = read("issuance.rs");
    let view = issuance
        .split("pub struct TransportIssuance {")
        .nth(1)
        .expect("TransportIssuance struct")
        .split("\n}")
        .next()
        .expect("struct body");
    for forbidden in ["private_key", "key_pem", "secret", "sealed"] {
        assert!(
            !view.contains(forbidden),
            "TransportIssuance must not carry `{forbidden}`:\n{view}",
        );
    }
    assert!(view.contains("certificate_pem"));
    assert!(view.contains("issuer_pem"));
}

#[tokio::test]
async fn no_status_struct_renders_key_material_in_debug_or_json() {
    let state = support::state().await;
    let ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let leaf = ca.issue_server("localhost");
    let key_pem = String::from_utf8(
        // The testkit hands the key out for exactly this: to prove none of
        // these bytes appear anywhere a caller can see.
        {
            use secrecy::ExposeSecret;
            leaf.key_secret().expose_secret().clone()
        },
    )
    .expect("key pem");
    let needle = key_pem
        .lines()
        .find(|line| !line.starts_with("---") && line.len() > 20)
        .expect("a body line of the key")
        .to_owned();

    let generations = support::generations(leaf.identity(), &client_ca);
    let credential = crate::transport_lifecycle::activation::credential_status(
        &generations,
        IdentitySourceKind::ManagedCertificate,
        &state.transport_lifecycle,
    );
    let revocation = crate::transport_lifecycle::crl::status(&state, Utc::now());
    let lifecycle = format!("{:?}", state.transport_lifecycle);
    let identity = Arc::new(leaf.identity());

    for rendered in [
        format!("{credential:?}"),
        serde_json::to_string(&credential).expect("credential json"),
        format!("{revocation:?}"),
        serde_json::to_string(&revocation).expect("revocation json"),
        lifecycle,
        format!("{identity:?}"),
    ] {
        assert!(!rendered.contains(&needle), "key bytes leaked: {rendered}");
        assert!(!rendered.contains("PRIVATE KEY"), "{rendered}");
    }
}

#[tokio::test]
async fn the_lifecycle_handle_itself_says_nothing_about_what_it_holds() {
    let state = support::state().await;
    let rendered = format!("{:?}", state.transport_lifecycle);
    assert!(rendered.starts_with("LifecycleState"));
    for forbidden in ["PRIVATE", "BEGIN", "ciphertext", "nonce"] {
        assert!(!rendered.contains(forbidden), "{rendered}");
    }
}
