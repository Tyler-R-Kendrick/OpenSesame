//! Reusable human-approved grants for one exact `run` assignment set
//! (ADR 0205 decision 4): pure binding canonicalization, ceilings, and
//! exact authority comparison. Until a run presents a grant, approval
//! stays per-run.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunGrantBinding {
    pub capability: String,
    /// Canonical `NAME=reference` entries, sorted, names unique.
    pub assignments: Vec<String>,
    pub mounts: Vec<String>,
    pub agent_proxy: bool,
    /// Canonical `NAME=/prefix[,/prefix...]` entries (broker mode only).
    pub paths: Vec<String>,
    /// Canonical `NAME=GET[,POST...]` entries (broker mode only).
    pub methods: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunGrant {
    pub id: String,
    pub principal: String,
    pub binding: RunGrantBinding,
    pub created_at: i64,
    pub expires_at: i64,
    pub use_budget: u32,
    pub uses_remaining: u32,
    pub revoked: bool,
}

fn canonical_assignments(entries: &[String], lane: &str) -> anyhow::Result<Vec<String>> {
    let mut rendered = Vec::new();
    let mut names = Vec::new();
    for entry in entries {
        let (name, reference) = super::env::assignment(entry)?;
        anyhow::ensure!(
            !names.contains(&name),
            "Run grant {lane} names must be unique"
        );
        names.push(name.clone());
        rendered.push(format!("{name}={reference}"));
    }
    rendered.sort();
    Ok(rendered)
}

fn canonical_scopes(entries: &[String], kind: &str, upper: bool) -> anyhow::Result<Vec<String>> {
    let mut rendered = Vec::new();
    let mut names = Vec::new();
    for entry in entries {
        let (name, raw) = entry
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("Run grant --{kind} requires NAME=value entries"))?;
        anyhow::ensure!(
            !name.is_empty()
                && !raw.is_empty()
                && !entry.contains(['\r', '\n', '\0'])
                && !names.contains(&name.to_string()),
            "Run grant --{kind} names must be unique and named"
        );
        names.push(name.to_string());
        let mut values: Vec<String> = raw
            .split(',')
            .map(|value| {
                let trimmed = value.trim();
                if upper {
                    trimmed.to_uppercase()
                } else {
                    trimmed.to_string()
                }
            })
            .filter(|value| !value.is_empty())
            .collect();
        values.sort();
        let unique = {
            let mut deduped = values.clone();
            deduped.dedup();
            deduped.len() == values.len()
        };
        anyhow::ensure!(
            !values.is_empty() && unique,
            "Run grant --{kind} values must be unique and named"
        );
        rendered.push(format!("{name}={}", values.join(",")));
    }
    rendered.sort();
    Ok(rendered)
}

/// The exact binding a grant is issued for and a run must present.
///
/// # Errors
/// Rejects empty, duplicated, or lane-inconsistent assignment sets.
pub fn describe(
    assignments: &[String],
    mounts: &[String],
    agent_proxy: bool,
    paths: &[String],
    methods: &[String],
) -> anyhow::Result<RunGrantBinding> {
    let assignments = canonical_assignments(assignments, "--env")?;
    let mounts = canonical_assignments(mounts, "--mount")?;
    anyhow::ensure!(
        !assignments.is_empty() || !mounts.is_empty(),
        "Run grant requires at least one --env or --mount entry"
    );
    let name_of = |entry: &String| entry.split('=').next().unwrap_or_default().to_string();
    let env_names: Vec<String> = assignments.iter().map(name_of).collect();
    anyhow::ensure!(
        !mounts
            .iter()
            .any(|entry| env_names.contains(&name_of(entry))),
        "A name cannot be both an env value and a mount."
    );
    anyhow::ensure!(
        !agent_proxy || mounts.is_empty(),
        "--agent-proxy cannot be used with --mount."
    );
    let paths = canonical_scopes(paths, "paths", false)?;
    let methods = canonical_scopes(methods, "methods", true)?;
    anyhow::ensure!(
        agent_proxy || (paths.is_empty() && methods.is_empty()),
        "--paths and --methods require --agent-proxy."
    );
    Ok(RunGrantBinding {
        capability: "run".into(),
        assignments,
        mounts,
        agent_proxy,
        paths,
        methods,
    })
}

impl RunGrantBinding {
    #[must_use]
    pub fn matches(&self, other: &RunGrantBinding) -> bool {
        self.capability == other.capability
            && self.agent_proxy == other.agent_proxy
            && self.assignments == other.assignments
            && self.mounts == other.mounts
            && self.paths == other.paths
            && self.methods == other.methods
    }

