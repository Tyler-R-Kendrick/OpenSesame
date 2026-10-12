//! `opensesame vault circle inspect`, and the shapes of the bundle it refuses.

use super::support::{path_str, run, text, Circle};

#[test]
fn inspect_shows_the_public_shape_as_json_by_default_and_as_text_on_request() {
    let circle = Circle::new();
    let bundle = path_str(&circle.bundle()).to_owned();
    let json = run(&["vault", "circle", "inspect", "--bundle", &bundle], None);
    assert!(json.status.success(), "{}", text(&json.stderr));
    let shape: serde_json::Value = serde_json::from_slice(&json.stdout).unwrap();
    assert_eq!(shape["signatureVerified"], true);
    assert_eq!(shape["epoch"], 1);
    assert_eq!(shape["groups"][1]["guardians"][2]["name"], "Fay");

    let plain = run(
        &[
            "--output", "text", "vault", "circle", "inspect", "--bundle", &bundle,
        ],
        None,
    );
    let out = text(&plain.stdout);
    assert!(out.contains("family: 2 of 3: Ada, Ben, Cy"), "{out}");
    assert!(!circle.leaks(&plain));
}

#[test]
fn a_pinned_owner_key_must_match_and_a_tampered_policy_is_refused() {
    let circle = Circle::new();
    let bundle = path_str(&circle.bundle()).to_owned();
    let owner = circle.fixture["ownerPublicKey"].as_str().unwrap();
    let pinned = run(
        &[
            "vault",
            "circle",
            "inspect",
            "--bundle",
            &bundle,
            "--owner-key",
            owner,
        ],
        None,
    );
    assert!(pinned.status.success());
    let wrong = run(
        &[
            "vault",
            "circle",
            "inspect",
            "--bundle",
            &bundle,
            "--owner-key",
            "AAAA",
        ],
        None,
    );
    assert!(!wrong.status.success());
    assert!(text(&wrong.stderr).contains("different owner key"));

    let mut edited = circle.fixture["bundle"].clone();
    edited["signedPolicy"]["policy"]["label"] = serde_json::json!("Not the family");
    let tampered = circle.path("tampered.json");
    std::fs::write(&tampered, edited.to_string()).unwrap();
    let refused = run(
        &[
            "vault",
            "circle",
            "inspect",
            "--bundle",
            path_str(&tampered),
        ],
        None,
    );
    assert!(!refused.status.success());
    assert!(text(&refused.stderr).contains("does not match its digest"));
}
