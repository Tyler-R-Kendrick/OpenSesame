//! The produce vectors, and entries through the facade (ADR 0174).

use super::*;
use serde_json::json;

const VECTORS: &str = include_str!("../../../spec/conformance/produce-vectors.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("the vectors parse")
}

fn rules(value: &Value) -> Rules {
    rules_of(value).expect("rules")
}

#[test]
fn computes_every_derived_vector_as_typescript_does() {
    for case in vectors()["derived"].as_array().expect("derived") {
        let name = case["name"].as_str().expect("name");
        let got = derive(
            case["root"].as_str().expect("root"),
            case["counter"].as_u64().expect("counter"),
            &rules(&case["rules"]),
        )
        .unwrap_or_else(|| panic!("{name}: not produced"));
        assert_eq!(
            &*got,
            case["password"].as_str().expect("password"),
            "{name}"
        );
    }
}

#[test]
fn puts_a_pepper_where_every_recorded_expression_says() {
    let positions = &vectors()["positions"];
    let password = positions["password"].as_str().expect("password");
    for case in positions["cases"].as_array().expect("cases") {
        let expression = case["expression"].as_str().expect("expression");
        let (head, tail) = split_at_pepper(password, expression);
        assert_eq!(head, case["head"].as_str().expect("head"), "`{expression}`");
        assert_eq!(tail, case["tail"].as_str().expect("tail"), "`{expression}`");
    }
}

fn entry(secret: &str, meta: &Value) -> Entry {
    Entry {
        secret: secret.to_owned(),
        trailer: format!("{meta}\n"),
        otp: None,
    }
}

fn password(method: &Value) -> Value {
    json!({ "v": 2, "kind": "account", "values": { "methods": [method] } })
}

#[test]
fn a_plain_pass_entry_is_its_line_one() {
    let plain = Entry::parse("hunter2\nurl: https://x.test\n");
    assert_eq!(
        produce_entry(&plain),
        Produced::Ok(Zeroizing::new("hunter2".into()))
    );
    assert_eq!(produce_entry(&Entry::parse("")), Produced::Absent);
}

#[test]
fn an_algorithmic_entry_has_no_password_in_the_file_and_computes_it_here() {
    let case = &vectors()["derived"][0];
    let meta = password(&json!({
        "id": "m", "type": "password", "pepper": false, "secret": case["root"],
        "generator": { "id": "derived", "rules": case["rules"], "counter": case["counter"] },
        "changedAt": "2026-01-01T00:00:00.000Z"
    }));
    let made = entry("", &meta);
    assert!(!made.trailer.contains(case["password"].as_str().unwrap()));
    assert_eq!(
        produce_entry(&made),
        Produced::Ok(Zeroizing::new(case["password"].as_str().unwrap().into()))
    );
}

#[test]
fn a_stored_password_with_a_pepper_slot_comes_out_in_two_parts() {
    let meta = password(&json!({
        "id": "m", "type": "password", "pepper": true, "pepperAt": "-2",
        "secret": "abcdefgh", "generator": { "id": "manual" }, "changedAt": "x"
    }));
    assert_eq!(
        produce_entry(&entry("", &meta)),
        Produced::Slotted {
            head: Zeroizing::new("abcdef".into()),
            tail: Zeroizing::new("gh".into())
        }
    );
}

#[test]
fn a_password_an_older_version_sealed_or_sphinx_made_is_legacy() {
    let sealed = password(&json!({
        "id": "m", "type": "password", "pepper": true, "secret": "",
        "generator": { "id": "manual" }, "sealed": { "v": 1 }, "changedAt": "x"
    }));
    assert_eq!(produce_entry(&entry("", &sealed)), Produced::Legacy);
    let sphinx = password(&json!({
        "id": "m", "type": "password", "pepper": true, "secret": "",
        "generator": { "id": "sphinx" }, "changedAt": "x"
    }));
    assert_eq!(produce_entry(&entry("", &sphinx)), Produced::Legacy);
}

const PEPPER_VECTORS: &str = include_str!("../../../spec/conformance/pepper-position-vectors.json");

/// `length` characters, ASCII or beyond the basic plane, so a position counts
/// code points the way Python does and never UTF-16 units or bytes.
fn passwords(length: u32) -> [Vec<char>; 2] {
    [
        (0..length)
            .filter_map(|i| char::from_u32(0x61 + i))
            .collect(),
        (0..length)
            .filter_map(|i| char::from_u32(0x1_f600 + i))
            .collect(),
    ]
}

#[test]
fn cuts_every_expression_at_every_length_as_python_does() {
    let vectors: Value = serde_json::from_str(PEPPER_VECTORS).expect("the vectors parse");
    let cases = vectors["cases"].as_array().expect("cases");
    let max = usize::try_from(vectors["maxLength"].as_u64().expect("maxLength")).expect("fits");
    assert!(cases.len() > 800, "the corpus is the whole grid");
    for case in cases {
        let expression = case["expression"].as_str().expect("expression");
        let cuts = case["cuts"].as_array().expect("cuts");
        assert_eq!(cuts.len(), max + 1, "`{expression}`");
        for (length, cut) in cuts.iter().enumerate() {
            let head = usize::try_from(cut[0].as_u64().expect("head")).expect("fits");
            let tail = usize::try_from(cut[1].as_u64().expect("tail")).expect("fits");
            for chars in passwords(u32::try_from(length).expect("fits")) {
                let password: String = chars.iter().collect();
                let (got_head, got_tail) = split_at_pepper(&password, expression);
                assert_eq!(
                    got_head,
                    chars[..head].iter().collect::<String>(),
                    "`{expression}` head at {length}"
                );
                assert_eq!(
                    got_tail,
                    chars[chars.len() - tail..].iter().collect::<String>(),
                    "`{expression}` tail at {length}"
                );
            }
        }
    }
}
