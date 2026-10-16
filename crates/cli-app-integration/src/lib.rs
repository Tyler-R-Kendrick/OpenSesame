//! `CLI` ↔ `OpenSesame` app integration (1Password-style terminal sessions).
mod daemon_attest;
mod device_crypto;
mod headless_policy;
mod human_proof;
mod pairing;
mod pairing_code;
mod policy;
mod root_enroll;
mod root_trust;
mod terminal_session;
mod trust;
mod webauthn_assertion;

use human_proof::human_proof_verify;
#[cfg(test)]
use policy::SOURCE;
use policy::{policy, respond_nonce};

use rand_core::{OsRng, RngCore as _};
use std::collections::{HashMap, HashSet};

/// Pin-probe ensure must never appear in the human approval queue (D7-2 U7).
pub const DAEMON_PIN_PROBE_VERB: &str = "daemon-pin-probe";
use std::sync::{Arc, Mutex};

#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(test)]
static TEST_TCP_EPHEMERAL: AtomicU64 = AtomicU64::new(0);

pub use daemon_attest::{
    daemon_attest_public_key_spki_b64, daemon_integration_id, sign_daemon_attest,
    verify_daemon_attest,
};
#[cfg(any(test, feature = "test-seams"))]
pub use device_crypto::{pairing_confirm_message, verifying_key_spki_b64};
pub use headless_policy::{
    refuse_tty_enrollment_without_opt_in, tty_enrollment_explicitly_allowed,
};
#[cfg(any(test, feature = "test-seams"))]
pub use human_proof::{mint_pin_human_proof, mint_test_signing_key, HumanProofContext};
pub use pairing::{
    format_pairing_code, is_device_public_key_shaped, is_pairable_origin,
    CliAppIntegrationPairings, ConfirmOutcome, Issued, PairedBinding, PairingError,
    WebAuthnCredential, WebAuthnRegistration, CODE_TTL_SECS, MAX_PIN_PROOF_FAILURES,
    PAIRING_CODE_PREFIX,
};
pub use root_enroll::{
    generate_root_signing_key, root_spki_der, EnrollmentConfirm, RootEnrollBegin, RootEnrollClient,
    RootEnrollError, RootEnrollFinish, RootEnrollRequest, ROOT_ENROLL_BEGIN_PATH,
    ROOT_ENROLL_FINISH_PATH, ROOT_ENROLL_TTL_SECS,
};
pub use root_trust::{fingerprint_of_spki, RootTrustError, RootTrustRecord};
pub use terminal_session::{parse_linux_proc_stat, session_id_from_pid, stable_session_id};
pub use trust::{TrustAnchor, TrustStore, TRUST_STORE_VERSION};

/// Daemon-held integration state and browser pairings.
pub struct CliAppIntegrationHost {
    pub store: CliAppIntegrationStore,
    pub pairings: CliAppIntegrationPairings,
    pub trust: TrustStore,
    /// One pending PAKE enrollment. A new begin replaces it.
    root_enroll: root_enroll::Sessions,
    /// TCP peers (or test harness keys) bound to a daemon-issued terminal session id.
    tcp_terminal_sessions: HashMap<String, String>,
}

impl Default for CliAppIntegrationHost {
    fn default() -> Self {
        Self::new()
    }
}

impl CliAppIntegrationHost {
    #[must_use]
    pub fn new() -> Self {
        Self {
            store: CliAppIntegrationStore::new(),
            pairings: CliAppIntegrationPairings::default(),
            trust: TrustStore::new(),
            root_enroll: root_enroll::Sessions::default(),
            tcp_terminal_sessions: HashMap::new(),
        }
    }

    /// Wipe in-memory legacy pairings after a trust-store format upgrade.
    pub fn wipe_legacy_pairings_on_trust_upgrade(&mut self) {
        self.pairings = CliAppIntegrationPairings::default();
    }

    /// Issue or return the terminal session id for a non-UDS ensure (never trusts the client body).
    pub fn terminal_session_for_tcp(&mut self, peer_key: &str) -> (String, bool) {
        if let Some(existing) = self.tcp_terminal_sessions.get(peer_key) {
            return (existing.clone(), true);
        }
        let mut raw = [0u8; 16];
        OsRng.fill_bytes(&mut raw);
        let id = format!("term-tcp-{}", hex::encode(raw));
        self.tcp_terminal_sessions
            .insert(peer_key.to_string(), id.clone());
        (id, false)
    }

    #[cfg(test)]
    pub fn terminal_session_for_tcp_test_harness(&mut self) -> (String, bool) {
        let n = TEST_TCP_EPHEMERAL.fetch_add(1, Ordering::Relaxed);
        self.terminal_session_for_tcp(&format!("tcp:harness-{n}"))
    }
}

pub type SharedCliAppIntegration = Arc<Mutex<CliAppIntegrationHost>>;

