//! The credential tool is the trusted `gh`, and hears only what it reads.

use super::*;
use opensesame_trusted_exec::testkit::Fixture;
use secrecy::ExposeSecret;

/// The fixture's hostile parent environment as the plugin's snapshot holds it.
fn snapshot(fixture: &Fixture, extra: &[(&str, &str)]) -> BTreeMap<String, String> {
    fixture
        .lookup(extra)
        .vars
        .into_iter()
        .map(|(name, value)| (name.into_string().unwrap(), value.into_string().unwrap()))
        .collect()
}

fn github(env: &BTreeMap<String, String>) -> CliTokenSource {
    CliTokenSource::for_provider("github", env).expect("github adapter")
}

#[test]
fn a_gh_planted_ahead_of_the_trusted_one_is_never_run_or_asked_for_the_token() {
    let fixture = Fixture::new("gh");
    fixture.stub_recorder_saying(&fixture.trusted.join("gh"), "gho_dummy_0123456789");
    let token = github(&snapshot(&fixture, &[])).acquire();
    let env = fixture.assert_clean();
    assert_eq!(token.unwrap().expose_secret(), "gho_dummy_0123456789");
    assert_eq!(fixture.args().unwrap(), ["auth", "token"]);
    assert!(!env.keys().any(|name| name.starts_with("OPENSESAME_")));
}

#[test]
fn the_tool_is_handed_where_its_configuration_is_and_nothing_else() {
    let fixture = Fixture::new("gh");
    let extra = [
        ("GH_CONFIG_DIR", "/home/dummy/.config/gh"),
        ("GH_HOST", "ghe.example.com"),
        ("GH_TOKEN", "gho_dummy_parent_token"),
        ("KUBECONFIG", "/home/dummy/.kube/config"),
    ];
    fixture.stub_recorder_saying(&fixture.trusted.join("gh"), "gho_dummy_0123456789");
    github(&snapshot(&fixture, &extra)).acquire().unwrap();
    let env = fixture.assert_clean();
    assert_eq!(env["GH_CONFIG_DIR"], "/home/dummy/.config/gh");
    assert_eq!(env["GH_HOST"], "ghe.example.com");
    assert!(!env.contains_key("GH_TOKEN") && !env.contains_key("KUBECONFIG"));
}

#[test]
fn opensesame_gh_names_the_exact_tool_and_is_not_handed_on() {
    let fixture = Fixture::new("gh");
    let chosen = fixture.scratch("chosen").join("gh");
    fixture.stub_recorder_saying(&chosen, "gho_dummy_chosen");
    let extra = [("OPENSESAME_GH", chosen.to_str().unwrap())];
    let token = github(&snapshot(&fixture, &extra)).acquire().unwrap();
    assert_eq!(token.expose_secret(), "gho_dummy_chosen");
    let env = fixture.assert_clean();
    assert!(!env.contains_key("OPENSESAME_GH"));
}

#[test]
fn an_unusable_opensesame_gh_is_an_error_and_never_a_search() {
    let fixture = Fixture::new("gh");
    let extra = [("OPENSESAME_GH", "gh")];
    let error = github(&snapshot(&fixture, &extra)).acquire().unwrap_err();
    let rendered = error.to_string();
    assert!(rendered.contains("OPENSESAME_GH"), "{rendered}");
    assert!(!fixture.planted_ran() && fixture.env().is_none());
}

#[test]
fn a_snapshot_without_path_runs_nothing() {
    let fixture = Fixture::new("gh");
    let mut env = snapshot(&fixture, &[]);
    env.remove("PATH");
    let error = github(&env).acquire().unwrap_err();
    assert!(matches!(error, InvokeError::TokenUnavailable(_)), "{error}");
    assert!(!fixture.planted_ran() && fixture.env().is_none());
}

#[test]
fn a_tool_in_a_directory_anyone_can_write_is_refused_by_name() {
    let fixture = Fixture::new("gh");
    std::fs::remove_file(fixture.trusted.join("gh")).unwrap();
    let error = github(&snapshot(&fixture, &[])).acquire().unwrap_err();
    assert!(error.to_string().contains("OPENSESAME_GH"), "{error}");
    assert!(!fixture.planted_ran());
}
