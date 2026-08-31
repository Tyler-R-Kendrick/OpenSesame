//! What can expire.
//!
//! An [`ExpirySubject`] is deliberately **metadata only**: an identity, a
//! deadline, and a renewal lead time. It has no field capable of carrying
//! credential material, and [`crate::event`]'s payloads are built from it, so
//! a hook subscriber structurally cannot receive a secret through this path.
//! `subject_kinds_carry_no_secret_shaped_fields` in this module is the fence
//! that keeps it that way, mirroring the connector world's
//! `assert_wit_forbids_secrets_get`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::stage::DEFAULT_RENEW_BEFORE_SECONDS;

/// The closed set of things whose expiry the platform tracks.
///
/// Closed on purpose (ADR 0065 Tier X): a community hook subscribes to these
/// kinds, it never adds one, because each kind implies a platform-owned
/// responder with real authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SubjectKind {
    /// An issued leaf certificate (`issued_certificates`).
    Certificate,
    /// A certificate authority's own certificate (`certificate_authorities`).
    CertificateAuthority,
    /// A brokered connection's credential (OAuth token, API key, …).
    ConnectionCredential,
    /// A sealed-store path under a rotation policy.
    StorePath,
    /// A code-signing signer's key/certificate pair (`signers`).
    Signer,
    /// A password at a relying party, under a web-login rotation policy
    /// (ADR 0076). The subject id is the origin, never an account.
    WebLogin,
    /// One participant's reach into a shared session (ADR 0079).
    ///
    /// Unlike every other kind, this one is **never renewable**: see
    /// [`SubjectKind::renewable`]. A certificate that renews itself overnight
    /// is the platform doing its job; a person's access to somebody else's
    /// vault renewing itself overnight is the platform giving away what it
    /// was trusted to hold.
    SessionGrant,
}

impl SubjectKind {
    pub const ALL: [Self; 7] = [
        Self::Certificate,
        Self::CertificateAuthority,
        Self::ConnectionCredential,
        Self::StorePath,
        Self::Signer,
        Self::WebLogin,
        Self::SessionGrant,
    ];

    /// Whether the platform's own responder may ever extend this kind.
    ///
    /// The kind decides, not the subject's `auto_respond` flag, and
    /// [`crate::should_respond`] consults both. A caller that builds a
    /// session-grant subject with `auto_respond: true` — by mistake, or
    /// because a row was copied from a certificate — still gets no automatic
    /// renewal, because extending one human's reach into another's vault is
    /// a decision only a human makes (ADR 0079).
    ///
    /// Expiry events still fire for a non-renewable kind. Telling somebody
    /// their access lapses in an hour is exactly what the ladder is for;
    /// acting on it without them is the part that is refused.
    #[must_use]
    pub const fn renewable(self) -> bool {
        match self {
            Self::Certificate
            | Self::CertificateAuthority
            | Self::ConnectionCredential
            | Self::StorePath
            | Self::Signer
            | Self::WebLogin => true,
            Self::SessionGrant => false,
        }
    }

    /// Frozen wire name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Certificate => "certificate",
            Self::CertificateAuthority => "certificate_authority",
            Self::ConnectionCredential => "connection_credential",
            Self::StorePath => "store_path",
            Self::Signer => "signer",
            Self::WebLogin => "web_login",
            Self::SessionGrant => "session_grant",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == raw)
    }
}

/// A tracked deadline. Metadata only — never a value, never a handle that
/// could be redeemed for one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpirySubject {
    pub kind: SubjectKind,
    /// Stable identity within `(organization_id, kind)`.
    pub subject_id: String,
    pub organization_id: String,
    /// When the thing stops being usable.
    pub expires_at: DateTime<Utc>,
    /// How far ahead of `expires_at` the renewal window opens. `None` uses
    /// [`DEFAULT_RENEW_BEFORE_SECONDS`].
    pub renew_before_seconds: Option<i64>,
    /// Whether the platform's own responder may act on the renewal rung.
    /// `false` still emits every event — subscribers are told, the platform
    /// just does not act. Alerting and acting are separate decisions.
    pub auto_respond: bool,
    /// Whether this subject participates in the informational alert ladder
    /// ([`crate::Track::Alert`]).
    ///
    /// `true` for things with a human-relevant lifetime: a certificate really
    /// does warrant "expires in 30 days". `false` for a recurring *schedule*
    /// such as a rotation policy, where it does not: a policy's deadline moves
    /// on every rotation, which resets the ladder, so an hourly policy would
    /// re-fire notice/warning/urgent every hour forever. Such a subject still
    /// runs the renewal track — it is the whole point of it — it just does not
    /// narrate.
    pub alerting: bool,
    /// Operator-facing label (a certificate common name, a store path, a
    /// connection provider). Never a credential; truncated by the event
    /// builder before it reaches a payload.
    pub label: Option<String>,
}

