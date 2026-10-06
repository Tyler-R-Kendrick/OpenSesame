//! Portable service-account setup policy, independent of credential-store IO.
use serde_json::Value;
#[must_use]
pub fn built_in(name: &str) -> bool {
    super::policy::policy()
        .dedicated_vault_denied_names
        .contains(&name.to_lowercase())
}
/// # Errors
/// Rejects implicit destinations, built-in automation vaults, or invalid durations.
pub fn validate_setup(
    name: &str,
    vault: &str,
    backup: &str,
    expires: Option<&str>,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        [name, vault, backup]
            .iter()
            .all(|s| !s.trim().is_empty() && !s.starts_with('-') && !s.contains(['\r', '\n'])),
        "Non-empty account name, automation vault, and backup vault required"
    );
    anyhow::ensure!(!built_in(vault), "Choose a dedicated automation vault");
    if let Some(duration) = expires {
        anyhow::ensure!(duration.is_ascii(), "Invalid expiration duration");
        let (n, unit) = duration.split_at(duration.len().saturating_sub(1));
        anyhow::ensure!(
            !n.starts_with('0')
                && n.bytes().all(|b| b.is_ascii_digit())
                && n.parse::<u64>().is_ok_and(|n| n > 0)
                && ["s", "m", "h", "d", "w"].contains(&unit),
            "Invalid expiration duration"
        );
    }
    Ok(())
}
/// # Errors
/// Rejects ambiguous or malformed provider vault metadata.
pub fn select(vaults: &[Value], name: &str) -> anyhow::Result<Option<Value>> {
    anyhow::ensure!(
        vaults
            .iter()
            .all(|v| v["id"].is_string() && v["name"].is_string()),
        "Invalid vault metadata"
    );
    let selected: Vec<_> = vaults
        .iter()
        .filter(|v| v["id"] == name || v["name"] == name)
        .collect();
    anyhow::ensure!(selected.len() <= 1, "Vault is ambiguous");
    Ok(selected.first().map(|v| (*v).clone()))
}
/// # Errors
/// Rejects built-in and shared backup destinations.
pub fn validate_destination(vault: &Value, backup_id: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        vault["id"]
            .as_str()
            .is_some_and(|id| !id.is_empty() && id != backup_id)
            && vault["name"].as_str().is_some_and(|name| !built_in(name)),
        "Use a dedicated automation vault separate from backup"
    );
    Ok(())
}
/// # Errors
/// Rejects provider identifiers before constructing authorization arguments.
pub fn grant(vault_id: &str, write: bool) -> anyhow::Result<String> {
    anyhow::ensure!(
        vault_id.len() == 26
            && vault_id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()),
        "Invalid automation vault identifier"
    );
    Ok(format!(
        "{vault_id}:read_items{}",
        if write { ",write_items" } else { "" }
    ))
}
/// # Errors
/// Rejects invalid private tokens without echoing input.
pub fn token(raw: &str) -> anyhow::Result<&str> {
    let token = raw
        .strip_suffix("\r\n")
        .or_else(|| raw.strip_suffix('\n'))
        .unwrap_or(raw);
    anyhow::ensure!(
        token.starts_with("ops_") && token.len() > 4 && !token.chars().any(char::is_whitespace),
        "Invalid service-account token"
    );
    Ok(token)
}
/// # Errors
/// Rejects unexpectedly broad or inconsistent newly created account access.
pub fn verify_visible(vaults: &[Value], expected_id: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        vaults.len() == 1 && vaults[0]["id"] == expected_id,
        "Saved service account vault access did not match; do not repeat setup"
    );
    Ok(())
}
