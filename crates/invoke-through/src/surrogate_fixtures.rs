//! Shared fixtures for the surrogate suites.

use super::*;
use crate::egress::{AuthStyle, EgressRule};

pub(super) const NOW: u64 = 1_000;
pub(super) const CALLER: &str = "run-a:pid-41";

pub(super) fn rules() -> Vec<EgressRule> {
    vec![EgressRule {
        provider_id: "github",
        scheme: "https",
        hosts: &["api.github.com", "uploads.github.com"],
        auth: AuthStyle::Bearer,
    }]
}

pub(super) fn spec(run: &str, caller: &str) -> SurrogateSpec {
    SurrogateSpec {
        provider_id: "github".into(),
        connection_ref: "conn://acme/gh".into(),
        run_id: run.into(),
        caller: caller.into(),
        site: SurrogateSite::Authorization,
        methods: vec!["GET".into(), "POST".into()],
        path_prefixes: vec!["/".into()],
        expires_at_unix: NOW + 600,
    }
}

pub(super) fn ledger_with(entropy: u8) -> (SurrogateLedger, String) {
    let mut ledger = SurrogateLedger::new(rules());
    let surrogate = ledger
        .issue(spec("run-a", CALLER), [entropy; 16])
        .expect("issued");
    (ledger, surrogate.as_str().to_string())
}

pub(super) fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(n, v)| ((*n).to_string(), (*v).to_string()))
        .collect()
}

pub(super) fn view<'a>(
    host: &'a str,
    path: &'a str,
    headers: &'a [(String, String)],
    body: &'a [u8],
) -> RequestView<'a> {
    RequestView {
        method: "GET",
        scheme: "https",
        host,
        port: None,
        path_and_query: path,
        headers,
        body,
    }
}

pub(super) fn refused(ledger: &SurrogateLedger, req: &RequestView<'_>, caller: &str) -> Refusal {
    ledger.admit(req, caller, NOW).expect_err("must be refused")
}
