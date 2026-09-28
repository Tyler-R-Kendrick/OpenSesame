//! A vaultwarden account's sign-in methods (ADR 0148): its API key, its
//! two-step recovery code, and an authenticator, which vaultwarden keeps as
//! the base32 key with the last time step it accepted. Other two-step
//! providers (email, Duo, `YubiKey`, security keys) are counted, not moved.

use opensesame_storage::bitwarden::{ArrivingSignIn, BitwardenTwoFactor};
use sqlx::sqlite::{SqlitePool, SqliteRow};
use sqlx::Row as _;

use super::rows::{text, Schema};
use crate::second_factor::{is_authenticator_key, normalize_key, AUTHENTICATOR};

/// vaultwarden keeps challenges and settings beside providers, at 1000 and up.
const FIRST_NON_PROVIDER: i64 = 1000;

/// The sign-in methods on a `users` row and in `twofactor`, and how many
/// enabled providers stay behind.
pub(super) async fn read(
    pool: &SqlitePool,
    schema: &Schema,
    user_row: &SqliteRow,
    user_id: &str,
) -> anyhow::Result<(ArrivingSignIn, usize)> {
    let mut sign_in = ArrivingSignIn {
        api_key: text(user_row, "api_key"),
        recovery_code: text(user_row, "totp_recover").map(|code| normalize_key(&code)),
        two_factors: Vec::new(),
    };
    if !schema.tables.contains("twofactor") {
        return Ok((sign_in, 0));
    }
    let rows = sqlx::query(
        "SELECT atype, enabled, data, last_used FROM twofactor WHERE user_uuid = ? AND enabled = 1",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    let mut left = 0;
    for row in &rows {
        let provider: i64 = row.try_get("atype").unwrap_or(-1);
        let key = text(row, "data").map(|key| normalize_key(&key));
        match key {
            Some(key) if provider == AUTHENTICATOR && is_authenticator_key(&key) => {
                sign_in.two_factors.push(BitwardenTwoFactor {
                    provider,
                    enabled: true,
                    data: key,
                    last_used_step: row.try_get::<i64, _>("last_used").unwrap_or(0),
                });
            }
            _ if (0..FIRST_NON_PROVIDER).contains(&provider) => left += 1,
            _ => {}
        }
    }
    Ok((sign_in, left))
}
