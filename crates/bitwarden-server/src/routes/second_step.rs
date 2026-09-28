//! The second step of a password sign-in (ADR 0148): when an account has
//! two-step login on, the right password alone gets a challenge naming the
//! providers, and the sign-in completes with a code, a remembered device, or
//! the recovery code.

use std::collections::HashMap;

use chrono::Utc;
use opensesame_storage::bitwarden::{BitwardenRemember, BitwardenUser};

use crate::error::{ApiError, ApiResult};
use crate::second_factor::{
    code_step, new_recovery_code, recovery_matches, AUTHENTICATOR, RECOVERY_CODE, REMEMBER,
};
use crate::tokens::{new_refresh_token, refresh_token_hash};
use crate::BitwardenServer;

/// How long "remember this device" lasts.
const REMEMBER_DAYS: i64 = 30;

/// A sign-in that passed its second step. `remember` asks for a token the
/// device keeps, issued once the device is recorded.
pub(crate) struct Passed {
    pub remember: bool,
}

/// Check the second step, if the account has one.
///
/// # Errors
///
/// A challenge naming the providers when no code came, and a refusal for a
/// wrong or replayed code.
pub(crate) async fn check(
    server: &BitwardenServer,
    user: &BitwardenUser,
    identifier: &str,
    form: &HashMap<String, String>,
) -> ApiResult<Passed> {
    let factors = server.db.bitwarden_two_factors(&user.id).await?;
    let enabled: Vec<i64> = factors
        .iter()
        .filter(|f| f.enabled)
        .map(|f| f.provider)
        .collect();
    if enabled.is_empty() {
        return Ok(Passed { remember: false });
    }
    let provider = form
        .get("twoFactorProvider")
        .and_then(|raw| raw.trim().parse::<i64>().ok());
    let token = form
        .get("twoFactorToken")
        .map(|raw| raw.trim())
        .filter(|raw| !raw.is_empty());
    let (Some(provider), Some(token)) = (provider, token) else {
        return Err(ApiError::two_factor_required(&enabled));
    };
    let remember = form.get("twoFactorRemember").map(String::as_str) == Some("1");
    match provider {
        REMEMBER => {
            let remembered = server
                .db
                .bitwarden_remembered(&BitwardenRemember {
                    user_id: &user.id,
                    identifier,
                    token_hash: &refresh_token_hash(token),
                    security_stamp: &user.security_stamp,
                    expires_at: Utc::now(),
                })
                .await?;
            // A stale remember token is not a failed code: ask again.
            if remembered {
                Ok(Passed { remember: false })
            } else {
                Err(ApiError::two_factor_required(&enabled))
            }
        }
        AUTHENTICATOR if enabled.contains(&AUTHENTICATOR) => {
            let key = factors
                .iter()
                .find(|f| f.provider == AUTHENTICATOR)
                .map(|f| f.data.as_str())
                .unwrap_or_default();
            let step = code_step(key, token, Utc::now().timestamp())
                .ok_or_else(ApiError::invalid_two_factor)?;
            if server
                .db
                .bitwarden_spend_step(&user.id, AUTHENTICATOR, step)
                .await?
            {
                Ok(Passed { remember })
            } else {
                Err(ApiError::invalid_two_factor())
            }
        }
        RECOVERY_CODE => {
            recover(server, user, token).await?;
            Ok(Passed { remember: false })
        }
        _ => Err(ApiError::invalid_two_factor()),
    }
}

/// Spend the recovery code: two-step login goes off, and a new code replaces
/// the one used, so a code works once.
///
/// # Errors
///
/// Refuses a code that is not the account's.
pub(crate) async fn recover(
    server: &BitwardenServer,
    user: &BitwardenUser,
    typed: &str,
) -> ApiResult<()> {
    let stored = server.db.bitwarden_recovery_code(&user.id).await?;
    let matches = stored
        .as_deref()
        .is_some_and(|stored| recovery_matches(stored, typed));
    let spent = matches
        && server
            .db
            .bitwarden_replace_recovery_code(&user.id, stored.as_deref(), &new_recovery_code())
            .await?;
    if !spent {
        return Err(ApiError::invalid_two_factor());
    }
    server
        .db
        .bitwarden_delete_two_factors(&user.id, None)
        .await?;
    Ok(())
}

/// Issue the token a device keeps to skip the second step next time.
///
/// # Errors
///
/// Returns an error when the write fails.
pub(crate) async fn remember_device(
    server: &BitwardenServer,
    user: &BitwardenUser,
    identifier: &str,
) -> ApiResult<String> {
    let token = new_refresh_token();
    server
        .db
        .bitwarden_remember_device(&BitwardenRemember {
            user_id: &user.id,
            identifier,
            token_hash: &refresh_token_hash(&token),
            security_stamp: &user.security_stamp,
            expires_at: Utc::now() + chrono::Duration::days(REMEMBER_DAYS),
        })
        .await?;
    Ok(token)
}
