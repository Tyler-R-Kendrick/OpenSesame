//! How a DNS allowance ends, and who actually ends it (DNS-LIFETIME).
//!
//! Blocky has exactly one autonomous timer: `GET /api/blocking/disable` with a
//! `duration`, which re-enables the group when it elapses (measured —
//! `autoEnableInSec` counted down from 29 for a `30s` disable). That timer
//! operates on a whole group, so reaching for it to time-box a single domain
//! would mean turning the unit's entire filter off for the duration. This crate
//! refuses that trade, which leaves a plain consequence:
//!
//! **Nothing in the resolver expires a list entry.** An allowance ends when
//! something rewrites the list and calls `lists/refresh`. [`ExpiryHolder`]
//! exists so that fact is in the type system rather than in a comment nobody
//! reads, because "the DNS filter expires it" is the natural assumption and it
//! is false.
//!
//! This module runs no timer. [`reconcile`] is a pure function of the
//! allowances and a clock reading the caller supplies, so the scheduling belongs
//! to the lifecycle scanner that already owns every other deadline in the
//! platform (ADR 0074, `INV-GA-05`) instead of to a private loop in here.
//!
//! The honest gap: between an allowance lapsing and the reconciled lists being
//! applied, the resolver still answers with the old lists. [`ReconciledLists`]
//! reports what has lapsed so a caller can see the window rather than assume it
//! away, and [`ReconciledLists::is_settled`] is how a caller asks whether the
//! resolver is actually in step with the record.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::scope::DomainRule;
use crate::topology::UnitId;

/// The longest a single allowance may run before it must be granted again.
///
/// A day is not a safety property, it is a forcing function: an allowance that
/// outlives the reason it was granted is indistinguishable from a permanent
/// hole, and a person renewing one is a person still choosing it.
pub const MAX_ALLOWANCE_SECONDS: i64 = 24 * 60 * 60;

/// Why a proposed allowance is not one.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum LifetimeError {
    /// The lifetime was zero or negative.
    #[error("an allowance needs a positive lifetime, got {seconds}s")]
    NotPositive {
        /// The lifetime that was offered.
        seconds: i64,
    },
    /// The lifetime exceeded [`MAX_ALLOWANCE_SECONDS`].
    #[error("an allowance runs at most {MAX_ALLOWANCE_SECONDS}s, got {seconds}s")]
    TooLong {
        /// The lifetime that was offered.
        seconds: i64,
    },
}

/// Which component makes an allowance stop working.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExpiryHolder {
    /// The resolver re-enables itself at a deadline it is tracking. True of
    /// Blocky's group disable, and of nothing this crate issues.
    DnsServer,
    /// Whoever applies [`reconcile`]'s output. If that stops running — crashed
    /// host, wedged queue, forgotten cron — the allowance keeps working.
    ListReconciler,
}

impl ExpiryHolder {
    /// Whether the deadline holds without anything of ours still running.
    ///
    /// [`Self::ListReconciler`] is `false`, and that is the whole reason this
    /// enum exists: a caller that needs an unattended deadline has to be told
    /// no, not handed one that depends on a process staying up.
    #[must_use]
    pub const fn survives_our_absence(self) -> bool {
        match self {
            Self::DnsServer => true,
            Self::ListReconciler => false,
        }
    }
}

/// A time-boxed permission for one name, in one enforcement unit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Allowance {
    unit: UnitId,
    rule: DomainRule,
    granted_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}

impl Allowance {
    /// Grant an allowance running `seconds` from `granted_at`.
    ///
    /// # Errors
    ///
    /// Returns [`LifetimeError`] when the lifetime is not positive or runs past
    /// [`MAX_ALLOWANCE_SECONDS`].
    pub fn granted(
        unit: UnitId,
        rule: DomainRule,
        granted_at: DateTime<Utc>,
        seconds: i64,
    ) -> Result<Self, LifetimeError> {
        if seconds <= 0 {
            return Err(LifetimeError::NotPositive { seconds });
        }
        if seconds > MAX_ALLOWANCE_SECONDS {
            return Err(LifetimeError::TooLong { seconds });
        }
        Ok(Self {
            unit,
            rule,
            granted_at,
            expires_at: granted_at + Duration::seconds(seconds),
        })
    }

