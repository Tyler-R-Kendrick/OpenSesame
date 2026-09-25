//! The bearer-token extractor every `/api` route but `config` sits behind.

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use opensesame_storage::bitwarden::BitwardenUser;

use crate::error::ApiError;
use crate::tokens::AccessClaims;
use crate::BitwardenServer;

/// A caller whose access token verified and whose security stamp is current.
pub struct Authed {
    pub user: BitwardenUser,
    pub claims: AccessClaims,
}

impl FromRequestParts<BitwardenServer> for Authed {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        server: &BitwardenServer,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or_else(ApiError::unauthorized)?;
        let claims = server
            .tokens
            .verify_access(token)
            .ok_or_else(ApiError::unauthorized)?;
        let user = server
            .db
            .bitwarden_user_by_id(&claims.sub)
            .await?
            .ok_or_else(ApiError::unauthorized)?;
        // A password change, KDF change or "log out all sessions" rotates the
        // stamp, and every token minted under the old one stops here.
        if user.security_stamp != claims.sstamp {
            return Err(ApiError::unauthorized());
        }
        Ok(Self { user, claims })
    }
}
