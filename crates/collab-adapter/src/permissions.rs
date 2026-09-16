//! Discord's permission bitfield, and the subset this adapter will never ask
//! for.
//!
//! Two protocol facts are load-bearing here and both are easy to get wrong:
//!
//! 1. Discord serializes a permission set as a **decimal string**, not a JSON
//!    number, because the field outgrew IEEE-754's exact integer range. A
//!    client that parses it as a number silently corrupts anything above
//!    `1 << 53`. [`Permissions`] therefore serializes as a string and parses
//!    from one.
//! 2. `ADMINISTRATOR` is not one permission among many — it **subsumes every
//!    other bit and ignores channel overwrites**. A role carrying it cannot be
//!    narrowed afterwards, so an adapter that hands it out has no story for
//!    "narrower, for this agent, until Friday".
//!
//! [`ELEVATED`] is wider than `ADMINISTRATOR` alone: a bit that lets its holder
//! edit roles, channels, webhooks, or integrations is a bit that lets its
//! holder *rewrite the permission graph that contains it*, which is the same
//! escalation by a longer route. Those are refused for the same reason, not as
//! a matter of taste.

use std::fmt;

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize, Serializer};

/// One named bit in Discord's guild permission bitfield.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bit {
    pub name: &'static str,
    pub mask: u64,
}

macro_rules! bits {
    ($($konst:ident = $shift:expr, $name:literal;)+) => {
        $(
            #[doc = concat!("Discord's `", $name, "` permission (`1 << ", stringify!($shift), "`).")]
            pub const $konst: u64 = 1 << $shift;
        )+

        /// Every bit this crate can name, for rendering a refusal that says
        /// *which* permission was the problem instead of printing an integer.
        pub const NAMED_BITS: &[Bit] = &[
            $(Bit { name: $name, mask: $konst },)+
        ];
    };
}

bits! {
    CREATE_INSTANT_INVITE = 0, "CREATE_INSTANT_INVITE";
    KICK_MEMBERS = 1, "KICK_MEMBERS";
    BAN_MEMBERS = 2, "BAN_MEMBERS";
    ADMINISTRATOR = 3, "ADMINISTRATOR";
    MANAGE_CHANNELS = 4, "MANAGE_CHANNELS";
    MANAGE_GUILD = 5, "MANAGE_GUILD";
    ADD_REACTIONS = 6, "ADD_REACTIONS";
    VIEW_AUDIT_LOG = 7, "VIEW_AUDIT_LOG";
    VIEW_CHANNEL = 10, "VIEW_CHANNEL";
    SEND_MESSAGES = 11, "SEND_MESSAGES";
    MANAGE_MESSAGES = 13, "MANAGE_MESSAGES";
    EMBED_LINKS = 14, "EMBED_LINKS";
    ATTACH_FILES = 15, "ATTACH_FILES";
    READ_MESSAGE_HISTORY = 16, "READ_MESSAGE_HISTORY";
    MENTION_EVERYONE = 17, "MENTION_EVERYONE";
    VIEW_GUILD_INSIGHTS = 19, "VIEW_GUILD_INSIGHTS";
    CONNECT = 20, "CONNECT";
    SPEAK = 21, "SPEAK";
    MUTE_MEMBERS = 22, "MUTE_MEMBERS";
    DEAFEN_MEMBERS = 23, "DEAFEN_MEMBERS";
    MOVE_MEMBERS = 24, "MOVE_MEMBERS";
    MANAGE_NICKNAMES = 27, "MANAGE_NICKNAMES";
    MANAGE_ROLES = 28, "MANAGE_ROLES";
    MANAGE_WEBHOOKS = 29, "MANAGE_WEBHOOKS";
    MANAGE_GUILD_EXPRESSIONS = 30, "MANAGE_GUILD_EXPRESSIONS";
    USE_APPLICATION_COMMANDS = 31, "USE_APPLICATION_COMMANDS";
    MANAGE_EVENTS = 33, "MANAGE_EVENTS";
    MANAGE_THREADS = 34, "MANAGE_THREADS";
    CREATE_PUBLIC_THREADS = 35, "CREATE_PUBLIC_THREADS";
    SEND_MESSAGES_IN_THREADS = 38, "SEND_MESSAGES_IN_THREADS";
    MODERATE_MEMBERS = 40, "MODERATE_MEMBERS";
    CREATE_GUILD_EXPRESSIONS = 43, "CREATE_GUILD_EXPRESSIONS";
    CREATE_EVENTS = 44, "CREATE_EVENTS";
}

