//! Certificate issuance requests, sealed delivery and issued certificates.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    certificate_issuance_state_is_terminal, certificate_time_is_expired,
    clear_certificate_delivery, sealed_certificate_delivery, stored_certificate_issuance_request,
    stored_issued_certificate, validate_san_json, validate_sealed_material, Db, Row,
    SealedCertificateDelivery, StoredCertificateIssuanceRequest, StoredIssuedCertificate, Utc,
};

impl Db {
    /// # Errors
    ///
    /// Returns an error when validation or insertion fails.
    pub async fn insert_certificate_issuance_request(
        &self,
        request: &StoredCertificateIssuanceRequest,
    ) -> anyhow::Result<bool> {
        validate_san_json(&request.san_json)?;
        if request.state != "created" || request.delivery.is_some() {
            anyhow::bail!("new certificate issuance requests must be unfulfilled and created");
        }
        let result = sqlx::query(
            "INSERT INTO certificate_issuance_requests (id, organization_id, authority_id, request_digest, idempotency_key, created_by, state, common_name, san_json, delivery_key_id, delivery_ciphertext, delivery_nonce, delivery_aad_digest, delivery_expires_at, expires_at, version, created_at, updated_at) \
             SELECT ?, ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM certificate_authorities \
             WHERE id = ? AND organization_id = ? AND status = 'active'",
        )
        .bind(&request.id)
        .bind(&request.organization_id)
        .bind(&request.request_digest)
        .bind(&request.idempotency_key)
        .bind(&request.created_by)
        .bind(&request.state)
        .bind(&request.common_name)
        .bind(&request.san_json)
        .bind(request.delivery.as_ref().map(|d| &d.material.key_id))
        .bind(request.delivery.as_ref().map(|d| &d.material.ciphertext))
        .bind(request.delivery.as_ref().map(|d| &d.material.nonce))
        .bind(request.delivery.as_ref().map(|d| &d.material.aad_digest))
        .bind(request.delivery.as_ref().map(|d| &d.expires_at))
        .bind(&request.expires_at)
        .bind(request.version)
        .bind(&request.created_at)
        .bind(&request.updated_at)
        .bind(&request.authority_id)
        .bind(&request.organization_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the lookup or stored-record decoding fails.
    pub async fn find_certificate_issuance_by_idempotency(
        &self,
        organization_id: &str,
        idempotency_key: &str,
    ) -> anyhow::Result<Option<StoredCertificateIssuanceRequest>> {
        let row = sqlx::query(
            "SELECT * FROM certificate_issuance_requests WHERE organization_id = ? AND idempotency_key = ?",
        )
        .bind(organization_id)
        .bind(idempotency_key)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref()
            .map(stored_certificate_issuance_request)
            .transpose()
    }

    /// # Errors
    ///
    /// Returns an error when the state update fails.
    pub async fn transition_certificate_issuance(
        &self,
        organization_id: &str,
        request_id: &str,
        expected_version: i64,
        expected_state: &str,
        next_state: &str,
    ) -> anyhow::Result<bool> {
        if certificate_issuance_state_is_terminal(expected_state) || next_state == "completed" {
            return Ok(false);
        }
        let result = sqlx::query(
            "UPDATE certificate_issuance_requests SET state = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ? AND state = ? AND julianday(expires_at) > julianday(?)",
        )
        .bind(next_state)
        .bind(Utc::now().to_rfc3339())
        .bind(organization_id)
        .bind(request_id)
        .bind(expected_version)
        .bind(expected_state)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Atomically records key-free certificate metadata and the encrypted,
    /// time-bounded delivery payload. A stale request cannot create a record.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the transaction fails.
    pub async fn complete_certificate_issuance(
        &self,
        organization_id: &str,
        request_id: &str,
        expected_version: i64,
        expected_state: &str,
        delivery: &SealedCertificateDelivery,
        issued: &StoredIssuedCertificate,
    ) -> anyhow::Result<bool> {
        if certificate_issuance_state_is_terminal(expected_state) {
            return Ok(false);
        }
        validate_sealed_material(&delivery.material)?;
        validate_san_json(&issued.san_json)?;
        if issued.organization_id != organization_id || issued.request_id != request_id {
            anyhow::bail!("issued certificate ownership does not match request");
        }
        let mut transaction = self.pool.begin().await?;
        let updated = sqlx::query(
            "UPDATE certificate_issuance_requests SET state = 'completed', delivery_key_id = ?, delivery_ciphertext = ?, delivery_nonce = ?, delivery_aad_digest = ?, delivery_expires_at = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND authority_id = ? AND common_name = ? AND san_json = ? AND version = ? AND state = ? AND julianday(expires_at) > julianday(?)",
        )
        .bind(&delivery.material.key_id)
        .bind(&delivery.material.ciphertext)
        .bind(&delivery.material.nonce)
        .bind(&delivery.material.aad_digest)
        .bind(&delivery.expires_at)
        .bind(Utc::now().to_rfc3339())
        .bind(organization_id)
        .bind(request_id)
        .bind(&issued.authority_id)
        .bind(&issued.common_name)
        .bind(&issued.san_json)
        .bind(expected_version)
        .bind(expected_state)
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() != 1 {
            transaction.rollback().await?;
            return Ok(false);
        }
        sqlx::query(
            "INSERT INTO issued_certificates (id, organization_id, authority_id, request_id, certificate_digest, serial_number, common_name, san_json, not_before, expires_at, status, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&issued.id)
        .bind(&issued.organization_id)
        .bind(&issued.authority_id)
        .bind(&issued.request_id)
        .bind(&issued.certificate_digest)
        .bind(&issued.serial_number)
        .bind(&issued.common_name)
        .bind(&issued.san_json)
        .bind(&issued.not_before)
        .bind(&issued.expires_at)
        .bind(&issued.status)
        .bind(issued.version)
        .bind(&issued.created_at)
        .bind(&issued.updated_at)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(true)
    }

    /// Destructive read of a still-valid encrypted delivery. The clear and
    /// version bump happen in the same transaction, so concurrent readers get
    /// at most one payload.
    ///
    /// # Errors
    ///
    /// Returns an error when delivery decoding or the transaction fails.
    pub async fn take_certificate_delivery(
        &self,
        organization_id: &str,
        request_id: &str,
        now: &str,
    ) -> anyhow::Result<Option<SealedCertificateDelivery>> {
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT version, delivery_key_id, delivery_ciphertext, delivery_nonce, delivery_aad_digest, delivery_expires_at \
             FROM certificate_issuance_requests WHERE organization_id = ? AND id = ? AND state = 'completed'",
        )
        .bind(organization_id)
        .bind(request_id)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let version: i64 = row.get("version");
        let Some(expires_at) = row.get::<Option<String>, _>("delivery_expires_at") else {
            return Ok(None);
        };
        if certificate_time_is_expired(&expires_at, now)? {
            clear_certificate_delivery(&mut transaction, request_id, version).await?;
            transaction.commit().await?;
            return Ok(None);
        }
        let delivery = sealed_certificate_delivery(&row)?;
        if !clear_certificate_delivery(&mut transaction, request_id, version).await? {
            transaction.rollback().await?;
            return Ok(None);
        }
        transaction.commit().await?;
        Ok(Some(delivery))
    }

    /// Reads a bounded encrypted delivery without consuming it. Callers must
    /// acknowledge only after the response has been durably stored by the
    /// holder; this avoids losing a generated private key on transport failure.
    ///
    /// # Errors
    ///
    /// Returns an error when delivery decoding or the transaction fails.
    pub async fn get_certificate_delivery(
        &self,
        organization_id: &str,
        request_id: &str,
        created_by: &str,
        now: &str,
    ) -> anyhow::Result<Option<SealedCertificateDelivery>> {
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT version, delivery_key_id, delivery_ciphertext, delivery_nonce, delivery_aad_digest, delivery_expires_at \
             FROM certificate_issuance_requests WHERE organization_id = ? AND id = ? AND created_by = ? AND state = 'completed'",
        )
        .bind(organization_id)
        .bind(request_id)
        .bind(created_by)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let version: i64 = row.get("version");
        let Some(expires_at) = row.get::<Option<String>, _>("delivery_expires_at") else {
            return Ok(None);
        };
        if certificate_time_is_expired(&expires_at, now)? {
            clear_certificate_delivery(&mut transaction, request_id, version).await?;
            transaction.commit().await?;
            return Ok(None);
        }
        let delivery = sealed_certificate_delivery(&row)?;
        transaction.commit().await?;
        Ok(Some(delivery))
    }

    /// Clears an encrypted delivery after holder acknowledgement. The CAS makes
    /// repeated or concurrent acknowledgements harmless.
    ///
    /// # Errors
    ///
    /// Returns an error when the lookup or transaction fails.
    pub async fn acknowledge_certificate_delivery(
        &self,
        organization_id: &str,
        request_id: &str,
        created_by: &str,
    ) -> anyhow::Result<bool> {
        let row = sqlx::query(
            "SELECT version FROM certificate_issuance_requests \
             WHERE organization_id = ? AND id = ? AND created_by = ? AND state = 'completed' AND delivery_ciphertext IS NOT NULL",
        )
        .bind(organization_id)
        .bind(request_id)
        .bind(created_by)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(false);
        };
        let mut transaction = self.pool.begin().await?;
        let cleared =
            clear_certificate_delivery(&mut transaction, request_id, row.get::<i64, _>("version"))
                .await?;
        transaction.commit().await?;
        Ok(cleared)
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_issued_certificate(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<Option<StoredIssuedCertificate>> {
        let row =
            sqlx::query("SELECT * FROM issued_certificates WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(certificate_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_issued_certificate))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_issued_certificates_expiring_before(
        &self,
        organization_id: &str,
        before: &str,
    ) -> anyhow::Result<Vec<StoredIssuedCertificate>> {
        let rows = sqlx::query(
            "SELECT * FROM issued_certificates WHERE organization_id = ? AND status = 'active' AND julianday(expires_at) <= julianday(?) ORDER BY expires_at, id",
        )
        .bind(organization_id)
        .bind(before)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_issued_certificate).collect())
    }

    // —— host operator kv ————————————————————————————————
}
