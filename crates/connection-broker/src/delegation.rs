//! Claimable connection delegation (ADR 0044).
//!
//! An owner mints an **offer** over one or more of their connections; a
//! claimant spends it **once** and receives, per accepted item, a child
//! [`Grant`] attenuated against that connection's owner grant — never token
//! bytes, never the sealed credential. The offer's claim token is a phishable
//! artifact by nature, so everything here is built around that fact:
//!
//! - Present is the spend point. The first presenter wins a single CAS; a
//!   token seen again after spend means the link leaked, and the offer is
//!   **burned** — every delegation already minted from it is revoked in the
//!   same transaction. Availability is sacrificed for integrity (Vault
//!   response-wrapping semantics).
//! - A user code travels out of band and is required to claim; wrong codes
//!   are counted and the offer burns at the cap, so the code cannot be
//!   brute-forced by whoever holds only the link.
//! - Attenuation is validated **at mint** against the connection's owner
//!   grant, so an offer that could not be honored is refused before a link
//!   ever exists, and again at claim via [`opensesame_domain::Grant`]
//!   `validate_attenuation` when the child is actually built.
//!
//! No row in these tables holds a token or credential — only hashes.

use std::collections::BTreeMap;

use chrono::{DateTime, Duration, Utc};
use opensesame_claims::{generate_claim_token, generate_user_code, hash_eq, hash_low_entropy};
use opensesame_domain::{
    ConnectionId, Grant, GrantConstraints, GrantId, OfflineUse, OrganizationId, PrincipalId,
    Shareability,
};
use opensesame_relay::ExecutionMode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteRow, Row, Sqlite, Transaction};

use crate::error::{BrokerError, Result};
use crate::model::{BindingTargetKind, EventKind};
use crate::store::{self, ConnectionRow};
use crate::{parse_shareability, ConnectionBroker};

pub const OFFER_TTL_DEFAULT_SECONDS: i64 = 600;
pub const OFFER_TTL_CEILING_SECONDS: i64 = 86_400;
/// Delegation lifetime when the offer does not name one.
const DELEGATION_TTL_DEFAULT_SECONDS: i64 = 3_600;
/// Wrong user codes tolerated before the offer burns.
const MAX_CODE_ATTEMPTS: i64 = 5;
const MAX_ITEMS: usize = 16;
/// Lifetime of the synthesized owner-ceiling grant.
const OWNER_GRANT_TTL_DAYS: i64 = 30;
/// Ceiling for per-delegation budgets. `validate_attenuation` requires every
/// child budget key to exist in the parent with a value at or below it, so the
/// ceiling grant carries the standard key at a bound no real offer reaches.
const OWNER_BUDGET_CEILING: i64 = 1_000_000;
pub const BUDGET_INVOCATIONS: &str = "invocations";

/// Purpose separator: a delegation token hash can never collide with any
/// other token purpose, even for identical bytes (docs/claims.md rule).
const TOKEN_PURPOSE: &str = "opensesame:delegation-token:v1";

fn token_hash(token: &str) -> Result<String> {
    let mut h = Sha256::new();
    for part in [TOKEN_PURPOSE, token] {
        let length = u32::try_from(part.len())
            .map_err(|_| BrokerError::Invalid("delegation token is too large".into()))?;
        h.update(length.to_be_bytes());
        h.update(part.as_bytes());
    }
    Ok(format!("sha256:{:x}", h.finalize()))
}

fn code_context(offer_id: &str) -> String {
    format!("delegation:{offer_id}")
}

/// One connection inside an offer, as the minting owner proposes it.
#[derive(Clone, Debug, Deserialize)]
pub struct OfferItemSpec {
    pub connection_id: String,
    /// Defaults to the provider's operation vocabulary minus mutating
    /// operations (`.write` / `push` / `delete` / `admin`).
    #[serde(default)]
    pub actions: Option<Vec<String>>,
    /// Defaults to `["*"]` — every resource the connection reaches.
    #[serde(default)]
    pub resources: Option<Vec<String>>,
    /// Delegation lifetime. Defaults to one hour; never past the owner grant.
    #[serde(default)]
    pub expires_in_seconds: Option<i64>,
    #[serde(default)]
    pub budgets: Option<BTreeMap<String, i64>>,
    /// `broker` (gateway invokes) or `relay` (the holder's runtime executes).
    #[serde(default = "default_execution_mode")]
    pub execution_mode: ExecutionMode,
    #[serde(default = "default_true")]
    pub required: bool,
    /// Indices into the offer's item list this item depends on.
    #[serde(default)]
    pub dependencies: Vec<usize>,
}

fn default_execution_mode() -> ExecutionMode {
    ExecutionMode::Broker
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize)]
pub struct MintOfferRequest {
    pub items: Vec<OfferItemSpec>,
    #[serde(default)]
    pub ttl_seconds: Option<i64>,
}

/// The stored per-item child-grant template, resolved and validated at mint.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct ItemTemplate {
    actions: Vec<String>,
    resources: Vec<String>,
    audiences: Vec<String>,
    expires_in_seconds: i64,
    budgets: BTreeMap<String, i64>,
}

struct PreparedMintItem {
    row: ConnectionRow,
    template: ItemTemplate,
    spec: OfferItemSpec,
}

struct PreparedMintOffer {
    items: Vec<PreparedMintItem>,
    item_ids: Vec<String>,
    manifest: Vec<serde_json::Value>,
    manifest_digest: String,
    offer_id: String,
    claim_token: String,
    user_code: String,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}

struct PreparedClaim {
    item_id: String,
    connection_id: String,
    child: Grant,
    owner_grant_id: GrantId,
    execution_mode: ExecutionMode,
    budgets: BTreeMap<String, i64>,
}

