use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StepUpRequirement {
    pub assurance: String,
    pub max_authentication_age: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AuthenticationPolicy {
    pub required_assurance: String,
    pub allowed_methods: Vec<String>,
    pub fallback_methods: Vec<String>,
    pub password_allowed: bool,
    pub session_maximum_age: String,
    pub session_inactivity_timeout: String,
    pub step_up: std::collections::BTreeMap<String, StepUpRequirement>,
}

impl Default for AuthenticationPolicy {
    fn default() -> Self {
        let mut step_up = std::collections::BTreeMap::new();
        step_up.insert(
            "credential.export".into(),
            StepUpRequirement {
                assurance: "phishing-resistant".into(),
                max_authentication_age: "5m".into(),
            },
        );
        step_up.insert(
            "agent.claim".into(),
            StepUpRequirement {
                assurance: "mfa".into(),
                max_authentication_age: "10m".into(),
            },
        );
        Self {
            required_assurance: "phishing-resistant".into(),
            allowed_methods: vec![
                "passkey".into(),
                "hardware-webauthn".into(),
                "federated-oidc".into(),
            ],
            fallback_methods: vec!["totp".into()],
            password_allowed: false,
            session_maximum_age: "8h".into(),
            session_inactivity_timeout: "30m".into(),
            step_up,
        }
    }
}
