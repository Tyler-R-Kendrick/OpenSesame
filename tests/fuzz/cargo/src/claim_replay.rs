//! Exercise the public single-use claim verifier against its authoritative clock.

use crate::types::ClaimReplayInput;
use chrono::Utc;
use opensesame_claims::{assert_claim_token, complete_claim, hash_secret};
use opensesame_domain::{
    ActorId, ActorInstanceId, ClaimSession, ClaimSessionId, ClaimState, PrincipalId,
};
use uuid::Uuid;

pub fn fuzz_claim_replay(input: ClaimReplayInput) {
    let token = if input.token.is_empty() {
        "fuzz-claim-token".into()
    } else {
        input.token
    };
    // The public verifier reads its authoritative wall clock. Fuzz relative
    // lifetimes around that clock, then bracket the actual verification call.
    let before = Utc::now();
    let offset = input
        .expires_secs
        .saturating_sub(input.now_secs)
        .clamp(-3_600, 3_600);
    let expires = before + chrono::Duration::seconds(offset);
    let mut session = ClaimSession {
        id: ClaimSessionId::from_uuid(Uuid::from_u128(1)),
        organization_hint: None,
        project_hint: None,
        actor_id: ActorId::from_uuid(Uuid::from_u128(2)),
        actor_instance_id: ActorInstanceId::from_uuid(Uuid::from_u128(3)),
        client_id: None,
        operator_id: None,
        instance_public_key_jwk: serde_json::json!({"kty":"OKP"}),
        claim_token_hash: hash_secret(&token),
        user_code_hash: None,
        claim_attempt_token_hash: None,
        provider_assertion_digest: None,
        attestation_digest: None,
        requested_grant_digest: "sha256:x".into(),
        state: if input.start_claimed {
            ClaimState::Claimed
        } else {
            ClaimState::Pending
        },
        created_at: expires - chrono::Duration::seconds(600),
        expires_at: expires,
        claimed_at: None,
        claimed_by_principal_id: None,
        narrowed_actions: None,
    };
    let first = assert_claim_token(&session, &token);
    let after = Utc::now();
    if input.start_claimed {
        assert!(first.is_err(), "non-pending claim cannot be presented");
        return;
    }
    if before >= expires && after >= expires {
        assert!(first.is_err(), "expired claim cannot be presented");
        return;
    }
    if before < expires && after < expires {
        first.expect("fresh pending claim token must verify");
    } else if let Err(error) = first {
        // The deadline crossed within the observed verification interval.
        assert!(matches!(
            error,
            opensesame_domain::DomainError::GrantTimeWindow
        ));
        return;
    }
    complete_claim(
        &mut session,
        PrincipalId::from_uuid(Uuid::from_u128(4)),
        after,
    )
    .expect("pending → claimed");
    assert!(
        assert_claim_token(&session, &token).is_err(),
        "single-use claim must not verify after complete"
    );
}