#[must_use]
pub fn fresh_host() -> SharedCliAppIntegration {
    Arc::new(Mutex::new(CliAppIntegrationHost::new()))
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
    pub argv_hash: String,
    pub peer_pid: u32,
    pub peer_start_time: u64,
    /// Browser approval is only allowed for kernel-attested unix-socket peers.
    pub approvable: bool,
}

/// In-memory integration state held by the daemon.
pub struct CliAppIntegrationStore {
    approved: HashMap<String, ApprovedSession>,
    pending: HashMap<String, PendingRequest>,
    denied: HashSet<String>,
    next_request: u64,
    now_ms: u64,
}

impl Default for CliAppIntegrationStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CliAppIntegrationStore {
    #[must_use]
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

    fn resume_approved_session(
        &mut self,
        terminal_session_id: &str,
        reuse_approved_session: bool,
    ) -> Option<(String, Option<String>)> {
        let session = self.approved.get(terminal_session_id)?;
        if self.hard_expired(session) {
            self.approved.remove(terminal_session_id);
            return Some(("expired".into(), None));
        }
        if !reuse_approved_session {
            self.approved.remove(terminal_session_id);
            self.expire_idle();
            return Some(("approved".into(), None));
        }
        if self.idle_expired(session) {
            self.approved.remove(terminal_session_id);
            return None;
        }
        let session = self.approved.get_mut(terminal_session_id)?;
        session.last_activity_ms = self.now_ms;
        self.expire_idle();
        Some(("approved".into(), None))
    }

    fn refuse_ambiguous_pending(&mut self) {
        if self.pending.len() > 1 {
            self.pending.clear();
        }
    }

    pub fn ensure(
        &mut self,
        terminal_session_id: &str,
        verb: &str,
        reference: Option<&str>,
        reuse_approved_session: bool,
        argv_hash: &str,
        peer_pid: u32,
        peer_start_time: u64,
        approvable: bool,
    ) -> (String, Option<String>) {
        self.expire_pending();
        self.refuse_ambiguous_pending();
        if self.denied.contains(terminal_session_id) {
            return ("denied".into(), None);
        }
        if let Some(outcome) =
            self.resume_approved_session(terminal_session_id, reuse_approved_session)
        {
            return outcome;
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
                argv_hash: argv_hash.to_string(),
                peer_pid,
                peer_start_time,
                approvable,
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
        binding: &PairedBinding,
    ) -> (String, Option<u32>) {
        self.expire_idle();
        self.refuse_ambiguous_pending();
        let Some(row) = self.pending.get(request_id) else {
            return ("wrongSession".into(), None);
        };
        if row.terminal_session_id != terminal_session_id {
            return ("wrongSession".into(), None);
        }
        if row.respond_nonce != respond_nonce {
            return ("wrongSession".into(), None);
        }
        if !row.approvable {
            return ("wrongSession".into(), None);
        }
        let ctx = human_proof::HumanProofContext {
            daemon_id: daemon_integration_id(),
            request_id: request_id.to_string(),
            terminal_session_id: terminal_session_id.to_string(),
            respond_nonce: respond_nonce.to_string(),
            verb: row.verb.clone(),
            argv_hash: row.argv_hash.clone(),
            peer_pid: row.peer_pid,
            peer_start_time: row.peer_start_time,
        };
        let Some(outcome) = human_proof_verify(human_proof, binding, &ctx) else {
            return ("wrongSession".into(), None);
        };
        let passkey_sign_count = Some(outcome.into_sign_count());
        self.pending.remove(request_id);
        self.denied.remove(terminal_session_id);
        self.approved.insert(
            terminal_session_id.to_string(),
            ApprovedSession {
                approved_at_ms: self.now_ms,
                last_activity_ms: self.now_ms,
            },
        );
        ("approved".into(), passkey_sign_count)
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
        self.refuse_ambiguous_pending();
        self.pending
            .values()
            .filter(|row| row.verb != DAEMON_PIN_PROBE_VERB)
            .cloned()
            .collect()
    }
}

#[must_use]
pub fn app_unavailable_message() -> &'static str {
    &policy().messages.app_unavailable
}

#[must_use]
pub fn denied_message() -> &'static str {
    &policy().messages.denied
}

#[must_use]
pub fn expired_message() -> &'static str {
    &policy().messages.expired
}

#[must_use]
pub fn request_timeout_message() -> &'static str {
    &policy().messages.request_timeout
}

#[cfg(any(test, feature = "test-seams"))]
mod seams_test_only;

#[cfg(any(test, feature = "test-seams"))]
pub use seams_test_only::seam_decision;

#[cfg(test)]
mod store_conformance_tests;

#[cfg(test)]
mod security_tests;

#[cfg(any(test, feature = "test-seams"))]
pub mod test_support;
