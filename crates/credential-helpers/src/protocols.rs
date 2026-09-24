//! The wire formats each helper speaks to its caller.

/// git credential helper protocol (input side): `key=value` lines terminated
/// by a blank line.
pub mod git_protocol {
    use std::collections::BTreeMap;

    #[must_use]
    pub fn parse_input(input: &str) -> BTreeMap<String, String> {
        input
            .lines()
            .take_while(|line| !line.is_empty())
            .filter_map(|line| line.split_once('='))
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    /// `get` output: username/password lines, blank-line terminated.
    #[must_use]
    pub fn render_credential(username: &str, password: &str) -> String {
        format!("username={username}\npassword={password}\n\n")
    }
}

/// docker credential helper output for `get`.
pub mod docker_protocol {
    use serde_json::{json, Value};

    #[must_use]
    pub fn render_credential(server_url: &str, username: &str, secret: &str) -> String {
        // serde_json rendering, not string interpolation: a registry URL or
        // username with a quote must not corrupt the JSON.
        let value: Value = json!({
            "ServerURL": server_url,
            "Username": username,
            "Secret": secret,
        });
        format!("{value}\n")
    }

    #[must_use]
    pub fn render_empty_list() -> &'static str {
        "{}\n"
    }
}

/// AWS `credential_process` output shape.
pub mod aws_protocol {
    use serde_json::{json, Value};

    #[must_use]
    pub fn render_credentials(
        access_key_id: &str,
        secret_access_key: &str,
        session_token: &str,
        expiration: Option<&str>,
    ) -> String {
        let mut value = json!({
            "Version": 1,
            "AccessKeyId": access_key_id,
            "SecretAccessKey": secret_access_key,
            "SessionToken": session_token,
        });
        if let Some(expiration) = expiration {
            value["Expiration"] = Value::String(expiration.to_string());
        }
        format!("{value}\n")
    }
}

/// kubectl client-go exec plugin output shape.
pub mod kube_protocol {
    use serde_json::{json, Value};

    #[must_use]
    pub fn render_exec_credential(token: &str, expiration: Option<&str>) -> String {
        let mut status = json!({"token": token});
        if let Some(expiration) = expiration {
            status["expirationTimestamp"] = Value::String(expiration.to_string());
        }
        let value = json!({
            "apiVersion": "client.authentication.k8s.io/v1",
            "kind": "ExecCredential",
            "status": status,
        });
        format!("{value}\n")
    }
}
