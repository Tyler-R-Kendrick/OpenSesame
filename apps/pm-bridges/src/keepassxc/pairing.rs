//! The `associate` approval ceremony and the association store lookups.
//!
//! `associate` is the one moment a new caller identity is admitted, so it is
//! the one moment a human must be in the loop (C2(b)). Real `KeePassXC` shows a
//! dialog; a headless bridge cannot, so approval is brokered through the
//! shared pairing-window file:
//!
//! ```text
//!   human:  opensesame bridge keepassxc pair      → window: Open
//!   client: associate { key, idKey }              → window: Requested{fingerprint}
//!   human:  sees the fingerprint, answers y/N     → window: Confirmed | Rejected
//!   bridge: reads the verdict, persists or denies → window: closed
//! ```
//!
//! Everything persisted is public: the identification **public** key, the
//! name the human paired it under, and when.

use std::time::Duration;

use crate::pairing::{
    key_fingerprint, load_pairings, save_pairings, Association, PairingFile, PairingWindow,
    WindowState,
};
use crate::{now_unix, BridgeError};

/// Pairing file / window basename for this bridge.
pub const BRIDGE_NAME: &str = "keepassxc";

/// How long the bridge waits for a human verdict once it has posted a
/// fingerprint. Bounded so a client cannot pin a connection open forever.
pub const CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);

/// How often the bridge re-reads the window file while waiting.
pub const CONFIRM_POLL: Duration = Duration::from_millis(200);

/// Outcome of asking a human to approve a client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Approval {
    /// The human confirmed; pair under this name.
    Granted { name: String },
    /// No window was open, the human said no, or the window aged out.
    Denied(&'static str),
}

/// Ask for approval of `id_key`, blocking until the human decides.
///
/// `sleep` is injected so tests drive the loop without real time passing.
///
/// # Errors
///
/// Returns an error when the pairing window cannot be read or updated.
pub fn request_approval(
    window: &PairingWindow,
    id_key_b64: &str,
    client_label: &str,
    mut sleep: impl FnMut(Duration),
) -> Result<Approval, BridgeError> {
    let fingerprint = key_fingerprint(id_key_b64);
    match window.state(now_unix())? {
        WindowState::Open { .. } => {}
        WindowState::Requested { .. } => {
            return Ok(Approval::Denied(
                "another pairing request is already pending",
            ))
        }
        _ => return Ok(Approval::Denied("no pairing window is open")),
    }
    window.request(now_unix(), &fingerprint, client_label)?;

    let deadline = std::time::Instant::now() + CONFIRM_TIMEOUT;
    loop {
        match window.state(now_unix())? {
            WindowState::Confirmed {
                fingerprint: confirmed,
                name,
            } => {
                // The human confirmed *a* fingerprint; make sure it is this
                // one, so a racing second client cannot ride the approval.
                if confirmed != fingerprint {
                    return Ok(Approval::Denied("the confirmed fingerprint does not match"));
                }
                let name = if name.trim().is_empty() {
                    client_label.to_string()
                } else {
                    name
                };
                return Ok(Approval::Granted { name });
            }
            WindowState::Rejected => {
                return Ok(Approval::Denied("the pairing request was rejected"))
            }
            WindowState::Expired | WindowState::Closed => {
                return Ok(Approval::Denied("the pairing window closed"))
            }
            WindowState::Requested { .. } | WindowState::Open { .. } => {}
        }
        if std::time::Instant::now() >= deadline {
            return Ok(Approval::Denied("timed out waiting for confirmation"));
        }
        sleep(CONFIRM_POLL);
    }
}

/// Persist a newly approved client and return the association.
///
/// # Errors
///
/// Returns an error when pairing state cannot be read or written.
pub fn persist_association(name: &str, id_key_b64: &str) -> Result<Association, BridgeError> {
    let mut file = load_pairings(BRIDGE_NAME)?;
    let association = Association {
        id: allocate_id(&file, name),
        name: name.to_string(),
        id_key: id_key_b64.to_string(),
        created_at: now_unix().to_string(),
    };
    file.upsert(association.clone());
    save_pairings(BRIDGE_NAME, &file)?;
    Ok(association)
}

/// A stable, human-legible id that does not collide with an existing one.
#[must_use]
pub fn allocate_id(file: &PairingFile, name: &str) -> String {
    let base: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let base = if base.is_empty() {
        "opensesame".to_string()
    } else {
        base
    };
    if !file.associations.iter().any(|a| a.id == base) {
        return base;
    }
    for n in 2..1000u32 {
        let candidate = format!("{base}-{n}");
        if !file.associations.iter().any(|a| a.id == candidate) {
            return candidate;
        }
    }
    format!("{base}-{}", now_unix())
}

