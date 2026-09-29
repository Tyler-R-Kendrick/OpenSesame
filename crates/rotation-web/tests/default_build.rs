//! Login-form substitution is an optional plugin feature (ADR 0150 §7): the
//! `login-surrogate` cargo feature, off by default, enabled by nothing a
//! default build links. These tests ask cargo itself, so they prove what a
//! default build resolves — not what a test build resolves, which has the
//! feature on through the crate's own dev-dependency.
//!
//! Not feature-gated: they run in every `cargo test`, including the Rust CI
//! job's `cargo test --workspace --all-targets`.

use std::process::Command;

use serde_json::Value;

const CRATE: &str = "opensesame-rotation-web";
const FEATURE: &str = "login-surrogate";
/// The only package a normal dependency may enable the feature from: the
/// plugin binary, installed at runtime (ADR 0150 §7).
const PLUGIN_BINARY: &str = "opensesame-surrogate-proxy";
/// Dependencies only substitution uses. Each must be optional and pulled in
/// by the feature alone.
const FEATURE_ONLY: &[&str] = &[
    "opensesame-plugin-settings",
    "base64",
    "secrecy",
    "zeroize",
];

fn cargo(args: &[&str]) -> String {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let output = Command::new(cargo)
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("cargo runs");
    assert!(
        output.status.success(),
        "cargo {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("cargo writes UTF-8")
}

fn metadata() -> Value {
    let text = cargo(&[
        "metadata",
        "--format-version",
        "1",
        "--no-deps",
        "--offline",
    ]);
    serde_json::from_str(&text).expect("cargo metadata is JSON")
}

fn packages(metadata: &Value) -> &Vec<Value> {
    metadata["packages"].as_array().expect("packages")
}

fn this_crate(metadata: &Value) -> &Value {
    packages(metadata)
        .iter()
        .find(|package| package["name"] == CRATE)
        .expect("rotation-web is a workspace member")
}

fn names(list: &Value) -> Vec<&str> {
    list.as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

#[test]
fn the_default_feature_set_does_not_include_login_surrogate() {
    let metadata = metadata();
    let features = &this_crate(&metadata)["features"];
    assert!(features.get(FEATURE).is_some(), "the feature exists");
    assert!(
        !names(&features["default"]).contains(&FEATURE),
        "default = {:?}",
        features["default"]
    );
}

#[test]
fn a_default_build_resolves_without_login_surrogate_or_its_dependencies() {
    // `-e normal,features`: the tree a default `cargo build` of the crate
    // resolves, with every enabled feature printed.
    let tree = cargo(&[
        "tree",
        "-p",
        CRATE,
        "-e",
        "normal,features",
        "--prefix",
        "none",
        "--offline",
        "--locked",
    ]);
    assert!(
        !tree.contains(&format!("feature \"{FEATURE}\"")),
        "a default build enables {FEATURE}:\n{tree}"
    );
    assert!(
        !tree.contains("opensesame-plugin-settings"),
        "a default build links the plugin settings reader:\n{tree}"
    );
}

#[test]
fn every_dependency_only_substitution_uses_is_optional() {
    let metadata = metadata();
    let package = this_crate(&metadata);
    let wanted = names(&package["features"][FEATURE]);
    for dependency in package["dependencies"].as_array().expect("dependencies") {
        let name = dependency["name"].as_str().unwrap_or_default();
        if !FEATURE_ONLY.contains(&name) || !dependency["kind"].is_null() {
            continue;
        }
        assert_eq!(
            dependency["optional"], true,
            "{name} is linked into a default build"
        );
        assert!(
            wanted.contains(&format!("dep:{name}").as_str()),
            "{name} is not enabled by {FEATURE}: {wanted:?}"
        );
    }
}

#[test]
fn no_workspace_crate_enables_login_surrogate_in_a_normal_build() {
    let metadata = metadata();
    for package in packages(&metadata) {
        let owner = package["name"].as_str().unwrap_or_default();
        for dependency in package["dependencies"].as_array().expect("dependencies") {
            let normal = dependency["kind"].is_null();
            let enables = dependency["name"] == CRATE
                && (names(&dependency["features"]).contains(&FEATURE)
                    || dependency["uses_default_features"] == true
                        && names(&this_crate(&metadata)["features"]["default"]).contains(&FEATURE));
            assert!(
                !(normal && enables) || owner == PLUGIN_BINARY,
                "{owner} enables {FEATURE} in a normal build"
            );
        }
    }
}

#[test]
fn the_crate_tests_itself_with_the_feature_on() {
    // The dev-dependency on itself is what makes `cargo test --workspace
    // --all-targets` compile and run the substitution suites.
    let metadata = metadata();
    let own = this_crate(&metadata)["dependencies"]
        .as_array()
        .expect("dependencies")
        .iter()
        .find(|dependency| dependency["name"] == CRATE)
        .expect("a dev-dependency on itself");
    assert_eq!(own["kind"], "dev");
    assert!(names(&own["features"]).contains(&FEATURE));
}
