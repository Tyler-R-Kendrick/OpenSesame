//! `opensesame daemon tailnet devices | approve | … | audit`: from a terminal,
//! the device and key operations a paired page performs (ADR 0169 §4),
//! through the same validation, the same upstream and the same audit trail —
//! recorded as `terminal`.

use clap::Subcommand;
use opensesame_plugin_settings::unix_now;
use opensesame_tailnet_admin::{
    ops, validate::KeyRequest, AdminError, AdminStore, AuditEntry, Paired, Role, Upstream,
};
use serde_json::{json, Value};

#[derive(Subcommand, Debug)]
pub enum DeviceCmd {
    /// Every device on the tailnet.
    Devices,
    /// One device.
    Device { id: String },
    /// Admit a device waiting for approval.
    Approve { id: String },
    /// Put a device out of the tailnet without removing it.
    Deauthorize { id: String },
    /// Rename a device; an empty name resets it to its hostname.
    Rename { id: String, name: String },
    /// Replace a device's tags (`tag:web tag:ci`; none clears them).
    Tag { id: String, tags: Vec<String> },
    /// Turn a device's key expiry `on` or `off`.
    KeyExpiry {
        id: String,
        #[arg(value_parser = ["on", "off"])]
        state: String,
    },
    /// Expire a device's key now: it must sign in again.
    Expire { id: String },
    /// Replace a device's enabled routes (`0.0.0.0/0 ::/0` make an exit node).
    Routes { id: String, routes: Vec<String> },
    /// Remove a device from the tailnet.
    Remove { id: String },
    /// The tailnet's auth keys, never their secrets.
    Keys,
    /// Mint an auth key to add a device; its secret is printed once.
    Mint {
        #[arg(long, default_value = "")]
        description: String,
        #[arg(long)]
        reusable: bool,
        #[arg(long)]
        ephemeral: bool,
        /// Devices joining with it need no approval.
        #[arg(long)]
        preauthorized: bool,
        #[arg(long = "tag")]
        tags: Vec<String>,
        #[arg(long, default_value_t = 24)]
        expiry_hours: u64,
    },
    /// Revoke an auth key.
    Revoke { id: String },
    /// The newest changes made through the tailnet routes and these verbs.
    Audit {
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
}

fn terminal() -> Paired {
    Paired {
        id: "terminal".into(),
        origin: String::new(),
        role: Role::Manage,
        label: "opensesame daemon tailnet".into(),
    }
}

/// Run a change and write its audit line, as the daemon's routes do.
async fn change<F>(store: &AdminStore, action: &str, target: &str, run: F) -> anyhow::Result<Value>
where
    F: std::future::Future<Output = Result<Value, AdminError>>,
{
    let outcome = run.await;
    let status = match &outcome {
        Err(AdminError::Invalid(_) | AdminError::TagsRequired) => None,
        Err(error) => Some(error.status()),
        Ok(_) => Some(200),
    };
    if let Some(status) = status {
        let named = outcome
            .as_ref()
            .ok()
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
            .unwrap_or(target);
        store.audit().append(&AuditEntry::new(
            unix_now(),
            &terminal(),
            action,
            named,
            status,
        ))?;
    }
    outcome.map_err(super::explain)
}

fn done(_: ()) -> Value {
    json!({ "ok": true })
}

/// Run one device or key verb against the connected tailnet.
pub async fn run(store: &AdminStore, cmd: DeviceCmd) -> anyhow::Result<Value> {
    let up = Upstream::from_env();
    let (up, s) = (&up, store);
    Ok(match cmd {
        DeviceCmd::Devices => {
            json!({ "devices": ops::list_devices(up, s).await.map_err(super::explain)? })
        }
        DeviceCmd::Device { id } => {
            json!(ops::get_device(up, s, &id).await.map_err(super::explain)?)
        }
        DeviceCmd::Keys => json!({ "keys": ops::list_keys(up, s).await.map_err(super::explain)? }),
        DeviceCmd::Audit { limit } => json!({ "entries": s.audit().recent(limit)? }),
        DeviceCmd::Approve { id } => {
            change(s, "device.authorize", &id, async {
                ops::set_authorized(up, s, &id, true).await.map(done)
            })
            .await?
        }
        DeviceCmd::Deauthorize { id } => {
            change(s, "device.deauthorize", &id, async {
                ops::set_authorized(up, s, &id, false).await.map(done)
            })
            .await?
        }
        DeviceCmd::Rename { id, name } => {
            change(s, "device.rename", &id, async {
                ops::rename(up, s, &id, &name).await.map(done)
            })
            .await?
        }
        DeviceCmd::Tag { id, tags } => {
            change(s, "device.tags", &id, async {
                ops::set_tags(up, s, &id, &tags).await.map(done)
            })
            .await?
        }
        DeviceCmd::KeyExpiry { id, state } => {
            let disabled = state == "off";
            change(s, "device.key_expiry", &id, async {
                ops::set_key_expiry_disabled(up, s, &id, disabled)
                    .await
                    .map(done)
            })
            .await?
        }
        DeviceCmd::Expire { id } => {
            change(s, "device.expire", &id, async {
                ops::expire(up, s, &id).await.map(done)
            })
            .await?
        }
        DeviceCmd::Routes { id, routes } => {
            change(s, "device.routes", &id, async {
                ops::set_routes(up, s, &id, &routes).await.map(|v| json!(v))
            })
            .await?
        }
        DeviceCmd::Remove { id } => {
            change(s, "device.delete", &id, async {
                ops::delete_device(up, s, &id).await.map(done)
            })
            .await?
        }
        DeviceCmd::Revoke { id } => {
            change(s, "key.delete", &id, async {
                ops::delete_key(up, s, &id).await.map(done)
            })
            .await?
        }
        DeviceCmd::Mint {
            description,
            reusable,
            ephemeral,
            preauthorized,
            tags,
            expiry_hours,
        } => {
            let request = KeyRequest {
                description,
                reusable,
                ephemeral,
                preauthorized,
                tags,
                expiry_seconds: expiry_hours.saturating_mul(3600),
            };
            let created = change(s, "key.create", "", ops::create_key(up, s, request)).await?;
            eprintln!("The key is shown once. Join a machine with: tailscale up --auth-key=<key>");
            created
        }
    })
}
