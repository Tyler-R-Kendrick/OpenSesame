//! Every refusal from the SLIP-0039 kernel. A message names the rule that was
//! broken and never quotes a word of a share.

/// A mnemonic, a set of mnemonics or a parameter that SLIP-0039 refuses.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Slip39Error {
    /// A word that is not one of the 1024.
    #[error("word {position} is not in the SLIP-0039 wordlist")]
    UnknownWord {
        /// One-based position in the mnemonic.
        position: usize,
    },
    /// Fewer words than the shortest share.
    #[error("a share is at least {min} words, not {got}")]
    TooShort {
        /// The shortest legal share, in words.
        min: usize,
        /// What was given.
        got: usize,
    },
    /// The RS1024 checksum does not verify.
    #[error("invalid mnemonic checksum")]
    Checksum,
    /// The padding of the share value is too long or not zero.
    #[error("invalid mnemonic padding")]
    Padding,
    /// A header field outside its range.
    #[error("share fields out of range")]
    Fields,
    /// The group threshold exceeds the group count.
    #[error("group threshold exceeds group count")]
    GroupThreshold,
    /// No mnemonics at all.
    #[error("the list of mnemonics is empty")]
    Empty,
    /// The shares come from different backups or layouts.
    #[error("the mnemonics do not share an identifier, exponent and group layout")]
    Mismatch,
    /// The share values differ in length.
    #[error("the shares differ in length")]
    LengthMismatch,
    /// The wrong number of groups for the threshold.
    #[error("expected {expected} groups, got {got}")]
    GroupCount {
        /// The group threshold.
        expected: usize,
        /// The groups present.
        got: usize,
    },
    /// A group does not hold exactly its member threshold of shares.
    #[error("a group needs exactly {expected} shares, not {got}")]
    GroupSize {
        /// The member threshold.
        expected: usize,
        /// The shares present.
        got: usize,
    },
    /// Shares of one group disagree on the member threshold.
    #[error("mismatching member thresholds in a group")]
    MemberThreshold,
    /// Two shares of one group carry the same member index.
    #[error("duplicate member index in a group")]
    DuplicateMember,
    /// Two points share an x coordinate.
    #[error("share indices must be unique")]
    DuplicateIndex,
    /// Shares of different lengths were interpolated together.
    #[error("all share values must have the same length")]
    Interpolation,
    /// The digest at f(254) does not match: a wrong or damaged set of shares.
    #[error("invalid digest of the shared secret")]
    Digest,
    /// The share asks for more PBKDF2 work than the caller allows.
    #[error("iteration exponent {got} exceeds the limit of {limit}")]
    IterationExponent {
        /// What the share asks for.
        got: u8,
        /// What the caller allows.
        limit: u8,
    },
    /// A passphrase outside printable ASCII.
    #[error("the passphrase must be printable ASCII (32-126)")]
    Passphrase,
    /// A parameter the standard does not allow (generation only).
    #[error("{0}")]
    Parameters(&'static str),
}
