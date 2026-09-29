//! Surrogate admission: the front half of invoke-through for clients we did
//! not write (ADR 0150).
//!
//! An unmodified SDK or CLI wants a token in an environment variable and puts
//! it in an `Authorization` header. Invoke-through already owns that header —
//! the caller may not set it, and the broker writes the credential itself. A
//! surrogate lets such a client take part without ever holding the credential:
//! it is handed `osr_<32 hex>`, sends it where it would have sent the token,
//! and this module decides whether that request may become a brokered call.
//!
//! **Recognize, strip, re-place — never find-and-replace.** The surrogate is a
//! selector, not a template. Admission finds it, checks it against the ledger,
//! removes the header it arrived in, and hands the request to
//! [`Invoker`](crate::Invoker), which writes the credential into the one place
//! the provider's [`EgressRule`] names. Nothing the client wrote is ever
//! rewritten into a credential, so a surrogate placed in a body, a query or a
//! second header cannot have the credential written there: it is refused. This
//! is what separates the design from the generic string replacer ADR 0005 §5
//! forbids and the page-driven swap ADR 0076 §6 rejects.
//!
//! What must hold for admission, in order, each a distinct refusal:
//!
//! 1. at most one distinct surrogate in the whole request;
//! 2. it was issued by this ledger, is not revoked and has not expired;
//! 3. it is presented by the caller it was issued to (a surrogate copied out
//!    of one run is dead in any other);
//! 4. the request goes, over https, to a host its provider's egress rule names
//!    exactly;
//! 5. it appears exactly once, as the entire value of its declared site.
//!
//! Every refusal is a tripwire. A surrogate sent to the wrong host is the
//! signature of exfiltration, since the only way a surrogate leaves its
//! declared site is that something copied it; [`Refusal::code`] names which
//! fence it hit so the owner's notice can say so. The client is told only
//! [`Refusal::CLIENT_MESSAGE`]: a caller probing with guesses learns nothing
//! about which of them were real.
//!
//! The module is pure. The clock, the entropy and the caller's identity are
//! the adapter's to supply; the adapter (a proxy listener) is not part of this
//! slice.

use std::collections::HashMap;
use std::fmt;

use crate::egress::{rule_for, EgressRule};

mod forward;
mod refusal;
mod scan;
pub use refusal::{Refusal, RefusalCode};
use scan::{check_placement, check_scope, sightings};

/// Every surrogate starts with this marker, and nothing else we issue does.
/// It is deliberately not any provider's own token prefix: a surrogate must be
/// recognisable as one by our redactors and by provider secret scanning alike,
/// so a leaked surrogate is never mistaken for a leaked credential.
pub const SURROGATE_MARKER: &str = "osr_";
/// Hex characters after the marker: 128 bits of caller-supplied entropy.
pub const SURROGATE_HEX_LEN: usize = 32;

/// Where the client is told to put its surrogate. Recognition only: where the
/// credential goes upstream is the provider rule's business, not this.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SurrogateSite {
    /// `Authorization: Bearer <surrogate>` or `Authorization: token
    /// <surrogate>` (the scheme GitHub's older clients send).
    Authorization,
    /// One named header whose whole value is the surrogate (`x-api-key`).
    Header(String),
}

impl SurrogateSite {
    fn header_name(&self) -> &str {
        match self {
            Self::Authorization => "authorization",
            Self::Header(name) => name,
        }
    }

    fn is_exact(&self, value: &str, surrogate: &str) -> bool {
        match self {
            Self::Authorization => value.split_once(' ').is_some_and(|(scheme, rest)| {
                (scheme.eq_ignore_ascii_case("bearer") || scheme.eq_ignore_ascii_case("token"))
                    && rest == surrogate
            }),
            Self::Header(_) => value == surrogate,
        }
    }
}

