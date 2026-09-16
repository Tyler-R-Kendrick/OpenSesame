//! Group offers, and why activating one is not spending a group token.
//!
//! An offer names a cohort and the envelope grant its activations must stay
//! inside. It authorizes nobody by existing. Activation is one transaction that
//! does three things together — count the activation against the cardinality cap,
//! record who was admitted and on what membership provenance, and bind the
//! individual grant — so there is no window in which a person holds authority the
//! roster does not account for, and no retry that mints a second grant.
//!
//! The two unique keys do the work a service must not be trusted to do:
//! `(offer_id, beneficiary_principal_id)` means one activation per person, and
//! `(organization_id, idempotency_key)` means a redelivered claim is the same
//! claim.

use crate::{append_outbox_tx, Db, Utc};

/// An offer to create.
pub struct NewGrantOffer<'a> {
    pub id: &'a str,
    pub organization_id: &'a str,
    pub domain_id: &'a str,
    pub cohort_id: &'a str,
    pub cohort_revision: i64,
    /// `snapshot` binds the roster as reviewed; `live` admits under a trusted
    /// writer's envelope. The distinction is recorded because the two have
    /// different revocation meanings.
    pub membership_binding: &'a str,
    /// The grant whose envelope every activation must stay inside. It must
    /// already carry generalized authority.
    pub envelope_grant_id: &'a str,
    pub max_activations: i64,
}

/// One person's activation of an offer.
pub struct OfferActivation<'a> {
    pub offer_id: &'a str,
    pub organization_id: &'a str,
    pub beneficiary_principal_id: &'a str,
    /// The individually bound grant that already carries generalized authority
    /// inside the offer's envelope.
    pub grant_id: &'a str,
    pub cohort_revision: i64,
    pub membership_source: &'a str,
    pub membership_issuer: &'a str,
    pub idempotency_key: &'a str,
}

/// What an activation attempt did.
#[derive(Debug, PartialEq, Eq)]
pub enum ActivationOutcome {
    /// The activation was counted and bound.
    Bound,
    /// This person, or this idempotency key, already activated.
    Duplicate,
    /// The offer is revoked, absent, out of activations, or the roster revision
    /// the claimant presented is not the one the offer was reviewed against.
    Refused,
}

impl Db {
    /// Create an offer against an envelope grant.
    ///
    /// # Errors
    ///
    /// Returns an error when the insert or its outbox event cannot commit.
    pub async fn create_grant_offer(&self, offer: &NewGrantOffer<'_>) -> anyhow::Result<bool> {
        anyhow::ensure!(offer.max_activations > 0, "an offer must admit somebody");
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool().begin().await?;
        let envelope = sqlx::query(
            "SELECT 1 AS present FROM grant_authority \
             WHERE grant_id = ? AND organization_id = ? AND domain_id = ?",
        )
        .bind(offer.envelope_grant_id)
        .bind(offer.organization_id)
        .bind(offer.domain_id)
        .fetch_optional(&mut *tx)
        .await?;
        if envelope.is_none() {
            return Ok(false);
        }
        sqlx::query(
            "INSERT INTO grant_offers \
             (id, organization_id, domain_id, cohort_id, cohort_revision, membership_binding, \
              envelope_grant_id, max_activations, activations, revision, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)",
        )
        .bind(offer.id)
        .bind(offer.organization_id)
        .bind(offer.domain_id)
        .bind(offer.cohort_id)
        .bind(offer.cohort_revision)
        .bind(offer.membership_binding)
        .bind(offer.envelope_grant_id)
        .bind(offer.max_activations)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        append_outbox_tx(
            &mut tx,
            "authority.offer.created",
            &serde_json::json!({
                "organization_id": offer.organization_id,
                "offer_id": offer.id,
                "cohort_id": offer.cohort_id,
                "cohort_revision": offer.cohort_revision,
            })
            .to_string(),
        )
        .await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Bind one individual grant to an offer, atomically with its count.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction cannot be completed.
    pub async fn activate_grant_offer(
        &self,
        activation: &OfferActivation<'_>,
    ) -> anyhow::Result<ActivationOutcome> {
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool().begin().await?;
        let existing = sqlx::query(
            "SELECT 1 AS present FROM grant_offer_activations \
             WHERE organization_id = ? \
               AND (idempotency_key = ? OR (offer_id = ? AND beneficiary_principal_id = ?))",
        )
        .bind(activation.organization_id)
        .bind(activation.idempotency_key)
        .bind(activation.offer_id)
        .bind(activation.beneficiary_principal_id)
        .fetch_optional(&mut *tx)
        .await?;
        if existing.is_some() {
            return Ok(ActivationOutcome::Duplicate);
        }
        let counted = sqlx::query(
            "UPDATE grant_offers SET activations = activations + 1, revision = revision + 1 \
             WHERE id = ? AND organization_id = ? AND revoked_at IS NULL \
               AND cohort_revision = ? AND activations < max_activations",
        )
        .bind(activation.offer_id)
        .bind(activation.organization_id)
        .bind(activation.cohort_revision)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if counted != 1 {
            return Ok(ActivationOutcome::Refused);
        }
        sqlx::query(
            "INSERT INTO grant_offer_activations \
             (offer_id, organization_id, beneficiary_principal_id, grant_id, cohort_revision, \
              membership_source, membership_issuer, idempotency_key, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(activation.offer_id)
        .bind(activation.organization_id)
        .bind(activation.beneficiary_principal_id)
        .bind(activation.grant_id)
        .bind(activation.cohort_revision)
        .bind(activation.membership_source)
        .bind(activation.membership_issuer)
        .bind(activation.idempotency_key)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        append_outbox_tx(
            &mut tx,
            "authority.offer.activated",
            &serde_json::json!({
                "organization_id": activation.organization_id,
                "offer_id": activation.offer_id,
                "grant_id": activation.grant_id,
                "beneficiary_principal_id": activation.beneficiary_principal_id,
            })
            .to_string(),
        )
        .await?;
        tx.commit().await?;
        Ok(ActivationOutcome::Bound)
    }

    /// Revoke an offer. Activations already bound keep their own grants: an offer
    /// closing is not a revocation of authority somebody was legitimately issued,
    /// and revoking those is `revoke_authority`'s job, one grant at a time.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction cannot be completed.
    pub async fn revoke_grant_offer(
        &self,
        organization_id: &str,
        offer_id: &str,
    ) -> anyhow::Result<bool> {
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool().begin().await?;
        let changed = sqlx::query(
            "UPDATE grant_offers SET revoked_at = ?, revision = revision + 1 \
             WHERE id = ? AND organization_id = ? AND revoked_at IS NULL",
        )
        .bind(&now)
        .bind(offer_id)
        .bind(organization_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if changed != 1 {
            return Ok(false);
        }
        append_outbox_tx(
            &mut tx,
            "authority.offer.revoked",
            &serde_json::json!({"organization_id": organization_id, "offer_id": offer_id})
                .to_string(),
        )
        .await?;
        tx.commit().await?;
        Ok(true)
    }
}
