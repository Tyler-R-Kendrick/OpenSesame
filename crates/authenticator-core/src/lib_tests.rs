use super::*;

fn policy() -> InvocationPolicy {
    InvocationPolicy::new("https://auth.opensesame.example").unwrap()
}

#[test]
fn accepts_only_verified_secret_free_links() {
    let request = policy()
        .validate_link("https://auth.opensesame.example/invoke/mfa?request_id=req_123")
        .unwrap();
    assert_eq!(request.kind, InvocationKind::MfaApproval);
    assert_eq!(
        request.payload,
        InvocationPayload::RequestId("req_123".into())
    );

    assert_eq!(
        policy().validate_link("https://evil.example/invoke/mfa?request_id=req_123"),
        Err(AuthenticatorError::UnverifiedInvocationOrigin)
    );
    assert_eq!(
        policy().validate_link("https://auth.opensesame.example/invoke/oid4vp?request_id=req_123"),
        Err(AuthenticatorError::InvalidInvocationPayload)
    );
    assert_eq!(
        policy().validate_link(
            "https://auth.opensesame.example/invoke/oid4vci?credential_offer=secret"
        ),
        Err(AuthenticatorError::ForbiddenInvocationParameter)
    );
}

#[test]
fn validates_by_reference_protocol_requests() {
    let request = policy()
        .validate_link(
            "https://auth.opensesame.example/invoke/oid4vci?request_uri=https%3A%2F%2Fissuer.example%2Foffer%2Fabc",
        )
        .unwrap();
    assert!(matches!(request.payload, InvocationPayload::RequestUri(_)));
    assert_eq!(
        policy().validate_link(
            "https://auth.opensesame.example/invoke/oid4vp?request_uri=http%3A%2F%2Fverifier.example%2Frequest"
        ),
        Err(AuthenticatorError::InsecureRequestUri)
    );
    assert_eq!(
        policy().validate_link(
            "https://auth.opensesame.example/invoke/oid4vp?request_uri=https%3A%2F%2F127.0.0.1%2Frequest"
        ),
        Err(AuthenticatorError::PrivateRequestUri)
    );
}

#[test]
fn custom_scheme_offers_require_a_public_by_reference_uri() {
    let policy = policy();
    let ok = "openid-credential-offer://?credential_offer_uri=https%3A%2F%2Fissuer.example%2Foffer";
    assert_eq!(policy.validate_credential_offer_scheme(ok).unwrap(), ok);
    assert_eq!(
        policy.validate_credential_offer_scheme(
            "openid-credential-offer://?credential_offer=https%3A%2F%2Fissuer.example%2Foffer"
        ),
        Err(AuthenticatorError::ForbiddenInvocationParameter)
    );
    assert_eq!(
        policy.validate_credential_offer_scheme(
            "openid-credential-offer://?credential_offer_uri=https%3A%2F%2F127.0.0.1%2Foffer"
        ),
        Err(AuthenticatorError::PrivateRequestUri)
    );
}

#[test]
fn custom_scheme_presentment_requires_a_public_request_uri() {
    let policy = policy();
    let ok = "openid4vp://?request_uri=https%3A%2F%2Fverifier.example%2Frequest";
    assert_eq!(policy.validate_presentation_scheme(ok).unwrap(), ok);
    assert_eq!(
        policy.validate_presentation_scheme("openid4vp://?request_id=req_123"),
        Err(AuthenticatorError::ForbiddenInvocationParameter)
    );
}

#[test]
fn rejects_ssrf_literal_and_localhost_forms() {
    for request_uri in [
        "https://localhost./request",
        "https://service.localhost/request",
        "https://2130706433/request",
        "https://[::1]/request",
        "https://[fe80::1]/request",
        "https://224.0.0.1/request",
    ] {
        let link = format!(
            "https://auth.opensesame.example/invoke/oid4vp?request_uri={}",
            url::form_urlencoded::byte_serialize(request_uri.as_bytes()).collect::<String>()
        );
        assert_eq!(
            policy().validate_link(&link),
            Err(AuthenticatorError::PrivateRequestUri),
            "accepted {request_uri}"
        );
    }
}

#[test]
fn rejects_ipv4_mapped_private_request_uris() {
    for request_uri in [
        "https://[::ffff:127.0.0.1]/request",
        "https://[::ffff:169.254.169.254]/latest",
        "https://[::ffff:10.1.2.3]/x",
        "https://[::ffff:192.168.0.1]/x",
    ] {
        let link = format!(
            "https://auth.opensesame.example/invoke/oid4vp?request_uri={}",
            url::form_urlencoded::byte_serialize(request_uri.as_bytes()).collect::<String>()
        );
        assert_eq!(
            policy().validate_link(&link),
            Err(AuthenticatorError::PrivateRequestUri),
            "accepted {request_uri}"
        );
    }
    policy()
        .validate_link(
            "https://auth.opensesame.example/invoke/oid4vp?request_uri=https%3A%2F%2Fverifier.example%2Frequest",
        )
        .unwrap();
}

#[test]
fn rejects_ambiguous_invocation_parameters() {
    for link in [
        "https://auth.opensesame.example/invoke/oid4vp?request_uri=https%3A%2F%2Fverifier.example%2Fa&request_uri=https%3A%2F%2Fverifier.example%2Fb",
        "https://auth.opensesame.example/invoke/oid4vp?request_uri=https%3A%2F%2Fverifier.example%2Fa&extra=1",
        "https://auth.opensesame.example/invoke/oid4vp?request_uri=https%3A%2F%2Fuser%3Apass%40verifier.example%2Fa",
        "https://auth.opensesame.example/invoke/oid4vp?request_uri=https%3A%2F%2Fverifier.example%2Fa%23fragment",
    ] {
        assert!(policy().validate_link(link).is_err(), "accepted {link}");
    }
}

#[test]
fn requires_fresh_verification_for_each_request() {
    let verification = UserVerification {
        device_id: "device-a".into(),
        verified_at_unix: 1_000,
        method: UserVerificationMethod::Biometric,
    };
    assert_eq!(
        require_fresh_user_verification(Some(&verification), "device-a", 1_030),
        Ok(())
    );
    assert_eq!(
        require_fresh_user_verification(Some(&verification), "device-a", 1_031),
        Err(AuthenticatorError::UserVerificationRequired)
    );
    assert_eq!(
        require_fresh_user_verification(Some(&verification), "device-b", 1_001),
        Err(AuthenticatorError::WrongDevice)
    );
    assert_eq!(
        require_fresh_user_verification(None, "device-a", 1_001),
        Err(AuthenticatorError::UserVerificationRequired)
    );
}

#[test]
fn platform_api_returns_only_validated_protocol_requests() {
    let invocation = validate_platform_invocation(
        "https://auth.opensesame.example".into(),
        "https://auth.opensesame.example/invoke/oid4vp?request_uri=https%3A%2F%2Fverifier.example%2Frequest".into(),
    )
    .unwrap();
    assert_eq!(invocation.kind, InvocationKind::Oid4vp);
    assert_eq!(invocation.payload, "https://verifier.example/request");
    assert_eq!(
        invocation.protocol_uri,
        "openid4vp://?request_uri=https%3A%2F%2Fverifier.example%2Frequest"
    );
}