/// What a surrogate stands for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SurrogateSpec {
    pub provider_id: String,
    /// The `conn://…` reference the brokered call is receipted against.
    pub connection_ref: String,
    /// The run this surrogate belongs to; revoking the run kills it.
    pub run_id: String,
    /// The identity the adapter attests for the presenting process (a peer
    /// credential, a per-run listener). Opaque here, compared exactly.
    pub caller: String,
    pub site: SurrogateSite,
    /// Methods this surrogate may be used with. Required: a surrogate is an
    /// attenuation of the connection, and an unstated scope is not one.
    pub methods: Vec<String>,
    /// Path prefixes, matched on segment boundaries (`/repos/acme` admits
    /// `/repos/acme/x`, never `/repos/acme-private`). Required; `/` is the
    /// explicit "anywhere this host serves".
    pub path_prefixes: Vec<String>,
    pub expires_at_unix: u64,
}

/// An issued surrogate. `Debug` shows only the marker: the value is harmless
/// outside its run, but it is still the key to one, and logs are not the place
/// for keys.
#[derive(Clone, PartialEq, Eq)]
pub struct Surrogate(String);

impl Surrogate {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Surrogate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Surrogate({SURROGATE_MARKER}…)")
    }
}

/// Why issuing failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IssueError {
    #[error("no egress rule serves provider {0}")]
    UnsupportedProvider(String),
    #[error("surrogate spec is incomplete: {0}")]
    Incomplete(&'static str),
    #[error("surrogate already issued")]
    Collision,
}

/// The request as the adapter parsed it off the wire, before anything is
/// forwarded. `host` is lowercased by the adapter from the request target and
/// must agree with the TLS server name it terminated; `port` is `None` for the
/// scheme's default.
#[derive(Debug, Clone, Copy)]
pub struct RequestView<'a> {
    pub method: &'a str,
    pub scheme: &'a str,
    pub host: &'a str,
    pub port: Option<u16>,
    pub path_and_query: &'a str,
    pub headers: &'a [(String, String)],
    pub body: &'a [u8],
}

/// An admitted request: what invoke-through needs to broker it, with the
/// surrogate's header already removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admission {
    pub provider_id: String,
    pub connection_ref: String,
    pub run_id: String,
    pub forward_headers: Vec<(String, String)>,
}

/// Issued surrogates for one broker. In memory only: a restart revokes them
/// all, which is the right failure.
pub struct SurrogateLedger {
    rules: Vec<EgressRule>,
    issued: HashMap<String, (SurrogateSpec, bool)>,
}

/// Counts only. A derived `Debug` would print the map's keys — every live
/// surrogate — into whatever panic or trace touched the ledger.
impl fmt::Debug for SurrogateLedger {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let revoked = self.issued.values().filter(|(_, dead)| *dead).count();
        f.debug_struct("SurrogateLedger")
            .field("providers", &self.rules.len())
            .field("issued", &self.issued.len())
            .field("revoked", &revoked)
            .finish()
    }
}

impl SurrogateLedger {
    #[must_use]
    pub fn new(rules: Vec<EgressRule>) -> Self {
        Self {
            rules,
            issued: HashMap::new(),
        }
    }

