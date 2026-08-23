//! A **keepassxc-protocol** server, so the stock KeePassXC-Browser extension
//! can drive the OpenSesame sealed store.
//!
//! # The protocol, in one paragraph
//!
//! The extension and its peer exchange JSON envelopes. Exactly one message —
//! `change-public-keys` — is unencrypted; it carries the client's ephemeral
//! X25519 public key and receives the host's. Everything after that is a NaCl
//! `box` (X25519 + XSalsa20-Poly1305) between those two ephemeral keys,
//! wrapped as `{action, message: <base64 box>, nonce: <24B base64>, clientID}`.
//! Replies reuse the same shape with the request's nonce **incremented** as a
//! little-endian 192-bit integer. A third, *persistent* keypair — the
//! identification key — is minted by the client at `associate` time and is
//! what proves, in later sessions, that this client was once approved.
//!
//! Implemented from the public protocol document at
//! <https://github.com/keepassxreboot/keepassxc-browser/blob/develop/keepassxc-protocol.md>.
//! KeePassXC itself is GPL-licensed and was **not** read or copied (C3).
//!
//! # Where OpenSesame is deliberately stricter
//!
//! Real KeePassXC pops a dialog on `associate`. This bridge has no GUI, so
//! the approval ceremony is a **pairing window** a human opens on a TTY with
//! `opensesame bridge keepassxc pair`; the bridge writes the incoming key's
//! fingerprint into the shared window file and waits for the human's verdict.
//! Outside an open, confirmed window, `associate` is refused — and every
//! action beyond the handshake requires a stored association (C2(b)).
//!
//! # Module map
//!
//! - [`proto`] — wire types, error codes, nonce arithmetic, base64.
//! - [`crypto`] — the three keypairs and the box/unbox operations.
//! - [`pairing`] — association lookup plus the windowed approval ceremony.
//! - [`actions`] — the action handlers and the session that owns them.
//! - [`transport`] — stdio native-messaging mode and UDS server mode.

pub mod actions;
pub mod crypto;
pub mod pairing;
pub mod proto;
pub mod transport;

pub use actions::{Session, SessionConfig};
pub use proto::{ErrorCode, PROTOCOL_VERSION};
