//! The request-header fence per provider: a documented request parameter one
//! provider's SDKs send reaches that provider and no other, and nothing a
//! provider may add names a credential, a session or a content encoding the
//! reflection scrub could not read.

use super::*;
use crate::egress::AuthStyle;

fn fence() -> EgressFence {
    EgressFence::new(
        vec![
            EgressRule {
                provider_id: "github",
                scheme: "https",
                hosts: &["api.github.com"],
                auth: AuthStyle::Bearer,
            },
            EgressRule {
                provider_id: "other",
                scheme: "https",
                hosts: &["api.other.test"],
                auth: AuthStyle::Bearer,
            },
        ],
        1024,
    )
}

fn request(provider: &str, host: &str, header: &str) -> InvokeRequest {
    InvokeRequest {
        provider_id: provider.into(),
        method: "GET".into(),
        url: format!("https://{host}/"),
        headers: vec![(header.into(), "2022-11-28".into())],
        body: None,
        subject: None,
        actor: None,
    }
}

#[test]
fn a_provider_parameter_header_reaches_only_its_own_provider() {
    let fence = fence();
    fence
        .preflight(request("github", "api.github.com", "X-GitHub-Api-Version"))
        .expect("github's own version header passes");
    let err = fence
        .preflight(request("other", "api.other.test", "x-github-api-version"))
        .expect_err("another provider never receives it");
    assert!(matches!(err, InvokeError::HeaderNotAllowed(_)));
}

#[test]
fn no_provider_parameter_names_a_credential_a_session_or_an_encoding() {
    for provider in ["github", "other", "unknown"] {
        for banned in [
            "authorization",
            "proxy-authorization",
            "cookie",
            "x-api-key",
            "accept-encoding",
            "host",
        ] {
            assert!(
                !forwardable_request_header(provider, banned),
                "{provider}: {banned}"
            );
        }
    }
    assert!(forwardable_request_header("unknown", "Accept"));
}