    /// The unit this allowance belongs to.
    #[must_use]
    pub const fn unit(&self) -> &UnitId {
        &self.unit
    }

    /// The name this allowance permits.
    #[must_use]
    pub const fn rule(&self) -> &DomainRule {
        &self.rule
    }

    /// When it was granted.
    #[must_use]
    pub const fn granted_at(&self) -> DateTime<Utc> {
        self.granted_at
    }

    /// When it lapses.
    #[must_use]
    pub const fn expires_at(&self) -> DateTime<Utc> {
        self.expires_at
    }

    /// Whether it is still in force at `now`.
    ///
    /// The deadline is exclusive: at exactly `expires_at` the allowance is over,
    /// so a zero-width allowance cannot exist by rounding.
    #[must_use]
    pub fn is_live(&self, now: DateTime<Utc>) -> bool {
        now < self.expires_at
    }

    /// Who makes this allowance stop working. Always
    /// [`ExpiryHolder::ListReconciler`] — see the module documentation.
    #[must_use]
    pub const fn expiry_holder(&self) -> ExpiryHolder {
        ExpiryHolder::ListReconciler
    }
}

/// The allowlist one unit should have, and what fell out of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReconciledLists {
    /// The rules that belong in the unit's allowlist now, sorted and deduped so
    /// the rendered file is byte-stable and a no-op refresh is recognisable.
    pub allow: Vec<DomainRule>,
    /// The rules that have lapsed since they were granted. Non-empty means the
    /// resolver is still permitting something it should not, until this output
    /// is applied.
    pub lapsed: Vec<DomainRule>,
}

impl ReconciledLists {
    /// Whether the resolver, once this is applied, needs nothing further.
    ///
    /// `false` means an allowance has lapsed in the record but not yet in the
    /// resolver — the window named in the module documentation.
    #[must_use]
    pub fn is_settled(&self) -> bool {
        self.lapsed.is_empty()
    }
}