/// Does `(id, key)` name a stored association?
///
/// # Errors
///
/// Returns an error when pairing state cannot be read or parsed.
pub fn verify(id: &str, id_key_b64: &str) -> Result<Option<Association>, BridgeError> {
    Ok(load_pairings(BRIDGE_NAME)?.find(id, id_key_b64).cloned())
}

/// Does any of the `keys` the client offered name a stored association?
///
/// # Errors
///
/// Returns an error when pairing state cannot be read or parsed.
pub fn verify_any(keys: &[(String, String)]) -> Result<Option<Association>, BridgeError> {
    let file = load_pairings(BRIDGE_NAME)?;
    Ok(keys
        .iter()
        .find_map(|(id, key)| file.find(id, key))
        .cloned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window() -> (tempfile::TempDir, PairingWindow) {
        let dir = tempfile::tempdir().unwrap();
        let w = PairingWindow::at(dir.path().join("keepassxc-pairing.json"));
        (dir, w)
    }

    const KEY: &str = "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=";

    #[test]
    fn approval_is_denied_when_no_window_is_open() {
        let (_d, w) = window();
        assert_eq!(
            request_approval(&w, KEY, "firefox", |_| {}).unwrap(),
            Approval::Denied("no pairing window is open")
        );
    }

    #[test]
    fn approval_is_denied_after_the_window_expires() {
        let (_d, w) = window();
        w.open(0, 1).unwrap(); // expired long ago relative to now_unix()
        assert!(matches!(
            request_approval(&w, KEY, "firefox", |_| {}).unwrap(),
            Approval::Denied(_)
        ));
    }

    #[test]
    fn approval_is_granted_once_a_human_confirms() {
        let (_d, w) = window();
        w.open(now_unix(), 60).unwrap();
        let window_for_thread = w.clone();
        // Stand in for the human at the TTY: confirm on the first poll.
        let approval = request_approval(&w, KEY, "firefox", move |_| {
            let _ = window_for_thread.confirm(now_unix());
        })
        .unwrap();
        assert_eq!(
            approval,
            Approval::Granted {
                name: "firefox".into()
            }
        );
    }

    #[test]
    fn approval_is_denied_when_a_human_rejects() {
        let (_d, w) = window();
        w.open(now_unix(), 60).unwrap();
        let window_for_thread = w.clone();
        let approval = request_approval(&w, KEY, "firefox", move |_| {
            let _ = window_for_thread.reject();
        })
        .unwrap();
        assert_eq!(
            approval,
            Approval::Denied("the pairing request was rejected")
        );
    }

    #[test]
    fn a_racing_second_client_cannot_ride_an_open_request() {
        let (_d, w) = window();
        w.open(now_unix(), 60).unwrap();
        w.request(now_unix(), &key_fingerprint(KEY), "firefox")
            .unwrap();
        assert_eq!(
            request_approval(&w, "OTHER-KEY", "chrome", |_| {}).unwrap(),
            Approval::Denied("another pairing request is already pending")
        );
    }

    #[test]
    fn a_confirmation_for_a_different_fingerprint_is_refused() {
        let (dir, w) = window();
        w.open(now_unix(), 60).unwrap();
        let path = dir.path().join("keepassxc-pairing.json");
        let approval = request_approval(&w, KEY, "firefox", move |_| {
            // Simulate a confirmation recorded against someone else's key.
            std::fs::write(
                &path,
                serde_json::json!({
                    "state": "confirmed",
                    "expires_at": u64::MAX,
                    "fingerprint": "DEAD:BEEF:DEAD:BEEF",
                    "name": "impostor"
                })
                .to_string(),
            )
            .unwrap();
        })
        .unwrap();
        assert_eq!(
            approval,
            Approval::Denied("the confirmed fingerprint does not match")
        );
    }

    #[test]
    fn ids_are_sanitized_and_deduplicated() {
        let mut file = PairingFile::default();
        assert_eq!(allocate_id(&file, "Firefox (work)"), "Firefox--work");
        assert_eq!(allocate_id(&file, "!!!"), "opensesame");
        file.upsert(Association {
            id: "firefox".into(),
            name: "firefox".into(),
            id_key: KEY.into(),
            created_at: "0".into(),
        });
        assert_eq!(allocate_id(&file, "firefox"), "firefox-2");
    }

    #[test]
    fn persist_and_verify_round_trip() {
        crate::pairing::with_bridges_dir(|| {
            let association = persist_association("firefox", KEY).unwrap();
            assert_eq!(
                verify(&association.id, KEY).unwrap(),
                Some(association.clone())
            );
            assert_eq!(verify(&association.id, "other").unwrap(), None);
            assert_eq!(verify("nope", KEY).unwrap(), None);
            assert_eq!(
                verify_any(&[
                    ("nope".into(), "x".into()),
                    (association.id.clone(), KEY.into())
                ])
                .unwrap(),
                Some(association)
            );
            assert_eq!(verify_any(&[]).unwrap(), None);
        });
    }
}