/// The bits this adapter refuses to request, create, or leave in place on a
/// role it manages.
///
/// Grouped by *why*, because the list is otherwise arbitrary-looking:
///
/// - `ADMINISTRATOR` — subsumes everything and ignores overwrites.
/// - `MANAGE_ROLES`, `MANAGE_CHANNELS`, `MANAGE_WEBHOOKS`, `MANAGE_GUILD`,
///   `MANAGE_GUILD_EXPRESSIONS`, `CREATE_GUILD_EXPRESSIONS` — edit the
///   structure the permission lives in, so the holder can widen itself.
/// - `KICK_MEMBERS`, `BAN_MEMBERS`, `MODERATE_MEMBERS`, `MANAGE_NICKNAMES`,
///   `MUTE_MEMBERS`, `DEAFEN_MEMBERS`, `MOVE_MEMBERS` — act on people, which
///   is not something an automated projection should ever be able to do.
/// - `MANAGE_MESSAGES`, `MANAGE_THREADS`, `MANAGE_EVENTS` — destructive over
///   other people's content.
/// - `MENTION_EVERYONE` — a guild-wide side effect with no undo.
/// - `VIEW_AUDIT_LOG`, `VIEW_GUILD_INSIGHTS` — read the oversight record that
///   exists to catch this adapter misbehaving.
pub const ELEVATED: u64 = ADMINISTRATOR
    | MANAGE_ROLES
    | MANAGE_CHANNELS
    | MANAGE_WEBHOOKS
    | MANAGE_GUILD
    | MANAGE_GUILD_EXPRESSIONS
    | CREATE_GUILD_EXPRESSIONS
    | KICK_MEMBERS
    | BAN_MEMBERS
    | MODERATE_MEMBERS
    | MANAGE_NICKNAMES
    | MUTE_MEMBERS
    | DEAFEN_MEMBERS
    | MOVE_MEMBERS
    | MANAGE_MESSAGES
    | MANAGE_THREADS
    | MANAGE_EVENTS
    | MENTION_EVERYONE
    | VIEW_AUDIT_LOG
    | VIEW_GUILD_INSIGHTS;

/// A Discord permission set.
///
/// Wire form is a decimal string (see the module docs). An unknown high bit
/// round-trips unchanged rather than being dropped, so a set observed from a
/// guild is never quietly narrowed by this crate's vocabulary lagging
/// Discord's.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Permissions(u64);

impl Permissions {
    /// The empty set.
    pub const NONE: Self = Self(0);

    #[must_use]
    pub const fn from_bits(bits: u64) -> Self {
        Self(bits)
    }

    #[must_use]
    pub const fn bits(self) -> u64 {
        self.0
    }

    #[must_use]
    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    #[must_use]
    pub const fn contains(self, mask: u64) -> bool {
        self.0 & mask == mask
    }

    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// Every bit present in this set that the crate can name, in bit order.
    ///
    /// For showing a person what they are about to approve. A bit outside
    /// [`NAMED_BITS`] is omitted from the list but is still in
    /// [`Permissions::bits`] — the list describes, it does not define.
    #[must_use]
    pub fn names(self) -> Vec<&'static str> {
        NAMED_BITS
            .iter()
            .filter(|bit| self.0 & bit.mask != 0)
            .map(|bit| bit.name)
            .collect()
    }

    /// The elevated bits present in this set, by name.
    ///
    /// Empty means the set is safe to request. Non-empty is a refusal that can
    /// name the offending permission, which is the difference between "denied"
    /// and a message an operator can act on.
    #[must_use]
    pub fn elevated(self) -> Vec<&'static str> {
        NAMED_BITS
            .iter()
            .filter(|bit| bit.mask & ELEVATED != 0 && self.0 & bit.mask != 0)
            .map(|bit| bit.name)
            .collect()
    }

    /// Whether any elevated bit is set, including one this crate cannot name.
    ///
    /// The mask check is the authority; [`Permissions::elevated`] only exists
    /// to describe it.
    #[must_use]
    pub const fn is_elevated(self) -> bool {
        self.0 & ELEVATED != 0
    }
}

impl fmt::Display for Permissions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl Serialize for Permissions {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for Permissions {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        raw.parse::<u64>()
            .map(Self)
            .map_err(|_| de::Error::custom(format!("permissions is not a decimal bitfield: {raw}")))
    }
}
