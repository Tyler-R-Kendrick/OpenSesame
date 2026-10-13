//! CLI ↔ OpenSesame app integration (1Password-style terminal sessions).
mod human_proof;
mod pairing;
mod terminal_session;

use human_proof::human_proof_valid;

use rand_core::{OsRng, RngCore as _};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

pub use pairing::{
    format_pairing_code, is_pairable_origin, CliAppIntegrationPairings, Issued, PairingError,
    CODE_TTL_SECS, PAIRING_CODE_PREFIX,
};
pub use terminal_session::{parse_linux_proc_stat, session_id_from_pid, stable_session_id};

/// Daemon-held integration state and browser pairings.
pub struct CliAppIntegrationHost {
    pub store: CliAppIntegrationStore,
    pub pairings: CliAppIntegrationPairings,
}

impl CliAppIntegrationHost {
    #[must_use]
    pub fn new() -> Self {
        Self {
            store: CliAppIntegrationStore::new(),
            pairings: CliAppIntegrationPairings::default(),
        }
    }
}

pub type SharedCliAppIntegration = Arc<Mutex<CliAppIntegrationHost>>;

#[must_use]
pub fn fresh_host() -> SharedCliAppIntegration {
    Arc::new(Mutex::new(CliAppIntegrationHost::new()))
}

fn respond_nonce() -> String {
    let mut raw = [0u8; 16];
    OsRng.fill_bytes(&mut raw);
    hex::encode(raw)
}

const SOURCE: &str = include_str!("../../../spec/conformance/cli-app-integration.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
    idle_timeout_seconds: u64,
    hard_limit_seconds: u64,
    request_timeout_seconds: u64,
    messages: Messages,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Messages {
    app_unavailable: String,
    denied: String,
    expired: String,
    request_timeout: String,
}

fn policy() -> &'static Policy {
    static POLICY: std::sync::OnceLock<Policy> = std::sync::OnceLock::new();
    POLICY.get_or_init(|| serde_json::from_str(SOURCE).expect("cli-app-integration.json"))
}

#[derive(Clone, Debug)]
struct ApprovedSession {
    approved_at_ms: u64,
    last_activity_ms: u64,
}

#[derive(Clone, Debug)]
pub struct PendingRequest {
    pub request_id: String,
    pub terminal_session_id: String,
    pub verb: String,
    pub reference: Option<String>,
    pub created_at_ms: u64,
    pub respond_nonce: String,
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

    fn hard_expired(&self, session: &ApprovedSession) -> bool {
        let hard_ms = policy().hard_limit_seconds * 1000;
        self.now_ms.saturating_sub(session.approved_at_ms) > hard_ms
    }

    fn expire_idle(&mut self) {
        let now_ms = self.now_ms;
        let idle_ms = policy().idle_timeout_seconds * 1000;
        let hard_ms = policy().hard_limit_seconds * 1000;
        self.approved.retain(|_, session| {
            now_ms.saturating_sub(session.last_activity_ms) <= idle_ms
                && now_ms.saturating_sub(session.approved_at_ms) <= hard_ms
        });
    }

    fn expire_pending(&mut self) {
        let ttl_ms = policy().request_timeout_seconds * 1000;
        self.pending
            .retain(|_, row| self.now_ms.saturating_sub(row.created_at_ms) <= ttl_ms);
    }

    pub fn ensure(
        &mut self,
        terminal_session_id: &str,
        verb: &str,
        reference: Option<&str>,
        reuse_approved_session: bool,
    ) -> (String, Option<String>) {
        self.expire_pending();
        if self.denied.contains(terminal_session_id) {
            return ("denied".into(), None);
        }
        if let Some(session) = self.approved.get(terminal_session_id) {
            if self.hard_expired(session) {
                self.approved.remove(terminal_session_id);
                return ("expired".into(), None);
            }
            if reuse_approved_session {
                if self.idle_expired(session) {
                    self.approved.remove(terminal_session_id);
                } else {
                    let session = self.approved.get_mut(terminal_session_id).expect("session");
                    session.last_activity_ms = self.now_ms;
                    self.expire_idle();
                    return ("approved".into(), None);
                }
            } else {
                self.approved.remove(terminal_session_id);
                self.expire_idle();
                return ("approved".into(), None);
            }
        }
        self.expire_idle();
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
                reference: reference.map(str::to_string),
                created_at_ms: self.now_ms,
                respond_nonce: respond_nonce(),
            },
        );
        ("pending".into(), Some(request_id))
    }

    pub fn approve(
        &mut self,
        request_id: &str,
        terminal_session_id: &str,
        respond_nonce: &str,
        human_proof: &str,
    ) -> String {
        self.expire_idle();
        let Some(row) = self.pending.get(request_id) else {
            return "wrongSession".into();
        };
        if row.terminal_session_id != terminal_session_id {
            return "wrongSession".into();
        }
        if row.respond_nonce != respond_nonce {
            return "wrongSession".into();
        }
        if !human_proof_valid(human_proof) {
            return "wrongSession".into();
        }
        self.pending.remove(request_id);
        self.denied.remove(terminal_session_id);
        self.approved.insert(
            terminal_session_id.to_string(),
            ApprovedSession {
                approved_at_ms: self.now_ms,
                last_activity_ms: self.now_ms,
            },
        );
        "approved".into()
    }

    pub fn deny(
        &mut self,
        request_id: &str,
        terminal_session_id: &str,
        respond_nonce: &str,
    ) -> String {
        let Some(row) = self.pending.get(request_id) else {
            return "wrongSession".into();
        };
        if row.terminal_session_id != terminal_session_id {
            return "wrongSession".into();
        }
        if row.respond_nonce != respond_nonce {
            return "wrongSession".into();
        }
        self.pending.remove(request_id);
        self.denied.insert(terminal_session_id.to_string());
        self.approved.remove(terminal_session_id);
        "denied".into()
    }

    pub fn list_pending(&mut self) -> Vec<PendingRequest> {
        self.expire_pending();
        self.pending.values().cloned().collect()
    }
}

pub fn app_unavailable_message() -> &'static str {
    &policy().messages.app_unavailable
}

pub fn denied_message() -> &'static str {
    &policy().messages.denied
}

pub fn expired_message() -> &'static str {
    &policy().messages.expired
}

pub fn request_timeout_message() -> &'static str {
    &policy().messages.request_timeout
}

#[cfg(any(test, feature = "test-seams"))]
mod seams_test_only;

#[cfg(any(test, feature = "test-seams"))]
pub use seams_test_only::seam_decision;

#[cfg(test)]
mod store_conformance_tests;
