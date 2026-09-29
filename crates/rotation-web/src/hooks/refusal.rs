//! What a hook session says when it will not let something happen, and how a
//! session ends.
//!
//! Kept apart from the session so the types a caller matches on do not drag
//! the emitter's machinery into view. A [`Refusal`] is value-blind by
//! construction: it carries the interception point and the combined verdict's
//! `reason` — an identifier such as `opensesame:raw_secret` or
//! `host_error:transform_invalid` — and deliberately *not* the verdict's
//! `message`, which §10.3 only truncates and an interceptor may have filled
//! from what it read.

use std::fmt;

use agent_hooks::{InterceptionPoint, InterceptionRecord};

/// The reason on a [`Refusal`] the session produced itself, without an
/// emission, because emitting would break §3.1's ordering (a verb before
/// `agent_startup` or after `agent_shutdown`, or anything after a §6.1a
/// startup deny). Not a verdict, so it never appears in a record.
pub const OUT_OF_ORDER: &str = "opensesame:hook_out_of_order";

/// A step, turn or run a hook session refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    /// Where the refusal happened.
    pub point: InterceptionPoint,
    /// The combined verdict's reason, or [`OUT_OF_ORDER`]. `None` when the
    /// interceptor denied without one.
    pub reason: Option<String>,
}

impl Refusal {
    pub(crate) const fn new(point: InterceptionPoint, reason: Option<String>) -> Self {
        Self { point, reason }
    }

    /// The refusal a blocking record stands for: its point and reason only.
    pub(crate) fn of(record: &InterceptionRecord) -> Self {
        Self::new(record.interception_point, record.verdict.reason.clone())
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} refused ({})",
            self.point,
            self.reason.as_deref().unwrap_or("no reason")
        )
    }
}

impl std::error::Error for Refusal {}

/// `summary.reason` on `agent_shutdown` (§4.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShutdownReason {
    /// The run reached its outcome and the report was delivered.
    Completed,
    /// A hook verdict blocked the run, or the run failed.
    Error,
    /// The run stood down: a person holds the page, or the caller closed it.
    Cancelled,
}

impl ShutdownReason {
    /// The wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
        }
    }
}

/// `input.role` (§4.2): who the run request came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputRole {
    /// A person asked for the run directly.
    User,
    /// `OpenSesame`'s own scheduler or an operator policy — the usual case.
    System,
    /// Another system, over an integration.
    External,
}

impl InputRole {
    /// The wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::System => "system",
            Self::External => "external",
        }
    }
}
