//! The runtime switch: a declared substitution is armed only while the
//! `surrogate-proxy` plugin is installed, recorded on and not forced off
//! (ADR 0150 §7). Login substitution shares that plugin's switch; there is no
//! second one. Everything else logs in by CDP fill, and a declaration that
//! was never armed has no way to substitute anything.
#![cfg(feature = "login-surrogate")]

mod login_support;

use login_support::{spec, ENTROPY};
use opensesame_plugin_settings::PluginState;
use opensesame_rotation_web::{CdpOnly, LoginRoad, LoginSubstitution, SUBSTITUTION_PLUGIN};

fn plugin(installed: bool, enabled: bool, forced_off: bool) -> PluginState {
    PluginState {
        id: SUBSTITUTION_PLUGIN.into(),
        capability: "agents.surrogate-credentials".into(),
        installed,
        version: installed.then(|| "1.0.0".into()),
        enabled,
        forced_off,
        active: enabled && !forced_off,
    }
}

fn on() -> PluginState {
    plugin(true, true, false)
}

fn declared() -> LoginSubstitution {
    LoginSubstitution::declare(spec("password"), ENTROPY).unwrap()
}

fn refused(road: LoginRoad) -> CdpOnly {
    match road {
        LoginRoad::CdpFill(why) => why,
        LoginRoad::Substitute(armed) => panic!("armed: {armed:?}"),
    }
}

#[test]
fn substitution_shares_the_surrogate_proxy_switch() {
    assert_eq!(SUBSTITUTION_PLUGIN, "surrogate-proxy");
}

#[test]
fn a_recipe_that_opted_in_with_the_plugin_on_is_armed() {
    let LoginRoad::Substitute(armed) = LoginRoad::choose(Some(declared()), &on()) else {
        panic!("not armed");
    };
    assert_eq!(armed.field(), "password");
}

#[test]
fn a_recipe_that_did_not_opt_in_logs_in_by_cdp_fill_whatever_the_switch_says() {
    assert_eq!(
        refused(LoginRoad::choose(None, &on())),
        CdpOnly::NotDeclared
    );
}

#[test]
fn an_uninstalled_plugin_cannot_arm_substitution() {
    assert_eq!(
        refused(LoginRoad::choose(
            Some(declared()),
            &plugin(false, false, false)
        )),
        CdpOnly::NotInstalled
    );
}

#[test]
fn a_plugin_recorded_off_cannot_arm_substitution() {
    assert_eq!(
        refused(LoginRoad::choose(
            Some(declared()),
            &plugin(true, false, false)
        )),
        CdpOnly::SwitchedOff
    );
}

#[test]
fn an_environment_that_forces_the_plugin_off_wins_over_the_file() {
    assert_eq!(
        refused(LoginRoad::choose(
            Some(declared()),
            &plugin(true, true, true)
        )),
        CdpOnly::ForcedOff
    );
}

#[test]
fn a_forged_active_flag_does_not_arm_substitution() {
    // `active` is derived; the gate re-derives it rather than trusting it.
    for mut state in [
        plugin(false, false, false),
        plugin(true, false, false),
        plugin(true, true, true),
    ] {
        state.active = true;
        assert!(
            matches!(
                LoginRoad::choose(Some(declared()), &state),
                LoginRoad::CdpFill(_)
            ),
            "{state:?}"
        );
    }
    let mut stale = on();
    stale.active = false;
    assert_eq!(
        refused(LoginRoad::choose(Some(declared()), &stale)),
        CdpOnly::SwitchedOff
    );
}

#[test]
fn another_plugins_switch_does_not_arm_substitution() {
    let mut autofill = on();
    autofill.id = "browser-autofill".into();
    autofill.capability = "vault.browser-autofill".into();
    assert_eq!(
        refused(LoginRoad::choose(Some(declared()), &autofill)),
        CdpOnly::NotThePlugin
    );
}

#[test]
fn the_reason_is_a_stable_string_and_never_carries_the_surrogate() {
    for (why, name) in [
        (CdpOnly::NotDeclared, "not_declared"),
        (CdpOnly::NotThePlugin, "not_the_plugin"),
        (CdpOnly::NotInstalled, "not_installed"),
        (CdpOnly::SwitchedOff, "switched_off"),
        (CdpOnly::ForcedOff, "forced_off"),
    ] {
        assert_eq!(why.as_str(), name);
        assert_eq!(serde_json::to_value(why).unwrap(), name);
    }
}

#[test]
fn an_armed_substitution_prints_no_surrogate() {
    let LoginRoad::Substitute(armed) = LoginRoad::choose(Some(declared()), &on()) else {
        panic!("not armed");
    };
    let alone = format!("{armed:?}");
    let shown = format!("{alone} {:?}", LoginRoad::Substitute(armed));
    assert!(!shown.contains(login_support::SURROGATE), "{shown}");
    assert!(shown.contains("osr_…"), "{shown}");
}

/// The same decision over the real settings type, walked the way a person
/// walks it: install (recorded off), switch on, force off from the
/// environment, switch off again. No file is read or written.
#[test]
fn the_real_settings_walk_arms_substitution_only_while_switched_on() {
    use opensesame_plugin_settings::PluginSettings;
    let no_env = |_: &str| None;
    let forced = |name: &str| (name == "OPENSESAME_PLUGIN_SURROGATE_PROXY").then(|| "off".into());
    let road = |settings: &PluginSettings, env: &dyn Fn(&str) -> Option<String>| {
        let state = settings.state(SUBSTITUTION_PLUGIN, env).unwrap();
        LoginRoad::choose(Some(declared()), &state)
    };

    let mut settings = PluginSettings::default();
    assert_eq!(refused(road(&settings, &no_env)), CdpOnly::NotInstalled);
    settings
        .record_install(SUBSTITUTION_PLUGIN, "1.0.0", &"a".repeat(64), "/opt/proxy")
        .unwrap();
    assert_eq!(refused(road(&settings, &no_env)), CdpOnly::SwitchedOff);
    settings.set_enabled(SUBSTITUTION_PLUGIN, true).unwrap();
    assert!(matches!(road(&settings, &no_env), LoginRoad::Substitute(_)));
    assert_eq!(refused(road(&settings, &forced)), CdpOnly::ForcedOff);
    settings.set_enabled(SUBSTITUTION_PLUGIN, false).unwrap();
    assert_eq!(refused(road(&settings, &no_env)), CdpOnly::SwitchedOff);
}
