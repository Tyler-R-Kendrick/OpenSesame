//! The circle's signed policy, read and verified the way
//! `packages/app-core/src/lib/quorum/policy.ts` does: well-formed (`schema`),
//! sound (`sound`), its digest recomputed from the canonical JSON, and the
//! owner's Ed25519 signature checked over that digest.
//!
//! The digest is taken over the document as received, with every field it
//! carries, so a field this reader does not know still cannot be added or
//! changed without breaking the signature. A document with a field it does not
//! know is refused all the same, as the TypeScript schema is `strict`.

mod schema;
mod sound;

use std::collections::BTreeMap;

use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use serde_json::Value;

use crate::canonical::{canonicalize, frame, framed_digest};
use crate::encoding::b64url_decode;

pub use sound::assert_sound;

const POLICY_PURPOSE: &str = "opensesame:quorum-policy:v1";
const SIGNATURE_PURPOSE: &str = "opensesame:quorum-policy-signature:v1";

/// Why a policy was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PolicyError {
    /// The document is not a circle policy.
    #[error("not a circle policy: {0}")]
    Malformed(String),
    /// Well-formed, but a circle that cannot work.
    #[error("{message}")]
    Unsound {
        /// The rule, as `policy.ts` names it (`no_prf`, `commitments`, ...).
        code: &'static str,
        /// What is wrong.
        message: String,
    },
    /// The canonical digest differs from the one the document claims.
    #[error("the policy does not match its digest")]
    DigestMismatch,
    /// A pinned owner key was given and the policy names another.
    #[error("the policy is signed by a different owner key")]
    OwnerKeyChanged,
    /// The Ed25519 signature does not verify.
    #[error("the owner signature does not verify")]
    BadSignature,
}

/// What a circle can be asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Operation {
    /// Release shares of the recovery key.
    RecoverCollection,
    /// A quorum-approved standing share.
    GrantAccess,
    /// Replace the owner's credential.
    ReplaceOwnerCredential,
    /// Export items.
    ExportItems,
}

impl Operation {
    /// The name the policy writes.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RecoverCollection => "recover-collection",
            Self::GrantAccess => "grant-access",
            Self::ReplaceOwnerCredential => "replace-owner-credential",
            Self::ExportItems => "export-items",
        }
    }
}

/// One of a guardian's keys.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GuardianCredential {
    /// The `WebAuthn` credential id.
    pub credential_id: String,
    /// `SubjectPublicKeyInfo`, DER.
    pub public_key: String,
    /// COSE algorithm: -7 (ES256) or -8 (`EdDSA`).
    pub alg: i64,
    /// What the guardian calls the key.
    pub label: String,
    /// Whether enrollment saw the PRF extension answer twice the same.
    pub prf: bool,
    /// When the key was added.
    pub added_at: String,
}

/// A person who holds one share.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Guardian {
    /// The guardian id inside the circle.
    pub id: String,
    /// The name the owner gave them.
    pub name: String,
    /// The vault `contact` item this guardian is, if any.
    pub contact_ref: Option<String>,
    /// Guardians in one domain count as one for independence.
    pub custody_domain: String,
    /// The X25519 key the share was sealed to at enrollment.
    pub hpke_public_key: String,
    /// Alternatives for one guardian.
    pub credentials: Vec<GuardianCredential>,
}

/// A group of guardians with a member threshold.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Group {
    /// The group id.
    pub id: String,
    /// How many members are needed.
    pub threshold: u64,
    /// The members, by guardian id.
    pub guardian_ids: Vec<String>,
}

/// The policy this one replaces.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Supersedes {
    /// The epoch before this one.
    pub epoch: u64,
    /// Its digest.
    pub digest: String,
}

/// `Option<T>` that refuses `null`: a field is absent or has a value, as Zod's
/// `.optional()` has it.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// The circle's policy, as the owner signed it.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CirclePolicy {
    /// Always 1.
    pub v: u64,
    /// The circle id.
    pub circle_id: String,
    /// The epoch of the guardian set; a new set is a new epoch.
    pub epoch: u64,
    /// The circle's name.
    pub label: String,
    /// What the circle protects, as the owner names it.
    pub collection: String,
    /// The `WebAuthn` RP ID.
    pub rp_id: String,
    /// The origins a guardian approves from.
    pub origins: Vec<String>,
    /// The Ed25519 key that signs this policy.
    pub owner_key: String,
    /// Groups needed.
    pub group_threshold: u64,
    /// The groups.
    pub groups: Vec<Group>,
    /// The guardians.
    pub guardians: Vec<Guardian>,
    /// Guardian id to the commitment to the share they hold.
    pub share_commitments: BTreeMap<String, String>,
    /// What the circle may be asked to do.
    pub operations: Vec<Operation>,
    /// Seconds approvals may be gathered.
    pub approval_window_sec: u64,
    /// Seconds before any share may be released.
    pub release_delay_sec: u64,
    /// Seconds a request stays alive in all.
    pub request_lifetime_sec: u64,
    /// Whether approvals need user verification.
    pub require_user_verification: bool,
    /// When the policy was made.
    pub created_at: String,
    /// The policy this one replaces, from epoch 2.
    #[serde(default, deserialize_with = "present")]
    pub supersedes: Option<Supersedes>,
}

