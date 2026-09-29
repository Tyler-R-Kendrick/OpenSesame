//! Login-form surrogate substitution for the agent browser (ADR 0150 §6.3).
//!
//! CDP `fill_credential` keeps a password from the model, not from the page:
//! a compromised third-party script on a login page reads the filled field,
//! and a password outlives a session. With a declared substitution the runner
//! types a surrogate (`osr_` and 128 bits of hex) into the field instead, and
//! the credential exists only in the one request the recipe declared, placed
//! there at the runner's egress boundary after the page is done with it.
//!
//! **Recognize, strip, re-place — never find-and-replace.** The body is parsed
//! as the one format it claims to be; the surrogate must be the whole value of
//! the one declared field, exactly once, in a POST to the exact declared
//! origin and path; and the credential is then written into that field with
//! the format's own encoder. A surrogate anywhere else is refused, because the
//! credential would never have been written there anyway:
//!
//! | fence | refusal |
//! |-------|---------|
//! | scheme, host, port or path is not the declared action | [`RefusalCode::Misdirected`] |
//! | not a POST; compressed; not form or JSON; not UTF-8; malformed | [`RefusalCode::Unsupported`] |
//! | another field or key, the query, a header, a second copy, nested JSON, an array, multipart | [`RefusalCode::Misplaced`] |
//! | the declared submission carries no surrogate | [`RefusalCode::Absent`] |
//! | a second substitution in one attempt | [`RefusalCode::Replayed`] |
//!
//! Misdirected and Misplaced are tripwires — something copied the surrogate —
//! and park the run. The others fall back to CDP fill, as does a substituted
//! login the site rejects; nothing ever retries substitution
//! ([`AfterSubstitution`]). Password-set fields are never a site: see
//! [`LoginSubstitution::declare`]. Responses and DOM reads are scrubbed of the
//! credential before the model sees them ([`ResponseScrub`]).
//!
//! The module is pure. The entropy, the credential and the interception are
//! the runner's to supply; [`SurrogateLoginTransport`] is the contract a
//! runner implements to offer it.
//!
//! A declaration substitutes nothing until the plugin's switch arms it
//! ([`LoginRoad::choose`]): only an [`ArmedSubstitution`] has
//! [`egress`](ArmedSubstitution::egress). The whole module is behind the
//! `login-surrogate` cargo feature, off by default (ADR 0150 §7).

use std::sync::atomic::Ordering;

use secrecy::{ExposeSecret, SecretString};
use zeroize::Zeroizing;

mod decl;
mod form;
mod gate;
mod json;
mod outcome;
mod request;
mod runner;
mod scrub;
mod sighting;

pub use decl::{
    DeclareError, LoginSubstitution, LoginSubstitutionSpec, LoginSurrogate, SubstitutionPurpose,
};
pub use gate::{ArmedSubstitution, CdpOnly, LoginRoad, SUBSTITUTION_PLUGIN};
pub use outcome::{AfterSubstitution, FallbackReason, ParkReason, Refusal, RefusalCode};
pub use request::{LoginOrigin, LoginRequest};
pub use runner::{
    run_login, run_surrogate_login, EgressReport, LoginOutcome, LoginReport, LoginVia,
    SurrogateLoginRecipe, SurrogateLoginTransport,
};
pub use scrub::{ResponseScrub, REDACTED};

use request::{parse_url, Target};

/// The surrogate marker, shared with invoke-through's (ADR 0150 §3).
pub const SURROGATE_MARKER: &str = "osr_";
/// Hex characters after the marker: 128 bits.
pub const SURROGATE_HEX_LEN: usize = 32;

/// A substituted body. `Debug` prints its length: the body is the credential
/// and the rest of the form.
pub struct Substituted {
    body: Zeroizing<Vec<u8>>,
}

impl std::fmt::Debug for Substituted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Substituted")
            .field("len", &self.body.len())
            .finish()
    }
}

impl Substituted {
    /// The body to send in place of the page's. The runner sets
    /// `Content-Length` from [`len`](Self::len) and sends it once.
    #[must_use]
    pub fn body(&self) -> &[u8] {
        &self.body
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.body.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.body.is_empty()
    }

    #[must_use]
    pub fn into_body(self) -> Zeroizing<Vec<u8>> {
        self.body
    }
}

/// What the egress hook does with one request.
#[derive(Debug)]
pub enum Egress {
    /// No surrogate anywhere in it: send it as the page wrote it.
    Untouched,
    /// The declared submission: send this body instead.
    Substituted(Substituted),
}

enum Media {
    Form,
    Json,
    Other,
}

impl ArmedSubstitution {
    /// The runner's egress hook: called for **every** request the page sends
    /// while this declaration is armed.
    ///
    /// A request with no surrogate in it is [`Egress::Untouched`]; one with a
    /// surrogate anywhere is held to [`substitute`](Self::substitute)'s rules.
    ///
    /// # Errors
    ///
    /// The [`Refusal`] `substitute` returns. The runner fails the request with
    /// [`Refusal::CLIENT_MESSAGE`] and acts on [`Refusal::next`].
    pub fn egress(
        &self,
        request: &LoginRequest<'_>,
        credential: &SecretString,
    ) -> Result<Egress, Refusal> {
        if !carries_surrogate(request) {
            return Ok(Egress::Untouched);
        }
        self.substitute(request, credential)
            .map(Egress::Substituted)
    }

