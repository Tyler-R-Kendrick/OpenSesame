//! What the breach scanner watches.
//!
//! Provider disclosure is checked against the hosts a tenant's connections
//! actually talk to, taken from each connection's egress binding. That is a
//! better list than anything an operator would maintain by hand: it is derived
//! from what the platform is already authorized to reach, so a connection added
//! last week is watched this pass without anyone remembering to add it.
//!
//! Collection reads metadata only. No sealed column is opened, so a scan needs
//! no sealing key and a gateway running without one still gets provider
//! coverage.

use std::collections::BTreeMap;

use opensesame_breach_intel::{BreachSubject, BreachSubjectKind};
use opensesame_domain::OrganizationId;

use crate::app_state::AppState;

/// Longest host we will treat as a watchable domain.
const MAX_HOST_CHARS: usize = 253;

/// Every host an organization's connections are bound to reach.
///
/// # Errors
///
/// Returns an error when the connection list cannot be read.
pub async fn watched_domains(
    state: &AppState,
    organization_id: &OrganizationId,
) -> anyhow::Result<Vec<BreachSubject>> {
    let views = state
        .connection_broker
        .list_connections(organization_id)
        .await
        .map_err(|error| anyhow::anyhow!("{}", error.hint()))?;

    // Keyed by host so two connections to one provider are one watched domain,
    // and ordered so a pass is deterministic.
    let mut by_host: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for view in views {
        for authority in &view.egress.authorities {
            let Some(host) = normalize_host(authority) else {
                continue;
            };
            let providers = by_host.entry(host).or_default();
            if !providers.contains(&view.provider_id) {
                providers.push(view.provider_id.clone());
            }
        }
    }

    Ok(by_host
        .into_iter()
        .map(|(host, providers)| {
            BreachSubject::new(BreachSubjectKind::Domain, host, organization_id.to_string())
                .labelled(providers.join(", "))
        })
        .collect())
}

/// An egress authority reduced to a comparable host.
///
/// Ports, case, and a trailing root dot are stripped; a wildcard authority is
/// reduced to the domain it wildcards, because `*.github.com` and
/// `api.github.com` are the same watch as far as a breach catalogue is
/// concerned. Anything that is not a plausible hostname is skipped rather than
/// guessed at — a bad entry should cost one domain's coverage, not the pass.
#[must_use]
pub fn normalize_host(authority: &str) -> Option<String> {
    let trimmed = authority.trim().trim_end_matches('.');
    // Strip a port, but leave an IPv6 literal's colons alone: an address is
    // never a breach-catalogue domain and is filtered out below anyway.
    let hostish = trimmed.rsplit_once(':').map_or(trimmed, |(host, port)| {
        if port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty() {
            host
        } else {
            trimmed
        }
    });
    let host = hostish
        .trim_start_matches("*.")
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();

    if host.is_empty() || host.len() > MAX_HOST_CHARS || !host.contains('.') {
        return None;
    }
    // A literal address has no registrable domain to match a breach against.
    if host.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return None;
    }
    Some(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_host_normalizes_to_itself() {
        assert_eq!(
            normalize_host("api.github.com").as_deref(),
            Some("api.github.com")
        );
    }

    #[test]
    fn case_ports_and_a_root_dot_are_stripped() {
        assert_eq!(
            normalize_host("API.GitHub.com:443").as_deref(),
            Some("api.github.com")
        );
        assert_eq!(
            normalize_host("api.github.com.").as_deref(),
            Some("api.github.com")
        );
        assert_eq!(
            normalize_host("  api.github.com  ").as_deref(),
            Some("api.github.com")
        );
    }

    #[test]
    fn a_wildcard_authority_watches_the_domain_it_wildcards() {
        assert_eq!(
            normalize_host("*.github.com").as_deref(),
            Some("github.com")
        );
    }

    #[test]
    fn addresses_are_not_watchable_domains() {
        assert_eq!(normalize_host("10.0.0.1"), None);
        assert_eq!(normalize_host("[2001:db8::1]"), None);
        assert_eq!(normalize_host("127.0.0.1:8080"), None);
    }

    #[test]
    fn a_bare_name_with_no_dot_is_skipped() {
        assert_eq!(normalize_host("localhost"), None);
        assert_eq!(normalize_host(""), None);
    }

    #[test]
    fn a_host_with_illegal_characters_is_skipped_rather_than_guessed_at() {
        assert_eq!(normalize_host("api github.com"), None);
        assert_eq!(normalize_host("api/github.com"), None);
        assert_eq!(normalize_host("api_github.com"), None);
    }

    #[test]
    fn an_absurdly_long_host_is_refused() {
        let long = format!("{}.com", "a".repeat(MAX_HOST_CHARS));
        assert_eq!(normalize_host(&long), None);
    }

    #[test]
    fn a_non_numeric_suffix_after_a_colon_is_not_a_port() {
        assert_eq!(normalize_host("api.github.com:https"), None);
    }
}
