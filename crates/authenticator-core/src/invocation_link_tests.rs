use super::{
    require_fresh_user_verification, validate_platform_invocation, AuthenticatorError,
    InvocationKind, InvocationPayload, InvocationPolicy, UserVerification, UserVerificationMethod,
};

fn policy() -> InvocationPolicy {
    InvocationPolicy::new("https://auth.opensesame.example").unwrap()
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
