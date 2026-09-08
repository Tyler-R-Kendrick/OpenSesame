//! Strict deployment policy. Transport locality never supplies authorization.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentMode {
    Development,
    Test,
    Production,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExposureClass {
    LocalOnly,
    Networked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deployment {
    pub mode: DeploymentMode,
    pub exposure: ExposureClass,
}

impl Deployment {
    #[must_use]
    pub fn production_safeguards(self) -> bool {
        self.mode == DeploymentMode::Production || self.exposure == ExposureClass::Networked
    }
}

fn parse(name: &str, value: &str) -> Result<DeploymentMode, String> {
    match value {
        "development" => Ok(DeploymentMode::Development),
        "test" => Ok(DeploymentMode::Test),
        "production" => Ok(DeploymentMode::Production),
        _ => Err(format!(
            "{name} must be exactly development, test, or production"
        )),
    }
}

/// Resolve explicit inputs, without test-runner or ambient mode inference.
/// # Errors
/// Invalid, conflicting, missing, or network-exposed development defaults fail.
pub fn resolve(
    opensesame_env: Option<&str>,
    node_env: Option<&str>,
    allow_dev_defaults: Option<&str>,
    exposure: ExposureClass,
) -> Result<Deployment, String> {
    let explicit = opensesame_env
        .map(|v| parse("OPENSESAME_ENV", v))
        .transpose()?;
    let node = node_env.map(|v| parse("NODE_ENV", v)).transpose()?;
    if explicit.is_some() && node.is_some() && explicit != node {
        return Err("OPENSESAME_ENV and NODE_ENV conflict".into());
    }
    if !matches!(allow_dev_defaults, None | Some("0" | "1")) {
        return Err("OPENSESAME_ALLOW_DEV_DEFAULTS must be exactly 0 or 1".into());
    }
    if allow_dev_defaults == Some("1") && exposure == ExposureClass::Networked {
        return Err("OPENSESAME_ALLOW_DEV_DEFAULTS requires local-only exposure".into());
    }
    let mode = explicit
        .or(node)
        .or_else(|| (allow_dev_defaults == Some("1")).then_some(DeploymentMode::Development))
        .ok_or("OPENSESAME_ENV or NODE_ENV must be exactly development, test, or production")?;
    Ok(Deployment { mode, exposure })
}

/// Read only the named mode inputs; callers supply all effective endpoints.
/// # Errors
/// See [`resolve`].
pub fn from_env(exposure: ExposureClass) -> Result<Deployment, String> {
    resolve(
        std::env::var("OPENSESAME_ENV").ok().as_deref(),
        std::env::var("NODE_ENV").ok().as_deref(),
        std::env::var("OPENSESAME_ALLOW_DEV_DEFAULTS")
            .ok()
            .as_deref(),
        exposure,
    )
}

/// URL parsing rejects ambiguous credential-bearing endpoint configuration.
/// # Errors
/// Errors identify the policy, never echo the endpoint or credentials.
pub fn endpoint_exposure(endpoint: &str) -> Result<ExposureClass, String> {
    let url = url::Url::parse(endpoint).map_err(|_| "invalid deployment endpoint")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || endpoint.contains('\\')
        || endpoint.trim() != endpoint
    {
        return Err(
            "deployment endpoint must be HTTP(S) without credentials, query, or fragment".into(),
        );
    }
    let local = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(host)) => host == "localhost",
        None => false,
    };
    Ok(if local {
        ExposureClass::LocalOnly
    } else {
        ExposureClass::Networked
    })
}

/// Classify all listeners and externally visible endpoint URLs together.
/// # Errors
/// A malformed listener or endpoint refuses configuration.
pub fn classify(listeners: &[&str], endpoints: &[&str]) -> Result<ExposureClass, String> {
    let mut exposure = ExposureClass::LocalOnly;
    for listener in listeners {
        let address: std::net::SocketAddr = listener
            .parse()
            .map_err(|_| "invalid deployment listener")?;
        if !address.ip().is_loopback() {
            exposure = ExposureClass::Networked;
        }
    }
    for endpoint in endpoints {
        if endpoint_exposure(endpoint)? == ExposureClass::Networked {
            exposure = ExposureClass::Networked;
        }
    }
    Ok(exposure)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Deserialize)]
    struct Case {
        name: String,
        opensesame_env: Option<String>,
        node_env: Option<String>,
        allow_dev_defaults: Option<String>,
        exposure: ExposureClass,
        expected: Option<DeploymentMode>,
        production_safeguards: bool,
    }
    #[test]
    fn shared_truth_table() {
        let cases: Vec<Case> = serde_json::from_str(include_str!(
            "../../../contracts/deployment-mode-cases.json"
        ))
        .unwrap();
        for case in cases {
            let result = resolve(
                case.opensesame_env.as_deref(),
                case.node_env.as_deref(),
                case.allow_dev_defaults.as_deref(),
                case.exposure,
            );
            assert_eq!(
                result.as_ref().ok().map(|d| d.mode),
                case.expected,
                "{}",
                case.name
            );
            if let Ok(deployment) = result {
                assert_eq!(
                    deployment.production_safeguards(),
                    case.production_safeguards,
                    "{}",
                    case.name
                );
            }
        }
    }
    #[test]
    fn exposure_cannot_be_hidden_by_a_local_listener() {
        assert_eq!(
            classify(&["127.0.0.1:8787"], &["https://authority.example"]),
            Ok(ExposureClass::Networked)
        );
        assert_eq!(
            classify(&["0.0.0.0:8787"], &["http://localhost:8787"]),
            Ok(ExposureClass::Networked)
        );
        assert_eq!(
            classify(&["[::1]:8787"], &["http://127.0.0.2:8788"]),
            Ok(ExposureClass::LocalOnly)
        );
        for endpoint in [
            "http://secret@localhost",
            "http://localhost?token=secret",
            "http://localhost/#token",
            "http://localhost\\@remote.example",
            "file:///local",
        ] {
            assert!(endpoint_exposure(endpoint).is_err());
        }
    }
}
