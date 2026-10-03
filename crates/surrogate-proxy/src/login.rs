//! Login-form substitution at the proxy (ADR 0150 §6.3), through
//! `opensesame-rotation-web`'s `login-surrogate` feature — compiled into this
//! plugin crate and nothing else (ADR 0150 §7).
//!
//! A run may declare logins beside its API grants. Each one is a
//! [`LoginSubstitution`] armed by [`LoginRoad::choose`] over the plugin's
//! own switch, so a switched-off, forced-off or absent plugin arms nothing
//! and the run refuses to start rather than hand the child a surrogate that
//! could never sign in. The child gets `osr_…` in the declared variable, and
//! its browser types that into the login form. When the form is posted
//! through the proxy, [`ArmedSubstitution::egress`] recognizes the surrogate
//! as the whole value of the one declared field of a form or JSON POST to the
//! exact declared origin and path, with identity encoding, and re-places the
//! credential with the body format's own encoder — once. Any other
//! appearance is refused: misdirected and misplaced are tripwires, the rest
//! fall back, and nothing ever retries substitution.
//!
//! Every response from a declared login origin passes through a
//! [`ResponseScrub`] for its credential before the child reads it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use opensesame_plugin_settings::PluginState;
use opensesame_rotation_web::{
    ArmedSubstitution, CdpOnly, DeclareError, Egress, FieldSnapshot, LoginOrigin, LoginRequest,
    LoginRoad, LoginSubstitution, LoginSubstitutionSpec, Refusal, ResponseScrub, Substituted,
};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::CertificateDer;
use secrecy::SecretString;
use zeroize::Zeroizing;

use crate::auth::random_entropy;
use crate::listener::unpoison;
use crate::passthrough::PassthroughClient;

/// One login a run's child signs in with. The credential is the human's,
/// read by the embedder from its own store; it reaches only the declared
/// field of the declared submission. `Debug` never prints it.
#[derive(Clone)]
pub struct LoginGrant {
    /// Where the child receives the login surrogate.
    pub env_var: String,
    /// `https://host[:port]`, exact.
    pub origin: String,
    /// The form's action path, exact, no query.
    pub action_path: String,
    /// The one form field (or top-level JSON key) the credential goes into.
    pub field: String,
    pub credential: SecretString,
    pub trust: LoginTrust,
}

impl std::fmt::Debug for LoginGrant {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginGrant")
            .field("env_var", &self.env_var)
            .field("origin", &self.origin)
            .field("action_path", &self.action_path)
            .field("field", &self.field)
            .field("trust", &self.trust)
            .finish_non_exhaustive()
    }
}

/// Which roots the login origin's certificate must chain to.
#[derive(Clone, PartialEq, Eq)]
pub enum LoginTrust {
    /// The public web's roots.
    Webpki,
    /// One operator-supplied anchor (PEM), and nothing else: a private login
    /// origin. It replaces webpki for this origin only.
    Anchor(String),
}

impl std::fmt::Debug for LoginTrust {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Webpki => "Webpki",
            Self::Anchor(_) => "Anchor",
        })
    }
}

/// Why a declared login could not be armed. Names no value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum LoginError {
    #[error("the login declaration is refused: {0}")]
    Declare(DeclareError),
    #[error("login substitution is not armed ({})", .0.as_str())]
    NotArmed(CdpOnly),
    #[error("the login trust anchor is not a certificate")]
    Trust,
}

/// What one request carrying a login surrogate comes to.
pub(crate) enum DeskEgress {
    /// The declaration was revoked (the run tripped or ended).
    Revoked,
    Substituted(Substituted),
    Refused(Refusal),
}

/// One armed login, for the life of its run.
pub(crate) struct LoginDesk {
    pub(crate) env_var: String,
    pub(crate) origin: LoginOrigin,
    surrogate: Zeroizing<String>,
    armed: Mutex<Option<ArmedSubstitution>>,
    credential: Mutex<Option<SecretString>>,
    pub(crate) scrub: ResponseScrub,
    pub(crate) client: PassthroughClient,
    revoked: AtomicBool,
}

impl LoginDesk {
    fn arm(grant: &LoginGrant, switch: Option<&PluginState>) -> Result<Self, LoginError> {
        let declared = LoginSubstitution::declare(
            LoginSubstitutionSpec {
                origin: grant.origin.clone(),
                action_path: grant.action_path.clone(),
                field: grant.field.clone(),
                control: FieldSnapshot {
                    selector: format!("[name=\"{}\"]", grant.field),
                    input_type: Some("password".into()),
                    autocomplete: Some("current-password".into()),
                    is_credential_target: true,
                    has_box: true,
                },
            },
            random_entropy(),
        )
        .map_err(LoginError::Declare)?;
        let armed = match switch.map(|state| LoginRoad::choose(Some(declared), state)) {
            Some(LoginRoad::Substitute(armed)) => armed,
            Some(LoginRoad::CdpFill(why)) => return Err(LoginError::NotArmed(why)),
            None => return Err(LoginError::NotArmed(CdpOnly::NotInstalled)),
        };
        let client = match &grant.trust {
            LoginTrust::Webpki => PassthroughClient::webpki(),
            LoginTrust::Anchor(pem) => anchored(pem)?,
        };
        Ok(Self {
            env_var: grant.env_var.clone(),
            origin: armed.origin().clone(),
            surrogate: Zeroizing::new(armed.surrogate().as_str().to_owned()),
            armed: Mutex::new(Some(armed)),
            scrub: ResponseScrub::new(&grant.credential),
            credential: Mutex::new(Some(grant.credential.clone())),
            client,
            revoked: AtomicBool::new(false),
        })
    }

