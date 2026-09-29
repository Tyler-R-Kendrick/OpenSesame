//! Declaring a substitution site: the one field of the one login submission a
//! recipe names, and the surrogate issued for it.
//!
//! What cannot be declared matters as much as what can. There is no purpose
//! but [`SubstitutionPurpose::Login`], and a field that sets a password — the
//! `new-password` autocomplete token, a `new_password` or `confirm` name — is
//! refused at construction. ADR 0150 §6.3 keeps ADR 0076 §6 for rotation:
//! a page that hashes a password-set field turns a surrogate into a new
//! password nobody holds, silently. On a login the same transform fails
//! loudly, which is the whole reason login is different.

use std::fmt;
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroizing;

use super::request::LoginOrigin;
use super::sighting;
use super::{SURROGATE_HEX_LEN, SURROGATE_MARKER};
use crate::capture::FieldSnapshot;

/// Why a substitution may exist. One variant, on purpose: a password-set
/// flow has no way to name itself here, so it has no way to obtain one.
///
/// ```
/// let _ = opensesame_rotation_web::SubstitutionPurpose::Login;
/// ```
///
/// ```compile_fail
/// let _ = opensesame_rotation_web::SubstitutionPurpose::Rotation;
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubstitutionPurpose {
    Login,
}

/// What a login recipe declares about its submission.
///
/// `origin` is `https://host[:port]`, exact; `action_path` is the form's
/// action path, exact, with no query; `field` is the one form field (or
/// top-level JSON key) the credential goes into; `control` is the DOM field
/// the surrogate is typed into, as the capture pipeline described it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoginSubstitutionSpec {
    pub origin: String,
    pub action_path: String,
    pub field: String,
    pub control: FieldSnapshot,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum DeclareError {
    /// Not `https://host[:port]`. A cleartext origin is refused here too: a
    /// credential is not substituted into a request anyone on the path reads.
    #[error("the action origin is not an exact https origin")]
    Origin,
    /// Empty, relative, carrying a query or fragment, or holding a dot segment.
    #[error("the action path is not an exact absolute path")]
    ActionPath,
    #[error("the substituted field has no name")]
    EmptyField,
    /// The field sets a password. Rotation is never a substitution site.
    #[error("the field sets a password; only a login field may be substituted")]
    PasswordSetField,
    /// The entropy is one byte repeated — a zeroed buffer, not randomness.
    #[error("the surrogate entropy is not random")]
    WeakEntropy,
}

/// The surrogate typed into the page in place of the credential.
///
/// Worthless outside this declaration's one site, but still the key to it, so
/// `Debug` prints the marker only.
#[derive(Clone, PartialEq, Eq)]
pub struct LoginSurrogate(Zeroizing<String>);

impl LoginSurrogate {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for LoginSurrogate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "LoginSurrogate({SURROGATE_MARKER}…)")
    }
}

/// One declared login substitution. Deliberately not `Clone`: the runner
/// holds exactly one, and once the plugin's switch has armed it
/// ([`LoginRoad::choose`](super::LoginRoad::choose)),
/// [`ArmedSubstitution::conclude`](super::ArmedSubstitution::conclude)
/// consumes it, leaving nothing to try a second substitution with. Declared
/// but unarmed, it can substitute nothing.
pub struct LoginSubstitution {
    pub(super) origin: LoginOrigin,
    pub(super) action_path: String,
    pub(super) field: String,
    pub(super) surrogate: LoginSurrogate,
    purpose: SubstitutionPurpose,
    /// Set by the one successful substitution; every later one is refused.
    pub(super) spent: AtomicBool,
}

impl fmt::Debug for LoginSubstitution {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LoginSubstitution")
            .field("origin", &self.origin.to_string())
            .field("action_path", &self.action_path)
            .field("field", &self.field)
            .field("surrogate", &self.surrogate)
            .field("purpose", &self.purpose)
            .finish_non_exhaustive()
    }
}

