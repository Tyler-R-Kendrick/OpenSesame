//! Project-config secret domain (ADR 0052).
//!
//! Wire views for configs, the write-only value intake, and
//! [`StoreSecretSource`] — the first production [`SyncSecretSource`]: it opens
//! host-sealed rows in-process, applies one level of `parent_config_id`
//! inheritance (child wins), then resolves `${KEY}` / `${config:slug.KEY}`
//! references fail-closed. Values never leave this module except toward
//! sync egress, rotation, or operator materialize.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::{BrokerError, Result};
use crate::store::{self, SecretConfigRow};
use crate::sync_target::SyncSecretSource;

/// Metadata-only wire view. Mirrors `SecretConfig` in
/// `packages/os-domain/src/types.ts` plus host bookkeeping fields.
#[derive(Debug, Clone, Serialize)]
pub struct SecretConfigView {
    pub id: String,
    pub organization_id: String,
    pub project_id: String,
    pub slug: String,
    pub display_name: String,
    pub environment: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_config_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<SecretConfigRow> for SecretConfigView {
    fn from(row: SecretConfigRow) -> Self {
        Self {
            id: row.id,
            organization_id: row.organization_id,
            project_id: row.project_id,
            slug: row.slug,
            display_name: row.display_name,
            environment: row.environment,
            parent_config_id: row.parent_config_id,
            created_at: row.created_at.to_rfc3339(),
            updated_at: row.updated_at.to_rfc3339(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateSecretConfig {
    pub project_id: String,
    pub slug: String,
    #[serde(default)]
    pub display_name: Option<String>,
    pub environment: String,
    #[serde(default)]
    pub parent_config_id: Option<String>,
}

/// Key metadata — the only shape value reads ever take on the wire.
#[derive(Debug, Clone, Serialize)]
pub struct ConfigKeyMeta {
    pub key_name: String,
    pub version: u64,
    pub updated_at: String,
}

#[must_use]
pub fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 64
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Env-var discipline for key names keeps the AAD canonical encoding
/// unambiguous (no `|` or `$` in names) and matches what sync targets push.
#[must_use]
pub fn valid_key_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

// ---- secret referencing (§4.7) ---------------------------------------------

/// One parsed `${…}` occurrence.
#[derive(Debug, PartialEq)]
enum Reference {
    SameConfig { key: String },
    CrossConfig { slug: String, key: String },
}

fn parse_reference(inner: &str) -> Result<Reference> {
    if let Some(rest) = inner.strip_prefix("config:") {
        let (slug, key) = rest.split_once('.').ok_or_else(|| {
            BrokerError::Invalid(format!(
                "cross-config reference `{inner}` must be `config:<slug>.<KEY>`"
            ))
        })?;
        if !valid_slug(slug) || !valid_key_name(key) {
            return Err(BrokerError::Invalid(format!(
                "invalid cross-config reference `{inner}`"
            )));
        }
        return Ok(Reference::CrossConfig {
            slug: slug.to_string(),
            key: key.to_string(),
        });
    }
    if !valid_key_name(inner) {
        return Err(BrokerError::Invalid(format!(
            "invalid secret reference `{inner}`"
        )));
    }
    Ok(Reference::SameConfig {
        key: inner.to_string(),
    })
}

/// Scan a value for references. `$${…}` is an escape for a literal `${…}` and
/// is left alone here (unescaped during substitution). Malformed references
/// (unclosed, bad names) are hard errors — fail closed, never pass through.
fn parse_references(value: &str) -> Result<Vec<(usize, usize, Reference)>> {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'$' && bytes[i + 1] == b'$' && bytes.get(i + 2) == Some(&b'{') {
            let close = value[i + 2..]
                .find('}')
                .ok_or_else(|| BrokerError::Invalid("unclosed secret reference".into()))?;
            i += 2 + close + 1;
            continue;
        }
        if bytes[i] == b'$' && bytes[i + 1] == b'{' {
            let close = value[i..]
                .find('}')
                .ok_or_else(|| BrokerError::Invalid("unclosed secret reference".into()))?;
            let inner = &value[i + 2..i + close];
            let reference = parse_reference(inner)?;
            out.push((i, i + close + 1, reference));
            i += close + 1;
            continue;
        }
        i += 1;
    }
    Ok(out)
}

fn unescape(value: &str) -> String {
    value.replace("$${", "${")
}

/// Refuse a reference that would pull production values into a non-production
/// config — a dev sync target must never become a prod exfiltration path.
fn guard_cross_environment(from: &SecretConfigRow, to: &SecretConfigRow) -> Result<()> {
    if to.environment == "production" && from.environment != "production" {
        return Err(BrokerError::Invalid(format!(
            "config `{}` ({}) may not reference production config `{}`",
            from.slug, from.environment, to.slug
        )));
    }
    Ok(())
}

// ---- StoreSecretSource ------------------------------------------------------

/// Production secret source: host-sealed rows, opened in-process only.
pub struct StoreSecretSource {
    pool: SqlitePool,
    key: [u8; 32],
}

impl StoreSecretSource {
    #[must_use]
    pub fn new(pool: SqlitePool, key: [u8; 32]) -> Self {
        Self { pool, key }
    }

    async fn config_by_id(
        &self,
        organization_id: &str,
        config_id: &str,
    ) -> Result<SecretConfigRow> {
        store::get_secret_config(&self.pool, organization_id, config_id)
            .await?
            .ok_or(BrokerError::ConfigNotFound)
    }

    async fn config_by_slug(
        &self,
        organization_id: &str,
        project_id: &str,
        slug: &str,
    ) -> Result<SecretConfigRow> {
        store::list_secret_configs(&self.pool, organization_id, project_id)
            .await?
            .into_iter()
            .find(|c| c.slug == slug)
            .ok_or(BrokerError::ConfigNotFound)
    }

    /// Raw (opened, pre-reference) values for one config, inheritance applied.
    async fn raw_values(
        &self,
        organization_id: &str,
        config: &SecretConfigRow,
    ) -> Result<BTreeMap<String, String>> {
        let mut merged = BTreeMap::new();
        if let Some(parent_id) = &config.parent_config_id {
            let parent = self.config_by_id(organization_id, parent_id).await?;
            if parent.project_id != config.project_id {
                return Err(BrokerError::Invalid(
                    "parent config belongs to another project".into(),
                ));
            }
            if parent.parent_config_id.is_some() {
                return Err(BrokerError::Invalid(
                    "config inheritance is limited to one level".into(),
                ));
            }
            for row in
                store::load_config_values_sealed(&self.pool, organization_id, &parent.id).await?
            {
                let ad = crate::crypto::config_value_ad(
                    organization_id,
                    &parent.project_id,
                    &parent.id,
                    &row.key_name,
                    store::config_version_from_db(row.version)?,
                );
                let plaintext = crate::crypto::open_with_ad(&self.key, &ad, &row.sealed)?;
                merged.insert(
                    row.key_name,
                    String::from_utf8_lossy(&plaintext).into_owned(),
                );
            }
        }
        for row in store::load_config_values_sealed(&self.pool, organization_id, &config.id).await?
        {
            let ad = crate::crypto::config_value_ad(
                organization_id,
                &config.project_id,
                &config.id,
                &row.key_name,
                store::config_version_from_db(row.version)?,
            );
            let plaintext = crate::crypto::open_with_ad(&self.key, &ad, &row.sealed)?;
            merged.insert(
                row.key_name,
                String::from_utf8_lossy(&plaintext).into_owned(),
            );
        }
        Ok(merged)
    }

    fn resolve_value<'a>(
        &'a self,
        organization_id: &'a str,
        config: &'a SecretConfigRow,
        key: &'a str,
        raw: &'a BTreeMap<String, String>,
        visited: &'a mut HashSet<(String, String)>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send + 'a>> {
        Box::pin(async move {
            if !visited.insert((config.id.clone(), key.to_string())) {
                return Err(BrokerError::Invalid(format!(
                    "secret reference cycle through `{key}`"
                )));
            }
            let value = raw
                .get(key)
                .ok_or_else(|| BrokerError::Invalid(format!("missing secret reference `{key}`")))?;
            let references = parse_references(value)?;
            if references.is_empty() {
                visited.remove(&(config.id.clone(), key.to_string()));
                return Ok(unescape(value));
            }
            let mut resolved = String::new();
            let mut cursor = 0;
            for (start, end, reference) in references {
                resolved.push_str(&value[cursor..start]);
                let inner = self
                    .resolve_reference(organization_id, config, raw, visited, reference)
                    .await?;
                resolved.push_str(&inner);
                cursor = end;
            }
            resolved.push_str(&value[cursor..]);
            visited.remove(&(config.id.clone(), key.to_string()));
            Ok(unescape(&resolved))
        })
    }

    async fn resolve_reference(
        &self,
        organization_id: &str,
        config: &SecretConfigRow,
        raw: &BTreeMap<String, String>,
        visited: &mut HashSet<(String, String)>,
        reference: Reference,
    ) -> Result<String> {
        match reference {
            Reference::SameConfig { key } => {
                self.resolve_value(organization_id, config, &key, raw, visited)
                    .await
            }
            Reference::CrossConfig { slug, key } => {
                let other = self
                    .config_by_slug(organization_id, &config.project_id, &slug)
                    .await?;
                guard_cross_environment(config, &other)?;
                let other_raw = self.raw_values(organization_id, &other).await?;
                self.resolve_value(organization_id, &other, &key, &other_raw, visited)
                    .await
            }
        }
    }
}

#[async_trait::async_trait]
impl SyncSecretSource for StoreSecretSource {
    async fn load_config_secrets(
        &self,
        organization_id: &str,
        project_id: &str,
        config_id: &str,
    ) -> Result<BTreeMap<String, String>> {
        let config = self.config_by_id(organization_id, config_id).await?;
        if config.project_id != project_id {
            return Err(BrokerError::ConfigNotFound);
        }
        let raw = self.raw_values(organization_id, &config).await?;
        let mut out = BTreeMap::new();
        for key in raw.keys() {
            let mut visited = HashSet::new();
            let resolved = self
                .resolve_value(organization_id, &config, key, &raw, &mut visited)
                .await?;
            out.insert(key.clone(), resolved);
        }
        Ok(out)
    }
}
// ---- broker surface ---------------------------------------------------------

use std::sync::Arc;

use chrono::Utc;
use serde_json::Map;

use crate::changelog_hook::{record_secret_changelog_durable, RecordSecretChangelog};
use crate::store::{ConfigValueVersionMetaRow, UpsertConfigValue};

impl crate::ConnectionBroker {
    /// Durable changelog write through this broker's pool (fail closed on an
    /// unknown event name). The one production entry point for Host rows.
    ///
    /// # Errors
    ///
    /// Returns an error when event validation or durable persistence fails.
    pub async fn record_changelog(
        &self,
        input: RecordSecretChangelog,
    ) -> Result<crate::changelog_hook::ChangelogEntry> {
        record_secret_changelog_durable(&self.pool, input).await
    }

    /// Durable changelog read, newest first; `before_seq` pages backwards.
    ///
    /// # Errors
    ///
    /// Returns an error when durable changelog storage cannot be read.
    pub async fn list_changelog(
        &self,
        organization_id: &str,
        project_id: &str,
        limit: usize,
        before_seq: Option<i64>,
    ) -> Result<Vec<crate::changelog_hook::ChangelogEntry>> {
        crate::changelog_hook::list_secret_changelog_durable(
            &self.pool,
            organization_id,
            project_id,
            limit,
            before_seq,
        )
        .await
    }

    async fn config_changelog(
        &self,
        event_type: &str,
        config: &SecretConfigRow,
        key_names: Vec<String>,
        actor_id: Option<&str>,
        version_id: Option<String>,
    ) {
        let _ = record_secret_changelog_durable(
            &self.pool,
            RecordSecretChangelog {
                event_type: event_type.into(),
                project_id: config.project_id.clone(),
                organization_id: Some(config.organization_id.clone()),
                actor_id: actor_id.map(str::to_string),
                config_id: Some(config.id.clone()),
                environment: Some(config.environment.clone()),
                key_names,
                version_id,
                metadata: Map::new(),
                ..Default::default()
            },
        )
        .await;
    }

    async fn validate_cross_config_references(
        &self,
        organization_id: &str,
        config: &SecretConfigRow,
        value: &str,
    ) -> Result<()> {
        for (_, _, reference) in parse_references(value)? {
            let Reference::CrossConfig { slug, .. } = reference else {
                continue;
            };
            let other = store::list_secret_configs(&self.pool, organization_id, &config.project_id)
                .await?
                .into_iter()
                .find(|candidate| candidate.slug == slug)
                .ok_or_else(|| {
                    BrokerError::Invalid(format!("referenced config `{slug}` does not exist"))
                })?;
            guard_cross_environment(config, &other)?;
        }
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when validation, parent lookup, or durable insertion fails.
    pub async fn create_secret_config(
        &self,
        organization_id: &str,
        create: CreateSecretConfig,
        actor_id: Option<&str>,
    ) -> Result<SecretConfigView> {
        if !valid_slug(&create.slug) {
            return Err(BrokerError::Invalid(
                "slug must be lowercase [a-z0-9-], at most 64 chars".into(),
            ));
        }
        if let Some(parent_id) = &create.parent_config_id {
            let parent = store::get_secret_config(&self.pool, organization_id, parent_id)
                .await?
                .ok_or(BrokerError::ConfigNotFound)?;
            if parent.project_id != create.project_id {
                return Err(BrokerError::Invalid(
                    "parent config belongs to another project".into(),
                ));
            }
            if parent.parent_config_id.is_some() {
                return Err(BrokerError::Invalid(
                    "config inheritance is limited to one level".into(),
                ));
            }
        }
        let now = Utc::now();
        let row = SecretConfigRow {
            id: format!("cfg_{}", uuid::Uuid::now_v7()),
            organization_id: organization_id.to_string(),
            project_id: create.project_id,
            display_name: create.display_name.unwrap_or_else(|| create.slug.clone()),
            slug: create.slug,
            environment: create.environment,
            parent_config_id: create.parent_config_id,
            created_at: now,
            updated_at: now,
        };
        store::insert_secret_config(&self.pool, &row).await?;
        self.config_changelog("secret.config.created", &row, Vec::new(), actor_id, None)
            .await;
        Ok(row.into())
    }

    /// # Errors
    ///
    /// Returns an error when durable config storage cannot be read.
    pub async fn list_secret_configs(
        &self,
        organization_id: &str,
        project_id: &str,
    ) -> Result<Vec<SecretConfigView>> {
        Ok(
            store::list_secret_configs(&self.pool, organization_id, project_id)
                .await?
                .into_iter()
                .map(SecretConfigView::from)
                .collect(),
        )
    }

    /// # Errors
    ///
    /// Returns an error when the config is absent or durable storage cannot be read.
    pub async fn get_secret_config_view(
        &self,
        organization_id: &str,
        config_id: &str,
    ) -> Result<SecretConfigView> {
        store::get_secret_config(&self.pool, organization_id, config_id)
            .await?
            .map(SecretConfigView::from)
            .ok_or(BrokerError::ConfigNotFound)
    }

    /// Refuses while sync targets still reference the config (delete those
    /// first) — a silent cascade would orphan fan-out state.
    ///
    /// # Errors
    ///
    /// Returns an error when the config is absent, referenced, or cannot be deleted atomically.
    pub async fn delete_secret_config(
        &self,
        organization_id: &str,
        config_id: &str,
        actor_id: Option<&str>,
    ) -> Result<()> {
        let config = store::get_secret_config(&self.pool, organization_id, config_id)
            .await?
            .ok_or(BrokerError::ConfigNotFound)?;
        let referencing =
            store::list_sync_targets(&self.pool, organization_id, None, Some(config_id)).await?;
        if !referencing.is_empty() {
            return Err(BrokerError::Invalid(format!(
                "{} sync target(s) still reference this config",
                referencing.len()
            )));
        }
        store::delete_secret_config(&self.pool, organization_id, config_id).await?;
        self.config_changelog("secret.config.deleted", &config, Vec::new(), actor_id, None)
            .await;
        Ok(())
    }

    /// Write-only value intake. Returns key metadata — never values.
    ///
    /// # Errors
    ///
    /// Returns an error when validation, sealing, versioning, or durable persistence fails.
    pub async fn put_config_secrets(
        &self,
        organization_id: &str,
        config_id: &str,
        secrets: &std::collections::BTreeMap<String, String>,
        actor_id: Option<&str>,
    ) -> Result<Vec<ConfigKeyMeta>> {
        if secrets.is_empty() {
            return Err(BrokerError::Invalid("no secrets provided".into()));
        }
        let key = *self.sealing_key()?;
        let config = store::get_secret_config(&self.pool, organization_id, config_id)
            .await?
            .ok_or(BrokerError::ConfigNotFound)?;
        for (name, value) in secrets {
            if !valid_key_name(name) {
                return Err(BrokerError::Invalid(format!(
                    "key `{name}` must match [A-Za-z_][A-Za-z0-9_]*"
                )));
            }
            if value.len() > crate::MAX_CREDENTIAL_BYTES {
                return Err(BrokerError::Invalid(format!(
                    "value for `{name}` exceeds {} bytes",
                    crate::MAX_CREDENTIAL_BYTES
                )));
            }
            // Fail closed at write time: malformed references and forbidden
            // cross-environment pulls never enter the store.
            self.validate_cross_config_references(organization_id, &config, value)
                .await?;
        }
        let mut out = Vec::with_capacity(secrets.len());
        let mut top_version = 0;
        for (name, value) in secrets {
            let version = store::upsert_config_value(
                &self.pool,
                &key,
                UpsertConfigValue {
                    organization_id,
                    project_id: &config.project_id,
                    config_id,
                    key_name: name,
                    plaintext: value.as_bytes(),
                    actor_id,
                },
            )
            .await?;
            top_version = top_version.max(version);
            out.push(ConfigKeyMeta {
                key_name: name.clone(),
                version,
                updated_at: Utc::now().to_rfc3339(),
            });
        }
        self.config_changelog(
            "secret.value.changed",
            &config,
            secrets.keys().cloned().collect(),
            actor_id,
            Some(format!("v{top_version}")),
        )
        .await;
        Ok(out)
    }

    /// # Errors
    ///
    /// Returns an error when the config/value is absent or durable deletion fails.
    pub async fn delete_config_secret(
        &self,
        organization_id: &str,
        config_id: &str,
        key_name: &str,
        actor_id: Option<&str>,
    ) -> Result<()> {
        let config = store::get_secret_config(&self.pool, organization_id, config_id)
            .await?
            .ok_or(BrokerError::ConfigNotFound)?;
        if !store::delete_config_value(&self.pool, organization_id, config_id, key_name, actor_id)
            .await?
        {
            return Err(BrokerError::ConfigValueNotFound);
        }
        self.config_changelog(
            "secret.value.changed",
            &config,
            vec![key_name.to_string()],
            actor_id,
            None,
        )
        .await;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the config is absent, a stored version is invalid, or storage fails.
    pub async fn config_key_meta(
        &self,
        organization_id: &str,
        config_id: &str,
    ) -> Result<Vec<ConfigKeyMeta>> {
        store::get_secret_config(&self.pool, organization_id, config_id)
            .await?
            .ok_or(BrokerError::ConfigNotFound)?;
        store::list_config_key_meta(&self.pool, organization_id, config_id)
            .await?
            .into_iter()
            .map(|row| {
                Ok(ConfigKeyMeta {
                    key_name: row.key_name,
                    version: store::config_version_from_db(row.version)?,
                    updated_at: row.updated_at.to_rfc3339(),
                })
            })
            .collect()
    }

    /// # Errors
    ///
    /// Returns an error when the config is absent or durable history cannot be read.
    pub async fn config_value_versions(
        &self,
        organization_id: &str,
        config_id: &str,
        key_name: &str,
    ) -> Result<Vec<ConfigValueVersionMetaRow>> {
        store::list_config_value_versions(&self.pool, organization_id, config_id, key_name).await
    }

    /// Rollback = decrypt the old version in-process and re-seal it as a NEW
    /// head version (the AAD binds the version number; old bytes never move).
    ///
    /// # Errors
    ///
    /// Returns an error when the version is absent, invalid, cannot be opened, or cannot be re-sealed.
    pub async fn rollback_config_secret(
        &self,
        organization_id: &str,
        config_id: &str,
        key_name: &str,
        to_version: u64,
        actor_id: Option<&str>,
    ) -> Result<u64> {
        let key = *self.sealing_key()?;
        let config = store::get_secret_config(&self.pool, organization_id, config_id)
            .await?
            .ok_or(BrokerError::ConfigNotFound)?;
        let old = store::get_config_value_version_sealed(
            &self.pool,
            organization_id,
            config_id,
            key_name,
            to_version,
        )
        .await?
        .ok_or(BrokerError::ConfigValueNotFound)?;
        let ad = crate::crypto::config_value_ad(
            organization_id,
            &config.project_id,
            config_id,
            key_name,
            to_version,
        );
        let plaintext = crate::crypto::open_with_ad(&key, &ad, &old.sealed)?;
        let new_version = store::upsert_config_value(
            &self.pool,
            &key,
            UpsertConfigValue {
                organization_id,
                project_id: &config.project_id,
                config_id,
                key_name,
                plaintext: &plaintext,
                actor_id,
            },
        )
        .await?;
        let _ = record_secret_changelog_durable(
            &self.pool,
            RecordSecretChangelog {
                event_type: "secret.value.rolled_back".into(),
                project_id: config.project_id.clone(),
                organization_id: Some(config.organization_id.clone()),
                actor_id: actor_id.map(str::to_string),
                config_id: Some(config.id.clone()),
                environment: Some(config.environment.clone()),
                key_names: vec![key_name.to_string()],
                version_id: Some(format!("v{new_version}")),
                metadata: {
                    let mut m = Map::new();
                    m.insert("rolledBackTo".into(), serde_json::json!(to_version));
                    m
                },
                ..Default::default()
            },
        )
        .await;
        Ok(new_version)
    }

    /// The production secret source for sync egress (replaces
    /// `EmptySecretSource`). Errors when the deployment seal key is unset —
    /// fail closed, a keyless deployment cannot sync.
    ///
    /// # Errors
    ///
    /// Returns an error when the deployment sealing key is unavailable.
    pub fn sync_secret_source(&self) -> Result<Arc<dyn SyncSecretSource>> {
        let key = *self.sealing_key()?;
        Ok(Arc::new(StoreSecretSource::new(self.pool.clone(), key)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_cross_references() {
        let refs = parse_references("a ${KEY_ONE} b ${config:prod-api.TOKEN} c").unwrap();
        assert_eq!(refs.len(), 2);
        assert_eq!(
            refs[0].2,
            Reference::SameConfig {
                key: "KEY_ONE".into()
            }
        );
        assert_eq!(
            refs[1].2,
            Reference::CrossConfig {
                slug: "prod-api".into(),
                key: "TOKEN".into()
            }
        );
    }

    #[test]
    fn escapes_are_left_alone_then_unescaped() {
        assert!(parse_references("literal $${NOT_A_REF} here")
            .unwrap()
            .is_empty());
        assert_eq!(unescape("literal $${NOT_A_REF}"), "literal ${NOT_A_REF}");
    }

    #[test]
    fn malformed_references_fail_closed() {
        assert!(parse_references("${unclosed").is_err());
        assert!(parse_references("${bad name}").is_err());
        assert!(parse_references("${config:noDot}").is_err());
        assert!(parse_references("${config:Bad_Slug.KEY}").is_err());
    }

    #[test]
    fn key_and_slug_validation() {
        assert!(valid_key_name("API_KEY_2"));
        assert!(valid_key_name("_PRIVATE"));
        assert!(!valid_key_name("2LEADING"));
        assert!(!valid_key_name("has-dash"));
        assert!(!valid_key_name(""));
        assert!(valid_slug("prod-api-2"));
        assert!(!valid_slug("Bad"));
        assert!(!valid_slug(""));
    }
}