    /// Whether this desk's surrogate is anywhere in the request, raw or
    /// percent-decoded. A transformed copy is not seen and redeems nothing
    /// (ADR 0150 §8).
    pub(crate) fn appears_in(&self, url: &str, headers: &[(String, String)], body: &[u8]) -> bool {
        let needle = self.surrogate.as_bytes();
        let seen = |haystack: &[u8]| {
            contains(haystack, needle) || contains(&percent_decode(haystack), needle)
        };
        seen(url.as_bytes())
            || headers
                .iter()
                .any(|(name, value)| seen(name.as_bytes()) || seen(value.as_bytes()))
            || seen(body)
    }

    /// Put one request carrying this surrogate to the declaration.
    pub(crate) fn egress(&self, request: &LoginRequest<'_>) -> DeskEgress {
        let armed = unpoison(self.armed.lock());
        let credential = unpoison(self.credential.lock());
        let (Some(armed), Some(credential)) = (armed.as_ref(), credential.as_ref()) else {
            return DeskEgress::Revoked;
        };
        if self.revoked.load(Ordering::SeqCst) {
            return DeskEgress::Revoked;
        }
        match armed.egress(request, credential) {
            Ok(Egress::Substituted(body)) => DeskEgress::Substituted(body),
            // `egress` found no surrogate where `appears_in` did: a decoding
            // one reads and the other does not. Never forwarded.
            Ok(Egress::Untouched) => DeskEgress::Revoked,
            Err(refusal) => DeskEgress::Refused(refusal),
        }
    }

    /// Whether `host:port` is this login's origin.
    pub(crate) fn serves(&self, host: &str, port: u16) -> bool {
        self.origin.host() == host && self.origin.port() == port
    }

    /// Drop the declaration and the credential; keep the surrogate text, so a
    /// late use is recognized and refused as revoked. `true` if it was live.
    fn revoke(&self) -> bool {
        let was_live = !self.revoked.swap(true, Ordering::SeqCst);
        drop(unpoison(self.armed.lock()).take());
        drop(unpoison(self.credential.lock()).take());
        was_live
    }
}

/// A run's armed logins.
pub(crate) struct RunLogins {
    pub(crate) desks: Vec<LoginDesk>,
}

impl RunLogins {
    /// Arm every grant, or none.
    pub(crate) fn arm(
        grants: &[LoginGrant],
        switch: Option<&PluginState>,
    ) -> Result<Option<Arc<Self>>, LoginError> {
        if grants.is_empty() {
            return Ok(None);
        }
        let desks = grants
            .iter()
            .map(|grant| LoginDesk::arm(grant, switch))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(Arc::new(Self { desks })))
    }

    /// `(variable, surrogate)` per login, for the child's environment.
    pub(crate) fn surrogates(&self) -> Vec<(String, Zeroizing<String>)> {
        self.desks
            .iter()
            .map(|desk| (desk.env_var.clone(), desk.surrogate.clone()))
            .collect()
    }

    /// Revoke every login; how many were live.
    pub(crate) fn revoke(&self) -> usize {
        self.desks.iter().filter(|desk| desk.revoke()).count()
    }

    /// The desk whose origin is `host:port`.
    pub(crate) fn for_origin(&self, host: &str, port: u16) -> Option<&LoginDesk> {
        self.desks.iter().find(|desk| desk.serves(host, port))
    }
}

fn anchored(pem: &str) -> Result<PassthroughClient, LoginError> {
    let der = CertificateDer::from_pem_slice(pem.as_bytes()).map_err(|_| LoginError::Trust)?;
    let mut roots = rustls::RootCertStore::empty();
    roots.add(der).map_err(|_| LoginError::Trust)?;
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| LoginError::Trust)?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(PassthroughClient::with_tls(config, None))
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

/// `%XX` decoded once; anything else, `+` included, kept as it is.
fn percent_decode(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = |b: u8| char::from(b).to_digit(16);
        match (bytes[at], bytes.get(at + 1), bytes.get(at + 2)) {
            (b'%', Some(&high), Some(&low)) if hex(high).is_some() && hex(low).is_some() => {
                let value = hex(high).unwrap_or(0) * 16 + hex(low).unwrap_or(0);
                out.push(u8::try_from(value).unwrap_or(b'%'));
                at += 3;
            }
            (byte, _, _) => {
                out.push(byte);
                at += 1;
            }
        }
    }
    out
}

#[cfg(test)]
#[path = "login_tests.rs"]
mod tests;