/// Autocomplete tokens and name fragments that mark a field as setting a
/// password rather than presenting one. Names are compared with case and
/// punctuation removed, so `new_password`, `newPassword` and `new-password`
/// are one name. The lists fail closed: a login field that happens to match
/// is refused, and the login proceeds by CDP fill — a slower road, not a
/// wrong one.
const PASSWORD_SET_TOKENS: &[&str] = &["new-password"];
/// Fragments that set a password wherever they appear.
const PASSWORD_SET_NAMES: &[&str] = &[
    "confirm", "repeat", "retype", "reenter", "again", "setpass", "setpw",
];
/// The password word, in the spellings forms use, longest first.
const PASSWORD_WORDS: &[&str] = &["password", "passwd", "pass", "pwd", "pw"];
/// Fragments that set a password beside a password word, before or after it:
/// `new_password` and `password_new`, `resetPassword`, `passwordVerify`.
/// Not `set`, which a selector's `fieldset` would trip.
const PASSWORD_SET_MARKERS: &[&str] = &["new", "verify", "change", "reset", "create", "choose"];

impl LoginSubstitution {
    /// Declare a substitution and issue its surrogate from 16 bytes of
    /// caller-supplied entropy: 128 bits, as `osr_` and 32 lowercase hex, the
    /// shape invoke-through issues.
    ///
    /// # Errors
    ///
    /// A [`DeclareError`] naming what is wrong with the declaration. Notably
    /// [`DeclareError::PasswordSetField`] for any field that sets a password.
    pub fn declare(spec: LoginSubstitutionSpec, entropy: [u8; 16]) -> Result<Self, DeclareError> {
        let origin = LoginOrigin::parse(&spec.origin).ok_or(DeclareError::Origin)?;
        if !is_exact_path(&spec.action_path) {
            return Err(DeclareError::ActionPath);
        }
        if spec.field.is_empty() || sighting::count(spec.field.as_bytes()) > 0 {
            return Err(DeclareError::EmptyField);
        }
        if sets_a_password(&spec.field, &spec.control) {
            return Err(DeclareError::PasswordSetField);
        }
        if entropy.iter().all(|byte| *byte == entropy[0]) {
            return Err(DeclareError::WeakEntropy);
        }
        let mut value = Zeroizing::new(String::with_capacity(
            SURROGATE_MARKER.len() + SURROGATE_HEX_LEN,
        ));
        value.push_str(SURROGATE_MARKER);
        for byte in entropy {
            value.push(char::from(HEX[usize::from(byte >> 4)]));
            value.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
        Ok(Self {
            origin,
            action_path: spec.action_path,
            field: spec.field,
            surrogate: LoginSurrogate(value),
            purpose: SubstitutionPurpose::Login,
            spent: AtomicBool::new(false),
        })
    }

    #[must_use]
    pub const fn origin(&self) -> &LoginOrigin {
        &self.origin
    }

    #[must_use]
    pub fn action_path(&self) -> &str {
        &self.action_path
    }

    #[must_use]
    pub fn field(&self) -> &str {
        &self.field
    }

    /// The surrogate the runner types into the page.
    #[must_use]
    pub const fn surrogate(&self) -> &LoginSurrogate {
        &self.surrogate
    }

    #[must_use]
    pub const fn purpose(&self) -> SubstitutionPurpose {
        self.purpose
    }
}

fn is_exact_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.contains(['?', '#'])
        && !path
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
        && !path
            .split('/')
            .any(|segment| segment == "." || segment == "..")
        && !path.to_ascii_lowercase().contains("%2e")
}

fn sets_a_password(field: &str, control: &FieldSnapshot) -> bool {
    let token_sets = control.autocomplete.as_deref().is_some_and(|tokens| {
        tokens
            .split_ascii_whitespace()
            .any(|token| PASSWORD_SET_TOKENS.contains(&token.to_ascii_lowercase().as_str()))
    });
    token_sets || names_a_password_set(field) || names_a_password_set(&control.selector)
}

fn names_a_password_set(text: &str) -> bool {
    let squashed: String = text
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect();
    let has = |fragments: &[&str]| fragments.iter().any(|f| squashed.contains(f));
    has(PASSWORD_SET_NAMES)
        || (has(PASSWORD_WORDS) && has(PASSWORD_SET_MARKERS))
        || numbered_password(&squashed)
}

/// `password1`, `password2`, `pwd2`: the numbered pair a sign-up or reset
/// form asks for, the new password and its confirmation.
fn numbered_password(squashed: &str) -> bool {
    PASSWORD_WORDS.iter().any(|word| {
        squashed.match_indices(word).any(|(at, _)| {
            squashed[at + word.len()..]
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_digit())
        })
    })
}

const HEX: &[u8; 16] = b"0123456789abcdef";
