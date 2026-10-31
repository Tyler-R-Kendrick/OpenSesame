//! The two things an AWS mint hands back beside the common mint fields: the
//! temporary credential's parts, and the receipt that names the mint.

use std::fmt;

use secrecy::{ExposeSecret, SecretString};
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// The STS credential, in the field names `opensesame-credential-process`
/// reads. Only ever serialized into the one mint response; Debug redacts it.
#[derive(Clone)]
pub struct AwsSessionCredentials {
    pub access_key_id: String,
    pub secret_access_key: SecretString,
    pub session_token: SecretString,
}

impl fmt::Debug for AwsSessionCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AwsSessionCredentials")
            .field("access_key_id", &"[REDACTED]")
            .field("secret_access_key", &"[REDACTED]")
            .field("session_token", &"[REDACTED]")
            .finish()
    }
}

impl Serialize for AwsSessionCredentials {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut out = serializer.serialize_struct("AwsSessionCredentials", 3)?;
        out.serialize_field("access_key_id", &self.access_key_id)?;
        out.serialize_field("secret_access_key", self.secret_access_key.expose_secret())?;
        out.serialize_field("session_token", self.session_token.expose_secret())?;
        out.end()
    }
}

/// A mint's value-blind receipt: what was assumed, under which session name,
/// until when, and STS's request id. Recorded as the connection's
/// `materialized` event and returned with the credential.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct MintReceipt {
    pub grant_id: String,
    pub role_arn: String,
    pub role_session_name: String,
    pub source_identity: String,
    pub duration_seconds: u32,
    pub expires_at: String,
    pub request_id: String,
}
