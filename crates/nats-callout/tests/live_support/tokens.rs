//! The three upstream tokens the live stack drives clients with.
//!
//! They are JWS-*shaped* strings (three base64url segments), which is what
//! `opensesame_nats_callout::evidence::extract` looks for; the mock Host
//! matches them by value. Signature verification against a real JWKS belongs
//! to the Host route and is unit-tested there — this file must never be read
//! as evidence that the live stack verified a signature.

/// A token the mock Host admits with a five-minute decision.
pub const GOOD_TOKEN: &str =
    "eyJhbGciOiJSUzI1NiIsImtpZCI6ImxpdmUifQ.eyJpc3MiOiJodHRwczovL2lkcC5saXZlIiwic3ViIjoidS0xIn0.Z29vZA";
/// A token the mock Host refuses, standing in for a bad signature.
pub const FORGED_TOKEN: &str =
    "eyJhbGciOiJSUzI1NiIsImtpZCI6ImxpdmUifQ.eyJpc3MiOiJodHRwczovL2lkcC5saXZlIiwic3ViIjoidS0yIn0.Zm9yZ2Vk";
/// A token the mock Host admits for five seconds, so nats-server's own
/// expiry enforcement disconnects the client.
pub const SHORT_TOKEN: &str =
    "eyJhbGciOiJSUzI1NiIsImtpZCI6ImxpdmUifQ.eyJpc3MiOiJodHRwczovL2lkcC5saXZlIiwic3ViIjoidS0zIn0.c2hvcnQ";

/// What the mock Host does with a token.
pub enum TokenOutcome {
    Allow { principal: &'static str, ttl: i64 },
    Deny(&'static str),
}

/// Map a presented token onto its outcome. Anything unrecognised is denied.
#[must_use]
pub fn outcome_for(token: &str) -> TokenOutcome {
    match token {
        GOOD_TOKEN => TokenOutcome::Allow {
            principal: "prnlive1",
            ttl: 300,
        },
        SHORT_TOKEN => TokenOutcome::Allow {
            principal: "prnlive3",
            ttl: 5,
        },
        _ => TokenOutcome::Deny("invalid_token"),
    }
}
