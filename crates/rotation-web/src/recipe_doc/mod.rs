//! The recipe document: what an organization stores, signs and a run replays
//! (ADR 0076 §4, `docs/architecture/rotation-recipe-schema.md`).
//!
//! A document is **strict JSON** — every object denies unknown members, so a
//! field this build does not know is a refusal and never something a signature
//! quietly covers — with a version, one origin, an expiry and the executor's
//! own [`ChangePasswordRecipe`]. There is no second step language: the steps a
//! run takes are the ones [`run_change_password`](crate::run_change_password)
//! takes, in the order it takes them, and the document names only the page and
//! the fields (selectors) they act on. It carries no value, no account and no
//! session: a recipe is a statement about a site, the same for every user of
//! it.
//!
//! Two optional members are *claims*, never trust:
//!
//! - `canary` — "this recipe completed a real change, verified by a fresh
//!   login, at this time". It counts only inside a verified signature: the
//!   signer is attesting it.
//! - `signature` — Ed25519 over the document without this member, in the
//!   canonical form of [`sign`] (RFC 8785 JSON canonicalization with a domain
//!   tag). Whether the signing key is one the organization pinned is the
//!   Host's decision, not this crate's.
//!
//! Nothing here decides trust. [`RecipeDocument::verify`] answers whether one
//! public key signed exactly this document; the Host's store decides whether
//! that key is pinned and unrevoked, and records the result itself.

mod sign;
#[cfg(test)]
mod tests;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// The key types a signature is made and checked with, so a consumer needs no
/// signature crate of its own to name them.
pub use ed25519_dalek::{SigningKey, VerifyingKey};
pub use sign::{
    key_id_of, parse_public_key_hex, signing_key_from_seed_hex, SIGNATURE_ALGORITHM, SIGNING_DOMAIN,
};

use crate::ChangePasswordRecipe;

/// The only document version this build reads and writes.
pub const SCHEMA_VERSION: u32 = 1;

/// Largest document the Host reads, in bytes. Selectors and a URL; far above
/// any real recipe, and a bound on what one request makes the parser walk.
pub const MAX_RECIPE_BYTES: usize = 16 * 1024;

/// Longest selector a document may name, in characters.
pub const MAX_SELECTOR_CHARS: usize = 512;

/// Furthest ahead of now a recipe may expire (one quarter, per the schema's
/// review checklist). A recipe that has not been re-proved inside its window
/// is not trusted, however green its last replay looked.
pub const MAX_LIFETIME_DAYS: i64 = 93;

/// How old a canary may be and still count, in days. Sites change on their
/// own schedule, not ours.
pub const CANARY_MAX_AGE_DAYS: i64 = 90;

/// How far ahead of the Host's clock a canary's timestamp may be.
const CLOCK_SKEW_MINUTES: i64 = 5;

/// Why a document was refused. The text names a member or a rule, never a
/// value from the document.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum RecipeError {
    #[error("a recipe is at most {MAX_RECIPE_BYTES} bytes")]
    TooLarge,
    #[error("the recipe is not a valid recipe document: {0}")]
    Malformed(String),
    #[error("schema_version {0} is not supported; this build reads version {SCHEMA_VERSION}")]
    UnsupportedVersion(u32),
    #[error("recipe_id must be `rcp_` then 1 to 63 of a-z, 0-9, `_` or `-`")]
    BadRecipeId,
    #[error("origin must be a canonical https origin: no path, query, fragment or credentials")]
    BadOrigin,
    #[error("change_url must be an https URL on the recipe's own origin, with no credentials")]
    OffOrigin,
    #[error("{0} must be a non-blank selector of at most {MAX_SELECTOR_CHARS} characters")]
    BadSelector(&'static str),
    #[error("{0} must be an RFC 3339 timestamp")]
    BadTimestamp(&'static str),
    #[error("the recipe has expired")]
    Expired,
    #[error("a recipe may expire at most {MAX_LIFETIME_DAYS} days from now")]
    LifetimeTooLong,
    #[error("the canary is dated in the future")]
    CanaryInTheFuture,
    #[error("the canary is older than {CANARY_MAX_AGE_DAYS} days")]
    CanaryStale,
    #[error("the signature algorithm must be `{SIGNATURE_ALGORITHM}`")]
    UnsupportedAlgorithm,
    #[error("the signature names a different key than the one it was checked against")]
    KeyMismatch,
    #[error("the signature does not verify against this document")]
    BadSignature,
    #[error("the recipe carries no signature")]
    Unsigned,
    #[error("{0}")]
    BadKey(&'static str),
}

/// A signer's claim that the recipe completed a real change, verified by a
/// fresh login (rotation-recipe-schema.md, "Signing and trust"). A failed
/// canary is not something anyone signs, so the claim has no `result`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CanaryAttestation {
    /// When the verifying login succeeded, RFC 3339.
    pub verified_at: String,
}

/// A detached signature over the document's canonical form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecipeSignature {
    /// Always [`SIGNATURE_ALGORITHM`].
    pub alg: String,
    /// `rsk_` and the key's digest ([`key_id_of`]). Derived from the public
    /// key, so a signature cannot name a key it was not made with.
    pub key_id: String,
    /// The 64-byte signature, lowercase hex.
    pub value: String,
}

/// One recipe document, version 1.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecipeDocument {
    pub schema_version: u32,
    /// The recipe's own name, `rcp_…`, for receipts and replay overlays.
    pub recipe_id: String,
    /// The relying party's origin, exactly as a rotation target names it.
    pub origin: String,
    /// When the recipe stops being replayable, RFC 3339.
    pub expires_at: String,
    /// The change-password page and the fields the executor acts on.
    pub change_password: ChangePasswordRecipe,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canary: Option<CanaryAttestation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<RecipeSignature>,
}

