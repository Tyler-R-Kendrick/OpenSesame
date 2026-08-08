use chrono::{DateTime, Utc};
use opensesame_domain::{ClaimSession, ClaimState, DomainError};
use rand::{Rng, RngCore};
use sha2::{Digest, Sha256};

/// Digest for a *high-entropy* secret (32 random bytes: claim tokens, device
/// codes, session ids). A bare hash is enough there because the preimage space is
/// not searchable.
pub fn hash_secret(secret: &str) -> String {
    let mut h = Sha256::new();
    h.update(secret.as_bytes());
    format!("sha256:{:x}", h.finalize())
}

/// Domain separator for low-entropy digests.
const LOW_ENTROPY_PURPOSE: &str = "opensesame:low-entropy:v1";

/// Digest for a *low-entropy* secret such as a user code.
///
/// `generate_user_code` draws 8 characters from a 20-letter alphabet — about 2^35
/// possibilities, which an unsalted SHA-256 gives up almost immediately. Keying
/// the digest with a server-held pepper puts it out of reach, and binding the
/// context (claim or device id) means one recovered code says nothing about
/// any other.
pub fn hash_low_entropy(pepper: &str, context: &str, secret: &str) -> String {
    use hmac::{Mac, SimpleHmac};
    let mut mac = SimpleHmac::<Sha256>::new_from_slice(pepper.as_bytes())
        .expect("SimpleHmac accepts any key length");
    for part in [LOW_ENTROPY_PURPOSE, context, secret] {
        mac.update(&(part.len() as u32).to_be_bytes());
        mac.update(part.as_bytes());
    }
    format!("hmac-sha256:{:x}", mac.finalize().into_bytes())
}

/// Constant-time equality for `hash_secret` digests (and other equal-length hex strings).
pub fn hash_eq(a: &str, b: &str) -> bool {
    let (aa, bb) = (a.as_bytes(), b.as_bytes());
    if aa.len() != bb.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in aa.iter().zip(bb.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn generate_claim_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    data_encoding::BASE64URL_NOPAD.encode(&bytes)
}

pub fn generate_user_code() -> String {
    const ALPHA: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";
    let mut rng = rand::thread_rng();
    let mut chars = Vec::new();
    for _ in 0..8 {
        chars.push(ALPHA[rng.gen_range(0..ALPHA.len())] as char);
    }
    format!(
        "{}-{}",
        chars[..4].iter().collect::<String>(),
        chars[4..].iter().collect::<String>()
    )
}

pub fn assert_claim_token(session: &ClaimSession, presented: &str) -> Result<(), DomainError> {
    if session.state != ClaimState::Pending {
        return Err(DomainError::InvalidTransition {
            from: format!("{:?}", session.state),
            to: "claim".into(),
        });
    }
    if Utc::now() >= session.expires_at {
        return Err(DomainError::GrantTimeWindow);
    }
    if !hash_eq(&hash_secret(presented), &session.claim_token_hash) {
        return Err(DomainError::InvalidId("claim token".into()));
    }
    Ok(())
}

pub fn complete_claim(
    session: &mut ClaimSession,
    principal: opensesame_domain::PrincipalId,
    now: DateTime<Utc>,
) -> Result<(), DomainError> {
    if session.state != ClaimState::Pending {
        return Err(DomainError::InvalidTransition {
            from: format!("{:?}", session.state),
            to: "claimed".into(),
        });
    }
    session.state = ClaimState::Claimed;
    session.claimed_at = Some(now);
    session.claimed_by_principal_id = Some(principal);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use opensesame_domain::*;
    use serde_json::json;

    #[test]
    fn low_entropy_digests_are_keyed_and_bound() {
        let code = generate_user_code();
        let bound = hash_low_entropy("pepper", "clm_1", &code);

        // Not the keyless hash: ~2^35 codes are exhaustible against SHA-256.
        assert!(!hash_eq(&bound, &hash_secret(&code)));
        // Not reusable against another claim.
        assert!(!hash_eq(&bound, &hash_low_entropy("pepper", "clm_2", &code)));
        // Not reproducible without the pepper.
        assert!(!hash_eq(&bound, &hash_low_entropy("other", "clm_1", &code)));
        // Deterministic for the same inputs, and not the code itself.
        assert!(hash_eq(&bound, &hash_low_entropy("pepper", "clm_1", &code)));
        assert!(!bound.contains(&code.replace('-', "")));
    }

    #[test]
    fn user_codes_carry_the_expected_shape() {
        let code = generate_user_code();
        assert_eq!(code.len(), 9, "XXXX-XXXX");
        assert!(code
            .chars()
            .all(|c| c == '-' || "BCDFGHJKLMNPQRSTVWXZ".contains(c)));
    }

    fn pending_session(token: &str) -> ClaimSession {
        ClaimSession {
            id: ClaimSessionId::new(),
            organization_hint: None,
            project_hint: None,
            actor_id: ActorId::new(),
            actor_instance_id: ActorInstanceId::new(),
            client_id: None,
            operator_id: None,
            instance_public_key_jwk: json!({"kty":"OKP"}),
            claim_token_hash: hash_secret(token),
            user_code_hash: Some(hash_secret("ABCD-EFGH")),
            claim_attempt_token_hash: None,
            provider_assertion_digest: None,
            attestation_digest: None,
            requested_grant_digest: "sha256:x".into(),
            state: ClaimState::Pending,
            created_at: Utc::now(),
            expires_at: Utc::now() + Duration::minutes(10),
            claimed_at: None,
            claimed_by_principal_id: None,
        }
    }

    #[test]
    fn token_hash_not_reversible_equality() {
        let t = generate_claim_token();
        assert_ne!(hash_secret(&t), t);
        assert!(hash_secret(&t).starts_with("sha256:"));
        assert!(hash_eq(&hash_secret(&t), &hash_secret(&t)));
        assert!(!hash_eq(&hash_secret(&t), &hash_secret("other")));
    }

    #[test]
    fn wrong_token_rejected() {
        let s = pending_session("good");
        assert!(assert_claim_token(&s, "bad").is_err());
    }

    #[test]
    fn replay_after_complete_rejected() {
        let mut s = pending_session("tok");
        assert_claim_token(&s, "tok").unwrap();
        complete_claim(&mut s, PrincipalId::new(), Utc::now()).unwrap();
        assert!(assert_claim_token(&s, "tok").is_err());
        assert!(complete_claim(&mut s, PrincipalId::new(), Utc::now()).is_err());
    }

    #[test]
    fn expired_claim_rejected() {
        let mut s = pending_session("tok");
        s.expires_at = Utc::now() - Duration::seconds(1);
        assert_eq!(
            assert_claim_token(&s, "tok"),
            Err(DomainError::GrantTimeWindow)
        );
    }

    #[test]
    fn user_code_format() {
        let code = generate_user_code();
        let parts: Vec<_> = code.split('-').collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].len(), 4);
        assert_eq!(parts[1].len(), 4);
        assert!(code
            .chars()
            .filter(|c| *c != '-')
            .all(|c| "BCDFGHJKLMNPQRSTVWXZ".contains(c)));
    }
}
