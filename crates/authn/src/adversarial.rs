#[cfg(test)]
mod tests {
    use crate::*;
    use chrono::{Duration, Utc};

    #[test]
    fn flow_matrix_ssh_codespaces_wsl_ci() {
        let cases = [
            (
                EnvironmentSignals {
                    ssh_connection: true,
                    device_endpoint_available: true,
                    ..Default::default()
                },
                LoginFlow::Device,
            ),
            (
                EnvironmentSignals {
                    codespaces: true,
                    device_endpoint_available: true,
                    ..Default::default()
                },
                LoginFlow::Device,
            ),
            (
                EnvironmentSignals {
                    wsl: true,
                    has_display: false,
                    device_endpoint_available: true,
                    ..Default::default()
                },
                LoginFlow::Device,
            ),
            (
                EnvironmentSignals {
                    has_display: true,
                    can_bind_loopback: true,
                    browser_launch_allowed: true,
                    device_endpoint_available: true,
                    ..Default::default()
                },
                LoginFlow::Loopback,
            ),
            (
                EnvironmentSignals {
                    non_interactive: true,
                    workload_configured: true,
                    ..Default::default()
                },
                LoginFlow::Workload,
            ),
        ];
        for (sig, expect) in cases {
            assert_eq!(resolve_login_flow(LoginFlow::Auto, &sig), expect);
        }
    }

    #[test]
    fn explicit_flow_honored() {
        let s = EnvironmentSignals {
            has_display: true,
            can_bind_loopback: true,
            device_endpoint_available: true,
            ..Default::default()
        };
        assert_eq!(
            resolve_login_flow(LoginFlow::Device, &s),
            LoginFlow::Device
        );
    }

    #[test]
    fn device_pending_then_success() {
        let auth = demo_device_authorization("https://issuer.example");
        let mut st = DevicePollState::new(&auth);
        assert_eq!(
            st.next_action(Utc::now(), DeviceServerStatus::AuthorizationPending),
            Err(DeviceFlowError::AuthorizationPending)
        );
        assert_eq!(
            st.next_action(Utc::now(), DeviceServerStatus::Success),
            Ok(DevicePollOutcome::Complete)
        );
    }

    #[test]
    fn device_expiry_and_deny_and_cancel() {
        let mut auth = demo_device_authorization("https://issuer.example");
        auth.expires_at = Utc::now() - Duration::seconds(1);
        let mut st = DevicePollState::new(&auth);
        assert_eq!(
            st.next_action(Utc::now(), DeviceServerStatus::AuthorizationPending),
            Err(DeviceFlowError::ExpiredToken)
        );
        let auth = demo_device_authorization("https://issuer.example");
        let mut st = DevicePollState::new(&auth);
        assert_eq!(
            st.next_action(Utc::now(), DeviceServerStatus::AccessDenied),
            Err(DeviceFlowError::AccessDenied)
        );
        st.cancelled = true;
        assert_eq!(
            st.next_action(Utc::now(), DeviceServerStatus::Success),
            Err(DeviceFlowError::Cancelled)
        );
    }

    #[test]
    fn pkce_unique() {
        let a = Pkce::s256();
        let b = Pkce::s256();
        assert_ne!(a.verifier, b.verifier);
        assert_eq!(a.verifier.len(), 43); // 32 bytes base64url no pad
    }

    #[test]
    fn detect_env_signals() {
        let map: std::collections::HashMap<String, String> = std::collections::HashMap::from([
            ("SSH_CONNECTION".into(), "1 2 3 4".into()),
            ("DEVCONTAINER".into(), "1".into()),
        ]);
        let s = detect_signals_from_env(&|k| map.get(k).cloned(), false, true);
        assert!(s.ssh_connection);
        assert!(s.devcontainer);
    }
}