impl CirclePolicy {
    /// The guardian with this id.
    #[must_use]
    pub fn guardian(&self, id: &str) -> Option<&Guardian> {
        self.guardians.iter().find(|g| g.id == id)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSigned {
    policy: Value,
    digest: String,
    signature: String,
}

/// A policy whose shape, soundness, digest and owner signature all check out.
#[derive(Debug, Clone)]
pub struct SignedPolicy {
    /// The policy.
    pub policy: CirclePolicy,
    /// `sha256:<hex>` of its canonical form.
    pub digest: String,
    /// The owner's signature over the digest, base64url.
    pub signature: String,
    document: Value,
}

impl SignedPolicy {
    /// The signed document exactly as it was received (`policy`, `digest`,
    /// `signature`), for writing a bundle that carries it unchanged.
    #[must_use]
    pub fn document(&self) -> &Value {
        &self.document
    }
}

/// What the owner signs: the purpose and the digest, framed.
fn signed_bytes(digest: &str) -> Vec<u8> {
    frame(&[SIGNATURE_PURPOSE, digest])
}

fn verify_signature(owner_key: &str, digest: &str, signature: &str) -> Result<(), PolicyError> {
    let key: [u8; 32] = b64url_decode(owner_key)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(PolicyError::BadSignature)?;
    let key = VerifyingKey::from_bytes(&key).map_err(|_| PolicyError::BadSignature)?;
    let signature = b64url_decode(signature)
        .ok()
        .and_then(|bytes| Signature::from_slice(&bytes).ok())
        .ok_or(PolicyError::BadSignature)?;
    // Strict: a weak key or a non-canonical signature is refused, which an
    // honestly made signature never trips.
    key.verify_strict(&signed_bytes(digest), &signature)
        .map_err(|_| PolicyError::BadSignature)
}

/// A policy as received: well-formed, sound, matching its digest, and signed by
/// the owner key it names (and by `pinned_owner_key` when one is given, which
/// is how a person who wrote the key down checks it).
///
/// # Errors
/// [`PolicyError`] naming the first check that failed, in `policy.ts`'s order.
pub fn verify_signed_policy(
    document: &Value,
    pinned_owner_key: Option<&str>,
) -> Result<SignedPolicy, PolicyError> {
    let raw: RawSigned = serde_json::from_value(document.clone())
        .map_err(|e| PolicyError::Malformed(e.to_string()))?;
    let policy: CirclePolicy = serde_json::from_value(raw.policy.clone())
        .map_err(|e| PolicyError::Malformed(e.to_string()))?;
    schema::check_signed(&raw.digest, &raw.signature)?;
    schema::check_policy(&policy)?;
    sound::assert_sound(&policy)?;
    let canonical = canonicalize(&raw.policy)
        .map_err(|e| PolicyError::Malformed(format!("canonical form: {e}")))?;
    if framed_digest(POLICY_PURPOSE, &[&canonical]) != raw.digest {
        return Err(PolicyError::DigestMismatch);
    }
    if pinned_owner_key.is_some_and(|pinned| pinned != policy.owner_key) {
        return Err(PolicyError::OwnerKeyChanged);
    }
    verify_signature(&policy.owner_key, &raw.digest, &raw.signature)?;
    Ok(SignedPolicy {
        policy,
        digest: raw.digest,
        signature: raw.signature,
        document: document.clone(),
    })
}

/// The digest `policy.ts` would compute for `policy`; exposed for tests that
/// build a policy of their own.
///
/// # Errors
/// [`PolicyError::Malformed`] for a value the canonical form does not admit.
pub fn policy_digest(policy: &Value) -> Result<String, PolicyError> {
    let canonical =
        canonicalize(policy).map_err(|e| PolicyError::Malformed(format!("canonical form: {e}")))?;
    Ok(framed_digest(POLICY_PURPOSE, &[&canonical]))
}

/// The bytes the owner signs over `digest`; exposed for tests.
#[must_use]
pub fn bytes_to_sign(digest: &str) -> Vec<u8> {
    signed_bytes(digest)
}
