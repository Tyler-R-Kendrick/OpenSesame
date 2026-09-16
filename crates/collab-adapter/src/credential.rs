//! The bot credential, and the constructor that makes a user token
//! unrepresentable.
//!
//! `Authorization: Bot <token>` is the only header this adapter can produce.
//! That is not enforced by a check at send time — it is enforced by
//! [`BotToken`] being the only type [`crate::transport::WireRequest`] accepts,
//! and by [`BotToken::from_credential`] refusing every credential kind that
//! belongs to a person. There is no `Bearer` path, so there is no
//! self-botting path.

use std::fmt;

use crate::refusal::Refusal;

/// What kind of credential a caller is holding.
///
/// Named exhaustively rather than as "bot or not", so a caller that acquires a
/// new credential type has to come here and decide, instead of falling into the
/// permissive branch of a boolean.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialKind {
    /// A bot application's token, from the Developer Portal. The only accepted
    /// kind.
    BotToken,
    /// An `OAuth2` access token minted for a person.
    UserAccessToken,
    /// An `OAuth2` refresh token minted for a person.
    UserRefreshToken,
    /// A person's account password.
    UserPassword,
    /// A person's session/authorization header, as a browser would send it.
    UserSessionToken,
}

impl CredentialKind {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::BotToken => "bot token",
            Self::UserAccessToken => "user oauth2 access token",
            Self::UserRefreshToken => "user oauth2 refresh token",
            Self::UserPassword => "user password",
            Self::UserSessionToken => "user session token",
        }
    }

    /// Whether the credential belongs to a person rather than to an
    /// application.
    #[must_use]
    pub const fn is_user(self) -> bool {
        !matches!(self, Self::BotToken)
    }

    /// # Errors
    ///
    /// [`Refusal::UserCredential`] for anything but [`CredentialKind::BotToken`].
    pub const fn assert_bot(self) -> Result<(), Refusal> {
        if self.is_user() {
            return Err(Refusal::UserCredential { kind: self.label() });
        }
        Ok(())
    }
}

/// A Discord bot token.
///
/// Constructible only from [`CredentialKind::BotToken`]. `Debug` redacts,
/// `Display` is deliberately absent, and there is no `Serialize`, no
/// `as_str`, and no `expose()`: the single way to get the bytes out is
/// [`BotToken::authorization_header`], which has already committed to the `Bot`
/// scheme by the time it returns.
#[derive(Clone, PartialEq, Eq)]
pub struct BotToken(String);

impl BotToken {
    /// # Errors
    ///
    /// [`Refusal::UserCredential`] when `kind` is not
    /// [`CredentialKind::BotToken`].
    pub fn from_credential(
        kind: CredentialKind,
        token: impl Into<String>,
    ) -> Result<Self, Refusal> {
        kind.assert_bot()?;
        Ok(Self(token.into()))
    }

    /// The complete `Authorization` header value, scheme included.
    ///
    /// Returning the whole header rather than the token is the point: a caller
    /// cannot put these bytes behind `Bearer`.
    #[must_use]
    pub fn authorization_header(&self) -> String {
        format!("Bot {}", self.0)
    }
}

impl fmt::Debug for BotToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("BotToken(<redacted>)")
    }
}
