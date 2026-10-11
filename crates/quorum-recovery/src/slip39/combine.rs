//! `CombineShares` and `GenerateShares`: the two-level scheme over the kernel.

use std::collections::BTreeMap;
use std::fmt;

use rand::RngCore;

use super::cipher::{check_passphrase, decrypt, encrypt, CipherParams, MAX_ITERATION_EXPONENT};
use super::error::Slip39Error;
use super::gf256::Point;
use super::shamir::{recover_secret, split_secret};
use super::share::{decode_share, encode_share, Share};
use crate::secret::Secret;

/// What a caller chooses when combining.
#[derive(Clone, Copy)]
pub struct CombineOptions<'a> {
    /// Printable ASCII; the trusted-contacts export writes the empty one.
    pub passphrase: &'a str,
    /// Refuse a share that asks for more PBKDF2 work than this.
    pub max_iteration_exponent: u8,
}

/// The passphrase is a secret; a debug print says so and shows none of it.
impl fmt::Debug for CombineOptions<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CombineOptions")
            .field("passphrase", &"[REDACTED]")
            .field("max_iteration_exponent", &self.max_iteration_exponent)
            .finish()
    }
}

impl Default for CombineOptions<'_> {
    fn default() -> Self {
        Self {
            passphrase: "",
            max_iteration_exponent: MAX_ITERATION_EXPONENT,
        }
    }
}

/// The non-secret header of a share, for sorting a pile of them into sets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShareHeader {
    /// The 15-bit identifier of the backup.
    pub identifier: u16,
    /// Whether the backup uses the extendable salt.
    pub extendable: bool,
    /// PBKDF2 work exponent.
    pub iteration_exponent: u8,
    /// This share's group.
    pub group_index: u8,
    /// Groups needed.
    pub group_threshold: u8,
    /// Groups in all.
    pub group_count: u8,
    /// This share's index inside its group.
    pub member_index: u8,
    /// Members needed in the group.
    pub member_threshold: u8,
}

impl From<&Share> for ShareHeader {
    fn from(s: &Share) -> Self {
        Self {
            identifier: s.identifier,
            extendable: s.extendable,
            iteration_exponent: s.iteration_exponent,
            group_index: s.group_index,
            group_threshold: s.group_threshold,
            group_count: s.group_count,
            member_index: s.member_index,
            member_threshold: s.member_threshold,
        }
    }
}

/// Read a mnemonic's header (the checksum is verified; the value is dropped).
///
/// # Errors
/// [`Slip39Error`] as for [`decode_share`].
pub fn describe(mnemonic: &str) -> Result<ShareHeader, Slip39Error> {
    Ok(ShareHeader::from(&decode_share(mnemonic)?))
}

fn same_layout(a: &Share, b: &Share) -> bool {
    a.identifier == b.identifier
        && a.extendable == b.extendable
        && a.iteration_exponent == b.iteration_exponent
        && a.group_threshold == b.group_threshold
        && a.group_count == b.group_count
}

fn check_shares(shares: &[Share]) -> Result<&Share, Slip39Error> {
    let first = shares.first().ok_or(Slip39Error::Empty)?;
    if !shares.iter().all(|s| same_layout(s, first)) {
        return Err(Slip39Error::Mismatch);
    }
    if !shares.iter().all(|s| s.value.len() == first.value.len()) {
        return Err(Slip39Error::LengthMismatch);
    }
    Ok(first)
}

fn check_group(members: &[&Share]) -> Result<u8, Slip39Error> {
    let first = members.first().ok_or(Slip39Error::Empty)?;
    if members
        .iter()
        .any(|m| m.member_threshold != first.member_threshold)
    {
        return Err(Slip39Error::MemberThreshold);
    }
    let mut indices: Vec<u8> = members.iter().map(|m| m.member_index).collect();
    indices.sort_unstable();
    indices.dedup();
    if indices.len() != members.len() {
        return Err(Slip39Error::DuplicateMember);
    }
    if members.len() != usize::from(first.member_threshold) {
        return Err(Slip39Error::GroupSize {
            expected: usize::from(first.member_threshold),
            got: members.len(),
        });
    }
    Ok(first.member_threshold)
}

fn group_secret(members: &[&Share]) -> Result<Secret, Slip39Error> {
    let threshold = check_group(members)?;
    let points: Vec<Point> = members
        .iter()
        .map(|m| Point {
            x: m.member_index,
            y: m.value.clone(),
        })
        .collect();
    recover_secret(threshold, &points)
}