    /// # Errors
    /// A persisted binding that is not already canonical was not issued
    /// by the grant ceremony.
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.capability == "run"
                && self.assignments.len() <= 64
                && self.mounts.len() <= 64
                && self.paths.len() <= 64
                && self.methods.len() <= 64,
            "Invalid persisted run-grant binding"
        );
        let canonical = describe(
            &self.assignments,
            &self.mounts,
            self.agent_proxy,
            &self.paths,
            &self.methods,
        )?;
        anyhow::ensure!(
            canonical.matches(self),
            "Run grant binding is not canonical"
        );
        Ok(())
    }
}

impl RunGrant {
    /// # Errors
    /// Persisted grants must retain grant ceilings and typed authority.
    pub fn validate(&self, now: i64) -> anyhow::Result<()> {
        let lifetime = self
            .expires_at
            .checked_sub(self.created_at)
            .unwrap_or_default();
        anyhow::ensure!(
            (1..=3_600_000).contains(&lifetime)
                && self.created_at <= now
                && uuid::Uuid::parse_str(&self.id).is_ok()
                && uuid::Uuid::parse_str(&self.principal).is_ok()
                && (1..=10).contains(&self.use_budget)
                && self.uses_remaining <= self.use_budget,
            "Invalid persisted run-grant authority"
        );
        self.binding.validate()?;
        Ok(())
    }

    /// # Errors
    /// Reject mismatched, expired, revoked, or exhausted authority.
    pub fn authorize(
        &self,
        principal: &str,
        binding: &RunGrantBinding,
        now: i64,
    ) -> anyhow::Result<()> {
        self.validate(now)?;
        binding.validate()?;
        anyhow::ensure!(
            self.principal == principal
                && self.binding.matches(binding)
                && self.expires_at > now
                && !self.revoked
                && self.uses_remaining > 0,
            "Run grant is invalid, expired, revoked, exhausted, or mismatched"
        );
        Ok(())
    }

    #[must_use]
    pub fn receipt(&self) -> serde_json::Value {
        serde_json::json!({"id":self.id,"principal":self.principal,"capability":self.binding.capability,"assignments":self.binding.assignments,"mounts":self.binding.mounts,"agentProxy":self.binding.agent_proxy,"paths":self.binding.paths,"methods":self.binding.methods,"createdAt":self.created_at,"expiresAt":self.expires_at,"useBudget":self.use_budget,"usesRemaining":self.uses_remaining,"revoked":self.revoked})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(binding: RunGrantBinding) -> RunGrant {
        RunGrant {
            id: "00000000-0000-4000-8000-000000000001".into(),
            principal: "00000000-0000-4000-8000-000000000002".into(),
            binding,
            created_at: 1,
            expires_at: 600_001,
            use_budget: 2,
            uses_remaining: 2,
            revoked: false,
        }
    }

    #[test]
    fn run_grant_binds_exact_assignment_set_and_broker_scopes() {
        let binding = describe(
            &["B=os://personal/i2/f".into(), "A=op://v/i/f".into()],
            &[],
            false,
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(
            binding.assignments,
            vec![
                "A=op://v/i/f".to_string(),
                "B=os://personal/i2/f".to_string()
            ]
        );
        let issued = grant(binding.clone());
        assert!(issued
            .authorize("00000000-0000-4000-8000-000000000002", &binding, 2)
            .is_ok());
        let widened = describe(
            &[
                "A=op://v/i/f".into(),
                "B=os://personal/i2/f".into(),
                "C=op://v/i/g".into(),
            ],
            &[],
            false,
            &[],
            &[],
        )
        .unwrap();
        assert!(issued
            .authorize("00000000-0000-4000-8000-000000000002", &widened, 2)
            .is_err());
        assert!(issued
            .authorize("00000000-0000-4000-8000-000000000002", &binding, 600_001)
            .is_err());
        assert!(issued.authorize("other", &binding, 2).is_err());
        let brokered = describe(
            &["GH=os://personal/connections/gh".into()],
            &[],
            true,
            &["GH=/repos/acme,/user".into()],
            &["GH=get,post".into()],
        )
        .unwrap();
        assert_eq!(brokered.methods, vec!["GH=GET,POST".to_string()]);
        assert!(describe(
            &["A=op://v/i/f".into(), "A=op://v/i/g".into()],
            &[],
            false,
            &[],
            &[]
        )
        .is_err());
        let mut corrupt = issued.clone();
        corrupt.use_budget = 11;
        assert!(corrupt.validate(2).is_err());
        let mut corrupt = issued;
        corrupt.binding.assignments.reverse();
        assert!(corrupt.validate(2).is_err());
    }
}
