//! The local half of the `run` inject lane: `os://vault/item/field`
//! references resolve against the sealed store (the vault a tomb names,
//! the entry a path names), values are injected into a directly spawned
//! child, and every injected value is masked in the child's output — the
//! same contract `op run` masking gives op:// values. Runs that stay
//! purely op:// keep the provider lane in `consume`.

use super::os_child::{materialize_mounts, spawn_masked};
use opensesame_connector_host::password_agent::env as core;
use std::{
    collections::HashMap,
    io::Write,
    process::{ExitStatus, Stdio},
};
use zeroize::Zeroizing;

/// Whether an env template names a local reference the provider lane
/// cannot resolve. An unreadable file stays with the provider lane,
/// which surfaces the read error itself.
pub(super) fn template_has_os(cmd: &super::consume::Env) -> bool {
    use super::consume::Env;
    let file = match cmd {
        Env::Run { file, .. } => file,
        Env::Write { .. } => return false,
    };
    std::fs::read_to_string(file).is_ok_and(|content| {
        core::references(&core::parse(&content))
            .iter()
            .any(|reference| reference.starts_with("os://"))
    })
}

/// The secret a sealed entry holds for one os:// field segment. Line one
/// answers the canonical secret names (a secret item's `value`, an
/// account's `password`, an API credential's `credential`); the trailer's
/// metadata line answers concealed custom fields by name and named
/// string values, mirroring the vault's own field projection.
pub(super) fn entry_field(secret: &str, trailer: &str, field: &str) -> Option<String> {
    if matches!(field, "password" | "value" | "secret" | "credential") {
        return (!secret.is_empty()).then(|| secret.to_string());
    }
    let meta = trailer.lines().find_map(|line| {
        serde_json::from_str::<serde_json::Value>(line.trim())
            .ok()
            .filter(serde_json::Value::is_object)
    })?;
    let custom = meta["fields"].as_array().and_then(|fields| {
        fields
            .iter()
            .find(|custom| custom["hidden"] == true && custom["name"].as_str() == Some(field))
    });
    if let Some(value) = custom.and_then(|custom| custom["value"].as_str()) {
        return Some(value.to_string());
    }
    meta["values"][field].as_str().map(str::to_string)
}

pub(super) struct LocalVault {
    tombs: HashMap<
        String,
        (
            opensesame_sealed_store::StoreRoot,
            opensesame_sealed_store::ItemDataKey,
        ),
    >,
}

impl LocalVault {
    pub(super) fn new() -> Self {
        Self {
            tombs: HashMap::new(),
        }
    }

    pub(super) fn resolve(&mut self, reference: &str) -> anyhow::Result<Zeroizing<String>> {
        let (vault, item, field) = core::parse_os_reference(reference)?;
        if !self.tombs.contains_key(&vault) {
            let opened = crate::store::open_unlocked(None, Some(&vault))
                .map_err(|_| anyhow::anyhow!("The local vault could not be opened"))?;
            self.tombs.insert(vault.clone(), opened);
        }
        let (root, key) = self
            .tombs
            .get(&vault)
            .ok_or_else(|| anyhow::anyhow!("The local vault could not be opened"))?;
        let age_id = std::env::var("OPENSESAME_AGE_IDENTITY").ok();
        let entry = root
            .show_with_age_identity(&item, key, age_id.as_deref())
            .map_err(|_| anyhow::anyhow!("The referenced item was not found."))?;
        entry_field(&entry.secret, &entry.trailer, &field)
            .map(Zeroizing::new)
            .ok_or_else(|| anyhow::anyhow!("The referenced secret field was not found."))
    }
}

