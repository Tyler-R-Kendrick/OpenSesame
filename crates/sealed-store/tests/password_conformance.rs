//! ADR 0139: the password-policy cases `packages/app-core` runs too
//! (`spec/conformance/password-policy.json`).

use opensesame_sealed_store::{generate_characters, CharOptions};
use serde_json::Value;

fn policy() -> Value {
    serde_json::from_str(include_str!(
        "../../../spec/conformance/password-policy.json"
    ))
    .expect("password-policy.json parses")
}

fn options(overrides: &Value) -> CharOptions {
    let mut merged = policy()["defaults"].clone();
    for (key, value) in overrides.as_object().expect("options object") {
        merged[key] = value.clone();
    }
    serde_json::from_value(merged).expect("options")
}

#[test]
fn generator_matches_the_shared_cases() {
    let policy = policy();
    let ambiguous = policy["ambiguous"].as_str().expect("ambiguous");
    for case in policy["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let opts = options(&case["options"]);
        let Some(expect) = case.get("expect") else {
            assert!(
                generate_characters(&opts).is_err(),
                "`{name}` should be refused"
            );
            continue;
        };
        let classes: Vec<&str> = expect["classes"]
            .as_array()
            .expect("classes")
            .iter()
            .map(|c| {
                policy["classes"][c.as_str().expect("class")]
                    .as_str()
                    .expect("pool")
            })
            .collect();
        for _ in 0..50 {
            let out = generate_characters(&opts).expect(name);
            check(name, &out, expect, &classes, ambiguous);
        }
    }
}

fn check(name: &str, out: &str, expect: &Value, classes: &[&str], ambiguous: &str) {
    assert_eq!(
        Some(out.chars().count() as u64),
        expect["length"].as_u64(),
        "`{name}` length"
    );
    let allowed: String = classes.concat();
    let refuse_ambiguous = expect["ambiguous"] == false;
    for c in out.chars() {
        assert!(allowed.contains(c), "`{name}`: {c:?} outside its classes");
        assert!(
            !(refuse_ambiguous && ambiguous.contains(c)),
            "`{name}`: ambiguous {c:?}"
        );
    }
    for pool in classes {
        assert!(
            out.chars().any(|c| pool.contains(c)),
            "`{name}`: a class is missing"
        );
    }
}
