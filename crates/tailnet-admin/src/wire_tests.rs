use super::*;

fn tailscale_device() -> Value {
    json!({
        "addresses": ["100.101.102.103", "fd7a:115c:a1e0::1"],
        "id": "92960230385",
        "nodeId": "n292kg92CNTRL",
        "user": "amelie@example.com",
        "name": "pangolin.tailfe8c.ts.net",
        "hostname": "pangolin",
        "clientVersion": "1.80.2",
        "updateAvailable": true,
        "os": "linux",
        "created": "2022-12-01T05:23:30Z",
        "connectedToControl": false,
        "lastSeen": "2022-12-01T05:23:30Z",
        "keyExpiryDisabled": true,
        "expires": "0001-01-01T00:00:00Z",
        "authorized": true,
        "isExternal": false,
        "machineKey": "mkey:secretish",
        "nodeKey": "nodekey:secretish",
        "blocksIncomingConnections": false,
        "enabledRoutes": ["10.0.0.0/16"],
        "advertisedRoutes": ["10.0.0.0/16", "0.0.0.0/0", "::/0"],
        "tags": ["tag:web"],
        "tailnetLockError": "",
        "sshEnabled": true,
        "isEphemeral": false,
        "multipleConnections": false
    })
}

#[test]
fn a_device_is_mapped_and_nothing_else_comes_through() {
    let view = device(&tailscale_device()).unwrap();
    assert_eq!(view.id, "n292kg92CNTRL");
    assert_eq!(view.name, "pangolin.tailfe8c.ts.net");
    assert_eq!(view.expires, None, "a zero time is never");
    assert_eq!(view.last_seen.as_deref(), Some("2022-12-01T05:23:30Z"));
    assert!(view.key_expiry_disabled && view.ssh_enabled && view.update_available);
    assert_eq!(view.tailnet_lock_error, None);
    assert_eq!(view.advertised_routes.len(), 3);
    let out = serde_json::to_string(&view).unwrap();
    assert!(!out.contains("mkey:") && !out.contains("nodekey:"));
    assert!(!out.contains("machineKey"));
}

#[test]
fn the_legacy_id_stands_in_and_junk_is_dropped() {
    let mut raw = tailscale_device();
    raw["nodeId"] = json!("");
    assert_eq!(device(&raw).unwrap().id, "92960230385");
    raw["id"] = json!("../../etc");
    assert_eq!(device(&raw), None);
    let listed = devices(&json!({"devices": [tailscale_device(), {"nodeId": "bad id"}, 7]}));
    assert_eq!(listed.len(), 1);
    assert!(devices(&json!({})).is_empty());
}

#[test]
fn strings_are_bounded_and_printable() {
    let mut raw = tailscale_device();
    raw["hostname"] = json!(format!("a\u{1b}[31m{}", "x".repeat(1000)));
    let view = device(&raw).unwrap();
    assert_eq!(view.hostname.chars().count(), MAX_TEXT);
    assert!(!view.hostname.contains('\u{1b}'));
}

#[test]
fn keys_never_carry_their_secret_except_when_created() {
    let raw = json!({
        "id": "k123456CNTRL",
        "key": "tskey-auth-k123456CNTRL-abcdef",
        "keyType": "auth",
        "description": "lab",
        "created": "2026-10-01T00:00:00Z",
        "expires": "2026-10-02T00:00:00Z",
        "capabilities": {"devices": {"create": {
            "reusable": true, "ephemeral": false, "preauthorized": true, "tags": ["tag:ci"]
        }}}
    });
    let view = key(&raw).unwrap();
    assert!(view.reusable && view.preauthorized && !view.ephemeral);
    assert!(!serde_json::to_string(&view).unwrap().contains("tskey-"));
    let created = created_key(&raw).unwrap();
    assert_eq!(created["key"], "tskey-auth-k123456CNTRL-abcdef");
    assert_eq!(created["tags"], json!(["tag:ci"]));
    let mut not_auth = raw.clone();
    not_auth["key"] = json!("tskey-api-xyz");
    assert_eq!(created_key(&not_auth), None);
    let mut client = raw;
    client["keyType"] = json!("client");
    assert_eq!(key(&client), None);
}

#[test]
fn a_key_list_keeps_auth_keys_and_marks_bare_ones() {
    let listed = key_ids(&json!({"keys": [
        {"id": "kBARE1CNTRL"},
        {"id": "kFULL2CNTRL", "keyType": "auth", "capabilities": {"devices": {"create": {}}}},
        {"id": "kAPI3CNTRL", "keyType": "api"},
        {"id": "bad id"}
    ]}));
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].0, "kBARE1CNTRL");
    assert!(listed[0].1.is_none());
    assert!(listed[1].1.is_some());
}

#[test]
fn the_create_body_is_tailscales() {
    let body = create_key_body(&KeyRequest {
        description: "lab".into(),
        reusable: false,
        ephemeral: true,
        preauthorized: false,
        tags: vec!["tag:ci".into()],
        expiry_seconds: 3600,
    });
    assert_eq!(
        body,
        json!({
            "keyType": "auth",
            "description": "lab",
            "expirySeconds": 3600,
            "capabilities": {"devices": {"create": {
                "reusable": false, "ephemeral": true, "preauthorized": false, "tags": ["tag:ci"]
            }}}
        })
    );
    let bare = create_key_body(&KeyRequest {
        description: String::new(),
        reusable: false,
        ephemeral: false,
        preauthorized: false,
        tags: vec![],
        expiry_seconds: 3600,
    });
    assert!(bare.get("description").is_none());
    assert!(bare.pointer("/capabilities/devices/create/tags").is_none());
}

#[test]
fn routes_and_errors_map() {
    let view = routes(&json!({"advertisedRoutes": ["10.0.0.0/16"], "enabledRoutes": []}));
    assert_eq!(view.advertised_routes, ["10.0.0.0/16"]);
    assert!(view.enabled_routes.is_empty());
    assert_eq!(
        error_message(&json!({"message": "tags invalid"})),
        "tags invalid"
    );
    assert_eq!(error_message(&json!(null)), "");
}
