//! Unit tests for [`crate::managed_certs`] (ADR 0075).
//!
//! A sibling file so the module itself stays inside its recorded size budget
//! after the transport seam (`issue_managed_material`) was added.

use super::*;

fn certificate(not_before: &str, expires_at: &str) -> StoredManagedCertificate {
    StoredManagedCertificate {
        id: "certificate:1".into(),
        organization_id: "org:1".into(),
        authority_id: "ca:1".into(),
        request_id: "request:1".into(),
        certificate_digest: "sha256:x".into(),
        serial_number: "01".into(),
        common_name: "api.example".into(),
        san_json: r#"{"dns_names":["api.example","alt.example"],"ip_addrs":["10.0.0.1"]}"#.into(),
        not_before: not_before.into(),
        expires_at: expires_at.into(),
        status: "active".into(),
        application_id: None,
        profile_id: None,
        source: "issued".into(),
        enrollment_method: Some("api".into()),
        metadata_json: "{}".into(),
        key_algorithm: None,
        signature_algorithm: None,
        fingerprint_sha256: None,
        chain_pem: None,
        renewed_from_id: None,
        renewed_by_id: None,
        auto_renew_enabled: true,
        renew_before_seconds: Some(86_400),
        revocation_reason: None,
        revoked_at: None,
        version: 1,
        created_at: "2026-08-01T00:00:00+00:00".into(),
        updated_at: "2026-08-01T00:00:00+00:00".into(),
    }
}

#[test]
fn a_renewal_inherits_the_span_it_replaces() {
    let previous = certificate("2026-08-01T00:00:00+00:00", "2026-08-31T00:00:00+00:00");
    assert_eq!(inherited_ttl(&previous).as_secs(), 30 * 86_400);
}

#[test]
fn an_unreadable_span_falls_back_rather_than_minting_a_zero_life_certificate() {
    for (from, to) in [
        ("not a time", "2026-08-31T00:00:00+00:00"),
        ("2026-08-01T00:00:00+00:00", "not a time"),
        // A backwards or zero-length span would otherwise produce a
        // certificate that is expired the moment it is signed.
        ("2026-08-31T00:00:00+00:00", "2026-08-01T00:00:00+00:00"),
        ("2026-08-01T00:00:00+00:00", "2026-08-01T00:00:00+00:00"),
    ] {
        assert_eq!(
            inherited_ttl(&certificate(from, to)),
            dev_pki::DEFAULT_TTL,
            "{from} -> {to}",
        );
    }
}

#[test]
fn sans_round_trip_through_the_stored_document() {
    let previous = certificate("2026-08-01T00:00:00+00:00", "2026-08-31T00:00:00+00:00");
    assert_eq!(
        san_names(&previous.san_json),
        ["api.example", "alt.example"]
    );
    assert_eq!(
        san_ips(&previous.san_json),
        vec!["10.0.0.1".parse::<std::net::IpAddr>().unwrap()],
    );
}

#[test]
fn a_malformed_san_document_yields_no_names_rather_than_a_panic() {
    assert!(san_names("not json").is_empty());
    assert!(san_ips("not json").is_empty());
    assert!(san_names(r#"{"dns_names":"not-an-array"}"#).is_empty());
    assert!(san_ips(r#"{"ip_addrs":["not-an-ip"]}"#).is_empty());
}

#[test]
fn custody_errors_carry_a_stable_code_and_status() {
    for (error, code, status) in [
        (CustodyError::NotInCustody, "not_in_custody", 409),
        (CustodyError::NotFound, "not_found", 404),
        (CustodyError::NotActive, "certificate_not_active", 409),
        (
            CustodyError::SealingUnavailable,
            "certificate_key_protection_unavailable",
            503,
        ),
        (CustodyError::Mint("bad cn".into()), "invalid_request", 400),
        (
            CustodyError::PurposeMismatch,
            "certificate_purpose_mismatch",
            409,
        ),
        (CustodyError::LeafNotRetained, "leaf_not_retained", 409),
    ] {
        assert_eq!(error.code(), code);
        assert_eq!(error.http_status(), status);
    }
}

#[test]
fn the_renewal_lead_is_clamped_away_from_the_scanner_tick() {
    // A lead shorter than a tick makes the renewal rung a coin flip.
    let day = 86_400;
    assert_eq!(
        converging_renew_before(60, day).unwrap(),
        MIN_RENEW_BEFORE_SECONDS
    );
}

#[test]
fn a_lead_can_never_reach_the_lifetime_it_sits_inside() {
    // The loop this prevents: a lead >= the lifetime makes every successor
    // due the moment it is signed, so the responder reissues every tick.
    for lifetime in [MIN_MANAGED_LIFETIME_SECONDS, 86_400, 90 * 86_400] {
        let lead = converging_renew_before(lifetime * 10, lifetime).unwrap();
        assert!(
            lead <= lifetime / 2,
            "lead {lead} must leave room inside {lifetime}",
        );
        assert!(
            lifetime - lead >= lead,
            "a successor must spend at least as long outside the window as inside it",
        );
    }
}

#[test]
fn a_lifetime_with_no_room_for_a_window_is_refused() {
    for lifetime in [0, 60, MIN_MANAGED_LIFETIME_SECONDS - 1] {
        let refused = converging_renew_before(MIN_RENEW_BEFORE_SECONDS, lifetime);
        assert!(
            matches!(refused, Err(CustodyError::LifetimeTooShort)),
            "{lifetime}"
        );
    }
    assert!(converging_renew_before(MIN_RENEW_BEFORE_SECONDS, MIN_MANAGED_LIFETIME_SECONDS).is_ok());
}

#[test]
fn a_requested_lead_inside_the_ceiling_is_honoured() {
    assert_eq!(
        converging_renew_before(6 * 3_600, 86_400).unwrap(),
        6 * 3_600
    );
}

#[test]
fn transport_metadata_is_read_back_from_the_certificate_row() {
    let mut row = certificate("2026-08-01T00:00:00+00:00", "2026-08-31T00:00:00+00:00");
    assert!(transport_metadata(&row).is_none());
    row.metadata_json = r#"{"transport":{"purpose":"listener"}}"#.into();
    assert_eq!(
        transport_metadata(&row).and_then(|t| t.get("purpose").cloned()),
        Some(serde_json::json!("listener"))
    );
}
