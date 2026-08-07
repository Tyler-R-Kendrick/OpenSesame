use crate::jwk::{sign_dpop_proof, DpopClaims, DpopPublicJwk};
use crate::ProofError;
use jsonwebtoken::EncodingKey;
use opensesame_domain::{ProofPurpose, TaskRunId};
use serde::{Deserialize, Serialize};

/// Authorized binding for proof signing — prevents arbitrary agent signing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorizedProofRequest {
    pub purpose: ProofPurpose,
    pub task_run_id: TaskRunId,
    pub task_state_digest: String,
    pub intent_digest: Option<String>,
    pub htm: String,
    pub htu: String,
    pub access_token_hash: Option<String>,
}

impl AuthorizedProofRequest {
    pub fn binding_digest(&self) -> Result<String, ProofError> {
        let value = serde_json::json!({
            "purpose": self.purpose,
            "task_run_id": self.task_run_id,
            "task_state_digest": self.task_state_digest,
            "intent_digest": self.intent_digest,
            "htm": self.htm,
            "htu": self.htu,
            "access_token_hash": self.access_token_hash,
        });
        Ok(opensesame_domain::digest_json(&value)?)
    }
}

/// Key custody — only signs proofs for explicitly authorized requests.
pub trait KeyCustodyProvider: Send + Sync {
    fn sign_dpop(&self, request: &AuthorizedProofRequest) -> Result<String, ProofError>;
    fn public_jwk(&self) -> DpopPublicJwk;
    fn jkt(&self) -> Result<String, ProofError>;
}

/// Software key custody with authorized-request binding (no signing oracle).
pub struct LocalSoftwareKeyCustodyProvider {
    jwk: DpopPublicJwk,
    encoding_key: EncodingKey,
    jkt: String,
    /// Last authorized binding digest accepted for signing.
    authorized_binding: std::sync::Mutex<Option<String>>,
}

impl LocalSoftwareKeyCustodyProvider {
    pub fn generate_ed25519() -> Result<Self, ProofError> {
        let mut seed = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut seed);
        Self::from_ed25519_seed(seed)
    }

    pub fn from_ed25519_seed(seed: [u8; 32]) -> Result<Self, ProofError> {
        let (jwk, encoding_key) = crate::jwk::ed25519_jwk_from_seed(&seed);
        let jkt = crate::jwk::jwk_thumbprint(&jwk)?;
        Ok(Self {
            jwk,
            encoding_key,
            jkt,
            authorized_binding: std::sync::Mutex::new(None),
        })
    }

    /// Authorize exactly one signing request binding.
    pub fn authorize(&self, request: &AuthorizedProofRequest) -> Result<(), ProofError> {
        if request.task_state_digest.is_empty() {
            return Err(ProofError::UnauthorizedProofRequest(
                "task_state_digest required".into(),
            ));
        }
        if request.purpose != ProofPurpose::ResourceAccess
            && request.purpose != ProofPurpose::IntentAttestation
        {
            return Err(ProofError::UnauthorizedProofRequest(format!(
                "purpose {:?} not allowed for local signing",
                request.purpose
            )));
        }
        if request.purpose == ProofPurpose::IntentAttestation && request.intent_digest.is_none() {
            return Err(ProofError::UnauthorizedProofRequest(
                "intent_digest required for intent attestation".into(),
            ));
        }
        let digest = request.binding_digest()?;
        let mut guard = self
            .authorized_binding
            .lock()
            .map_err(|_| ProofError::SigningOracleMismatch("lock poisoned".into()))?;
        *guard = Some(digest);
        Ok(())
    }

    fn take_authorized_binding(&self) -> Result<String, ProofError> {
        let mut guard = self
            .authorized_binding
            .lock()
            .map_err(|_| ProofError::SigningOracleMismatch("lock poisoned".into()))?;
        guard
            .take()
            .ok_or_else(|| ProofError::UnauthorizedProofRequest("not authorized".into()))
    }
}

impl KeyCustodyProvider for LocalSoftwareKeyCustodyProvider {
    fn sign_dpop(&self, request: &AuthorizedProofRequest) -> Result<String, ProofError> {
        let expected = self.take_authorized_binding()?;
        let actual = request.binding_digest()?;
        if expected != actual {
            return Err(ProofError::SigningOracleMismatch(
                "request binding does not match authorization".into(),
            ));
        }

        let now = chrono::Utc::now().timestamp();
        let jti = uuid::Uuid::now_v7().to_string();
        let claims = DpopClaims {
            jti,
            htm: request.htm.clone(),
            htu: request.htu.clone(),
            iat: now,
            ath: request.access_token_hash.clone(),
        };
        sign_dpop_proof(&self.jwk, &self.encoding_key, &claims)
    }

    fn public_jwk(&self) -> DpopPublicJwk {
        self.jwk.clone()
    }

    fn jkt(&self) -> Result<String, ProofError> {
        Ok(self.jkt.clone())
    }
}
