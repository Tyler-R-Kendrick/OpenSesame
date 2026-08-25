use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginFlow {
    Auto,
    Loopback,
    Device,
    Ciba,
    Workload,
}

#[derive(Clone, Debug, Default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "public compatibility record of independent platform capability signals"
)]
pub struct EnvironmentSignals {
    pub ssh_connection: bool,
    pub codespaces: bool,
    pub remote_containers: bool,
    pub devcontainer: bool,
    pub wsl: bool,
    pub has_display: bool,
    pub can_bind_loopback: bool,
    pub browser_launch_allowed: bool,
    pub non_interactive: bool,
    pub workload_configured: bool,
    pub device_endpoint_available: bool,
    pub ciba_available: bool,
    pub open_browser: OpenBrowser,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OpenBrowser {
    #[default]
    Auto,
    Always,
    Never,
}

/// Deterministic flow resolver. Heuristics influence usability, never security.
#[must_use]
pub fn resolve_login_flow(explicit: LoginFlow, signals: &EnvironmentSignals) -> LoginFlow {
    if signals.workload_configured && (explicit == LoginFlow::Workload || signals.non_interactive) {
        return LoginFlow::Workload;
    }
    match explicit {
        LoginFlow::Loopback | LoginFlow::Device | LoginFlow::Ciba | LoginFlow::Workload => explicit,
        LoginFlow::Auto => resolve_auto(signals),
    }
}

fn resolve_auto(signals: &EnvironmentSignals) -> LoginFlow {
    if !signals.browser_launch_allowed || signals.open_browser == OpenBrowser::Never {
        return prefer_headless(signals);
    }
    let remote = signals.ssh_connection
        || signals.codespaces
        || signals.remote_containers
        || signals.devcontainer
        || signals.wsl
        || !signals.has_display;
    if remote {
        return prefer_headless(signals);
    }
    if signals.can_bind_loopback && signals.has_display {
        return LoginFlow::Loopback;
    }
    prefer_headless(signals)
}

fn prefer_headless(signals: &EnvironmentSignals) -> LoginFlow {
    if signals.device_endpoint_available {
        LoginFlow::Device
    } else if signals.ciba_available {
        LoginFlow::Ciba
    } else {
        // Brokered ceremony path represented as Device for CLI surface.
        LoginFlow::Device
    }
}

pub fn detect_signals_from_env(
    env: &dyn Fn(&str) -> Option<String>,
    can_bind_loopback: bool,
    browser_launch_allowed: bool,
) -> EnvironmentSignals {
    EnvironmentSignals {
        ssh_connection: env("SSH_CONNECTION").is_some() || env("SSH_TTY").is_some(),
        codespaces: env("CODESPACES").as_deref() == Some("true"),
        remote_containers: env("REMOTE_CONTAINERS").as_deref() == Some("true"),
        devcontainer: env("DEVCONTAINER").is_some() || env("REMOTE_CONTAINERS").is_some(),
        wsl: env("WSL_DISTRO_NAME").is_some() || env("WSL_INTEROP").is_some(),
        has_display: env("DISPLAY").is_some() || env("WAYLAND_DISPLAY").is_some(),
        can_bind_loopback,
        browser_launch_allowed,
        non_interactive: env("CI").is_some(),
        workload_configured: env("OPENSESAME_WORKLOAD_IDENTITY").is_some(),
        device_endpoint_available: true,
        ciba_available: false,
        open_browser: OpenBrowser::Auto,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_selects_device_in_devcontainer() {
        let mut s = EnvironmentSignals {
            devcontainer: true,
            has_display: false,
            can_bind_loopback: false,
            browser_launch_allowed: true,
            device_endpoint_available: true,
            ..Default::default()
        };
        assert_eq!(resolve_login_flow(LoginFlow::Auto, &s), LoginFlow::Device);
        s.devcontainer = false;
        s.has_display = true;
        s.can_bind_loopback = true;
        assert_eq!(resolve_login_flow(LoginFlow::Auto, &s), LoginFlow::Loopback);
    }

    #[test]
    fn no_browser_never_falls_back_to_password() {
        let s = EnvironmentSignals {
            open_browser: OpenBrowser::Never,
            browser_launch_allowed: false,
            device_endpoint_available: true,
            ..Default::default()
        };
        assert_eq!(resolve_login_flow(LoginFlow::Auto, &s), LoginFlow::Device);
    }
}
