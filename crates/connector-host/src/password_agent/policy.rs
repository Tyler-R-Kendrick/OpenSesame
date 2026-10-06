//! One pinned policy shared by every provider core (ADR 0139).
use serde::Deserialize;
use std::sync::OnceLock;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub suggestion_threshold: f64,
    pub suggestion_limit: usize,
    pub old_login_years: i32,
    pub machine_kinds: Vec<String>,
    pub transient_url_terms: Vec<String>,
    pub dedicated_vault_denied_names: Vec<String>,
    pub credential_startup_env_keys: Vec<String>,
}
const SOURCE: &str = include_str!("../../../../spec/conformance/2password-policy.json");
/// The compiled policy is authored source, checked by both cores' tests.
/// # Panics
/// Panics only if the compiled policy source is not valid JSON.
#[must_use]
pub fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| serde_json::from_str(SOURCE).expect("compiled password-agent policy"))
}
#[cfg(test)]
mod tests {
    #[test]
    fn pinned_policy_is_consumed() {
        let policy = super::policy();
        assert_eq!(policy.suggestion_limit, 3);
        assert_eq!(policy.old_login_years, 5);
        assert!(policy.machine_kinds.contains(&"api-credential".to_owned()));
        assert!(policy
            .dedicated_vault_denied_names
            .contains(&"personal".to_owned()));
    }
}
