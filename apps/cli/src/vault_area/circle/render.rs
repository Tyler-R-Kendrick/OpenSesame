//! The public shape of a circle, as `vault circle inspect` prints it: JSON by
//! default (the global `--output`), plain text on request. Nothing here reads
//! a share, a nonce or a ciphertext.

use opensesame_quorum_recovery::RecoveryBundle;
use serde_json::{json, Value};

pub(super) fn inspect_json(bundle: &RecoveryBundle) -> Value {
    let policy = &bundle.signed_policy.policy;
    let groups: Vec<Value> = policy
        .groups
        .iter()
        .map(|group| {
            let guardians: Vec<Value> = group
                .guardian_ids
                .iter()
                .map(|id| json!({ "id": id, "name": policy.guardian(id).map(|g| g.name.as_str()) }))
                .collect();
            json!({ "id": group.id, "threshold": group.threshold, "guardians": guardians })
        })
        .collect();
    json!({
        "ok": true,
        "circleId": policy.circle_id,
        "label": policy.label,
        "collection": policy.collection,
        "epoch": policy.epoch,
        "supersedes": policy.supersedes.as_ref().map(|s| json!({ "epoch": s.epoch, "digest": s.digest })),
        "ownerKey": policy.owner_key,
        "digest": bundle.signed_policy.digest,
        "signatureVerified": true,
        "groupThreshold": policy.group_threshold,
        "groups": groups,
        "operations": policy.operations.iter().map(|o| o.as_str()).collect::<Vec<_>>(),
        "approvalWindowSec": policy.approval_window_sec,
        "releaseDelaySec": policy.release_delay_sec,
        "requestLifetimeSec": policy.request_lifetime_sec,
        "requireUserVerification": policy.require_user_verification,
        "createdAt": policy.created_at,
    })
}

fn inspect_text(shape: &Value) -> String {
    let text = |key: &str| shape[key].as_str().unwrap_or_default().to_owned();
    let mut lines = vec![
        format!(
            "OK -- the owner's signature verifies: circle {} \"{}\", epoch {}",
            text("circleId"),
            text("label"),
            shape["epoch"]
        ),
        format!("protects: {}", text("collection")),
        format!("owner key: {}", text("ownerKey")),
        format!(
            "needs {} of {} groups",
            shape["groupThreshold"],
            shape["groups"].as_array().map_or(0, Vec::len)
        ),
    ];
    for group in shape["groups"].as_array().into_iter().flatten() {
        let names: Vec<&str> = group["guardians"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|g| g["name"].as_str())
            .collect();
        lines.push(format!(
            "  {}: {} of {}: {}",
            group["id"].as_str().unwrap_or_default(),
            group["threshold"],
            names.len(),
            names.join(", ")
        ));
    }
    lines.push(format!(
        "release delay {} s, approval window {} s, lifetime {} s",
        shape["releaseDelaySec"], shape["approvalWindowSec"], shape["requestLifetimeSec"]
    ));
    lines.join("\n")
}

pub(super) fn render_inspect(bundle: &RecoveryBundle, output: &str) -> String {
    let shape = inspect_json(bundle);
    if output == "json" {
        serde_json::to_string_pretty(&shape).unwrap_or_default()
    } else {
        inspect_text(&shape)
    }
}
