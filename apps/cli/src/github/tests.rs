use super::*;

#[test]
fn an_installation_token_never_prints() {
    let token: InstallationToken = serde_json::from_str(
        r#"{"token":"ghs_16C7e42F292c6912E7710c838347Ae178B4a","expires_at":"2030-01-01T00:00:00Z"}"#,
    )
    .unwrap();
    let shown = format!("{token:?}");
    assert!(!shown.contains("ghs_") && shown.contains("2030"), "{shown}");
}

/// Fresh throwaway key per run — a committed PEM would trip the gitleaks
/// gate and repo policy (keys live outside git).
fn throwaway_rsa_pem() -> Option<String> {
    let output = std::process::Command::new("openssl")
        .args(["genrsa", "2048"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

#[test]
#[expect(
    clippy::items_after_statements,
    reason = "the test-local decoding import belongs beside the assertion that uses it"
)]
fn app_jwt_is_rs256_with_app_id_issuer() {
    let Some(pem) = throwaway_rsa_pem() else {
        eprintln!("skipping: openssl unavailable");
        return;
    };
    let config = GitHubAppConfig {
        app_id: "12345".into(),
        installation_id: None,
        private_key_pem: pem,
        api_base: DEFAULT_API_BASE.into(),
    };
    let jwt = mint_app_jwt(&config).unwrap();
    let parts: Vec<&str> = jwt.split('.').collect();
    assert_eq!(parts.len(), 3);
    use base64::Engine as _;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let header: serde_json::Value =
        serde_json::from_slice(&engine.decode(parts[0]).unwrap()).unwrap();
    assert_eq!(header["alg"], "RS256");
    let claims: serde_json::Value =
        serde_json::from_slice(&engine.decode(parts[1]).unwrap()).unwrap();
    assert_eq!(claims["iss"], "12345");
    let lifetime = claims["exp"].as_i64().unwrap() - claims["iat"].as_i64().unwrap();
    assert_eq!(lifetime, 600, "GitHub caps app JWTs at 10 minutes");
}

#[test]
fn resolve_requires_an_app_id() {
    // No explicit values and (in tests) no env — must fail with the fix named.
    if std::env::var("GITHUB_APP_ID").is_ok() {
        return; // environment already configured; nothing to assert
    }
    let err = GitHubAppConfig::resolve(None, None, None).unwrap_err();
    assert!(err.to_string().contains("GITHUB_APP_ID"));
}

#[cfg(unix)]
#[test]
fn gh_is_the_trusted_one_and_never_sees_the_app_key_or_the_hosts_secrets() {
    use opensesame_trusted_exec::testkit::{Fixture, SECRET};
    let fixture = Fixture::new("gh");
    let lookup = fixture.lookup(&[
        ("GH_HOST", "github.example.invalid"),
        ("GH_CONFIG_DIR", "/home/dummy/.config/gh"),
        ("HTTPS_PROXY", "http://proxy.invalid:3128"),
        ("GITHUB_APP_PRIVATE_KEY_PATH", "/home/dummy/app.pem"),
        ("GITHUB_APP_ID", "12345"),
        ("OPENSESAME_GIT_TOKEN", SECRET),
    ]);
    let mut command = gh_in(&lookup).unwrap();
    assert!(command.args(["auth", "token"]).status().unwrap().success());
    let env = fixture.assert_clean();
    for name in ["GH_HOST", "GH_CONFIG_DIR", "HTTPS_PROXY"] {
        assert!(env.contains_key(name), "{name} missing: {env:?}");
    }
    for name in [
        "GITHUB_APP_PRIVATE_KEY_PATH",
        "GITHUB_APP_ID",
        "OPENSESAME_GIT_TOKEN",
    ] {
        assert!(!env.contains_key(name), "{name} reached gh");
    }
}

#[cfg(unix)]
#[test]
fn a_refused_gh_is_said_with_the_variable_that_names_it() {
    use opensesame_trusted_exec::testkit::Fixture;
    let fixture = Fixture::new("gh");
    std::fs::remove_file(fixture.trusted.join("gh")).unwrap();
    let why = gh_token_in(&fixture.lookup(&[])).expect_err("gh was refused, not absent");
    assert!(
        why.contains("or set OPENSESAME_GH to the absolute path"),
        "{why}"
    );
    assert!(!fixture.planted_ran());
}

#[cfg(unix)]
#[test]
fn a_trusted_gh_that_prints_a_token_gives_it() {
    use opensesame_trusted_exec::testkit::Fixture;
    let fixture = Fixture::new("gh");
    fixture.stub_recorder_saying(&fixture.trusted.join("gh"), "gho_dummy_0123456789\n");
    let lookup = fixture.lookup(&[]);
    assert_eq!(
        gh_token_in(&lookup),
        Ok(Some("gho_dummy_0123456789".into()))
    );
}

#[cfg(unix)]
#[test]
fn gh_is_handed_a_ghes_token_and_a_version_managers_home() {
    use opensesame_trusted_exec::testkit::Fixture;
    let fixture = Fixture::new("gh");
    let enterprise_token = "T".repeat(32);
    let lookup = fixture.lookup(&[
        ("GH_ENTERPRISE_TOKEN", enterprise_token.as_str()),
        ("GITHUB_ENTERPRISE_TOKEN", enterprise_token.as_str()),
        ("ASDF_DATA_DIR", "/home/dummy/.asdf"),
        ("NIX_SSL_CERT_FILE", "/etc/ssl/certs/ca-bundle.crt"),
    ]);
    let mut command = gh_in(&lookup).unwrap();
    assert!(command.args(["auth", "token"]).status().unwrap().success());
    let env = fixture.env().expect("gh ran");
    for name in ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] {
        assert_eq!(
            env.get(name).map(String::as_str),
            Some(enterprise_token.as_str())
        );
    }
    for name in [
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
        "ASDF_DATA_DIR",
        "NIX_SSL_CERT_FILE",
    ] {
        assert!(env.contains_key(name), "{name} missing: {env:?}");
    }
}

#[cfg(unix)]
#[test]
fn opensesame_gh_names_the_exact_file() {
    use opensesame_trusted_exec::testkit::Fixture;
    let fixture = Fixture::new("gh");
    let chosen = fixture.scratch("chosen").join("gh");
    fixture.stub_recorder(&chosen);
    let value = chosen.display().to_string();
    let command = gh_in(&fixture.lookup(&[(GH_OVERRIDE, &value)])).unwrap();
    assert_eq!(command.get_program(), chosen.as_os_str());
    let err = gh_in(&fixture.lookup(&[(GH_OVERRIDE, "gh")]))
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("OPENSESAME_GH must be an absolute path"),
        "{err}"
    );
}

#[test]
fn a_garbage_key_fails_closed() {
    let config = GitHubAppConfig {
        app_id: "1".into(),
        installation_id: None,
        private_key_pem: "not a pem".into(),
        api_base: DEFAULT_API_BASE.into(),
    };
    assert!(mint_app_jwt(&config).is_err());
}
