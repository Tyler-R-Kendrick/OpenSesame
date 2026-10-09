use super::{AuthenticatorError, InvocationPolicy};

fn policy() -> InvocationPolicy {
    InvocationPolicy::new("https://auth.opensesame.example").unwrap()
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
