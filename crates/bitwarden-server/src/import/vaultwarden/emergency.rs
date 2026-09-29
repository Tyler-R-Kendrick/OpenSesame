//! A vaultwarden server's emergency contacts (ADR 0148 §2, §6), each with
//! the grantor's user key as it was wrapped for the contact.

use chrono::Utc;
use opensesame_storage::bitwarden::BitwardenEmergencyAccess;

use super::rows::{int, text, timestamp};
use super::Reader;

const EMERGENCY_COLUMNS: &[&str] = &[
    "uuid",
    "grantor_uuid",
    "grantee_uuid",
    "email",
    "key_encrypted",
    "atype",
    "status",
    "wait_time_days",
    "recovery_initiated_at",
    "created_at",
    "updated_at",
];

fn enc(value: Option<String>) -> Option<String> {
    value.filter(|v| crate::wire::cipher::is_enc_string(v))
}

impl Reader {
    /// Every emergency contact.
    pub(super) async fn emergency(&self) -> anyhow::Result<Vec<BitwardenEmergencyAccess>> {
        if !self.schema.tables.contains("emergency_access") {
            return Ok(Vec::new());
        }
        let emails = self.emails().await?;
        let sql = format!(
            "SELECT {} FROM emergency_access",
            self.select("emergency_access", EMERGENCY_COLUMNS)
        );
        let now = Utc::now();
        let mut out = Vec::new();
        for row in sqlx::query(&sql).fetch_all(&self.pool).await? {
            let grantee = text(&row, "grantee_uuid");
            let email = grantee
                .as_ref()
                .and_then(|g| emails.get(g).cloned())
                .or_else(|| text(&row, "email").map(|e| e.trim().to_ascii_lowercase()));
            let (Some(id), Some(grantor_id), Some(email)) =
                (text(&row, "uuid"), text(&row, "grantor_uuid"), email)
            else {
                continue;
            };
            let created = timestamp(text(&row, "created_at")).unwrap_or(now);
            out.push(BitwardenEmergencyAccess {
                id,
                grantor_id,
                grantee_id: grantee,
                email,
                key_encrypted: enc(text(&row, "key_encrypted")),
                access_type: int(&row, "atype").unwrap_or(0),
                status: int(&row, "status").unwrap_or(0),
                wait_time_days: int(&row, "wait_time_days").unwrap_or(7).clamp(1, 90),
                recovery_initiated_at: timestamp(text(&row, "recovery_initiated_at")),
                created_at: created,
                revision_at: timestamp(text(&row, "updated_at")).unwrap_or(created),
            });
        }
        Ok(out)
    }
}
