use super::*;

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

#[test]
fn ids_are_alphanumeric_and_bounded() {
    assert_eq!(id("nAbc123CNTRL").unwrap(), "nAbc123CNTRL");
    assert_eq!(id("12345").unwrap(), "12345");
    for bad in ["", "../x", "a b", "n-1", &"a".repeat(65)] {
        assert_eq!(id(bad).unwrap_err().code(), "invalid_id");
    }
}

#[test]
fn a_name_is_one_label_or_empty() {
    assert_eq!(name(" Web-01 ").unwrap(), "web-01");
    assert_eq!(name("").unwrap(), "");
    for bad in ["-web", "web-", "web.example", "we b", &"a".repeat(64)] {
        assert_eq!(name(bad).unwrap_err().code(), "invalid_name");
    }
}

#[test]
fn tags_are_tag_labels_sorted_and_unique() {
    assert_eq!(
        tags(&strings(&["tag:web", "tag:ci-2"])).unwrap(),
        strings(&["tag:ci-2", "tag:web"])
    );
    assert!(tags(&[]).unwrap().is_empty());
    for bad in [
        vec!["web"],
        vec!["tag:"],
        vec!["tag:Web"],
        vec!["tag:2web"],
        vec!["tag:web", "tag:web"],
        vec!["tag:we b"],
    ] {
        assert_eq!(tags(&strings(&bad)).unwrap_err().code(), "invalid_tags");
    }
    let many: Vec<String> = (0..=MAX_TAGS).map(|i| format!("tag:t{i}")).collect();
    assert_eq!(tags(&many).unwrap_err().code(), "invalid_tags");
}

#[test]
fn routes_are_canonical_prefixes() {
    assert_eq!(
        routes(&strings(&[
            "10.0.0.0/16",
            "0.0.0.0/0",
            "::/0",
            "fd00::/8",
            "192.168.1.7/32"
        ]))
        .unwrap(),
        strings(&[
            "10.0.0.0/16",
            "0.0.0.0/0",
            "::/0",
            "fd00::/8",
            "192.168.1.7/32"
        ])
    );
    for bad in [
        vec!["10.0.0.1/16"],
        vec!["10.0.0.0/33"],
        vec!["10.0.0.0"],
        vec!["example.com/24"],
        vec!["fd00::1/8"],
        vec!["10.0.0.0/16", "10.0.0.0/16"],
    ] {
        assert_eq!(routes(&strings(&bad)).unwrap_err().code(), "invalid_routes");
    }
}

fn request(description: &str, expiry: u64, tags: &[&str]) -> KeyRequest {
    KeyRequest {
        description: description.into(),
        reusable: true,
        ephemeral: false,
        preauthorized: true,
        tags: strings(tags),
        expiry_seconds: expiry,
    }
}

#[test]
fn a_key_request_is_what_tailscale_accepts() {
    let ok = key_request(&request(" lab runners ", 86_400, &["tag:ci"]), true).unwrap();
    assert_eq!(ok.description, "lab runners");
    assert!(ok.reusable && ok.preauthorized && !ok.ephemeral);
    assert_eq!(
        key_request(&request("x", 86_400, &[]), true)
            .unwrap_err()
            .code(),
        "tags_required"
    );
    assert!(key_request(&request("x", 86_400, &[]), false).is_ok());
    assert_eq!(
        key_request(&request("bad!", 86_400, &[]), false)
            .unwrap_err()
            .code(),
        "invalid_description"
    );
    assert_eq!(
        key_request(&request(&"a".repeat(51), 86_400, &[]), false)
            .unwrap_err()
            .code(),
        "invalid_description"
    );
    for expiry in [0, MIN_KEY_EXPIRY_SECS - 1, MAX_KEY_EXPIRY_SECS + 1] {
        assert_eq!(
            key_request(&request("x", expiry, &[]), false)
                .unwrap_err()
                .code(),
            "invalid_expiry"
        );
    }
}