/// One provider batch: values cross
/// only through the private pipe the internal batch encoder writes.
fn resolve_op_batch(refs: &[String]) -> anyhow::Result<Vec<Zeroizing<String>>> {
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let mut op = super::io::helper("op")?;
    super::credential::authenticate(&mut op)?;
    op.args(["run", "--no-masking", "--"])
        .arg(std::env::current_exe()?)
        .args(["password-agent", "internal-batch"])
        .arg(refs.len().to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (index, reference) in refs.iter().enumerate() {
        op.env(format!("OPENSESAME_SECRET_{index}"), reference);
    }
    let output = op
        .output()
        .map_err(|_| anyhow::anyhow!("Secret resolution failed (provider details suppressed)"))?;
    anyhow::ensure!(
        output.status.success(),
        "Secret resolution failed (provider details suppressed)"
    );
    let values: Vec<String> = serde_json::from_slice(&output.stdout)
        .map_err(|_| anyhow::anyhow!("Invalid secret batch"))?;
    anyhow::ensure!(values.len() == refs.len(), "Invalid secret batch");
    Ok(values.into_iter().map(Zeroizing::new).collect())
}

fn resolve_all(
    references: &[String],
    vault: &mut LocalVault,
) -> anyhow::Result<HashMap<String, Zeroizing<String>>> {
    let mut unique: Vec<String> = Vec::new();
    for reference in references {
        if !unique.contains(reference) {
            unique.push(reference.clone());
        }
    }
    let remote: Vec<String> = unique
        .iter()
        .filter(|reference| reference.starts_with("op://"))
        .cloned()
        .collect();
    let mut resolved = HashMap::new();
    for (reference, value) in remote.iter().zip(resolve_op_batch(&remote)?) {
        resolved.insert(reference.clone(), value);
    }
    for reference in unique
        .iter()
        .filter(|reference| reference.starts_with("os://"))
    {
        let value = vault.resolve(reference)?;
        resolved.insert(reference.clone(), value);
    }
    Ok(resolved)
}

fn finish(status: ExitStatus) {
    if !status.success() {
        std::process::exit(status.code().unwrap_or(1));
    }
}

/// Child variables for a template: resolved references in file order,
/// with plain `NAME=value` lines carried through as literals. The second
/// list is the resolved secret values to mask — literals never mask.
fn template_values(
    lines: &[core::Line],
    resolved: &HashMap<String, Zeroizing<String>>,
) -> (Vec<(String, String)>, Vec<String>) {
    let mut values = Vec::new();
    let mut secrets = Vec::new();
    for line in lines {
        match line {
            core::Line::Reference { name, reference } => {
                let value = resolved
                    .get(reference)
                    .map(|value| value.as_str().to_string())
                    .unwrap_or_default();
                secrets.push(value.clone());
                values.push((name.clone(), value));
            }
            core::Line::Literal(text) => {
                if let Some(pair) = core::literal_assignment(text) {
                    values.push(pair);
                }
            }
        }
    }
    (values, secrets)
}

fn run_with_values(
    command: &[String],
    values: &[(String, String)],
    mount_values: &[(String, String)],
    secrets: &[String],
) -> anyhow::Result<()> {
    let mounts = materialize_mounts(mount_values)?;
    let mut child_values: Vec<(String, String)> = values.to_vec();
    for (name, path) in &mounts.paths {
        child_values.push((name.clone(), path.display().to_string()));
    }
    // Mount contents are secret by construction.
    let mut secrets: Vec<String> = secrets.to_vec();
    secrets.extend(mount_values.iter().map(|(_, value)| value.clone()));
    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();
    let status = spawn_masked(command, &child_values, &secrets, &mut stdout, &mut stderr)?;
    drop(mounts);
    finish(status);
    Ok(())
}

pub(super) fn run_assignments(
    assignments: &[String],
    mounts: &[String],
    command: &[String],
    grant_approved: bool,
) -> anyhow::Result<()> {
    core::validate_run_assignments(assignments)?;
    core::validate_run_assignments(mounts)?;
    if !grant_approved {
        crate::cli_app_integration::ensure_reveal("run", None)?;
    }
    let parsed = assignments
        .iter()
        .map(|input| core::assignment(input))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let parsed_mounts = mounts
        .iter()
        .map(|input| core::assignment(input))
        .collect::<anyhow::Result<Vec<_>>>()?;
    anyhow::ensure!(
        !parsed_mounts
            .iter()
            .any(|(name, _)| parsed.iter().any(|(env_name, _)| env_name == name)),
        "A name cannot be both an env value and a mount."
    );
    let mut references: Vec<String> = parsed
        .iter()
        .map(|(_, reference)| reference.clone())
        .collect();
    references.extend(parsed_mounts.iter().map(|(_, reference)| reference.clone()));
    let mut vault = LocalVault {
        tombs: HashMap::new(),
    };
    let resolved = resolve_all(&references, &mut vault)?;
    let value_of = |reference: &str| {
        resolved
            .get(reference)
            .map(|value| value.as_str().to_string())
            .unwrap_or_default()
    };
    let values: Vec<(String, String)> = parsed
        .iter()
        .map(|(name, reference)| (name.clone(), value_of(reference)))
        .collect();
    let mount_values: Vec<(String, String)> = parsed_mounts
        .iter()
        .map(|(name, reference)| (name.clone(), value_of(reference)))
        .collect();
    let secrets: Vec<String> = values.iter().map(|(_, value)| value.clone()).collect();
    run_with_values(command, &values, &mount_values, &secrets)
}

pub(super) fn env(cmd: super::consume::Env) -> anyhow::Result<()> {
    use super::consume::Env;
    match cmd {
        Env::Run { file, command } => {
            crate::cli_app_integration::ensure_reveal("run", None)?;
            let content = Zeroizing::new(std::fs::read_to_string(file)?);
            core::validate_run_template(&content)?;
            let lines = core::parse(&content);
            let refs = core::references(&lines);
            let mut vault = LocalVault {
                tombs: HashMap::new(),
            };
            let resolved = resolve_all(&refs, &mut vault)?;
            let (values, secrets) = template_values(&lines, &resolved);
            run_with_values(&command, &values, &[], &secrets)
        }
        Env::Write { .. } => anyhow::bail!("env write needs no local resolution"),
    }
}

pub(super) fn reveal(reference: &str, desktop: bool, reveal: bool) -> anyhow::Result<()> {
    use opensesame_connector_host::password_agent::reveal_gate::{
        assert_human_reveal, emit_reveal_receipt, HumanRevealRequest,
    };
    core::parse_os_reference(reference)?;
    assert_human_reveal(HumanRevealRequest {
        verb: "reveal",
        reveal,
        desktop,
        reference: Some(reference),
        stdin_tty: None,
        stdout_tty: None,
    })?;
    if reveal {
        crate::cli_app_integration::ensure_reveal("reveal", Some(reference))?;
    }
    emit_reveal_receipt("reveal", Some(reference));
    let mut vault = LocalVault {
        tombs: HashMap::new(),
    };
    let value = vault.resolve(reference)?;
    std::io::stdout().write_all(value.as_bytes())?;
    Ok(())
}

#[cfg(test)]
#[path = "os_run_tests.rs"]
mod tests;
