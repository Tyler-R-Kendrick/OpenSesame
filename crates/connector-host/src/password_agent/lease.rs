//! Pure lease ceilings, metadata version checks, and exact authority comparison.
use super::request::Binding;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub id: String,
    pub version: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub id: String,
    pub principal: String,
    pub binding: Binding,
    pub resource: Resource,
    pub created_at: i64,
    pub expires_at: i64,
    pub use_budget: u32,
    pub uses_remaining: u32,
    pub revoked: bool,
}
/// # Errors
/// Validate bounds before metadata inspection or approval.
pub fn limits(duration: &str, uses: u32) -> anyhow::Result<i64> {
    anyhow::ensure!((1..=10).contains(&uses), "--uses must be between 1 and 10");
    anyhow::ensure!(duration.is_ascii(), "Invalid lease lifetime");
    let (digits, unit) = duration.split_at(duration.len().saturating_sub(1));
    anyhow::ensure!(
        !digits.starts_with('0') && digits.bytes().all(|b| b.is_ascii_digit()),
        "--expires-in must be a duration such as 10m or 1h"
    );
    let count = digits
        .parse::<i64>()
        .map_err(|_| anyhow::anyhow!("Invalid lease lifetime"))?;
    let seconds = count
        .checked_mul(match unit {
            "s" => 1,
            "m" => 60,
            "h" => 3600,
            _ => anyhow::bail!("Invalid lease lifetime"),
        })
        .ok_or_else(|| anyhow::anyhow!("Invalid lease lifetime"))?;
    anyhow::ensure!(
        (1..=3600).contains(&seconds),
        "Lease lifetime cannot exceed 60 minutes"
    );
    Ok(seconds)
}
/// # Errors
/// Metadata-only provider summaries must select one valid versioned item.
pub fn inspect(values: &[serde_json::Value], item: &str) -> anyhow::Result<Resource> {
    anyhow::ensure!(
        values.iter().all(|v| v["id"].is_string()
            && v["title"].is_string()
            && v["version"].as_u64().is_some_and(|n| n > 0)),
        "Invalid version metadata"
    );
    let matches: Vec<_> = values
        .iter()
        .filter(|v| v["id"] == item || v["title"] == item)
        .collect();
    anyhow::ensure!(
        matches.len() == 1,
        "Credential item must resolve to exactly one item for lease versioning"
    );
    let value = matches[0];
    let id = value["id"].as_str().unwrap_or_default();
    anyhow::ensure!(
        id.len() == 26
            && id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
        "Invalid credential item identifier"
    );
    let version = value["version"]
        .as_u64()
        .filter(|v| *v > 0)
        .ok_or_else(|| anyhow::anyhow!("1Password returned an invalid item version"))?;
    Ok(Resource {
        id: id.into(),
        version,
    })
}
impl Lease {
    /// # Errors
    /// Persisted leases must retain grant ceilings and typed authority.
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
                && self.uses_remaining <= self.use_budget
                && self.resource.version > 0
                && self.resource.id.len() == 26
                && self
                    .resource
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
            "Invalid persisted lease authority"
        );
        anyhow::ensure!(
            self.binding.capability == "request"
                && self.binding.method == "GET"
                && ["Authorization", "X-API-Key"].contains(&self.binding.header.as_str())
                && self.binding.destination_fingerprint.len() == 64
                && self
                    .binding
                    .destination_fingerprint
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit()),
            "Invalid persisted lease binding"
        );
        super::request::reference_location(&self.binding.reference)?;
        anyhow::ensure!(
            self.binding.prefix.len() <= 64 && !self.binding.prefix.contains(['\r', '\n', '\0']),
            "Invalid persisted lease prefix"
        );
        Ok(())
    }
    /// # Errors
    /// Reject mismatched, expired, revoked, exhausted, or stale authority.
    pub fn authorize(
        &self,
        principal: &str,
        binding: &Binding,
        resource: Option<&Resource>,
        now: i64,
    ) -> anyhow::Result<()> {
        self.validate(now)?;
        anyhow::ensure!(
            self.principal == principal
                && self.binding.matches(binding)
                && self.expires_at > now
                && !self.revoked
                && self.uses_remaining > 0
                && resource.is_none_or(|r| *r == self.resource),
            "Lease is invalid, expired, revoked, exhausted, stale, or mismatched"
        );
        Ok(())
    }
    #[must_use]
    pub fn receipt(&self) -> serde_json::Value {
        serde_json::json!({"id":self.id,"principal":self.principal,"capability":self.binding.capability,"method":self.binding.method,"reference":self.binding.reference,"itemId":self.resource.id,"itemVersion":self.resource.version,"destination":self.binding.destination,"destinationFingerprint":self.binding.destination_fingerprint,"header":self.binding.header,"prefix":self.binding.prefix,"createdAt":self.created_at,"expiresAt":self.expires_at,"useBudget":self.use_budget,"usesRemaining":self.uses_remaining,"revoked":self.revoked})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lease_bounds_and_exact_authority_fail_closed() {
        assert_eq!(limits("10m", 1).unwrap(), 600);
        for (ttl, uses) in [("2h", 1), ("1h", 11), ("0m", 1), ("10m", 0)] {
            assert!(limits(ttl, uses).is_err());
        }
        let binding = super::super::request::describe(
            "https://example.com/path?key=private",
            "op://Vault/Item/token",
            "authorization",
            "Bearer ",
        )
        .unwrap();
        let lease = Lease {
            id: "00000000-0000-4000-8000-000000000001".into(),
            principal: "00000000-0000-4000-8000-000000000002".into(),
            binding: binding.clone(),
            resource: Resource {
                id: "a".repeat(26),
                version: 7,
            },
            created_at: 1,
            expires_at: 1000,
            use_budget: 1,
            uses_remaining: 1,
            revoked: false,
        };
        assert!(lease
            .authorize(
                "00000000-0000-4000-8000-000000000002",
                &binding,
                Some(&lease.resource),
                2
            )
            .is_ok());
        assert!(lease.authorize("other", &binding, None, 2).is_err());
        assert!(lease
            .authorize("00000000-0000-4000-8000-000000000002", &binding, None, 1000)
            .is_err());
        let mut changed = binding;
        changed.destination_fingerprint.push('2');
        assert!(lease
            .authorize("00000000-0000-4000-8000-000000000002", &changed, None, 2)
            .is_err());
        for field in ["reference", "header", "prefix"] {
            let mut altered = lease.binding.clone();
            match field {
                "reference" => altered.reference.push_str("other"),
                "header" => altered.header = "X-API-Key".into(),
                _ => altered.prefix.clear(),
            }
            assert!(lease
                .authorize(&lease.principal, &altered, None, 2)
                .is_err());
        }
        let mut corrupt = lease.clone();
        corrupt.use_budget = 11;
        assert!(corrupt.validate(2).is_err());
        let mut corrupt = lease.clone();
        corrupt.uses_remaining = 2;
        assert!(corrupt.validate(2).is_err());
        let mut corrupt = lease.clone();
        corrupt.expires_at = 3_600_002;
        assert!(corrupt.validate(2).is_err());
        assert!(!lease.receipt().to_string().contains("private"));
    }
}
