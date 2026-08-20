//! Static egress allowlist for invoke-through (ADR 0032 §3, ADR 0048 D6/I8).
//!
//! **Derived from `crates/connection-broker/src/catalog.json`, not linked from
//! it.** The daemon must not link the broker (ADR 0048 D5 — dependency
//! quarantine), so the rows invoke-through serves are restated here as a
//! minimal static table, one row per provider. A drift test below reads the
//! catalog *file at compile time* (never the broker crate) and fails if this
//! table and the catalog disagree for a served provider.
//!
//! v1 serves `github` only. The catalog's `aws`/`gcp` entries carry
//! `scheme: none` — they have no HTTPS API egress row to derive — so their
//! rows are authored together with their `TokenSource` adapters when those
//! providers graduate (aws mint is a 422 follow-up in v1, ADR 0049).

/// How the acquired credential is presented upstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthStyle {
    /// `Authorization: Bearer <token>` — the only style in v1.
    Bearer,
}

/// One provider's egress rule: exact hosts, one scheme, one auth style.
/// Host matching is *exact* (case-insensitive) — no suffix or wildcard
/// matching, so `api.github.com.evil.test` never passes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EgressRule {
    pub provider_id: &'static str,
    pub scheme: &'static str,
    pub hosts: &'static [&'static str],
    pub auth: AuthStyle,
}

/// The catalog restated for the providers invoke-through serves.
///
/// `uploads.github.com` is GitHub's documented upload host (release assets,
/// LFS) alongside the catalog's `api.github.com`; it is the single documented
/// addition beyond the catalog row, kept here so release-asset uploads work
/// through the same fence.
pub static EGRESS_RULES: &[EgressRule] = &[EgressRule {
    provider_id: "github",
    scheme: "https",
    hosts: &["api.github.com", "uploads.github.com"],
    auth: AuthStyle::Bearer,
}];

pub fn rule_for<'a>(rules: &'a [EgressRule], provider_id: &str) -> Option<&'a EgressRule> {
    rules.iter().find(|rule| rule.provider_id == provider_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table must track the catalog for every provider it serves. Reads
    /// the catalog JSON at compile time — a file, not the broker crate, so
    /// the daemon's dependency quarantine (ADR 0048 D5) is untouched.
    #[test]
    fn egress_table_tracks_the_broker_catalog() {
        let catalog: serde_json::Value =
            serde_json::from_str(include_str!("../../connection-broker/src/catalog.json"))
                .expect("catalog parses");
        let providers = catalog["providers"].as_array().expect("providers");
        for rule in EGRESS_RULES {
            let entry = providers
                .iter()
                .find(|p| p["id"].as_str() == Some(rule.provider_id))
                .unwrap_or_else(|| panic!("{} must exist in the catalog", rule.provider_id));
            assert_eq!(
                entry["egress"]["scheme"].as_str(),
                Some(rule.scheme),
                "{}: scheme drift",
                rule.provider_id
            );
            let catalog_hosts: Vec<&str> = entry["egress"]["authorities"]
                .as_array()
                .expect("authorities")
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect();
            // Every catalog authority must be served; additions beyond the
            // catalog (uploads.github.com) are documented at the table.
            for host in &catalog_hosts {
                assert!(
                    rule.hosts.contains(host),
                    "{}: catalog host {host} missing from the static table",
                    rule.provider_id
                );
            }
        }
    }

    #[test]
    fn host_matching_is_exact() {
        let rule = rule_for(EGRESS_RULES, "github").expect("github rule");
        assert!(rule.hosts.contains(&"api.github.com"));
        assert!(!rule.hosts.contains(&"api.github.com.evil.test"));
        assert!(!rule.hosts.contains(&"github.com"));
        assert!(rule_for(EGRESS_RULES, "aws").is_none());
    }
}