    /// Substitute the credential into the declared submission.
    ///
    /// # Errors
    ///
    /// A [`Refusal`] naming the first fence the request failed, in the order
    /// of the module table.
    pub fn substitute(
        &self,
        request: &LoginRequest<'_>,
        credential: &SecretString,
    ) -> Result<Substituted, Refusal> {
        let target =
            parse_url(request.url).ok_or_else(|| Refusal::new(RefusalCode::Misdirected, "url"))?;
        if !target.is_origin(&self.origin) {
            return Err(Refusal::new(RefusalCode::Misdirected, &target.authority()));
        }
        if target.path != self.action_path {
            return Err(Refusal::new(RefusalCode::Misdirected, "path"));
        }
        if request.method != "POST" {
            return Err(Refusal::new(RefusalCode::Unsupported, "method"));
        }
        refuse_outside_body(&target, request.headers)?;
        refuse_encoded(request.headers)?;
        let surrogate = self.surrogate.as_str();
        let secret = credential.expose_secret();
        let body = match media_type(request.headers)? {
            Media::Form => form::substitute(request.body, &self.field, surrogate, secret)?,
            Media::Json => json::substitute(request.body, &self.field, surrogate, secret)?,
            Media::Other if sighting::count(request.body) > 0 => {
                return Err(Refusal::new(RefusalCode::Misplaced, "body"));
            }
            Media::Other => return Err(Refusal::new(RefusalCode::Unsupported, "content-type")),
        };
        if self
            .spent
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(Refusal::new(RefusalCode::Replayed, "attempt"));
        }
        Ok(Substituted { body })
    }

    /// End the attempt with what the site said about the substituted login.
    ///
    /// Takes the declaration by value: after this there is no declaration to
    /// substitute with, so a fallback is by CDP fill or not at all.
    #[must_use]
    pub fn conclude(self, verified: crate::tools::Verified) -> AfterSubstitution {
        use crate::tools::Verified;
        match verified {
            Verified::Works => AfterSubstitution::LoggedIn,
            Verified::Rejected => AfterSubstitution::FallBackToCdpFill(FallbackReason::Rejected),
            Verified::Indeterminate => AfterSubstitution::Park(ParkReason::Indeterminate),
        }
    }
}

/// The surrogate in the request line or a header is misplaced, whatever the
/// body holds: the credential is only ever written into the body.
fn refuse_outside_body(target: &Target<'_>, headers: &[(String, String)]) -> Result<(), Refusal> {
    let path = target.path.as_bytes();
    if sighting::count(path) + sighting::count(&sighting::percent_decode(path, false)) > 0 {
        return Err(Refusal::new(RefusalCode::Misplaced, "path"));
    }
    if let Some(query) = target.query.map(str::as_bytes) {
        if sighting::count(query) + sighting::count(&sighting::percent_decode(query, true)) > 0 {
            return Err(Refusal::new(RefusalCode::Misplaced, "query"));
        }
    }
    for (name, value) in headers {
        if sighting::count(name.as_bytes()) + sighting::count(value.as_bytes()) > 0 {
            return Err(Refusal::new(
                RefusalCode::Misplaced,
                &name.to_ascii_lowercase(),
            ));
        }
    }
    Ok(())
}

/// Only an identity body is parsed. A compressed body cannot be read without
/// a decoder per scheme, and one that cannot be read is not substituted into.
fn refuse_encoded(headers: &[(String, String)]) -> Result<(), Refusal> {
    let encoded = headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("content-encoding"))
        .flat_map(|(_, value)| value.split(','))
        .any(|coding| !coding.trim().eq_ignore_ascii_case("identity"));
    if encoded {
        return Err(Refusal::new(RefusalCode::Unsupported, "content-encoding"));
    }
    Ok(())
}

fn media_type(headers: &[(String, String)]) -> Result<Media, Refusal> {
    let mut declared = headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("content-type"));
    let (Some((_, value)), None) = (declared.next(), declared.next()) else {
        return Ok(Media::Other);
    };
    let mut parts = value.split(';');
    let essence = parts.next().unwrap_or_default().trim().to_ascii_lowercase();
    let media = match essence.as_str() {
        "application/x-www-form-urlencoded" => Media::Form,
        "application/json" => Media::Json,
        _ => return Ok(Media::Other),
    };
    for param in parts {
        let Some((key, charset)) = param.split_once('=') else {
            continue;
        };
        let charset = charset.trim().trim_matches('"').to_ascii_lowercase();
        if key.trim().eq_ignore_ascii_case("charset") && charset != "utf-8" && charset != "utf8" {
            return Err(Refusal::new(RefusalCode::Unsupported, "charset"));
        }
    }
    Ok(media)
}

/// Whether a surrogate-shaped run appears anywhere in the request, in any
/// decoding substitution itself would read.
fn carries_surrogate(request: &LoginRequest<'_>) -> bool {
    let url = request.url.as_bytes();
    sighting::count(url) > 0
        || sighting::count(&sighting::percent_decode(url, true)) > 0
        || request.headers.iter().any(|(name, value)| {
            sighting::count(name.as_bytes()) + sighting::count(value.as_bytes()) > 0
        })
        || sighting::count(request.body) > 0
        || form::carries(request.body)
        || json::carries(request.body)
}
