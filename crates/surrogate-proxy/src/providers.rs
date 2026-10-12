//! The providers this plugin brokers: its own egress table.
//!
//! **A second table, deliberately.** `opensesame_invoke_through::EGRESS_RULES`
//! is the one the daemon links and serves from `POST /v1/invoke_through`, and
//! it stays `github` only (ADR 0052 §7: consume-clients do not widen it;
//! `crates/connection-broker`'s `the_daemon_allowlist_is_untouched` fails on
//! a new row). A provider whose credential is not drawn from a local CLI tool
//! belongs here instead: the plugin is optional, installed by a person and
//! off until switched on, so a row in this table widens nothing for a machine
//! that never installed it. The table is handed to the broker through the
//! `Invoker::with_rules` seam the crate already provides, and the surrogate
//! ledger is built from the invoker's own rules, so admission and the fence
//! cannot disagree about a provider's hosts.
//!
//! Each added row restates `spec/connectors/catalog.json` (ADR 0139). The
//! tests below read the catalog file at compile time and fail if a row drifts
//! from it: the catalog says the provider, the host and how a credential is
//! presented; this table only decides that this plugin may broker it.

use opensesame_invoke_through::{rule_for, AuthStyle, EgressRule, EGRESS_RULES};

/// Providers served beyond invoke-through's shared table. Their credential is
/// a connection's own: the parent reads it from the person's sealed store and
/// sends it in the run spec (`plugin::wire::CredentialSpec`).
pub static CONNECTION_RULES: &[EgressRule] = &[EgressRule {
    provider_id: "vercel",
    scheme: "https",
    hosts: &["api.vercel.com"],
    auth: AuthStyle::Bearer,
}];

/// Every rule the plugin's broker enforces: the shared table, then
/// [`CONNECTION_RULES`].
#[must_use]
pub fn rules() -> Vec<EgressRule> {
    EGRESS_RULES
        .iter()
        .chain(CONNECTION_RULES)
        .copied()
        .collect()
}

/// Whether the plugin has an egress rule for `provider_id`.
#[must_use]
pub fn has_rule(provider_id: &str) -> bool {
    rule_for(EGRESS_RULES, provider_id)
        .or_else(|| rule_for(CONNECTION_RULES, provider_id))
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../spec/connectors/catalog.json"))
            .expect("catalog parses")
    }

    #[test]
    fn every_added_row_tracks_the_catalog() {
        let catalog = catalog();
        let providers = catalog["providers"].as_array().expect("providers");
        for rule in CONNECTION_RULES {
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
            let hosts: Vec<&str> = entry["egress"]["authorities"]
                .as_array()
                .expect("authorities")
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect();
            assert_eq!(hosts, rule.hosts, "{}: host drift", rule.provider_id);
            // The invoker places `Authorization: Bearer <token>`; the
            // catalog must say that is how this provider is presented.
            assert_eq!(rule.auth, AuthStyle::Bearer);
            assert_eq!(entry["auth"]["kind"], "api_key", "{}", rule.provider_id);
            assert_eq!(
                entry["auth"]["header"], "Authorization",
                "{}",
                rule.provider_id
            );
            assert_eq!(
                entry["auth"]["value_prefix"], "Bearer ",
                "{}",
                rule.provider_id
            );
        }
    }

    /// The command line links no plugin, so what it reads from the sealed store
    /// is the plugin catalog's list (`spec/plugins/catalog.json`); this table
    /// is what the broker admits. They must be the same providers, or the CLI
    /// reads a token for a provider nothing serves, or serves one it never
    /// reads a token for (ADR 0139).
    #[test]
    fn the_providers_taking_a_stored_credential_are_the_catalogs() {
        use std::collections::BTreeSet;

        let row = opensesame_plugin_settings::catalog()
            .into_iter()
            .find(|plugin| plugin.id == "surrogate-proxy")
            .expect("the catalog row");
        let listed: BTreeSet<&str> = row
            .stored_credential_providers
            .iter()
            .map(String::as_str)
            .collect();
        let brokered: BTreeSet<&str> = CONNECTION_RULES
            .iter()
            .map(|rule| rule.provider_id)
            .collect();
        assert_eq!(listed, brokered);
        for provider in &brokered {
            assert!(opensesame_plugin_settings::takes_stored_credential(
                "surrogate-proxy",
                provider
            ));
        }
    }

    #[test]
    fn the_shared_table_is_not_widened_for_the_plugin() {
        for rule in CONNECTION_RULES {
            assert!(
                rule_for(EGRESS_RULES, rule.provider_id).is_none(),
                "{} is in invoke-through's shared table, which the daemon serves",
                rule.provider_id
            );
        }
        let ids: Vec<&str> = rules().iter().map(|rule| rule.provider_id).collect();
        assert_eq!(ids, vec!["github", "vercel"]);
    }

    #[test]
    fn a_host_is_matched_exactly() {
        let rule = rule_for(CONNECTION_RULES, "vercel").expect("vercel rule");
        assert!(rule.hosts.contains(&"api.vercel.com"));
        assert!(!rule.hosts.contains(&"api.vercel.com.evil.test"));
        assert!(!rule.hosts.contains(&"vercel.com"));
        assert!(has_rule("vercel") && has_rule("github"));
        assert!(!has_rule("aws"));
    }
}