impl ExpirySubject {
    /// Effective renewal lead time, clamped to at least one second so a
    /// zero or negative configuration cannot collapse onto the `Expired`
    /// rung and make the renewal stage unreachable.
    #[must_use]
    pub fn renew_before(&self) -> i64 {
        self.renew_before_seconds
            .filter(|seconds| *seconds > 0)
            .unwrap_or(DEFAULT_RENEW_BEFORE_SECONDS)
            .max(1)
    }

    /// Seconds until expiry at `now`; negative once expired. Saturating, so a
    /// nonsense timestamp cannot overflow the ladder arithmetic.
    #[must_use]
    pub fn remaining_seconds(&self, now: DateTime<Utc>) -> i64 {
        self.expires_at
            .signed_duration_since(now)
            .num_seconds()
            .clamp(i64::MIN / 2, i64::MAX / 2)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subject(renew: Option<i64>) -> ExpirySubject {
        ExpirySubject {
            kind: SubjectKind::Certificate,
            subject_id: "cert-1".into(),
            organization_id: "org-1".into(),
            expires_at: "2026-09-30T00:00:00Z".parse().unwrap(),
            renew_before_seconds: renew,
            auto_respond: true,
            alerting: true,
            label: Some("api.example.com".into()),
        }
    }

    #[test]
    fn kind_names_are_frozen() {
        assert_eq!(
            SubjectKind::ALL.map(SubjectKind::as_str),
            [
                "certificate",
                "certificate_authority",
                "connection_credential",
                "store_path",
                "signer",
                "web_login",
                "session_grant",
            ],
        );
    }

    #[test]
    fn a_session_grant_is_the_one_kind_that_never_renews_itself() {
        for kind in SubjectKind::ALL {
            assert_eq!(
                kind.renewable(),
                kind != SubjectKind::SessionGrant,
                "{kind:?} renewability"
            );
        }
    }

    #[test]
    fn every_kind_round_trips_and_unknown_is_refused() {
        for kind in SubjectKind::ALL {
            assert_eq!(SubjectKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(SubjectKind::parse("password"), None);
    }

    #[test]
    fn renew_before_falls_back_and_clamps() {
        assert_eq!(subject(None).renew_before(), DEFAULT_RENEW_BEFORE_SECONDS);
        assert_eq!(
            subject(Some(0)).renew_before(),
            DEFAULT_RENEW_BEFORE_SECONDS
        );
        assert_eq!(
            subject(Some(-5)).renew_before(),
            DEFAULT_RENEW_BEFORE_SECONDS
        );
        assert_eq!(subject(Some(3_600)).renew_before(), 3_600);
    }

    #[test]
    fn remaining_seconds_goes_negative_after_expiry() {
        let s = subject(None);
        let before: DateTime<Utc> = "2026-09-29T00:00:00Z".parse().unwrap();
        let after: DateTime<Utc> = "2026-10-01T00:00:00Z".parse().unwrap();
        assert_eq!(s.remaining_seconds(before), 86_400);
        assert_eq!(s.remaining_seconds(after), -86_400);
    }

    #[test]
    fn subject_kinds_carry_no_secret_shaped_fields() {
        // The structural fence: serializing a subject must never produce a
        // key the audit redactor's DENY_KEY pass would strip, because such a
        // key is how credential material would leak into a hook payload.
        let json = serde_json::to_value(subject(None)).unwrap();
        let keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        for forbidden in [
            "secret",
            "value",
            "password",
            "token",
            "access_token",
            "refresh_token",
            "client_secret",
            "api_key",
            "private_key",
            "user_code",
            "device_code",
        ] {
            assert!(
                !keys.iter().any(|k| k.contains(forbidden)),
                "ExpirySubject grew a secret-shaped field: {forbidden}",
            );
        }
    }
}
