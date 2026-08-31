//! Egress allowlist for broker-side rotation verification (ADR 0073).
//!
//! **This is deliberately a second table, not an addition to the daemon's.**
//! `opensesame_invoke_through::EGRESS_RULES` is a static that `apps/daemon`
//! links and serves from `POST /v1/invoke_through`; adding providers to it to
//! satisfy the gateway would silently widen the daemon's egress surface for
//! callers that never asked for it. ADR 0052 §7 states the rule directly —
//! consume-clients "do not widen `EGRESS_RULES`" — so the broker passes its own
//! rules through the `Invoker::with_rules` seam the crate already provides.
//!
//! The table is a compile-time constant rather than something derived from
//! catalog data at runtime: an egress allowlist assembled from mutable input is
//! only as trustworthy as that input. A drift test below reads the catalog and
//! fails if the two disagree, which keeps the constant honest without letting
//! data decide what the fence permits.
//!
//! Only providers that carry a `verify` block in the catalog appear here. A
//! provider with no verify endpoint needs no egress row, and must not get one.

use opensesame_invoke_through::{AuthStyle, EgressRule};

/// Hosts the broker may reach while verifying a rotated credential.
///
/// Every row is `https`, exact-host, `Bearer`. Host matching in
/// `invoke-through` is exact and case-insensitive with no wildcards, so
/// `api.github.com.evil.test` never matches `api.github.com`.
pub static ROTATION_EGRESS_RULES: &[EgressRule] = &[
    EgressRule {
        provider_id: "github",
        scheme: "https",
        hosts: &["api.github.com"],
        auth: AuthStyle::Bearer,
    },
    EgressRule {
        provider_id: "gitlab",
        scheme: "https",
        hosts: &["gitlab.com"],
        auth: AuthStyle::Bearer,
    },
    EgressRule {
        provider_id: "stripe",
        scheme: "https",
        hosts: &["api.stripe.com"],
        auth: AuthStyle::Bearer,
    },
    EgressRule {
        provider_id: "openai",
        scheme: "https",
        hosts: &["api.openai.com"],
        auth: AuthStyle::Bearer,
    },
    EgressRule {
        provider_id: "cloudflare",
        scheme: "https",
        hosts: &["api.cloudflare.com"],
        auth: AuthStyle::Bearer,
    },
    EgressRule {
        provider_id: "vercel",
        scheme: "https",
        hosts: &["api.vercel.com"],
        auth: AuthStyle::Bearer,
    },
    EgressRule {
        provider_id: "digitalocean",
        scheme: "https",
        hosts: &["api.digitalocean.com"],
        auth: AuthStyle::Bearer,
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> serde_json::Value {
        serde_json::from_str(include_str!("catalog.json")).expect("catalog parses")
    }

    /// Every rule must name exactly the hosts its provider's catalog egress
    /// names, and the provider must actually have a verify endpoint. A rule
    /// without a verify block would be an egress permission with no user.
    #[test]
    fn rotation_rules_track_the_catalog() {
        let catalog = catalog();
        let providers = catalog["providers"].as_array().expect("providers");
        for rule in ROTATION_EGRESS_RULES {
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
            assert!(
                entry.get("verify").is_some(),
                "{}: has an egress rule but no verify endpoint to use it",
                rule.provider_id
            );
            let catalog_hosts: Vec<&str> = entry["egress"]["authorities"]
                .as_array()
                .expect("authorities")
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect();
            assert_eq!(
                catalog_hosts, rule.hosts,
                "{}: host drift between catalog and rotation egress table",
                rule.provider_id
            );
        }
    }

    /// The inverse: a catalog `verify` block with no egress row would fail at
    /// runtime with a denial rather than a verification, which is a silent
    /// downgrade to `verify_skipped`.
    #[test]
    fn every_verify_provider_has_a_rotation_rule() {
        let catalog = catalog();
        for provider in catalog["providers"].as_array().expect("providers") {
            if provider.get("verify").is_none() {
                continue;
            }
            let id = provider["id"].as_str().expect("id");
            assert!(
                ROTATION_EGRESS_RULES.iter().any(|r| r.provider_id == id),
                "{id}: catalog declares verify but no rotation egress rule permits it"
            );
        }
    }

    /// The daemon's own allowlist must not grow just because the broker's did.
    /// Widening `EGRESS_RULES` would extend `POST /v1/invoke_through` on every
    /// machine running the daemon (ADR 0048 D6, ADR 0052 §7).
    #[test]
    fn the_daemon_allowlist_is_untouched() {
        let served: Vec<&str> = opensesame_invoke_through::EGRESS_RULES
            .iter()
            .map(|rule| rule.provider_id)
            .collect();
        assert_eq!(
            served,
            vec!["github"],
            "the daemon's invoke-through allowlist must stay github-only; \
             broker rotation uses ROTATION_EGRESS_RULES instead"
        );
    }

    #[test]
    fn every_rule_is_https_and_bearer() {
        for rule in ROTATION_EGRESS_RULES {
            assert_eq!(rule.scheme, "https", "{}", rule.provider_id);
            assert_eq!(rule.auth, AuthStyle::Bearer, "{}", rule.provider_id);
            assert!(!rule.hosts.is_empty(), "{}", rule.provider_id);
        }
    }
}