/// `CombineShares`: exactly the threshold of groups, each with exactly its
/// threshold of members.
///
/// # Errors
/// [`Slip39Error`] for a mnemonic that does not decode, shares that do not
/// belong together, a set of the wrong size, a failed digest, a passphrase
/// outside printable ASCII or an exponent above the caller's limit.
pub fn combine<S: AsRef<str>>(
    mnemonics: &[S],
    options: &CombineOptions<'_>,
) -> Result<Secret, Slip39Error> {
    let shares = mnemonics
        .iter()
        .map(|m| decode_share(m.as_ref()))
        .collect::<Result<Vec<_>, _>>()?;
    let common = check_shares(&shares)?;
    let mut groups: BTreeMap<u8, Vec<&Share>> = BTreeMap::new();
    for share in &shares {
        groups.entry(share.group_index).or_default().push(share);
    }
    if groups.len() != usize::from(common.group_threshold) {
        return Err(Slip39Error::GroupCount {
            expected: usize::from(common.group_threshold),
            got: groups.len(),
        });
    }
    let group_points = groups
        .iter()
        .map(|(&x, members)| {
            Ok(Point {
                x,
                y: group_secret(members)?,
            })
        })
        .collect::<Result<Vec<_>, Slip39Error>>()?;
    let encrypted = recover_secret(common.group_threshold, &group_points)?;
    decrypt(
        encrypted.expose(),
        &CipherParams {
            passphrase: options.passphrase,
            iteration_exponent: common.iteration_exponent,
            identifier: common.identifier,
            extendable: common.extendable,
            max_iteration_exponent: options.max_iteration_exponent,
        },
    )
}

/// A group: how many members recover it, and how many there are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupSpec {
    /// Members needed.
    pub threshold: u8,
    /// Members in all.
    pub count: u8,
}

/// What generating needs. The master secret is the caller's to keep or wipe.
#[derive(Clone, Copy)]
pub struct GenerateParams<'a> {
    /// Groups needed to recover.
    pub group_threshold: u8,
    /// The groups, in index order.
    pub groups: &'a [GroupSpec],
    /// At least 128 bits and a whole number of 16-bit words.
    pub master_secret: &'a [u8],
    /// Printable ASCII; empty is what other tools assume.
    pub passphrase: &'a str,
    /// PBKDF2 runs 10 000 x 2^e times in all; the reference default is 1.
    pub iteration_exponent: u8,
    /// New backups are extendable; `false` writes the original salt format.
    pub extendable: bool,
}

/// The master secret and the passphrase are secrets; neither is printed.
impl fmt::Debug for GenerateParams<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GenerateParams")
            .field("group_threshold", &self.group_threshold)
            .field("groups", &self.groups)
            .field("master_secret", &"[REDACTED]")
            .field("passphrase", &"[REDACTED]")
            .field("iteration_exponent", &self.iteration_exponent)
            .field("extendable", &self.extendable)
            .finish()
    }
}

fn check_generate(p: &GenerateParams<'_>) -> Result<(), Slip39Error> {
    if p.master_secret.len() < 16 || p.master_secret.len() % 2 != 0 {
        return Err(Slip39Error::Parameters(
            "the master secret must be at least 128 bits and a multiple of 16 bits",
        ));
    }
    if p.group_threshold < 1 || usize::from(p.group_threshold) > p.groups.len() {
        return Err(Slip39Error::Parameters(
            "the group threshold must not exceed the group count",
        ));
    }
    if p.groups.len() > 16 {
        return Err(Slip39Error::Parameters("at most 16 groups"));
    }
    if p.groups.iter().any(|g| g.threshold == 1 && g.count > 1) {
        return Err(Slip39Error::Parameters(
            "a member threshold of 1 needs a group of 1: use 1-of-1 sharing",
        ));
    }
    check_passphrase(p.passphrase).map(|_| ())
}

/// `GenerateShares`: one list of mnemonics per group, in group order. The
/// trusted-contacts recovery never needs this on the native side; it exists so
/// the round trip, and the TypeScript reader, can be tested against it.
///
/// # Errors
/// [`Slip39Error`] for parameters the standard does not allow.
pub fn generate<R: RngCore + ?Sized>(
    params: &GenerateParams<'_>,
    rng: &mut R,
) -> Result<Vec<Vec<String>>, Slip39Error> {
    check_generate(params)?;
    let identifier = {
        let mut bytes = [0_u8; 2];
        rng.fill_bytes(&mut bytes);
        u16::from_be_bytes(bytes) & 0x7fff
    };
    let encrypted = encrypt(
        params.master_secret,
        &CipherParams {
            passphrase: params.passphrase,
            iteration_exponent: params.iteration_exponent,
            identifier,
            extendable: params.extendable,
            max_iteration_exponent: MAX_ITERATION_EXPONENT,
        },
    )?;
    let group_count = u8::try_from(params.groups.len())
        .map_err(|_| Slip39Error::Parameters("at most 16 groups"))?;
    let group_shares = split_secret(params.group_threshold, group_count, encrypted.expose(), rng)?;
    let mut out = Vec::with_capacity(params.groups.len());
    for (group_index, (spec, group)) in params.groups.iter().zip(&group_shares).enumerate() {
        let members = split_secret(spec.threshold, spec.count, group.y.expose(), rng)?;
        let mnemonics = members
            .into_iter()
            .map(|member| {
                encode_share(&Share {
                    identifier,
                    extendable: params.extendable,
                    iteration_exponent: params.iteration_exponent,
                    group_index: u8::try_from(group_index).unwrap_or(u8::MAX),
                    group_threshold: params.group_threshold,
                    group_count,
                    member_index: member.x,
                    member_threshold: spec.threshold,
                    value: member.y,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        out.push(mnemonics);
    }
    Ok(out)
}
