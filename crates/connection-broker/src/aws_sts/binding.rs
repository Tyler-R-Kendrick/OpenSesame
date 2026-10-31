//! What an operator binds to an aws-family connection so it may mint: the role
//! to assume and the bounds every mint stays inside.
//!
//! The whole binding is sealed under the connection's key with its own
//! associated data (`aws_sts_binding`), so a binding cannot be replayed onto
//! another connection or read without the deployment's key. Only the view —
//! role, region, cap, and whether a policy or `ExternalId` is set — leaves the
//! broker; the `ExternalId` itself never does.

use std::fmt;

use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};

use super::endpoint;
use super::request::{MAX_DURATION_SECONDS, MIN_DURATION_SECONDS};

/// STS's limit on a plaintext inline session policy.
pub const MAX_POLICY_BYTES: usize = 2048;
/// STS's `ExternalId` limits: 2..=1224 characters of `[\w+=,.@:/-]`.
const MAX_EXTERNAL_ID: usize = 1224;

/// The operator's request to bind or replace a binding.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AwsStsBindingInput {
    pub role_arn: String,
    pub region: String,
    #[serde(default)]
    pub max_duration_seconds: Option<u32>,
    /// An IAM policy document, as JSON. STS intersects it with the role's own
    /// permissions, so it can only narrow what a minted credential may do.
    #[serde(default)]
    pub session_policy: Option<serde_json::Value>,
    #[serde(default)]
    pub external_id: Option<String>,
}

impl fmt::Debug for AwsStsBindingInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AwsStsBindingInput")
            .field("role_arn", &self.role_arn)
            .field("region", &self.region)
            .field("max_duration_seconds", &self.max_duration_seconds)
            .field("session_policy", &self.session_policy.is_some())
            .field(
                "external_id",
                &self.external_id.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

/// A validated binding, as sealed at rest.
#[derive(Serialize, Deserialize)]
pub struct AwsStsBinding {
    pub role_arn: String,
    pub region: String,
    pub max_duration_seconds: u32,
    /// Minified JSON, at most [`MAX_POLICY_BYTES`].
    pub session_policy: Option<String>,
    #[serde(with = "secret_opt")]
    pub external_id: Option<SecretString>,
}

impl fmt::Debug for AwsStsBinding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AwsStsBinding")
            .field("role_arn", &self.role_arn)
            .field("region", &self.region)
            .field("max_duration_seconds", &self.max_duration_seconds)
            .field("session_policy", &self.session_policy.is_some())
            .field(
                "external_id",
                &self.external_id.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

/// What the Host API answers about a binding. Value-blind.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct AwsStsBindingView {
    pub role_arn: String,
    pub region: String,
    pub max_duration_seconds: u32,
    pub session_policy: bool,
    pub external_id: bool,
}

/// `arn:<partition>:iam::<12 digits>:role/<path and name>`.
fn valid_role_arn(arn: &str) -> bool {
    let Some(rest) = arn.strip_prefix("arn:") else {
        return false;
    };
    let Some((partition, rest)) = rest.split_once(":iam::") else {
        return false;
    };
    let Some((account, role)) = rest.split_once(":role/") else {
        return false;
    };
    matches!(partition, "aws" | "aws-cn" | "aws-us-gov")
        && account.len() == 12
        && account.bytes().all(|b| b.is_ascii_digit())
        && (1..=512).contains(&role.len())
        && role.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(b, b'+' | b'=' | b',' | b'.' | b'@' | b'_' | b'-' | b'/')
        })
}

fn valid_external_id(value: &str) -> bool {
    (2..=MAX_EXTERNAL_ID).contains(&value.len())
        && value.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'_' | b'+' | b'=' | b',' | b'.' | b'@' | b':' | b'/' | b'-'
                )
        })
}

impl AwsStsBinding {
    /// Validate an operator's input.
    ///
    /// # Errors
    ///
    /// A fixed sentence naming the first field that is not acceptable.
    pub fn from_input(input: AwsStsBindingInput) -> Result<Self, &'static str> {
        let role_arn = input.role_arn.trim().to_string();
        if !valid_role_arn(&role_arn) {
            return Err("role_arn must be an IAM role ARN");
        }
        let region = input.region.trim().to_string();
        if endpoint::regional_host(&region).is_none() {
            return Err("region is not an AWS region with a known STS endpoint");
        }
        let max_duration_seconds = input.max_duration_seconds.unwrap_or(MIN_DURATION_SECONDS);
        if !(MIN_DURATION_SECONDS..=MAX_DURATION_SECONDS).contains(&max_duration_seconds) {
            return Err("max_duration_seconds must be between 900 and 3600");
        }
        let session_policy = match input.session_policy {
            None => None,
            Some(policy) => Some(minified_policy(&policy)?),
        };
        let external_id = match input.external_id {
            None => None,
            Some(value) if valid_external_id(value.trim()) => {
                Some(SecretString::from(value.trim().to_string()))
            }
            Some(_) => return Err("external_id is not a valid STS ExternalId"),
        };
        Ok(Self {
            role_arn,
            region,
            max_duration_seconds,
            session_policy,
            external_id,
        })
    }

    #[must_use]
    pub fn view(&self) -> AwsStsBindingView {
        AwsStsBindingView {
            role_arn: self.role_arn.clone(),
            region: self.region.clone(),
            max_duration_seconds: self.max_duration_seconds,
            session_policy: self.session_policy.is_some(),
            external_id: self.external_id.is_some(),
        }
    }
}

/// A policy document: an object with `Version` and a `Statement`, minified,
/// within STS's size limit.
fn minified_policy(policy: &serde_json::Value) -> Result<String, &'static str> {
    let object = policy
        .as_object()
        .ok_or("session_policy must be an IAM policy document")?;
    if !object.contains_key("Version") || !object.contains_key("Statement") {
        return Err("session_policy must carry Version and Statement");
    }
    let text = serde_json::to_string(policy).map_err(|_| "session_policy is not JSON")?;
    if text.len() > MAX_POLICY_BYTES {
        return Err("session_policy exceeds STS's 2048-character limit");
    }
    Ok(text)
}

/// Serde for an optional secret, used only to write and read the sealed
/// plaintext.
mod secret_opt {
    use super::{ExposeSecret, SecretString};
    use serde::{Deserialize, Deserializer, Serializer};

    #[expect(
        clippy::ref_option,
        reason = "serde's `with` hands the field by reference"
    )]
    pub fn serialize<S: Serializer>(
        value: &Option<SecretString>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(secret) => serializer.serialize_some(secret.expose_secret()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<SecretString>, D::Error> {
        Ok(Option::<String>::deserialize(deserializer)?.map(SecretString::from))
    }
}

#[cfg(test)]
#[path = "binding_tests.rs"]
mod tests;
