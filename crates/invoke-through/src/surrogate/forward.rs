//! From an admitted request to the brokered call it stands for.
//!
//! Admission has already removed the surrogate's header. What is left is the
//! client's own request, and only part of it may travel: the headers the
//! provider's fence admits ([`forwardable_request_header`]), the method, the
//! path and query, and the body. Everything else an SDK sends — its encoding
//! preferences, connection management, cookies, telemetry — is dropped here
//! rather than refused later, so an unmodified client works and nothing it
//! chose reaches the upstream beside the credential the broker places.

use bytes::Bytes;

use super::{Admission, RequestView};
use crate::fence::forwardable_request_header;
use crate::invoke::InvokeRequest;

impl Admission {
    /// The invoke-through call for `req`, which this admission was decided
    /// on. The URL is the request's own host and target on its own scheme;
    /// admission has already proven the host is on the provider's rule, the
    /// port is the default and the scheme is the rule's.
    #[must_use]
    pub fn invoke_request(&self, req: &RequestView<'_>) -> InvokeRequest {
        let headers = self
            .forward_headers
            .iter()
            .filter(|(name, _)| forwardable_request_header(&self.provider_id, name))
            .cloned()
            .collect();
        InvokeRequest {
            provider_id: self.provider_id.clone(),
            method: req.method.to_ascii_uppercase(),
            url: format!(
                "{}://{}{}",
                req.scheme.to_ascii_lowercase(),
                req.host.to_ascii_lowercase(),
                req.path_and_query
            ),
            headers,
            body: (!req.body.is_empty()).then(|| Bytes::copy_from_slice(req.body)),
            subject: None,
            actor: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::*;
    use crate::Invoker;

    fn sdk_headers(s: &str) -> Vec<(String, String)> {
        headers(&[
            ("Authorization", &format!("Bearer {s}")),
            ("Accept", "application/vnd.github+json"),
            ("X-GitHub-Api-Version", "2022-11-28"),
            ("Accept-Encoding", "gzip, br"),
            ("Cookie", "session=planted"),
            ("Connection", "keep-alive"),
            ("Host", "api.github.com"),
            ("Content-Length", "2"),
        ])
    }

    #[test]
    fn an_admitted_request_forwards_only_what_the_provider_fence_admits() {
        let (ledger, s) = ledger_with(0x5a);
        let h = sdk_headers(&s);
        let mut req = view("API.github.com", "/repos/acme/x?page=2", &h, b"{}");
        req.method = "post";
        let admission = ledger.admit(&req, CALLER, NOW).unwrap().unwrap();
        let call = admission.invoke_request(&req);
        assert_eq!(call.provider_id, "github");
        assert_eq!(call.method, "POST");
        assert_eq!(call.url, "https://api.github.com/repos/acme/x?page=2");
        assert_eq!(
            call.headers,
            headers(&[
                ("Accept", "application/vnd.github+json"),
                ("X-GitHub-Api-Version", "2022-11-28"),
            ])
        );
        assert_eq!(call.body.as_deref(), Some(&b"{}"[..]));
        assert!(!format!("{:?} {}", call.headers, call.url).contains(&s));
    }

    #[test]
    fn the_forwarded_call_clears_the_invokers_own_fence() {
        let (ledger, s) = ledger_with(0x5b);
        let h = sdk_headers(&s);
        let req = view("api.github.com", "/user", &h, b"");
        let admission = ledger.admit(&req, CALLER, NOW).unwrap().unwrap();
        let call = admission.invoke_request(&req);
        assert!(call.body.is_none());
        Invoker::with_rules(rules())
            .preflight(call)
            .expect("an admitted request is a valid brokered call");
    }
}
