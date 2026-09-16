//! The fixture's routing table — the subset of Discord v10 this adapter uses.
//!
//! Split out of `support/mod.rs` to keep both files inside the 400-line module
//! budget (ADR 0093). The handlers are stateful: a create returns a fresh
//! snowflake and the role is then findable, an overwrite `PUT` is an upsert a
//! later channel read reflects, and a role delete also comes off every member.
//! That is what lets the suite assert convergence and "left alone" rather than
//! just "called the right URL".
//!
//! Anything unmatched answers `404` in Discord's error shape, so calling the
//! wrong endpoint fails a test instead of passing unnoticed.
#![allow(dead_code)]

use serde_json::{json, Value};

use super::{role_json, Server, BOT_USER_ID, GUILD_ID};

pub fn route(server: &Server, method: &str, path: &str, body: Option<&Value>) -> (u16, String) {
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match (method, segments.as_slice()) {
        ("GET", ["api", "v10", "users", "@me"]) => (
            200,
            json!({ "id": BOT_USER_ID, "username": "opensesame", "bot": true }).to_string(),
        ),
        ("GET", ["api", "v10", "guilds", GUILD_ID, "roles"]) => (
            200,
            Value::Array(server.state.lock().unwrap().roles.clone()).to_string(),
        ),
        ("GET", ["api", "v10", "guilds", GUILD_ID, "members", user]) => {
            member_response(server, user)
        }
        ("POST", ["api", "v10", "guilds", GUILD_ID, "roles"]) => create_role(server, body),
        ("PATCH", ["api", "v10", "guilds", GUILD_ID, "roles", role]) => {
            patch_role(server, role, body)
        }
        ("DELETE", ["api", "v10", "guilds", GUILD_ID, "roles", role]) => delete_role(server, role),
        ("PUT", ["api", "v10", "guilds", GUILD_ID, "members", user, "roles", role]) => {
            set_member_role(server, user, role, true)
        }
        ("DELETE", ["api", "v10", "guilds", GUILD_ID, "members", user, "roles", role]) => {
            set_member_role(server, user, role, false)
        }
        ("GET", ["api", "v10", "channels", channel]) => channel_response(server, channel),
        ("PUT", ["api", "v10", "channels", channel, "permissions", role]) => {
            put_overwrite(server, channel, role, body)
        }
        _ => (
            404,
            json!({ "message": "404: Not Found", "code": 0 }).to_string(),
        ),
    }
}

fn member_response(server: &Server, user: &str) -> (u16, String) {
    let state = server.state.lock().unwrap();
    match state.member_roles.get(user) {
        Some(roles) => (
            200,
            json!({ "user": { "id": user }, "roles": roles }).to_string(),
        ),
        None => unknown_member(),
    }
}

fn create_role(server: &Server, body: Option<&Value>) -> (u16, String) {
    let Some(body) = body else {
        return bad_request("missing body");
    };
    let mut state = server.state.lock().unwrap();
    let id = state.next_role_id.to_string();
    state.next_role_id += 1;
    // Discord answers with the created role, and permissions come back as the
    // same decimal string that went in.
    let created = role_json(
        &id,
        body["name"].as_str().unwrap_or_default(),
        body["permissions"].as_str().unwrap_or("0"),
        1,
        false,
    );
    state.roles.push(created.clone());
    (200, created.to_string())
}

/// A `PATCH` that touches only the fields it was sent, so a name or colour a
/// person set on the role survives a permission correction.
fn patch_role(server: &Server, role: &str, body: Option<&Value>) -> (u16, String) {
    let mut state = server.state.lock().unwrap();
    let Some(existing) = state.roles.iter_mut().find(|r| r["id"] == role) else {
        return unknown_role();
    };
    if let Some(permissions) = body.and_then(|b| b.get("permissions")).cloned() {
        existing["permissions"] = permissions;
    }
    (200, existing.to_string())
}

/// Deleting a role also takes it off every member, as Discord's does — which is
/// why `tests/reconcile.rs` can assert the member's remaining roles exactly.
fn delete_role(server: &Server, role: &str) -> (u16, String) {
    let mut state = server.state.lock().unwrap();
    let before = state.roles.len();
    state.roles.retain(|r| r["id"] != role);
    if state.roles.len() == before {
        return unknown_role();
    }
    for roles in state.member_roles.values_mut() {
        roles.retain(|held| held != role);
    }
    (204, String::new())
}

fn set_member_role(server: &Server, user: &str, role: &str, add: bool) -> (u16, String) {
    let mut state = server.state.lock().unwrap();
    if !state.roles.iter().any(|r| r["id"] == role) {
        return unknown_role();
    }
    let Some(held) = state.member_roles.get_mut(user) else {
        return unknown_member();
    };
    if add {
        if !held.iter().any(|existing| existing == role) {
            held.push(role.to_owned());
        }
    } else {
        held.retain(|existing| existing != role);
    }
    (204, String::new())
}

/// `GET /channels/{channel}`, carrying the overwrites a previous `PUT` wrote.
fn channel_response(server: &Server, channel: &str) -> (u16, String) {
    let state = server.state.lock().unwrap();
    match state.channel_overwrites.get(channel) {
        Some(overwrites) => (
            200,
            json!({
                "id": channel,
                "type": 0,
                "guild_id": GUILD_ID,
                "permission_overwrites": overwrites,
            })
            .to_string(),
        ),
        None => unknown_channel(),
    }
}

/// `PUT /channels/{channel}/permissions/{role}` — an upsert, as Discord's is.
fn put_overwrite(
    server: &Server,
    channel: &str,
    role: &str,
    body: Option<&Value>,
) -> (u16, String) {
    let Some(body) = body else {
        return bad_request("missing body");
    };
    let mut state = server.state.lock().unwrap();
    let Some(overwrites) = state.channel_overwrites.get_mut(channel) else {
        return unknown_channel();
    };
    let entry = json!({
        "id": role,
        "type": body["type"].clone(),
        "allow": body["allow"].clone(),
        "deny": body["deny"].clone(),
    });
    match overwrites
        .iter_mut()
        .find(|existing| existing["id"] == role)
    {
        Some(existing) => *existing = entry,
        None => overwrites.push(entry),
    }
    (204, String::new())
}

fn unknown_role() -> (u16, String) {
    (
        404,
        json!({ "message": "Unknown Role", "code": 10_011 }).to_string(),
    )
}

fn unknown_member() -> (u16, String) {
    (
        404,
        json!({ "message": "Unknown Member", "code": 10_007 }).to_string(),
    )
}

fn unknown_channel() -> (u16, String) {
    (
        404,
        json!({ "message": "Unknown Channel", "code": 10_003 }).to_string(),
    )
}

fn bad_request(detail: &str) -> (u16, String) {
    (
        400,
        json!({ "message": detail, "code": 50_035 }).to_string(),
    )
}
