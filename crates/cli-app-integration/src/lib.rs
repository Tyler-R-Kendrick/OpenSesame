//! CLI ↔ OpenSesame app integration (1Password-style terminal sessions).
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

const SOURCE: &str = include_str!("../../../spec/conformance/cli-app-integration.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
    idle_timeout_seconds: u64,
    messages: Messages,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Messages {
    app_unavailable: String,
    denied: String,
}

fn policy() -> &'static Policy {
    static POLICY: std::sync::OnceLock<Policy> = std::sync::OnceLock::new();
    POLICY.get_or_init(|| serde_json::from_str(SOURCE).expect("cli-app-integration.json"))
}

#[derive(Clone, Debug)]
struct ApprovedSession {
    last_activity_ms: u64,
}

#[derive(Clone, Debug)]
pub struct PendingRequest {
    pub request_id: String,
    pub terminal_session_id: String,
    pub verb: String,
}

/// In-memory integration state held by the daemon.
pub struct CliAppIntegrationStore {
    approved: HashMap<String, ApprovedSession>,
    pending: HashMap<String, PendingRequest>,
    denied: HashSet<String>,
    next_request: u64,
    now_ms: u64,
}

impl CliAppIntegrationStore {
    pub fn new() -> Self {
        Self {
            approved: HashMap::new(),
            pending: HashMap::new(),
            denied: HashSet::new(),
            next_request: 0,
            now_ms: 0,
        }
    }

    pub fn set_now_ms(&mut self, now_ms: u64) {
        self.now_ms = now_ms;
    }

    fn idle_expired(&self, session: &ApprovedSession) -> bool {
        let idle_ms = policy().idle_timeout_seconds * 1000;
        self.now_ms.saturating_sub(session.last_activity_ms) > idle_ms
    }

    fn expire_idle(&mut self) {
        let now_ms = self.now_ms;
        let idle_ms = policy().idle_timeout_seconds * 1000;
        self.approved.retain(|_, session| {
            now_ms.saturating_sub(session.last_activity_ms) <= idle_ms
        });
    }

    pub fn ensure(
        &mut self,
        terminal_session_id: &str,
        verb: &str,
        reference: Option<&str>,
    ) -> (String, Option<String>) {
        self.expire_idle();
        if self.denied.contains(terminal_session_id) {
            return ("denied".into(), None);
        }
        if let Some(session) = self.approved.get(terminal_session_id) {
            if self.idle_expired(session) {
                self.approved.remove(terminal_session_id);
            } else {
                let session = self.approved.get_mut(terminal_session_id).expect("session");
                session.last_activity_ms = self.now_ms;
                return ("approved".into(), None);
            }
        }
        for row in self.pending.values() {
            if row.terminal_session_id == terminal_session_id {
                return ("pending".into(), Some(row.request_id.clone()));
            }
        }
        self.next_request += 1;
        let request_id = format!("clr_{}", self.next_request);
        self.pending.insert(
            request_id.clone(),
            PendingRequest {
                request_id: request_id.clone(),
                terminal_session_id: terminal_session_id.to_string(),
                verb: verb.to_string(),
            },
        );
        let _ = reference;
        ("pending".into(), Some(request_id))
    }

    pub fn approve(&mut self, request_id: &str, terminal_session_id: &str) -> String {
        self.expire_idle();
        let Some(row) = self.pending.get(request_id) else {
            return "wrongSession".into();
        };
        if row.terminal_session_id != terminal_session_id {
            return "wrongSession".into();
        }
        self.pending.remove(request_id);
        self.denied.remove(terminal_session_id);
        self.approved.insert(
            terminal_session_id.to_string(),
            ApprovedSession {
                last_activity_ms: self.now_ms,
            },
        );
        "approved".into()
    }

    pub fn deny(&mut self, request_id: &str, terminal_session_id: &str) -> String {
        let Some(row) = self.pending.get(request_id) else {
            return "wrongSession".into();
        };
        if row.terminal_session_id != terminal_session_id {
            return "wrongSession".into();
        }
        self.pending.remove(request_id);
        self.denied.insert(terminal_session_id.to_string());
        self.approved.remove(terminal_session_id);
        "denied".into()
    }

    pub fn list_pending(&self) -> Vec<PendingRequest> {
        self.pending.values().cloned().collect()
    }
}

pub fn app_unavailable_message() -> &'static str {
    &policy().messages.app_unavailable
}

pub fn denied_message() -> &'static str {
    &policy().messages.denied
}

/// Test seam: `approve`, `deny`, or `unavailable`.
pub fn seam_decision() -> Option<&'static str> {
    match std::env::var("OPENSESAME_CLI_APP_INTEGRATION_SEAM")
        .ok()
        .as_deref()
    {
        Some("approve") => Some("approve"),
        Some("deny") => Some("deny"),
        Some("unavailable") => Some("unavailable"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SessionCase {
        id: String,
        terminal_session_id: String,
        other_terminal_session_id: Option<String>,
        action: String,
        idle_past_seconds: Option<u64>,
        query_as: Option<String>,
        expect_ensure: String,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        session_cases: Vec<SessionCase>,
    }

    #[test]
    fn conformance_session_cases() {
        let raw: Fixture = serde_json::from_str(SOURCE).unwrap();
        for case in raw.session_cases {
            let mut store = CliAppIntegrationStore::new();
            store.set_now_ms(1_000_000);
            let pending = store.ensure(&case.terminal_session_id, "read", None);
            assert_eq!(pending.0, "pending", "case {}", case.id);
            let request_id = pending.1.expect("request id");
            if case.action == "approve" {
                assert_eq!(
                    store.approve(&request_id, &case.terminal_session_id),
                    "approved"
                );
                if let Some(seconds) = case.idle_past_seconds {
                    store.set_now_ms(1_000_000 + seconds * 1000);
                }
                let query_id = if case.query_as.as_deref() == Some("other") {
                    case.other_terminal_session_id.as_deref().unwrap_or("missing")
                } else {
                    case.terminal_session_id.as_str()
                };
                let (status, _) = store.ensure(query_id, "read", None);
                assert_eq!(status, case.expect_ensure, "case {}", case.id);
            } else if case.action == "deny" {
                assert_eq!(
                    store.deny(&request_id, &case.terminal_session_id),
                    "denied"
                );
                let (status, _) = store.ensure(&case.terminal_session_id, "read", None);
                assert_eq!(status, "denied", "case {}", case.id);
            }
        }
    }
}