/// `raw` as a canonical origin — `https://host` or `https://host:port` —
/// or `None` when it is anything else. An origin is the unit a recipe, a
/// per-domain opt-in and a rate limit are scoped to (ADR 0076), so a target
/// carrying a path would quietly scope all three to the wrong thing, and a URL
/// with userinfo is a username, which this surface never stores.
#[must_use]
pub fn canonical_origin(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    let plain = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && (url.path() == "/" || url.path().is_empty())
        && url.query().is_none()
        && url.fragment().is_none();
    let host = url.host_str().filter(|_| plain)?;
    Some(match url.port() {
        Some(port) => format!("https://{host}:{port}"),
        None => format!("https://{host}"),
    })
}

fn timestamp(value: &str, member: &'static str) -> Result<DateTime<Utc>, RecipeError> {
    DateTime::parse_from_rfc3339(value)
        .map(|at| at.with_timezone(&Utc))
        .map_err(|_| RecipeError::BadTimestamp(member))
}

fn selector(value: &str, member: &'static str) -> Result<(), RecipeError> {
    let sound = !value.trim().is_empty()
        && value.chars().count() <= MAX_SELECTOR_CHARS
        && !value.chars().any(char::is_control);
    if sound {
        Ok(())
    } else {
        Err(RecipeError::BadSelector(member))
    }
}

fn recipe_id_is_sound(id: &str) -> bool {
    id.strip_prefix("rcp_").is_some_and(|rest| {
        (1..=63).contains(&rest.len())
            && rest
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    })
}

impl RecipeDocument {
    /// Read a document from request or file bytes: bounded, UTF-8, strict,
    /// and structurally valid ([`Self::validate`]). Says nothing about the
    /// clock or the signature.
    ///
    /// # Errors
    ///
    /// [`RecipeError`] naming the rule the document broke.
    pub fn parse(bytes: &[u8]) -> Result<Self, RecipeError> {
        if bytes.len() > MAX_RECIPE_BYTES {
            return Err(RecipeError::TooLarge);
        }
        let text = std::str::from_utf8(bytes)
            .map_err(|_| RecipeError::Malformed("the document is not UTF-8".into()))?;
        let document: Self = serde_json::from_str(text)
            .map_err(|failure| RecipeError::Malformed(failure.to_string()))?;
        document.validate()?;
        Ok(document)
    }

    /// The structural rules, with no clock: version, names, origin, the
    /// change URL on that origin, bounded selectors, parseable timestamps.
    ///
    /// # Errors
    ///
    /// [`RecipeError`] naming the first rule broken.
    pub fn validate(&self) -> Result<(), RecipeError> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(RecipeError::UnsupportedVersion(self.schema_version));
        }
        if !recipe_id_is_sound(&self.recipe_id) {
            return Err(RecipeError::BadRecipeId);
        }
        if canonical_origin(&self.origin).as_deref() != Some(self.origin.as_str()) {
            return Err(RecipeError::BadOrigin);
        }
        self.validate_steps()?;
        timestamp(&self.expires_at, "expires_at")?;
        if let Some(canary) = &self.canary {
            timestamp(&canary.verified_at, "canary.verified_at")?;
        }
        Ok(())
    }

    fn validate_steps(&self) -> Result<(), RecipeError> {
        let steps = &self.change_password;
        let on_origin = url::Url::parse(&steps.change_url).is_ok_and(|url| {
            url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none()
                && url.origin().ascii_serialization() == self.origin
        });
        if !on_origin {
            return Err(RecipeError::OffOrigin);
        }
        selector(&steps.new_password_selector, "new_password_selector")?;
        selector(&steps.submit_selector, "submit_selector")?;
        if let Some(current) = &steps.current_password_selector {
            selector(current, "current_password_selector")?;
        }
        if let Some(confirm) = &steps.confirm_password_selector {
            selector(confirm, "confirm_password_selector")?;
        }
        Ok(())
    }

    /// The rules that need a clock: unexpired, not further out than a quarter,
    /// and a canary that is neither from the future nor stale.
    ///
    /// # Errors
    ///
    /// [`RecipeError`] naming the rule broken. A document that was never
    /// [`validate`](Self::validate)d is refused as a bad timestamp.
    pub fn check_window(&self, now: DateTime<Utc>) -> Result<(), RecipeError> {
        let expires = timestamp(&self.expires_at, "expires_at")?;
        if expires <= now {
            return Err(RecipeError::Expired);
        }
        if expires > now + Duration::days(MAX_LIFETIME_DAYS) {
            return Err(RecipeError::LifetimeTooLong);
        }
        if let Some(canary) = &self.canary {
            let at = timestamp(&canary.verified_at, "canary.verified_at")?;
            if at > now + Duration::minutes(CLOCK_SKEW_MINUTES) {
                return Err(RecipeError::CanaryInTheFuture);
            }
            if at < now - Duration::days(CANARY_MAX_AGE_DAYS) {
                return Err(RecipeError::CanaryStale);
            }
        }
        Ok(())
    }

    /// The document with its signature removed: what a signature covers.
    #[must_use]
    pub fn unsigned(&self) -> Self {
        Self {
            signature: None,
            ..self.clone()
        }
    }

    /// The executor's projection, which a run replays.
    #[must_use]
    pub const fn steps(&self) -> &ChangePasswordRecipe {
        &self.change_password
    }
}