struct ClaimContext {
    offer_id: String,
    owner_subject: String,
    claimant_subject: String,
    now: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
pub struct OfferItemView {
    pub id: String,
    pub connection_id: String,
    pub provider_id: String,
    pub display_name: String,
    pub actions: Vec<String>,
    pub resources: Vec<String>,
    pub expires_in_seconds: i64,
    pub execution_mode: ExecutionMode,
    pub required: bool,
    pub dependencies: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct OfferView {
    pub id: String,
    pub state: String,
    pub manifest_digest: String,
    pub expires_at: String,
    pub items: Vec<OfferItemView>,
}

/// Returned once, at mint. The token and code are never stored or shown again.
#[derive(Debug, Serialize)]
pub struct MintedOffer {
    pub offer: OfferView,
    pub claim_token: String,
    pub user_code: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ClaimOfferRequest {
    pub claim_token: String,
    pub user_code: String,
    /// Every accepted item by id. There is no wildcard: accepting something
    /// unseen is exactly what the manifest step exists to prevent.
    pub accepted_item_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DelegationView {
    pub id: String,
    pub offer_id: String,
    pub connection_id: String,
    pub claimant_subject: String,
    pub grant_id: String,
    pub execution_mode: ExecutionMode,
    pub actions: Vec<String>,
    pub resources: Vec<String>,
    pub expires_at: String,
    pub revoked_at: Option<String>,
}

/// A live delegation resolved for exercise: the row plus its child grant.
#[derive(Clone, Debug)]
pub struct ResolvedDelegation {
    pub delegation_id: String,
    pub offer_id: String,
    pub connection_id: String,
    pub owner_subject: String,
    pub claimant_subject: String,
    pub execution_mode: ExecutionMode,
    pub grant: Grant,
    pub parent_grant_id: GrantId,
}

fn execution_mode_str(mode: ExecutionMode) -> &'static str {
    match mode {
        ExecutionMode::Broker => "broker",
        ExecutionMode::Relay => "relay",
    }
}

fn parse_execution_mode(raw: &str) -> ExecutionMode {
    match raw {
        "relay" => ExecutionMode::Relay,
        _ => ExecutionMode::Broker,
    }
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

fn parse_time(raw: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(raw)
        .map(|t| t.with_timezone(&Utc))
        .unwrap_or(DateTime::<Utc>::MIN_UTC)
}

/// Default delegate action set: the provider vocabulary minus mutating
/// operations. The owner may widen back up to the full set explicitly.
fn default_delegate_actions(operations: &[String]) -> Vec<String> {
    operations
        .iter()
        .filter(|op| {
            let lower = op.to_ascii_lowercase();
            !(lower.contains("write")
                || lower.contains("push")
                || lower.contains("delete")
                || lower.contains("admin"))
        })
        .cloned()
        .collect()
}

fn audiences_for(row: &ConnectionRow) -> Vec<String> {
    row.egress
        .authorities
        .iter()
        .map(|authority| format!("{}://{}", row.egress.scheme, authority))
        .collect()
}

impl ConnectionBroker {
    /// The attenuation ceiling for one connection: a root grant persisted in
    /// the shared `grants` table, minted on first use and stable thereafter so
    /// every offer over the connection shares one revocable ancestor.
    async fn owner_grant_for(&self, row: &ConnectionRow) -> Result<Grant> {
        let existing =
            sqlx::query(
                "SELECT body_json, revoked_at FROM grants
             WHERE json_extract(body_json, '$.connection_id') = ?
               AND json_extract(body_json, '$.parent_grant_id') IS NULL
             ORDER BY created_at ASC LIMIT 1",
            )
            .bind(
                serde_json::to_string(&ConnectionId::parse(&row.id).map_err(|_| {
                    BrokerError::Invalid("connection id is not a ConnectionId".into())
                })?)
                .map_err(internal)?
                .trim_matches('"')
                .to_string(),
            )
            .fetch_optional(&self.pool)
            .await
            .map_err(internal)?;
        if let Some(found) = existing {
            let mut grant: Grant =
                serde_json::from_str(&found.get::<String, _>("body_json")).map_err(internal)?;
            if let Some(revoked) = found.get::<Option<String>, _>("revoked_at") {
                grant.revoked_at = grant.revoked_at.or(Some(parse_time(&revoked)));
            }
            return Ok(grant);
        }

        let provider = self
            .resolve_provider(&row.organization_id, &row.provider_id)
            .await?;
        if provider.operations.is_empty() {
            return Err(BrokerError::Invalid(format!(
                "provider {} has no operation vocabulary; nothing to delegate",
                row.provider_id
            )));
        }
        let now = Utc::now();
        let grant = Grant {
            id: GrantId::new(),
            version: 1,
            issuer_principal_id: PrincipalId::new(),
            beneficiary_principal_id: PrincipalId::new(),
            actor_id: None,
            client_id: None,
            actor_instance_id: None,
            proof_key_thumbprint: None,
            organization_id: OrganizationId::parse(&row.organization_id)
                .map_err(|_| BrokerError::Invalid("connection organization id".into()))?,
            project_id: None,
            environment_id: None,
            connection_id: Some(
                ConnectionId::parse(&row.id)
                    .map_err(|_| BrokerError::Invalid("connection id".into()))?,
            ),
            actions: provider.operations.clone(),
            resources: vec!["*".into()],
            constraints: GrantConstraints {
                audiences: audiences_for(row),
                not_before: None,
                expires_at: now + Duration::days(OWNER_GRANT_TTL_DAYS),
                required_assurance: None,
                authentication_max_age_seconds: None,
                allowed_networks: vec![],
                parameter_rules_digest: None,
                budgets: [(BUDGET_INVOCATIONS.to_string(), OWNER_BUDGET_CEILING)]
                    .into_iter()
                    .collect(),
                maximum_delegation_depth: 1,
                offline_use: OfflineUse::Forbidden,
                raw_credential_export: false,
            },
            parent_grant_id: None,
            delegation_depth: 0,
            created_at: now,
            revoked_at: None,
        };
        materialize_organization(&self.pool, &grant.organization_id.to_string()).await?;
        sqlx::query(
            "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at)
             VALUES (?, ?, ?, NULL, ?)",
        )
        .bind(grant.id.to_string())
        .bind(grant.organization_id.to_string())
        .bind(serde_json::to_string(&grant).map_err(internal)?)
        .bind(grant.created_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .map_err(internal)?;
        Ok(grant)
    }

    /// Resolve the durable full-operation grant for a connection's owner.
    ///
    /// # Errors
    ///
    /// Returns an error when the connection is outside the organization or the
    /// caller is not its owner.
    pub async fn owner_invocation_grant(
        &self,
        organization_id: &OrganizationId,
        connection_id: &str,
        owner_subject: &str,
    ) -> Result<Grant> {
        let row = self.row_in_org(organization_id, connection_id).await?;
        if row.owner_subject.as_deref() != Some(owner_subject) {
            return Err(BrokerError::ConnectionNotFound);
        }
        self.owner_grant_for(&row).await
    }

    /// Mint an offer. Every fence runs per item, and any failure fails the
    /// whole mint: silently dropping an ineligible member would hand the
    /// claimant a different bundle than the owner reviewed.
    ///
    /// # Errors
    ///
    /// Returns an error when the request is invalid, an item is not owned and
    /// delegable, attenuation fails, or persistence fails.
    pub async fn mint_delegation_offer(
        &self,
        organization_id: &OrganizationId,
        owner_subject: &str,
        request: MintOfferRequest,
        pepper: &str,
    ) -> Result<MintedOffer> {
        let ttl = Self::validate_mint_request(&request)?;
        let now = Utc::now();
        let items = self
            .prepare_mint_items(organization_id, owner_subject, request.items, now)
            .await?;
        let prepared = Self::assemble_mint_offer(items, now, ttl)?;
        self.persist_mint_offer(organization_id, owner_subject, pepper, &prepared)
            .await?;

        for item in &prepared.items {
            store::append_event(
                &self.pool,
                &item.row.id,
                EventKind::Delegated,
                Some(&format!("offer {} minted", prepared.offer_id)),
            )
            .await?;
        }

        Ok(MintedOffer {
            offer: self.offer_view(&prepared.offer_id).await?,
            claim_token: prepared.claim_token,
            user_code: prepared.user_code,
        })
    }

    fn validate_mint_request(request: &MintOfferRequest) -> Result<i64> {
        if request.items.is_empty() {
            return Err(BrokerError::Invalid(
                "an offer needs at least one item".into(),
            ));
        }
        if request.items.len() > MAX_ITEMS {
            return Err(BrokerError::Invalid(format!(
                "an offer carries at most {MAX_ITEMS} items"
            )));
        }
        let ttl = request.ttl_seconds.unwrap_or(OFFER_TTL_DEFAULT_SECONDS);
        if !(30..=OFFER_TTL_CEILING_SECONDS).contains(&ttl) {
            return Err(BrokerError::Invalid(format!(
                "offer ttl must be 30..={OFFER_TTL_CEILING_SECONDS} seconds"
            )));
        }
        let missing_sibling = request
            .items
            .iter()
            .flat_map(|item| &item.dependencies)
            .any(|dependency| *dependency >= request.items.len());
        if missing_sibling {
            return Err(BrokerError::Invalid(
                "item dependency references a missing sibling".into(),
            ));
        }
        Ok(ttl)
    }

    async fn prepare_mint_items(
        &self,
        organization_id: &OrganizationId,
        owner_subject: &str,
        items: Vec<OfferItemSpec>,
        now: DateTime<Utc>,
    ) -> Result<Vec<PreparedMintItem>> {
        let mut prepared = Vec::with_capacity(items.len());
        for item in items {
            prepared.push(
                self.prepare_mint_item(organization_id, owner_subject, item, now)
                    .await?,
            );
        }
        Ok(prepared)
    }

    async fn prepare_mint_item(
        &self,
        organization_id: &OrganizationId,
        owner_subject: &str,
        spec: OfferItemSpec,
        now: DateTime<Utc>,
    ) -> Result<PreparedMintItem> {
        let row = store::get_connection(&self.pool, &spec.connection_id)
            .await?
            .ok_or(BrokerError::ConnectionNotFound)?;
        if row.organization_id != organization_id.to_string()
            || row.owner_subject.as_deref() != Some(owner_subject)
        {
            return Err(BrokerError::ConnectionNotFound);
        }
        if row.status != crate::model::ConnectionStatus::Active {
            return Err(BrokerError::Invalid(format!(
                "connection {} is not active",
                row.id
            )));
        }
        if parse_shareability(&row.shareability) == Shareability::Private {
            return Err(BrokerError::Invalid(format!(
                "connection {} is private and cannot be delegated",
                row.id
            )));
        }

        let owner_grant = self.owner_grant_for(&row).await?;
        owner_grant
            .assert_active(now)
            .map_err(|error| BrokerError::Invalid(format!("owner grant is not active: {error}")))?;
        let provider = self
            .resolve_provider(&row.organization_id, &row.provider_id)
            .await?;
        let actions = spec
            .actions
            .clone()
            .unwrap_or_else(|| default_delegate_actions(&provider.operations));
        if actions.is_empty() {
            return Err(BrokerError::Invalid(format!(
                "item for {} delegates no actions",
                row.id
            )));
        }
        let expires_in_seconds = spec
            .expires_in_seconds
            .unwrap_or(DELEGATION_TTL_DEFAULT_SECONDS);
        if expires_in_seconds <= 0 {
            return Err(BrokerError::Invalid(
                "delegation lifetime must be positive".into(),
            ));
        }
        let template = ItemTemplate {
            actions,
            resources: spec.resources.clone().unwrap_or_else(|| vec!["*".into()]),
            audiences: owner_grant.constraints.audiences.clone(),
            expires_in_seconds,
            budgets: spec.budgets.clone().unwrap_or_default(),
        };
        let rehearsal = child_grant_from(&owner_grant, &template, now);
        Grant::validate_attenuation(&owner_grant, &rehearsal).map_err(|error| {
            BrokerError::Invalid(format!("proposed grant is not an attenuation: {error}"))
        })?;
        Ok(PreparedMintItem {
            row,
            template,
            spec,
        })
    }

    fn assemble_mint_offer(
        items: Vec<PreparedMintItem>,
        now: DateTime<Utc>,
        ttl: i64,
    ) -> Result<PreparedMintOffer> {
        let offer_id = format!("dlgo_{}", uuid::Uuid::now_v7().simple());
        let claim_token = format!("osc_dlg_{offer_id}.{}", generate_claim_token());
        let item_ids: Vec<String> = items
            .iter()
            .map(|_| format!("dlgi_{}", uuid::Uuid::now_v7().simple()))
            .collect();

        let manifest: Vec<serde_json::Value> = items
            .iter()
            .zip(&item_ids)
            .map(|(item, id)| {
                serde_json::json!({
                    "id": id,
                    "connection_id": item.row.id,
                    "actions": item.template.actions,
                    "resources": item.template.resources,
                    "expires_in_seconds": item.template.expires_in_seconds,
                    "execution_mode": execution_mode_str(item.spec.execution_mode),
                    "required": item.spec.required,
                    "dependencies": item.spec.dependencies.iter().map(|dependency| item_ids[*dependency].clone()).collect::<Vec<_>>(),
                })
            })
            .collect();
        let mut hasher = Sha256::new();
        hasher.update(
            serde_json::to_string(&manifest)
                .map_err(internal)?
                .as_bytes(),
        );
        Ok(PreparedMintOffer {
            items,
            item_ids,
            manifest,
            manifest_digest: format!("sha256:{:x}", hasher.finalize()),
            offer_id,
            claim_token,
            user_code: generate_user_code(),
            created_at: now,
            expires_at: now + Duration::seconds(ttl),
        })
    }

    async fn persist_mint_offer(
        &self,
        organization_id: &OrganizationId,
        owner_subject: &str,
        pepper: &str,
        prepared: &PreparedMintOffer,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(internal)?;
        sqlx::query(
            "INSERT INTO connection_delegation_offers
             (id, organization_id, owner_subject, claim_token_hash, user_code_hash,
             manifest_digest, code_attempts, state, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)",
        )
        .bind(&prepared.offer_id)
        .bind(organization_id.to_string())
        .bind(owner_subject)
        .bind(token_hash(&prepared.claim_token)?)
        .bind(hash_low_entropy(
            pepper,
            &code_context(&prepared.offer_id),
            &prepared.user_code,
        ))
        .bind(&prepared.manifest_digest)
        .bind(prepared.expires_at.to_rfc3339())
        .bind(prepared.created_at.to_rfc3339())
        .execute(&mut *tx)
        .await
        .map_err(internal)?;

        for (((row, template, spec), item_id), manifest_entry) in prepared
            .items
            .iter()
            .map(|item| (&item.row, &item.template, &item.spec))
            .zip(&prepared.item_ids)
            .zip(&prepared.manifest)
        {
            sqlx::query(
                "INSERT INTO connection_delegation_offer_items
                 (id, offer_id, connection_id, proposed_grant, execution_mode, required, dependencies, state)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')",
            )
            .bind(item_id)
            .bind(&prepared.offer_id)
            .bind(&row.id)
            .bind(serde_json::to_string(template).map_err(internal)?)
            .bind(execution_mode_str(spec.execution_mode))
            .bind(i64::from(spec.required))
            .bind(
                serde_json::to_string(&manifest_entry["dependencies"]).map_err(internal)?,
            )
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        }
        tx.commit().await.map_err(internal)?;
        Ok(())
    }

    async fn offer_view(&self, offer_id: &str) -> Result<OfferView> {
        let offer = sqlx::query(
            "SELECT id, state, manifest_digest, expires_at FROM connection_delegation_offers WHERE id = ?",
        )
        .bind(offer_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?
        .ok_or(BrokerError::ConnectionNotFound)?;
        let items = sqlx::query(
            "SELECT id, connection_id, proposed_grant, execution_mode, required, dependencies
             FROM connection_delegation_offer_items WHERE offer_id = ? ORDER BY id ASC",
        )
        .bind(offer_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        let mut views = Vec::with_capacity(items.len());
        for item in items {
            let connection_id: String = item.get("connection_id");
            let row = store::get_connection(&self.pool, &connection_id)
                .await?
                .ok_or(BrokerError::ConnectionNotFound)?;
            let template: ItemTemplate =
                serde_json::from_str(&item.get::<String, _>("proposed_grant")).map_err(internal)?;
            views.push(OfferItemView {
                id: item.get("id"),
                connection_id,
                provider_id: row.provider_id,
                display_name: row.display_name,
                actions: template.actions,
                resources: template.resources,
                expires_in_seconds: template.expires_in_seconds,
                execution_mode: parse_execution_mode(&item.get::<String, _>("execution_mode")),
                required: item.get::<i64, _>("required") != 0,
                dependencies: serde_json::from_str(&item.get::<String, _>("dependencies"))
                    .map_err(internal)?,
            });
        }
        Ok(OfferView {
            id: offer.get("id"),
            state: offer.get("state"),
            manifest_digest: offer.get("manifest_digest"),
            expires_at: offer.get("expires_at"),
            items: views,
        })
    }

    /// Spend the offer's single presentation and return the manifest.
    ///
    /// First presenter wins a CAS; a second present is malfeasance evidence
    /// and burns the offer with everything minted from it. Expired offers
    /// answer the same way as unknown tokens where possible: this surface is
    /// reached by URL alone and must not become an oracle.
    ///
    /// # Errors
    ///
    /// Returns an error when the token is unknown, expired, reused, or when
    /// the state transition cannot be persisted.
    pub async fn present_delegation_offer(&self, claim_token: &str) -> Result<OfferView> {
        let hash = token_hash(claim_token)?;
        let offer = sqlx::query(
            "SELECT id, state, expires_at FROM connection_delegation_offers WHERE claim_token_hash = ?",
        )
        .bind(&hash)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?
        .ok_or(BrokerError::ConnectionNotFound)?;
        let offer_id: String = offer.get("id");
        let state: String = offer.get("state");
        let expires_at = parse_time(&offer.get::<String, _>("expires_at"));
        let now = Utc::now();

        if now >= expires_at && state == "pending" {
            sqlx::query(
                "UPDATE connection_delegation_offers SET state = 'expired' WHERE id = ? AND state = 'pending'",
            )
            .bind(&offer_id)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
            return Err(BrokerError::StateExpired);
        }

        match state.as_str() {
            "pending" => {
                let spent = sqlx::query(
                    "UPDATE connection_delegation_offers
                     SET state = 'presented', presented_at = ?
                     WHERE id = ? AND state = 'pending'",
                )
                .bind(now_rfc3339())
                .bind(&offer_id)
                .execute(&self.pool)
                .await
                .map_err(internal)?;
                if spent.rows_affected() != 1 {
                    // Lost the race: whoever won holds the presentation, and
                    // this caller is the second presenter.
                    self.burn_offer(&offer_id).await?;
                    return Err(BrokerError::InvalidState);
                }
                self.offer_view(&offer_id).await
            }
            // The token was seen again after its spend. The only safe
            // assumption is that the link leaked and the race's winner may
            // have been the attacker.
            "presented" | "claimed" => {
                self.burn_offer(&offer_id).await?;
                Err(BrokerError::InvalidState)
            }
            _ => Err(BrokerError::InvalidState),
        }
    }

    /// Complete a presented offer: verify the out-of-band code, check the
    /// accepted set, and mint one child grant + delegation per accepted item
    /// in a single transaction. Partial success does not exist.
    ///
    /// # Errors
    ///
    /// Returns an error when the token, state, code, accepted item set, or
    /// attenuation is invalid, or when the atomic persistence step fails.
    pub async fn claim_delegation_offer(
        &self,
        request: ClaimOfferRequest,
        claimant_subject: &str,
        pepper: &str,
    ) -> Result<Vec<DelegationView>> {
        let context = self
            .validate_claim_offer(&request, claimant_subject, pepper)
            .await?;
        let items = self.load_offer_items(&context.offer_id).await?;
        Self::validate_accepted_items(&items, &request.accepted_item_ids)?;
        let (accepted, rejected) = self
            .prepare_claims(&items, &request.accepted_item_ids, context.now)
            .await?;
        if accepted.is_empty() {
            return Err(BrokerError::Invalid("nothing was accepted".into()));
        }
        let (views, touched_connections) =
            self.persist_claims(&context, &accepted, &rejected).await?;
        for connection_id in touched_connections {
            store::append_event(
                &self.pool,
                &connection_id,
                EventKind::Delegated,
                Some(&format!("offer {} claimed", context.offer_id)),
            )
            .await?;
        }
        Ok(views)
    }

    async fn validate_claim_offer(
        &self,
        request: &ClaimOfferRequest,
        claimant_subject: &str,
        pepper: &str,
    ) -> Result<ClaimContext> {
        if claimant_subject.trim().is_empty() {
            return Err(BrokerError::Invalid("claimant subject required".into()));
        }
        let hash = token_hash(&request.claim_token)?;
        let offer = sqlx::query(
            "SELECT id, organization_id, owner_subject, user_code_hash, code_attempts, state, expires_at
             FROM connection_delegation_offers WHERE claim_token_hash = ?",
        )
        .bind(&hash)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?
        .ok_or(BrokerError::ConnectionNotFound)?;
        let offer_id: String = offer.get("id");
        let state: String = offer.get("state");
        let now = Utc::now();
        if now >= parse_time(&offer.get::<String, _>("expires_at")) {
            return Err(BrokerError::StateExpired);
        }
        if state != "presented" {
            return Err(BrokerError::InvalidState);
        }
        let owner_subject: String = offer.get("owner_subject");
        if owner_subject == claimant_subject {
            return Err(BrokerError::Invalid(
                "an owner cannot claim their own offer".into(),
            ));
        }

        let expected_code = offer.get::<String, _>("user_code_hash");
        let presented_code =
            hash_low_entropy(pepper, &code_context(&offer_id), request.user_code.trim());
        if !hash_eq(&presented_code, &expected_code) {
            let attempts: i64 = offer.get("code_attempts");
            if attempts + 1 >= MAX_CODE_ATTEMPTS {
                // The link-holder is guessing the out-of-band code. Burn.
                self.burn_offer(&offer_id).await?;
            } else {
                sqlx::query(
                    "UPDATE connection_delegation_offers SET code_attempts = code_attempts + 1 WHERE id = ?",
                )
                .bind(&offer_id)
                .execute(&self.pool)
                .await
                .map_err(internal)?;
            }
            return Err(BrokerError::Invalid("user code mismatch".into()));
        }
        Ok(ClaimContext {
            offer_id,
            owner_subject,
            claimant_subject: claimant_subject.to_string(),
            now,
        })
    }

    async fn load_offer_items(&self, offer_id: &str) -> Result<Vec<SqliteRow>> {
        sqlx::query(
            "SELECT id, connection_id, proposed_grant, execution_mode, required, dependencies
             FROM connection_delegation_offer_items WHERE offer_id = ?",
        )
        .bind(offer_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)
    }

    fn validate_accepted_items(items: &[SqliteRow], accepted_item_ids: &[String]) -> Result<()> {
        let known: Vec<String> = items.iter().map(|i| i.get::<String, _>("id")).collect();
        for accepted in accepted_item_ids {
            if !known.contains(accepted) {
                return Err(BrokerError::Invalid(
                    "accepted item is not in this offer".into(),
                ));
            }
        }
        for item in items {
            let id: String = item.get("id");
            let required = item.get::<i64, _>("required") != 0;
            if required && !accepted_item_ids.contains(&id) {
                return Err(BrokerError::Invalid(format!(
                    "required item {id} was not accepted"
                )));
            }
            if !accepted_item_ids.contains(&id) {
                continue;
            }
            let dependencies: Vec<String> =
                serde_json::from_str(&item.get::<String, _>("dependencies")).map_err(internal)?;
            if let Some(missing) = dependencies
                .into_iter()
                .find(|dependency| !accepted_item_ids.contains(dependency))
            {
                return Err(BrokerError::Invalid(format!(
                    "accepted item {id} depends on {missing}, which was not accepted"
                )));
            }
        }
        Ok(())
    }

    async fn prepare_claims(
        &self,
        items: &[SqliteRow],
        accepted_item_ids: &[String],
        now: DateTime<Utc>,
    ) -> Result<(Vec<PreparedClaim>, Vec<String>)> {
        let mut accepted = Vec::new();
        let mut rejected = Vec::new();
        for item in items {
            let item_id: String = item.get("id");
            if !accepted_item_ids.contains(&item_id) {
                rejected.push(item_id);
                continue;
            }
            accepted.push(self.prepare_claim(item, item_id, now).await?);
        }
        Ok((accepted, rejected))
    }

    async fn prepare_claim(
        &self,
        item: &SqliteRow,
        item_id: String,
        now: DateTime<Utc>,
    ) -> Result<PreparedClaim> {
        let connection_id: String = item.get("connection_id");
        let row = store::get_connection(&self.pool, &connection_id)
            .await?
            .ok_or(BrokerError::ConnectionNotFound)?;
        if row.status != crate::model::ConnectionStatus::Active {
            return Err(BrokerError::Invalid(format!(
                "connection {connection_id} is no longer active"
            )));
        }
        let template: ItemTemplate =
            serde_json::from_str(&item.get::<String, _>("proposed_grant")).map_err(internal)?;
        let owner_grant = self.owner_grant_for(&row).await?;
        owner_grant
            .assert_active(now)
            .map_err(|error| BrokerError::Invalid(format!("owner grant is not active: {error}")))?;
        let mut child = child_grant_from(&owner_grant, &template, now);
        child.parent_grant_id = Some(owner_grant.id);
        child.delegation_depth = owner_grant.delegation_depth + 1;
        Grant::validate_attenuation(&owner_grant, &child).map_err(|error| {
            BrokerError::Invalid(format!("attenuation failed at claim: {error}"))
        })?;
        Ok(PreparedClaim {
            item_id,
            connection_id,
            child,
            owner_grant_id: owner_grant.id,
            execution_mode: parse_execution_mode(&item.get::<String, _>("execution_mode")),
            budgets: template.budgets,
        })
    }

    async fn persist_claims(
        &self,
        context: &ClaimContext,
        accepted: &[PreparedClaim],
        rejected_item_ids: &[String],
    ) -> Result<(Vec<DelegationView>, Vec<String>)> {
        let mut tx = self.pool.begin().await.map_err(internal)?;
        let claimed = sqlx::query(
            "UPDATE connection_delegation_offers
             SET state = 'claimed', claimed_at = ?
             WHERE id = ? AND state = 'presented'",
        )
        .bind(now_rfc3339())
        .bind(&context.offer_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        if claimed.rows_affected() != 1 {
            return Err(BrokerError::InvalidState);
        }
        for item_id in rejected_item_ids {
            sqlx::query(
                "UPDATE connection_delegation_offer_items SET state = 'rejected' WHERE id = ?",
            )
            .bind(item_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        }

        let mut views = Vec::with_capacity(accepted.len());
        let mut touched_connections = Vec::with_capacity(accepted.len());
        for plan in accepted {
            views.push(Self::persist_claim(&mut tx, context, plan).await?);
            touched_connections.push(plan.connection_id.clone());
        }
        tx.commit().await.map_err(internal)?;
        Ok((views, touched_connections))
    }

    async fn persist_claim(
        tx: &mut Transaction<'_, Sqlite>,
        context: &ClaimContext,
        plan: &PreparedClaim,
    ) -> Result<DelegationView> {
        sqlx::query("UPDATE connection_delegation_offer_items SET state = 'accepted' WHERE id = ?")
            .bind(&plan.item_id)
            .execute(&mut **tx)
            .await
            .map_err(internal)?;
        sqlx::query(
            "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at)
             VALUES (?, ?, ?, NULL, ?)",
        )
        .bind(plan.child.id.to_string())
        .bind(plan.child.organization_id.to_string())
        .bind(serde_json::to_string(&plan.child).map_err(internal)?)
        .bind(plan.child.created_at.to_rfc3339())
        .execute(&mut **tx)
        .await
        .map_err(internal)?;

        let delegation_id = format!("dlg_{}", uuid::Uuid::now_v7().simple());
        sqlx::query(
            "INSERT INTO connection_delegations
             (id, offer_id, offer_item_id, connection_id, organization_id, owner_subject,
              claimant_subject, claimant_instance_jkt, grant_id, parent_grant_id,
              delegation_depth, execution_mode, budget_remaining, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&delegation_id)
        .bind(&context.offer_id)
        .bind(&plan.item_id)
        .bind(&plan.connection_id)
        .bind(plan.child.organization_id.to_string())
        .bind(&context.owner_subject)
        .bind(&context.claimant_subject)
        .bind(plan.child.id.to_string())
        .bind(plan.owner_grant_id.to_string())
        .bind(i64::from(plan.child.delegation_depth))
        .bind(execution_mode_str(plan.execution_mode))
        .bind(serde_json::to_string(&plan.budgets).map_err(internal)?)
        .bind(plan.child.constraints.expires_at.to_rfc3339())
        .bind(context.now.to_rfc3339())
        .execute(&mut **tx)
        .await
        .map_err(internal)?;

        sqlx::query(
            "INSERT OR IGNORE INTO connection_bindings (id, connection_id, target_kind, target_id, target_label, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(uuid::Uuid::now_v7().to_string())
        .bind(&plan.connection_id)
        .bind(BindingTargetKind::Identity.as_str())
        .bind(&context.claimant_subject)
        .bind(Some(format!("delegation {delegation_id}")))
        .bind(context.now.to_rfc3339())
        .execute(&mut **tx)
        .await
        .map_err(internal)?;

        Ok(DelegationView {
            id: delegation_id,
            offer_id: context.offer_id.clone(),
            connection_id: plan.connection_id.clone(),
            claimant_subject: context.claimant_subject.clone(),
            grant_id: plan.child.id.to_string(),
            execution_mode: plan.execution_mode,
            actions: plan.child.actions.clone(),
            resources: plan.child.resources.clone(),
            expires_at: plan.child.constraints.expires_at.to_rfc3339(),
            revoked_at: None,
        })
    }

    /// Burn an offer: the token was seen after its spend, or the code was
    /// guessed at. Every delegation minted from the offer is revoked in the
    /// same transaction — the race's winner may have been the attacker.
    async fn burn_offer(&self, offer_id: &str) -> Result<()> {
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await.map_err(internal)?;
        sqlx::query(
            "UPDATE connection_delegation_offers
             SET state = 'burned', revoked_at = ?
             WHERE id = ? AND state NOT IN ('burned')",
        )
        .bind(&now)
        .bind(offer_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        sqlx::query(
            "UPDATE grants SET revoked_at = ?
             WHERE revoked_at IS NULL
               AND id IN (SELECT grant_id FROM connection_delegations WHERE offer_id = ?)",
        )
        .bind(&now)
        .bind(offer_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        sqlx::query(
            "UPDATE connection_delegations SET revoked_at = ? WHERE offer_id = ? AND revoked_at IS NULL",
        )
        .bind(&now)
        .bind(offer_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        let connections: Vec<String> = sqlx::query(
            "SELECT DISTINCT connection_id FROM connection_delegation_offer_items WHERE offer_id = ?",
        )
        .bind(offer_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(internal)?
        .into_iter()
        .map(|r| r.get("connection_id"))
        .collect();
        tx.commit().await.map_err(internal)?;
        for connection_id in connections {
            store::append_event(
                &self.pool,
                &connection_id,
                EventKind::DelegationBurned,
                Some(&format!("offer {offer_id} burned")),
            )
            .await?;
        }
        Ok(())
    }

    /// Owner revokes an unclaimed offer (or the whole set, if claimed).
    ///
    /// # Errors
    ///
    /// Returns an error when the offer is not owned by the caller or the
    /// atomic revocation cannot be persisted.
    pub async fn revoke_delegation_offer(
        &self,
        organization_id: &OrganizationId,
        owner_subject: &str,
        offer_id: &str,
    ) -> Result<()> {
        let offer = sqlx::query(
            "SELECT owner_subject, organization_id FROM connection_delegation_offers WHERE id = ?",
        )
        .bind(offer_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?
        .ok_or(BrokerError::ConnectionNotFound)?;
        if offer.get::<String, _>("organization_id") != organization_id.to_string()
            || offer.get::<String, _>("owner_subject") != owner_subject
        {
            return Err(BrokerError::ConnectionNotFound);
        }
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await.map_err(internal)?;
        sqlx::query(
            "UPDATE connection_delegation_offers SET state = 'revoked', revoked_at = ?
             WHERE id = ? AND state NOT IN ('burned', 'revoked')",
        )
        .bind(&now)
        .bind(offer_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        sqlx::query(
            "UPDATE grants SET revoked_at = ?
             WHERE revoked_at IS NULL
               AND id IN (SELECT grant_id FROM connection_delegations WHERE offer_id = ?)",
        )
        .bind(&now)
        .bind(offer_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        sqlx::query(
            "UPDATE connection_delegations SET revoked_at = ? WHERE offer_id = ? AND revoked_at IS NULL",
        )
        .bind(&now)
        .bind(offer_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        tx.commit().await.map_err(internal)?;
        Ok(())
    }

    /// Revoke one delegation. The owner may revoke any; a claimant may drop
    /// what they hold, never anyone else's.
    ///
    /// # Errors
    ///
    /// Returns an error when the delegation is not visible to the caller or
    /// its grant and delegation records cannot be revoked atomically.
    pub async fn revoke_delegation(
        &self,
        organization_id: &OrganizationId,
        caller_subject: &str,
        delegation_id: &str,
    ) -> Result<()> {
        let row = sqlx::query(
            "SELECT owner_subject, claimant_subject, organization_id, grant_id, connection_id
             FROM connection_delegations WHERE id = ?",
        )
        .bind(delegation_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?
        .ok_or(BrokerError::ConnectionNotFound)?;
        if row.get::<String, _>("organization_id") != organization_id.to_string() {
            return Err(BrokerError::ConnectionNotFound);
        }
        let owner: String = row.get("owner_subject");
        let claimant: String = row.get("claimant_subject");
        if caller_subject != owner && caller_subject != claimant {
            // 404, not 403: the id space stays unenumerable.
            return Err(BrokerError::ConnectionNotFound);
        }
        let now = now_rfc3339();
        let grant_id: String = row.get("grant_id");
        let connection_id: String = row.get("connection_id");
        let mut tx = self.pool.begin().await.map_err(internal)?;
        sqlx::query(
            "UPDATE connection_delegations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .bind(&now)
        .bind(delegation_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        sqlx::query("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
            .bind(&now)
            .bind(&grant_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        tx.commit().await.map_err(internal)?;
        store::append_event(
            &self.pool,
            &connection_id,
            EventKind::DelegationRevoked,
            Some(&format!("delegation {delegation_id} revoked")),
        )
        .await?;
        Ok(())
    }

    /// Narrow a live delegation (ADR 0046 decision 10): revoke-and-replace
    /// with a grant validated against the parent AND the child it replaces.
    /// Widening is refused there, so this endpoint cannot grow authority back.
    ///
    /// # Errors
    ///
    /// Returns an error when the delegation is unavailable, the replacement
    /// widens authority, or the revoke-and-replace transaction fails.
    pub async fn narrow_delegation(
        &self,
        organization_id: &OrganizationId,
        owner_subject: &str,
        delegation_id: &str,
        actions: Option<Vec<String>>,
        resources: Option<Vec<String>>,
        expires_in_seconds: Option<i64>,
    ) -> Result<DelegationView> {
        let row = sqlx::query(
            "SELECT offer_id, connection_id, organization_id, owner_subject, claimant_subject,
                    grant_id, parent_grant_id, execution_mode, revoked_at, expires_at
             FROM connection_delegations WHERE id = ?",
        )
        .bind(delegation_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?
        .ok_or(BrokerError::ConnectionNotFound)?;
        if row.get::<String, _>("organization_id") != organization_id.to_string()
            || row.get::<String, _>("owner_subject") != owner_subject
        {
            return Err(BrokerError::ConnectionNotFound);
        }
        if row.get::<Option<String>, _>("revoked_at").is_some() {
            return Err(BrokerError::InvalidState);
        }
        let current = self
            .load_grant(&row.get::<String, _>("grant_id"))
            .await?
            .ok_or(BrokerError::InvalidState)?;
        let parent = self
            .load_grant(&row.get::<String, _>("parent_grant_id"))
            .await?
            .ok_or(BrokerError::InvalidState)?;

        let now = Utc::now();
        let mut replacement = current.clone();
        replacement.id = GrantId::new();
        replacement.created_at = now;
        if let Some(actions) = actions {
            replacement.actions = actions;
        }
        if let Some(resources) = resources {
            replacement.resources = resources;
        }
        if let Some(seconds) = expires_in_seconds {
            if seconds <= 0 {
                return Err(BrokerError::Invalid("lifetime must be positive".into()));
            }
            replacement.constraints.expires_at = now + Duration::seconds(seconds);
        }
        Grant::validate_replacement(&parent, &current, &replacement)
            .map_err(|e| BrokerError::Invalid(format!("not a narrowing: {e}")))?;

        let stamp = now_rfc3339();
        let mut tx = self.pool.begin().await.map_err(internal)?;
        sqlx::query(
            "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at)
             VALUES (?, ?, ?, NULL, ?)",
        )
        .bind(replacement.id.to_string())
        .bind(replacement.organization_id.to_string())
        .bind(serde_json::to_string(&replacement).map_err(internal)?)
        .bind(replacement.created_at.to_rfc3339())
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        sqlx::query("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
            .bind(&stamp)
            .bind(current.id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        sqlx::query("UPDATE connection_delegations SET grant_id = ?, expires_at = ? WHERE id = ?")
            .bind(replacement.id.to_string())
            .bind(replacement.constraints.expires_at.to_rfc3339())
            .bind(delegation_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        tx.commit().await.map_err(internal)?;

        Ok(DelegationView {
            id: delegation_id.to_string(),
            offer_id: row.get("offer_id"),
            connection_id: row.get("connection_id"),
            claimant_subject: row.get("claimant_subject"),
            grant_id: replacement.id.to_string(),
            execution_mode: parse_execution_mode(&row.get::<String, _>("execution_mode")),
            actions: replacement.actions.clone(),
            resources: replacement.resources.clone(),
            expires_at: replacement.constraints.expires_at.to_rfc3339(),
            revoked_at: None,
        })
    }

    async fn load_grant(&self, id: &str) -> Result<Option<Grant>> {
        let row = sqlx::query("SELECT body_json, revoked_at FROM grants WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal)?;
        let Some(row) = row else { return Ok(None) };
        let mut grant: Grant =
            serde_json::from_str(&row.get::<String, _>("body_json")).map_err(internal)?;
        if let Some(revoked) = row.get::<Option<String>, _>("revoked_at") {
            grant.revoked_at = grant.revoked_at.or(Some(parse_time(&revoked)));
        }
        Ok(Some(grant))
    }

    /// The caller's live delegation for a connection, with its child grant —
    /// what the invoke path resolves a submitted `ConnectionRef` against.
    ///
    /// # Errors
    ///
    /// Returns an error when stored identifiers or grants are malformed, or
    /// when persistence cannot be queried.
    pub async fn find_live_delegation(
        &self,
        claimant_subject: &str,
        connection_id: &str,
    ) -> Result<Option<ResolvedDelegation>> {
        let now = Utc::now();
        let row = sqlx::query(
            "SELECT id, offer_id, connection_id, owner_subject, claimant_subject, grant_id,
                    parent_grant_id, execution_mode, expires_at
             FROM connection_delegations
             WHERE claimant_subject = ? AND connection_id = ? AND revoked_at IS NULL
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(claimant_subject)
        .bind(connection_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        let Some(row) = row else { return Ok(None) };
        if now >= parse_time(&row.get::<String, _>("expires_at")) {
            return Ok(None);
        }
        let Some(grant) = self.load_grant(&row.get::<String, _>("grant_id")).await? else {
            return Ok(None);
        };
        if grant.assert_active(now).is_err() {
            return Ok(None);
        }
        // Ancestor revocation kills descendants: a live child under a dead
        // parent is authority that outlived the thing it narrowed.
        if let Some(parent) = self
            .load_grant(&row.get::<String, _>("parent_grant_id"))
            .await?
        {
            if parent.assert_active(now).is_err() {
                return Ok(None);
            }
        } else {
            return Ok(None);
        }
        let parent_grant_id = GrantId::parse(&row.get::<String, _>("parent_grant_id"))
            .map_err(|_| BrokerError::Invalid("stored parent grant id".into()))?;
        Ok(Some(ResolvedDelegation {
            delegation_id: row.get("id"),
            offer_id: row.get("offer_id"),
            connection_id: row.get("connection_id"),
            owner_subject: row.get("owner_subject"),
            claimant_subject: row.get("claimant_subject"),
            execution_mode: parse_execution_mode(&row.get::<String, _>("execution_mode")),
            grant,
            parent_grant_id,
        }))
    }

    /// Spend one unit of a delegation budget, atomically. Deny when the
    /// decrement cannot be performed — exhausted or contended past retry —
    /// the same fail-closed posture as `authority_quorum_ok` (ADR 0044).
    ///
    /// # Errors
    ///
    /// Returns an error when the delegation is missing, the budget is
    /// exhausted or malformed, contention persists, or persistence fails.
    pub async fn spend_delegation_budget(&self, delegation_id: &str, key: &str) -> Result<()> {
        for _ in 0..3 {
            let budget_row =
                sqlx::query("SELECT budget_remaining FROM connection_delegations WHERE id = ?")
                    .bind(delegation_id)
                    .fetch_optional(&self.pool)
                    .await
                    .map_err(internal)?
                    .ok_or(BrokerError::ConnectionNotFound)?;
            let serialized: Option<String> = budget_row.get("budget_remaining");
            let Some(serialized) = serialized else {
                return Ok(());
            };
            let mut budgets: BTreeMap<String, i64> =
                serde_json::from_str(&serialized).map_err(internal)?;
            let Some(remaining) = budgets.get(key).copied() else {
                // No budget on this key means the offer chose not to meter it.
                return Ok(());
            };
            if remaining <= 0 {
                return Err(BrokerError::Invalid(format!("budget exhausted: {key}")));
            }
            budgets.insert(key.to_string(), remaining - 1);
            let updated = sqlx::query(
                "UPDATE connection_delegations SET budget_remaining = ? WHERE id = ? AND budget_remaining = ?",
            )
            .bind(serde_json::to_string(&budgets).map_err(internal)?)
            .bind(delegation_id)
            .bind(&serialized)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
            if updated.rows_affected() == 1 {
                return Ok(());
            }
        }
        Err(BrokerError::Invalid("budget contention; denied".into()))
    }

    /// Offers minted by this owner (management surface).
    ///
    /// # Errors
    ///
    /// Returns an error when the offer records cannot be loaded.
    pub async fn list_delegation_offers(
        &self,
        organization_id: &OrganizationId,
        owner_subject: &str,
    ) -> Result<Vec<OfferView>> {
        let ids: Vec<String> = sqlx::query(
            "SELECT id FROM connection_delegation_offers
             WHERE organization_id = ? AND owner_subject = ? ORDER BY created_at DESC",
        )
        .bind(organization_id.to_string())
        .bind(owner_subject)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?
        .into_iter()
        .map(|r| r.get("id"))
        .collect();
        let mut views = Vec::with_capacity(ids.len());
        for id in ids {
            views.push(self.offer_view(&id).await?);
        }
        Ok(views)
    }

    /// Delegations where the caller is owner or claimant.
    ///
    /// # Errors
    ///
    /// Returns an error when delegation or grant records cannot be loaded.
    pub async fn list_delegations_for(
        &self,
        organization_id: &OrganizationId,
        subject: &str,
    ) -> Result<Vec<DelegationView>> {
        let rows = sqlx::query(
            "SELECT id, offer_id, connection_id, claimant_subject, grant_id, execution_mode,
                    expires_at, revoked_at
             FROM connection_delegations
             WHERE organization_id = ? AND (owner_subject = ? OR claimant_subject = ?)
             ORDER BY created_at DESC",
        )
        .bind(organization_id.to_string())
        .bind(subject)
        .bind(subject)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        let mut views = Vec::with_capacity(rows.len());
        for row in rows {
            let grant = self.load_grant(&row.get::<String, _>("grant_id")).await?;
            views.push(DelegationView {
                id: row.get("id"),
                offer_id: row.get("offer_id"),
                connection_id: row.get("connection_id"),
                claimant_subject: row.get("claimant_subject"),
                grant_id: row.get("grant_id"),
                execution_mode: parse_execution_mode(&row.get::<String, _>("execution_mode")),
                actions: grant
                    .as_ref()
                    .map(|g| g.actions.clone())
                    .unwrap_or_default(),
                resources: grant
                    .as_ref()
                    .map(|g| g.resources.clone())
                    .unwrap_or_default(),
                expires_at: row.get("expires_at"),
                revoked_at: row.get("revoked_at"),
            });
        }
        Ok(views)
    }
}

fn child_grant_from(owner: &Grant, template: &ItemTemplate, now: DateTime<Utc>) -> Grant {
    Grant {
        id: GrantId::new(),
        version: 1,
        issuer_principal_id: owner.issuer_principal_id,
        beneficiary_principal_id: PrincipalId::new(),
        actor_id: None,
        client_id: None,
        actor_instance_id: None,
        proof_key_thumbprint: None,
        organization_id: owner.organization_id,
        project_id: owner.project_id,
        environment_id: None,
        connection_id: owner.connection_id,
        actions: template.actions.clone(),
        resources: template.resources.clone(),
        constraints: GrantConstraints {
            audiences: template.audiences.clone(),
            not_before: None,
            expires_at: (now + Duration::seconds(template.expires_in_seconds))
                .min(owner.constraints.expires_at),
            required_assurance: None,
            authentication_max_age_seconds: None,
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: template.budgets.clone(),
            // No re-delegation unless the owner opts in — and the owner
            // ceiling caps it at one hop regardless.
            maximum_delegation_depth: owner.constraints.maximum_delegation_depth,
            offline_use: OfflineUse::Forbidden,
            raw_credential_export: false,
        },
        parent_grant_id: Some(owner.id),
        delegation_depth: owner.delegation_depth + 1,
        created_at: now,
        revoked_at: None,
    }
}

fn internal<E: std::fmt::Display>(e: E) -> BrokerError {
    BrokerError::Invalid(format!("delegation storage: {e}"))
}

/// `grants.organization_id` carries a foreign key. Organization membership is
/// established by Identity before the Host mints a session; materialize the
/// trusted tenant locally so a grant can satisfy the boundary (the same rule
/// `Db::insert_connection` follows).
async fn materialize_organization<'e, E>(executor: E, organization_id: &str) -> Result<()>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
        .bind(organization_id)
        .bind(organization_id)
        .bind(now_rfc3339())
        .execute(executor)
        .await
        .map_err(internal)?;
    Ok(())
}