/// Work out what one unit's allowlist should hold at `now`.
///
/// Allowances for other units are ignored rather than merged: mixing them is
/// exactly the leak [`crate::topology`] refuses at the config layer, and it
/// would be undetectable at this one.
#[must_use]
pub fn reconcile(unit: &UnitId, allowances: &[Allowance], now: DateTime<Utc>) -> ReconciledLists {
    let mut allow = Vec::new();
    let mut lapsed = Vec::new();

    for allowance in allowances.iter().filter(|a| a.unit() == unit) {
        if allowance.is_live(now) {
            allow.push(allowance.rule().clone());
        } else {
            lapsed.push(allowance.rule().clone());
        }
    }

    allow.sort();
    allow.dedup();
    lapsed.sort();
    lapsed.dedup();

    ReconciledLists { allow, lapsed }
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, Duration, Utc};

    use super::{reconcile, Allowance, ExpiryHolder, LifetimeError, MAX_ALLOWANCE_SECONDS};
    use crate::scope::DomainRule;
    use crate::topology::UnitId;

    fn t0() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-09-15T12:00:00Z")
            .expect("fixed timestamp")
            .with_timezone(&Utc)
    }

    fn unit(raw: &str) -> UnitId {
        UnitId::parse(raw).expect("unit id")
    }

    fn rule(raw: &str) -> DomainRule {
        DomainRule::parse(raw).expect("rule")
    }

    fn allowance(unit_name: &str, name: &str, seconds: i64) -> Allowance {
        Allowance::granted(unit(unit_name), rule(name), t0(), seconds).expect("allowance")
    }

    #[test]
    fn an_allowance_is_over_at_its_deadline_not_after_it() {
        let a = allowance("alpha", "docs.example.org", 600);
        assert!(a.is_live(t0()));
        assert!(a.is_live(t0() + Duration::seconds(599)));
        // Exclusive: no allowance survives its own expiry instant.
        assert!(!a.is_live(t0() + Duration::seconds(600)));
        assert!(!a.is_live(t0() + Duration::seconds(601)));
        assert_eq!(a.expires_at(), t0() + Duration::seconds(600));
    }

    #[test]
    fn a_lifetime_must_be_positive_and_bounded() {
        assert_eq!(
            Allowance::granted(unit("alpha"), rule("a.example.org"), t0(), 0),
            Err(LifetimeError::NotPositive { seconds: 0 })
        );
        assert_eq!(
            Allowance::granted(unit("alpha"), rule("a.example.org"), t0(), -5),
            Err(LifetimeError::NotPositive { seconds: -5 })
        );
        let too_long = MAX_ALLOWANCE_SECONDS + 1;
        assert_eq!(
            Allowance::granted(unit("alpha"), rule("a.example.org"), t0(), too_long),
            Err(LifetimeError::TooLong { seconds: too_long })
        );
        // The boundary itself is allowed.
        assert!(Allowance::granted(
            unit("alpha"),
            rule("a.example.org"),
            t0(),
            MAX_ALLOWANCE_SECONDS
        )
        .is_ok());
    }

    #[test]
    fn our_deadlines_do_not_survive_our_absence_and_say_so() {
        // The assumption this guards: that the resolver is watching the clock.
        // It is not, for anything this crate issues.
        let a = allowance("alpha", "docs.example.org", 600);
        assert_eq!(a.expiry_holder(), ExpiryHolder::ListReconciler);
        assert!(!a.expiry_holder().survives_our_absence());
        assert!(ExpiryHolder::DnsServer.survives_our_absence());
    }

    #[test]
    fn reconciling_keeps_the_live_rules_and_reports_the_lapsed_ones() {
        let allowances = [
            allowance("alpha", "docs.example.org", 600),
            allowance("alpha", "api.example.org", 60),
        ];
        let now = t0() + Duration::seconds(120);

        let settled = reconcile(&unit("alpha"), &allowances, t0());
        assert_eq!(
            settled.allow,
            vec![rule("api.example.org"), rule("docs.example.org")]
        );
        assert!(settled.is_settled());

        let partial = reconcile(&unit("alpha"), &allowances, now);
        assert_eq!(partial.allow, vec![rule("docs.example.org")]);
        assert_eq!(partial.lapsed, vec![rule("api.example.org")]);
        // Not settled: the resolver still permits `api` until this is applied.
        assert!(!partial.is_settled());
    }

    #[test]
    fn reconciling_never_mixes_one_units_allowances_into_another() {
        // The leak `topology` refuses in config form would be invisible here.
        let allowances = [
            allowance("alpha", "alpha-only.example.org", 600),
            allowance("beta", "beta-only.example.org", 600),
        ];
        let alpha = reconcile(&unit("alpha"), &allowances, t0());
        assert_eq!(alpha.allow, vec![rule("alpha-only.example.org")]);
        let beta = reconcile(&unit("beta"), &allowances, t0());
        assert_eq!(beta.allow, vec![rule("beta-only.example.org")]);
    }

    #[test]
    fn reconciled_output_is_byte_stable_regardless_of_grant_order() {
        let forward = [
            allowance("alpha", "b.example.org", 600),
            allowance("alpha", "a.example.org", 600),
            allowance("alpha", "a.example.org", 600),
        ];
        let reversed = [
            allowance("alpha", "a.example.org", 600),
            allowance("alpha", "a.example.org", 600),
            allowance("alpha", "b.example.org", 600),
        ];
        let one = reconcile(&unit("alpha"), &forward, t0());
        let two = reconcile(&unit("alpha"), &reversed, t0());
        assert_eq!(one, two);
        // Deduped, so a doubly-granted rule is one line, not two.
        assert_eq!(
            one.allow,
            vec![rule("a.example.org"), rule("b.example.org")]
        );
    }
}