    /// Issue a surrogate for `spec` from 16 bytes of caller-supplied entropy.
    ///
    /// # Errors
    ///
    /// `UnsupportedProvider` when no egress rule serves the provider — a
    /// surrogate for a provider the broker cannot reach would be a placeholder
    /// nothing redeems. `Incomplete` for an empty run, caller, connection or
    /// site name. `Collision` if the entropy repeats an issued value.
    pub fn issue(
        &mut self,
        spec: SurrogateSpec,
        entropy: [u8; 16],
    ) -> Result<Surrogate, IssueError> {
        if rule_for(&self.rules, &spec.provider_id).is_none() {
            return Err(IssueError::UnsupportedProvider(spec.provider_id));
        }
        if spec.run_id.is_empty() {
            return Err(IssueError::Incomplete("run_id"));
        }
        if spec.caller.is_empty() {
            return Err(IssueError::Incomplete("caller"));
        }
        if spec.connection_ref.is_empty() {
            return Err(IssueError::Incomplete("connection_ref"));
        }
        if matches!(&spec.site, SurrogateSite::Header(name) if name.is_empty()) {
            return Err(IssueError::Incomplete("site"));
        }
        if spec.methods.is_empty() {
            return Err(IssueError::Incomplete("methods"));
        }
        if spec.path_prefixes.is_empty() || spec.path_prefixes.iter().any(|p| !p.starts_with('/')) {
            return Err(IssueError::Incomplete("path_prefixes"));
        }
        let mut value = String::with_capacity(SURROGATE_MARKER.len() + SURROGATE_HEX_LEN);
        value.push_str(SURROGATE_MARKER);
        for byte in entropy {
            value.push(char::from(HEX[usize::from(byte >> 4)]));
            value.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
        if self.issued.contains_key(&value) {
            return Err(IssueError::Collision);
        }
        self.issued.insert(value.clone(), (spec, false));
        Ok(Surrogate(value))
    }

    /// Revoke every surrogate issued to `run_id`. Revoked entries are kept, so
    /// a late use is reported as `Revoked` — a tripwire — not `Unknown`.
    pub fn revoke_run(&mut self, run_id: &str) -> usize {
        let mut revoked = 0;
        for (spec, dead) in self.issued.values_mut() {
            if spec.run_id == run_id && !*dead {
                *dead = true;
                revoked += 1;
            }
        }
        revoked
    }

    /// Decide one request. `Ok(None)` when it carries no surrogate at all: the
    /// adapter's own egress policy decides what happens to it, not this.
    ///
    /// # Errors
    ///
    /// A [`Refusal`] naming the first fence the request failed.
    pub fn admit(
        &self,
        req: &RequestView<'_>,
        caller: &str,
        now_unix: u64,
    ) -> Result<Option<Admission>, Refusal> {
        let sightings = sightings(req);
        let Some(first) = sightings.first() else {
            return Ok(None);
        };
        if sightings.iter().any(|s| s.value != first.value) {
            return Err(Refusal::bare(RefusalCode::Ambiguous));
        }
        let surrogate = first.value.as_str();
        let Some((spec, revoked)) = self.issued.get(surrogate) else {
            return Err(Refusal::bare(RefusalCode::Unknown));
        };
        if *revoked {
            return Err(Refusal::issued(RefusalCode::Revoked, spec, None));
        }
        if now_unix >= spec.expires_at_unix {
            return Err(Refusal::issued(RefusalCode::Expired, spec, None));
        }
        if caller != spec.caller {
            return Err(Refusal::issued(RefusalCode::ForeignCaller, spec, None));
        }
        self.check_destination(req, spec)?;
        check_scope(req, spec)?;
        check_placement(&sightings, spec, surrogate, req.headers)?;
        let site = spec.site.header_name();
        Ok(Some(Admission {
            provider_id: spec.provider_id.clone(),
            connection_ref: spec.connection_ref.clone(),
            run_id: spec.run_id.clone(),
            forward_headers: req
                .headers
                .iter()
                .filter(|(name, _)| !name.eq_ignore_ascii_case(site))
                .cloned()
                .collect(),
        }))
    }

    fn check_destination(
        &self,
        req: &RequestView<'_>,
        spec: &SurrogateSpec,
    ) -> Result<(), Refusal> {
        let host = req.host.to_ascii_lowercase();
        let rule = rule_for(&self.rules, &spec.provider_id)
            .ok_or_else(|| Refusal::issued(RefusalCode::Misdirected, spec, Some(host.clone())))?;
        let port_ok = req.port.is_none_or(|port| port == 443);
        if !port_ok || !rule.hosts.iter().any(|allowed| *allowed == host) {
            return Err(Refusal::issued(RefusalCode::Misdirected, spec, Some(host)));
        }
        if !req.scheme.eq_ignore_ascii_case(rule.scheme) {
            return Err(Refusal::issued(RefusalCode::Cleartext, spec, Some(host)));
        }
        Ok(())
    }
}

const HEX: &[u8; 16] = b"0123456789abcdef";

#[cfg(test)]
#[path = "surrogate_detail_tests.rs"]
mod detail_tests;
#[cfg(test)]
#[path = "surrogate_fixtures.rs"]
mod fixtures;
#[cfg(test)]
#[path = "surrogate_lifecycle_tests.rs"]
mod lifecycle_tests;
#[cfg(test)]
#[path = "surrogate_tests.rs"]
mod tests;
