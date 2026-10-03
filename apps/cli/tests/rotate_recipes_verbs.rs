//! `rotate recipe` and `rotate signer`, driven through the real binary against
//! a stand-in Host (ADR 0076 §4, ADR 0159): signing is local, a recipe that is
//! not one never leaves the machine, and each verb names the right route.

mod hooks_mock;
mod rotate_recipes_mock;

use opensesame_rotation_web::recipe_doc::RecipeDocument;
use rotate_recipes_mock::{host, opensesame, rotate, ENCODED_ORIGIN, EXAMPLE, OPERATOR_TOKEN};
use serde_json::{json, Value};

#[test]
fn signing_is_local_and_names_no_host() {
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("k");
    let recipe = dir.path().join("r.json");
    std::fs::write(&recipe, EXAMPLE).unwrap();
    // Nothing listens here: a verb that dialled would fail.
    let nowhere = "http://127.0.0.1:1";
    for args in [
        vec!["signer", "keygen", "--out", key.to_str().unwrap()],
        vec![
            "recipe",
            "sign",
            "--key",
            key.to_str().unwrap(),
            recipe.to_str().unwrap(),
            "--expires-in-days",
            "30",
        ],
    ] {
        let out = rotate(dir.path(), nowhere).args(&args).output().unwrap();
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    // The signed document comes out on stdout, the sentence about it on stderr.
    let out = rotate(dir.path(), nowhere)
        .args([
            "recipe",
            "sign",
            "--key",
            key.to_str().unwrap(),
            recipe.to_str().unwrap(),
            "--expires-in-days",
            "30",
            "--canary-at",
            "now",
        ])
        .output()
        .unwrap();
    let signed = RecipeDocument::parse(&out.stdout).unwrap();
    assert!(signed.signature.is_some() && signed.canary.is_some());
    assert!(String::from_utf8_lossy(&out.stderr).contains("signed https://login.example with rsk_"));
}

#[test]
fn a_signing_key_is_a_file_never_an_argument() {
    let dir = tempfile::tempdir().unwrap();
    let recipe = dir.path().join("r.json");
    std::fs::write(&recipe, EXAMPLE).unwrap();
    let out = rotate(dir.path(), "http://127.0.0.1:1")
        .args([
            "recipe",
            "sign",
            "--key",
            &"ab".repeat(32),
            recipe.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!out.status.success(), "a seed in argv is not a file");
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(!said.contains(&"ab".repeat(32)), "never echoed: {said}");
    assert!(said.contains("names a file"), "{said}");
}

#[test]
fn a_recipe_that_is_not_one_never_leaves_the_machine() {
    let dir = tempfile::tempdir().unwrap();
    let (server, seen) = host();
    let mut document: Value = serde_json::from_str(EXAMPLE).unwrap();
    document["trust"] = json!("canary_verified");
    let file = dir.path().join("r.json");
    std::fs::write(&file, document.to_string()).unwrap();
    let out = rotate(dir.path(), &server)
        .args(["recipe", "put", file.to_str().unwrap(), "--if-version", "0"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("unknown field"));
    assert!(
        seen.lock().unwrap().is_empty(),
        "checked before any request"
    );
}

#[test]
fn reading_removing_and_revoking_name_the_right_routes() {
    let dir = tempfile::tempdir().unwrap();
    let (server, seen) = host();
    let run = |args: &[&str]| {
        let out = rotate(dir.path(), &server).args(args).output().unwrap();
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).to_string()
    };
    let only_the_document: Value = serde_json::from_str(&run(&[
        "recipe",
        "get",
        "https://LOGIN.example:443",
        "--document",
    ]))
    .unwrap();
    assert_eq!(
        only_the_document,
        json!({"origin": "https://login.example"})
    );
    let tables = |args: &[&str]| {
        let out = opensesame(dir.path())
            .env("OPENSESAME_OPERATOR_TOKEN", OPERATOR_TOKEN)
            .args([
                "--server",
                &server,
                "--output",
                "table",
                "access",
                "connectors",
                "rotate",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).to_string()
    };
    let table = tables(&["recipe", "ls"]);
    assert!(
        table.contains("https://login.example") && table.contains("canary_verified"),
        "{table}"
    );
    assert!(
        table.contains("passed (run)") && table.contains("yes"),
        "{table}"
    );
    let signers = tables(&["signer", "ls"]);
    assert!(
        signers.contains("release-signer") && signers.contains("active"),
        "{signers}"
    );
    run(&["recipe", "rm", "https://login.example", "--if-version", "2"]);
    run(&["signer", "rm", "rsk_0123456789abcdef0123456789abcdef"]);
    let seen = seen.lock().unwrap();
    let calls: Vec<(&str, &str, &str)> = seen
        .iter()
        .map(|r| (r.method.as_str(), r.path.as_str(), r.if_match.as_str()))
        .collect();
    assert_eq!(
        calls,
        [
            (
                "GET",
                &format!("/api/v1/web-login/recipes/{ENCODED_ORIGIN}") as &str,
                ""
            ),
            ("GET", "/api/v1/web-login/recipes", ""),
            ("GET", "/api/v1/web-login/signers", ""),
            (
                "DELETE",
                &format!("/api/v1/web-login/recipes/{ENCODED_ORIGIN}"),
                "\"2\""
            ),
            (
                "DELETE",
                "/api/v1/web-login/signers/rsk_0123456789abcdef0123456789abcdef",
                ""
            ),
        ]
    );
}

#[test]
fn a_session_alone_is_told_what_to_present_to_pin_a_signer() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("opensesame");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(
        config.join("session.json"),
        json!({"access_token": "opaque-session:plain-admin-session"}).to_string(),
    )
    .unwrap();
    let (server, _) = host();
    let out = opensesame(dir.path())
        .args([
            "--server",
            &server,
            "access",
            "connectors",
            "rotate",
            "signer",
            "add",
        ])
        .args(["--public-key", &"ab".repeat(32), "--label", "x"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(
        said.contains("step_up_required") && said.contains("OPENSESAME_OPERATOR_TOKEN"),
        "{said}"
    );
    assert!(said.contains("passkey"), "{said}");
}

#[test]
fn a_signer_is_named_by_a_public_key_or_a_key_file_never_both() {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        vec!["signer", "add", "--label", "x"],
        vec![
            "signer",
            "add",
            "--public-key",
            "ab",
            "--key",
            "k",
            "--label",
            "x",
        ],
        vec!["recipe", "put", "x.json"],
        vec![
            "recipe",
            "sign",
            "--key",
            "k",
            "x.json",
            "--expires-in-days",
            "94",
        ],
    ] {
        let out = rotate(dir.path(), "http://127.0.0.1:1")
            .args(&args)
            .output()
            .unwrap();
        assert!(!out.status.success(), "{args:?}");
    }
}
