//! The exit door (ADR 0187): recombine a circle's SLIP-0039 shares and open
//! its recovery bundle without a browser.
//!
//! Shares are written with an empty passphrase and the bundle opens with a key
//! derived from the recombined secret, so the steps here are the same ones any
//! conforming tool takes, plus the owner's signature on the policy.

use zeroize::Zeroizing;

use crate::bundle::{BundleError, RecoveryBundle};
use crate::canonical::framed_digest;
use crate::policy::CirclePolicy;
use crate::secret::Secret;
use crate::slip39::{self, CombineOptions, Slip39Error};

/// What a bundle will make a recipient spend recombining: 10 000 x 2^6 = 640 000
/// PBKDF2 iterations over the four rounds. A share asking for more is refused,
/// as the TypeScript reader does (`MAX_RECOVERY_EXPONENT` in `circle.ts`).
pub const MAX_RECOVERY_EXPONENT: u8 = 6;

const COMMITMENT_PURPOSE: &str = "opensesame:quorum-share-commitment:v1";

/// Why a recovery failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RecoverError {
    /// The shares do not recombine.
    #[error("the shares do not recombine: {0}")]
    Shares(#[from] Slip39Error),
    /// The bundle does not open with the recombined secret.
    #[error(transparent)]
    Bundle(#[from] BundleError),
}

/// A guardian a share was matched to by the owner's commitment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardianRef {
    /// The guardian id.
    pub id: String,
    /// The name the owner gave them.
    pub name: String,
    /// The id of the group the guardian sits in.
    pub group_id: String,
}

/// One supplied share, and whom the policy says it belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareMatch {
    /// One-based position among the shares supplied.
    pub position: usize,
    /// The guardian whose commitment this share matches, if any.
    pub guardian: Option<GuardianRef>,
}

/// A recovery: the payload the owner sealed, and whom the shares came from.
#[derive(Debug, Clone)]
pub struct Recovered {
    /// The payload, as the JSON text that was sealed.
    pub payload: Secret,
    /// One entry per share, in the order supplied.
    pub shares: Vec<ShareMatch>,
}

/// The words lower-cased and joined by single spaces, as `wrap.ts` normalizes a
/// share before committing to it. Built in one buffer that is wiped on drop.
fn normalize(mnemonic: &str) -> Zeroizing<String> {
    let mut text = Zeroizing::new(String::with_capacity(mnemonic.len()));
    for (i, word) in mnemonic.split_whitespace().enumerate() {
        if i > 0 {
            text.push(' ');
        }
        text.extend(word.chars().flat_map(char::to_lowercase));
    }
    text
}

/// What the signed policy commits to for a guardian's share
/// (`shareCommitment` in `wrap.ts`).
#[must_use]
pub fn share_commitment(circle_id: &str, guardian_id: &str, mnemonic: &str) -> String {
    framed_digest(
        COMMITMENT_PURPOSE,
        &[circle_id, guardian_id, &normalize(mnemonic)],
    )
}

fn guardian_for(policy: &CirclePolicy, mnemonic: &str) -> Option<GuardianRef> {
    let (id, _) = policy.share_commitments.iter().find(|(id, commitment)| {
        share_commitment(&policy.circle_id, id, mnemonic) == **commitment
    })?;
    let guardian = policy.guardian(id)?;
    let group = policy
        .groups
        .iter()
        .find(|group| group.guardian_ids.contains(id))?;
    Some(GuardianRef {
        id: guardian.id.clone(),
        name: guardian.name.clone(),
        group_id: group.id.clone(),
    })
}

/// Match each share to the guardian the owner committed it to. A share that
/// matches none is damaged, forged or from another circle; recombination
/// would fail on it, and this says which one.
#[must_use]
pub fn match_shares<S: AsRef<str>>(policy: &CirclePolicy, mnemonics: &[S]) -> Vec<ShareMatch> {
    mnemonics
        .iter()
        .enumerate()
        .map(|(i, mnemonic)| ShareMatch {
            position: i + 1,
            guardian: guardian_for(policy, mnemonic.as_ref()),
        })
        .collect()
}

/// Recombine `mnemonics` (empty passphrase, at most [`MAX_RECOVERY_EXPONENT`])
/// and open the bundle with the secret.
///
/// # Errors
/// [`RecoverError::Shares`] when the shares do not recombine, and
/// [`RecoverError::Bundle`] when the secret does not open this bundle.
pub fn recover<S: AsRef<str>>(
    bundle: &RecoveryBundle,
    mnemonics: &[S],
) -> Result<Recovered, RecoverError> {
    let secret = slip39::combine(
        mnemonics,
        &CombineOptions {
            passphrase: "",
            max_iteration_exponent: MAX_RECOVERY_EXPONENT,
        },
    )?;
    let payload = bundle.open(secret.expose())?;
    Ok(Recovered {
        payload,
        shares: match_shares(&bundle.signed_policy.policy, mnemonics),
    })
}
