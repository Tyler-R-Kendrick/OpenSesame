//! A credential helper is the trusted file and hears nothing of the store
//! password or the Host's keys.

use super::*;
use opensesame_trusted_exec::testkit::{Fixture, SECRET};

const OP_ENV: &str = "OPENSESAME_OP_BIN";

#[test]
fn every_helper_is_the_trusted_one_and_hears_no_opensesame_secret() {
    for helper in &HELPERS {
        let fixture = Fixture::new(helper.name);
        let lookup = fixture.lookup(&[]);
        let output = helper_in(helper.name, &lookup)
            .expect("the trusted helper is found")
            .output()
            .expect("it runs");
        assert!(output.status.success());
        let env = fixture.env().expect("the trusted stub recorded");
        assert!(!fixture.planted_ran(), "the planted {} ran", helper.name);
        for name in ["OPENSESAME_STORE_PASSWORD", "OPENSESAME_CONNECTION_KEY"] {
            assert!(!env.contains_key(name), "{name} reached {}", helper.name);
        }
        assert!(
            !env.values().any(|value| value == SECRET),
            "{}",
            helper.name
        );
    }
}

#[test]
fn op_is_handed_its_own_family_but_never_a_service_account_token_it_did_not_choose() {
    let fixture = Fixture::new("op");
    let extra = [
        ("OP_CONFIG_DIR", "/home/dummy/.config/op"),
        ("OP_SERVICE_ACCOUNT_TOKEN", SECRET),
        ("DISPLAY", ":0"),
        ("NODE_OPTIONS", "--require /tmp/planted.js"),
    ];
    helper_in("op", &fixture.lookup(&extra))
        .unwrap()
        .output()
        .unwrap();
    let env = fixture.env().unwrap();
    assert_eq!(env["OP_CONFIG_DIR"], "/home/dummy/.config/op");
    assert_eq!(env["DISPLAY"], ":0");
    assert!(!env.contains_key("NODE_OPTIONS"));
    assert!(!env.values().any(|value| value == SECRET), "{env:?}");
}

#[test]
fn a_clipboard_tool_hears_the_display_and_nothing_of_op() {
    let extra = [
        ("DISPLAY", ":0"),
        ("OP_CONFIG_DIR", "/home/dummy/.config/op"),
    ];
    let fixture = Fixture::new("xclip");
    helper_in("xclip", &fixture.lookup(&extra))
        .unwrap()
        .output()
        .unwrap();
    let env = fixture.env().unwrap();
    assert_eq!(env["DISPLAY"], ":0");
    assert!(!env.contains_key("OP_CONFIG_DIR"));
}

#[test]
fn opensesame_op_bin_names_the_exact_op_and_is_not_handed_on() {
    let fixture = Fixture::new("op");
    let chosen = fixture.scratch("chosen").join("op");
    fixture.stub_recorder(&chosen);
    let lookup = fixture.lookup(&[(OP_ENV, chosen.to_str().unwrap())]);
    helper_in("op", &lookup).unwrap().output().unwrap();
    let env = fixture.assert_clean();
    assert!(!env.contains_key(OP_ENV));
}

#[test]
fn an_unusable_override_is_an_error_naming_it_and_never_a_search() {
    let fixture = Fixture::new("op");
    let lookup = fixture.lookup(&[(OP_ENV, "op")]);
    let error = helper_in("op", &lookup).unwrap_err().to_string();
    assert!(error.contains(OP_ENV), "{error}");
    let error = host_in("op", &lookup).unwrap_err().to_string();
    assert!(error.contains(OP_ENV), "{error}");
    assert!(!fixture.planted_ran() && fixture.env().is_none());
}

#[test]
fn not_finding_a_helper_says_which_variable_points_at_it() {
    let fixture = Fixture::new("op");
    std::fs::remove_file(fixture.trusted.join("op")).unwrap();
    let error = helper_in("op", &fixture.lookup(&[]))
        .unwrap_err()
        .to_string();
    assert!(error.contains(OP_ENV), "{error}");
    assert!(!fixture.planted_ran());
}

#[test]
fn a_program_that_is_not_a_credential_helper_is_refused() {
    let fixture = Fixture::new("sh");
    let error = helper_in("sh", &fixture.lookup(&[]))
        .unwrap_err()
        .to_string();
    assert_eq!(error, "Unsupported credential helper");
    assert!(!fixture.planted_ran());
}

#[test]
fn a_run_that_hosts_the_persons_command_is_the_trusted_op_in_the_persons_environment() {
    let fixture = Fixture::new("op");
    let mut command = host_in("op", &fixture.lookup(&[])).unwrap();
    // Not built from nothing: `op run` hands its environment to the person's
    // command, so it is the process's own.
    command.output().unwrap();
    let env = fixture.env().unwrap();
    assert!(!fixture.planted_ran());
    assert_eq!(
        env.get("PATH").map(String::as_str),
        std::env::var("PATH").ok().as_deref()
    );
}
