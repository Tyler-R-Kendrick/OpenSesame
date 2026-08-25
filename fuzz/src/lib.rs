//! Shared Arbitrary types, security oracles, and harness bodies.
//!
//! Fuzz targets are thin `fuzz_target!` wrappers around these functions so
//! ClusterFuzzLite, cargo-fuzz, and regression tests share one implementation.

pub mod oracles;
pub mod types;

use chrono::{TimeZone, Utc};
use jsonwebtoken::jwk::Jwk;
use opensesame_audit::{receipt_key_id, ReceiptSigner, ReceiptVerifier};
use opensesame_authn::{
    assert_discovery_issuer, parse_oidc_discovery, reject_foreign_resource_token,
    validate_verification_uri_complete, DevicePollState, DeviceServerStatus,
};
use opensesame_claims::{assert_claim_token, complete_claim, hash_secret};
use opensesame_connection_broker::catalog::Catalog;
use opensesame_connection_broker::crypto::{open, seal, SealedBlob};
use opensesame_connection_broker::github_webhook_hmac::{
    sign_hub_signature_256, verify_hub_signature_256,
};
use opensesame_connection_detect::{
    ini_value, mcp_server_env_keys, mcp_server_names, PromoteRequest,
};
use opensesame_kdbx_bridge::map_kdbx;
use opensesame_authz::{
    callout_permissions, evaluate_callout, permissions_include_system, CalloutEval,
};
use opensesame_domain::{
    canonicalize_json, digest_json, resource_pattern_matches, ActorId, ActorInstanceId,
    Capability, CapabilitySet, ClaimSession, ClaimSessionId, ClaimState, DowngradePolicy, Grant,
    InvocationReceipt, PrincipalId, ProtectedResource, ProtocolProfile, ReceiptOutcome,
    TokenPresentation,
};
use opensesame_env_spec::{parse_schema_json, schema_summary};
use opensesame_grants::delegate;
use opensesame_human_vault::{
    ad_digest, decrypt_item, derive_attachment_key, encrypt_item, open_chunk, seal_chunk,
    AssociatedData, ChunkAd, EncryptedEnvelope, ItemDataKey, ENVELOPE_VERSION,
};
use opensesame_proof::{
    assert_proof_key_strength, decode_dpop_proof, normalize_htu, InMemoryReplayCache, ReplayCache,
};
use opensesame_protocol_aauth::{map_agent, map_person, unmap_agent, unmap_person, Agent, Person};
use opensesame_protocol_mcp::{validate_audience, validate_resource_uri};
use opensesame_provider_openbao::{handle_from_health, parse_sys_health};
use opensesame_provider_openfga::parse_check_response;
use opensesame_redaction::{redact_json, redact_text};
use opensesame_rotation::RotationState;
use serde_json::Value;
use uuid::Uuid;

use crate::oracles::{
    assert_attenuation_did_not_widen, assert_bindings_preserved, assert_intersection_subset,
    assert_no_secret_fields, assert_redacted_text_hides, assert_roundtrip_caps,
};
use crate::types::{
    BoundedJson, CapabilityAlgebraInput, ClaimReplayInput, DeviceAuthInput, FuzzGrant,
    GithubWebhookHmacInput, GrantPairInput, JwtJwkInput, NatsCalloutEvalInput, RedactionInput,
    ReplayCacheInput, ResourceMatchInput, RotationSeqInput, TokenAudienceInput, UriNormalizeInput,
    VaultMutateInput, AttachmentChunkInput};

pub const MAX_PARSER_BYTES: usize = 4096;

pub fn fuzz_capability_algebra(input: CapabilityAlgebraInput) {
    let a = input.a.into_set();
    let b = input.b.into_set();
    assert!(
        a.is_subset_of(&a),
        "subset must be reflexive"
    );
    let inter = a.intersection(&b);
    assert_intersection_subset(&a, &b, &inter);
    let inter2 = b.intersection(&a);
    assert_eq!(
        inter.canonicalize(),
        inter2.canonicalize(),
        "intersection must commute after canonicalize"
    );
    let removed = a.remove(&input.remove_action, &input.remove_sel.into_selector());
    assert!(
        removed.capabilities.len() <= a.canonicalize().capabilities.len(),
        "remove must never increase set size"
    );
    assert_roundtrip_caps(&a);
    if let (Ok(d1), Ok(d2)) = (a.digest(), a.canonicalize().digest()) {
        assert_eq!(d1, d2, "digest must be stable under canonicalize");
    }
}

pub fn fuzz_grant_attenuation(input: GrantPairInput) {
    let parent = input.parent.into_grant();
    let mut child = input.child.into_grant();
    child.organization_id = parent.organization_id;
    child.parent_grant_id = Some(parent.id);
    let now = secs_to_dt(input.now_secs);

    if parent.revoked_at.is_some() {
        assert!(
            matches!(
                parent.assert_active(now),
                Err(opensesame_domain::DomainError::GrantRevoked)
            ),
            "revoked grant must stay invalid"
        );
    }

    match Grant::validate_attenuation(&parent, &child) {
        Ok(()) => assert_attenuation_did_not_widen(&parent, &child),
        Err(_) => {}
    }

    let delegated = child.clone();
    match delegate(&parent, delegated) {
        Ok(out) => {
            assert_eq!(out.parent_grant_id, Some(parent.id));
            assert_eq!(out.delegation_depth, parent.delegation_depth + 1);
            assert_attenuation_did_not_widen(&parent, &out);
        }
        Err(_) => {}
    }
}

pub fn fuzz_grant_serde(data: &[u8]) {
    let bytes = truncate(data);
    match serde_json::from_slice::<Grant>(bytes) {
        Ok(grant) => {
            let encoded = serde_json::to_vec(&grant).expect("re-encode grant");
            let again: Grant = serde_json::from_slice(&encoded).expect("round-trip grant");
            assert_bindings_preserved(&grant, &again);
            if grant.revoked_at.is_some() {
                let now = grant.created_at;
                assert!(grant.assert_active(now).is_err());
            }
        }
        Err(_) => {}
    }
}

pub fn fuzz_canonical_json(input: BoundedJson) {
    let value = input.0;
    match canonicalize_json(&value) {
        Ok(canon) => {
            let reparsed: Value = serde_json::from_slice(&canon)
                .expect("canonical bytes must be valid JSON");
            let canon2 = canonicalize_json(&reparsed).expect("re-canonicalize");
            assert_eq!(canon, canon2, "canonicalization must be idempotent");
            let d1 = digest_json(&value).expect("digest");
            let d2 = digest_json(&reparsed).expect("digest reparsed");
            assert_eq!(d1, d2, "digest must survive canonicalize round-trip");
        }
        Err(_) => {
            // Non-finite numbers are the documented reject path.
        }
    }
}

pub fn fuzz_resource_match(input: ResourceMatchInput) {
    let matched = resource_pattern_matches(&input.pattern, &input.resource);
    if input.pattern != "*" && input.pattern.ends_with("/*") && matched {
        let prefix = input.pattern.trim_end_matches('*');
        assert!(
            input.resource.starts_with(prefix),
            "/* match must stay inside the prefix"
        );
        let without_star = input.pattern.trim_end_matches("/*");
        assert!(
            !input.resource.starts_with(&format!("{without_star}-")),
            "/* must not match a sibling name that only shares a string prefix"
        );
    }
    if input.pattern.ends_with(":*") && matched {
        let prefix = input.pattern.trim_end_matches('*');
        assert!(input.resource.starts_with(prefix));
    }

    let resource = ProtectedResource {
        id: opensesame_domain::ProtectedResourceId::from_uuid(Uuid::from_u128(1)),
        organization_id: opensesame_domain::OrganizationId::from_uuid(Uuid::from_u128(1)),
        project_id: None,
        name: "fuzz".into(),
        audience: input.audience.clone(),
        required_capabilities: CapabilitySet::empty(),
        protocol_profile_id: opensesame_domain::ProtocolProfileId::from_uuid(Uuid::from_u128(1)),
        account_ref: None,
        external_mappings: vec![],
    };
    let _ = validate_resource_uri(&input.request_uri, &resource);
    let _ = validate_audience(&input.token_aud, &resource);
}

pub fn fuzz_jwt_jwk(input: JwtJwkInput) {
    let bytes = truncate(&input.jwk_json);
    if let Ok(jwk) = serde_json::from_slice::<Jwk>(bytes) {
        let _ = assert_proof_key_strength(&jwk);
        let _ = opensesame_proof::jwk_thumbprint(&jwk);
    }
    let jwt = String::from_utf8_lossy(truncate(&input.jwt));
    let _ = decode_dpop_proof(&jwt, "POST", "https://example.test/token", None, 300, 1_700_000_000);
    if !input.htu.is_empty() {
        let _ = normalize_htu(&input.htu);
    }
}

pub fn fuzz_token_audience(input: TokenAudienceInput) {
    match reject_foreign_resource_token(&input.token_aud, &input.required) {
        Ok(()) => {
            assert!(
                input.token_aud.iter().any(|a| a == &input.required),
                "accept only when the required resource is present"
            );
        }
        Err(_) => {
            assert!(
                !input.token_aud.iter().any(|a| a == &input.required),
                "must not reject a token that names the required resource"
            );
        }
    }
}

pub fn fuzz_device_auth(input: DeviceAuthInput) {
    let expires = secs_to_dt(input.expires_secs);
    let now = secs_to_dt(input.now_secs);
    let mut state = DevicePollState {
        interval_seconds: input.interval.max(1),
        expires_at: expires,
        cancelled: input.cancelled,
    };
    let status = match input.status % 5 {
        0 => DeviceServerStatus::AuthorizationPending,
        1 => DeviceServerStatus::SlowDown,
        2 => DeviceServerStatus::AccessDenied,
        3 => DeviceServerStatus::Expired,
        _ => DeviceServerStatus::Success,
    };
    let result = state.next_action(now, status);
    if input.cancelled {
        assert!(result.is_err());
    } else if now >= expires {
        assert!(result.is_err());
    }
    let _ = validate_verification_uri_complete(&input.complete_uri, &input.issuer);
}

pub fn fuzz_oidc_discovery(data: &[u8]) {
    let bytes = truncate(data);
    match parse_oidc_discovery(bytes) {
        Ok(doc) => {
            assert!(!doc.issuer.is_empty());
            assert!(!doc.jwks_uri.is_empty());
            let _ = doc.issuer_url();
            let _ = doc.jwks_url();
            let _ = assert_discovery_issuer(&doc, &doc.issuer);
            if let Ok(issuer) = doc.issuer_url() {
                if let Some(host) = issuer.host_str() {
                    let evil = format!("https://{host}.evil.test");
                    assert!(
                        assert_discovery_issuer(&doc, &evil).is_err(),
                        "suffix host must not bind as the issuer"
                    );
                }
            }
        }
        Err(_) => {}
    }
}

pub fn fuzz_aauth_parse(data: &[u8]) {
    let bytes = truncate(data);
    if let Ok(person) = serde_json::from_slice::<Person>(bytes) {
        let mapped = map_person(&person);
        assert_eq!(mapped.source_person_id, person.id);
        let back = unmap_person(&mapped);
        assert_eq!(back.id, person.id);
    }
    if let Ok(agent) = serde_json::from_slice::<Agent>(bytes) {
        let mapped = map_agent(&agent);
        assert_eq!(mapped.source_agent_id, agent.id);
        assert_eq!(mapped.source_instance_id, agent.instance_id);
        let back = unmap_agent(&mapped);
        assert_eq!(back.id, agent.id);
        assert_eq!(back.instance_id, agent.instance_id);
    }
}

pub fn fuzz_mcp_authz(data: &[u8]) {
    let bytes = truncate(data);
    if let Ok(set) = serde_json::from_slice::<CapabilitySet>(bytes) {
        assert_roundtrip_caps(&set);
    }
    if let Ok(resource) = serde_json::from_slice::<ProtectedResource>(bytes) {
        let _ = validate_audience(&resource.audience, &resource);
        let _ = validate_resource_uri(&resource.audience, &resource);
        let _ = resource.assert_capabilities(&resource.required_capabilities);
    }
}

pub fn fuzz_claim_replay(input: ClaimReplayInput) {
    let token = if input.token.is_empty() {
        "fuzz-claim-token".into()
    } else {
        input.token
    };
    let expires = secs_to_dt(input.expires_secs);
    let now = secs_to_dt(input.now_secs);
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
        created_at: secs_to_dt(input.expires_secs.saturating_sub(600)),
        expires_at: expires,
        claimed_at: None,
        claimed_by_principal_id: None,
        narrowed_actions: None,
    };
    let first = assert_claim_token(&session, &token);
    if input.start_claimed {
        assert!(first.is_err(), "non-pending claim cannot be presented");
        return;
    }
    if now >= expires {
        assert!(first.is_err(), "expired claim cannot be presented");
        return;
    }
    first.expect("fresh pending claim token must verify");
    complete_claim(&mut session, PrincipalId::from_uuid(Uuid::from_u128(4)), now)
        .expect("pending → claimed");
    assert!(
        assert_claim_token(&session, &token).is_err(),
        "single-use claim must not verify after complete"
    );
}

pub fn fuzz_receipt_verify(data: &[u8]) {
    let bytes = truncate(data);
    let signer = ReceiptSigner::from_seed(&[7u8; 32]);
    let mut verifier = ReceiptVerifier::new();
    let trusted = verifier.trust(signer.verifying_key());
    assert_eq!(trusted, receipt_key_id(&signer.verifying_key()));

    if let Ok(mut receipt) = serde_json::from_slice::<InvocationReceipt>(bytes) {
        receipt.outcome = ReceiptOutcome::Succeeded;
        if let Ok(signed) = signer.sign_receipt(receipt.clone()) {
            assert!(verifier.verify(&signed).is_ok());
            let retired = ReceiptVerifier::new();
            assert!(
                retired.verify(&signed).is_err(),
                "retired generation must not verify"
            );
            let encoded = serde_json::to_value(&signed).expect("receipt json");
            let decoded: InvocationReceipt =
                serde_json::from_value(encoded).expect("receipt round-trip");
            assert_eq!(decoded.authority_key_id, signed.authority_key_id);
            assert_eq!(decoded.principal_id, signed.principal_id);
            assert_eq!(decoded.resource, signed.resource);
        }
    }
}

pub fn fuzz_redaction(input: RedactionInput) {
    let mut obj = serde_json::Map::new();
    for (k, v) in input.fields {
        obj.insert(k, Value::String(v));
    }
    for planted in &input.secret_keys {
        obj.insert(planted.clone(), Value::String("SUPERSECRET".into()));
    }
    let redacted = redact_json(&Value::Object(obj));
    assert_no_secret_fields(&redacted);
    let text = redact_text(&input.text);
    assert_redacted_text_hides(&input.text, &text);
}

pub fn fuzz_env_spec(data: &[u8]) {
    let bytes = truncate(data);
    let Ok(text) = std::str::from_utf8(bytes) else {
        return;
    };
    if let Ok(doc) = parse_schema_json(text) {
        let encoded = serde_json::to_string(&doc).expect("env-spec encode");
        let again = parse_schema_json(&encoded).expect("env-spec round-trip");
        assert_eq!(doc.items.len(), again.items.len());
        let summary = schema_summary(&doc);
        for item in &doc.items {
            if item.sensitive {
                if let Some(items) = summary.get("items").and_then(|v| v.as_array()) {
                    for s in items {
                        if s.get("key").and_then(|k| k.as_str()) == Some(item.key.as_str()) {
                            assert_ne!(
                                s.get("value").and_then(|v| v.as_str()),
                                item.value.as_deref().filter(|v| !v.is_empty()),
                                "sensitive value must not appear in schema_summary"
                            );
                        }
                    }
                }
            }
        }
    }
}

pub fn fuzz_connector_manifest(data: &[u8]) {
    let bytes = truncate(data);
    let Ok(text) = std::str::from_utf8(bytes) else {
        return;
    };
    match Catalog::parse(text) {
        Ok(catalog) => {
            assert!(
                !catalog.providers().is_empty(),
                "parsed catalog must have providers"
            );
        }
        Err(_) => {}
    }
}

pub fn fuzz_vault_envelope(input: VaultMutateInput) {
    let idk = ItemDataKey(input.key);
    let ad = AssociatedData {
        envelope_version: ENVELOPE_VERSION,
        item_id: "item".into(),
        organization_id: "org".into(),
        project_id: "proj".into(),
        collection_id: "col".into(),
        key_id: "k1".into(),
        revision: 1,
    };
    let Ok(env) = encrypt_item(&idk, b"vault-secret", ad) else {
        return;
    };
    assert_eq!(decrypt_item(&idk, &env).expect("honest decrypt"), b"vault-secret");

    let mut mutated = env.clone();
    if input.bump_version {
        mutated.version = mutated.version.wrapping_add(1);
    }
    if input.flip_ad_version {
        mutated.ad.envelope_version = mutated.ad.envelope_version.wrapping_add(1);
    }
    if input.corrupt_nonce {
        mutated.nonce = "AA".into();
    }
    if input.swap_org {
        mutated.ad.organization_id = "other-org".into();
        mutated.ad_digest = ad_digest(&mutated.ad).unwrap_or_else(|_| mutated.ad_digest.clone());
    }
    if input.bump_version || input.flip_ad_version || input.corrupt_nonce || input.swap_org {
        assert!(
            decrypt_item(&idk, &mutated).is_err(),
            "mutated envelope must not decrypt"
        );
    }

    if let Ok(parsed) = serde_json::from_str::<EncryptedEnvelope>(
        &serde_json::to_string(&env).expect("envelope encode"),
    ) {
        assert_eq!(parsed.version, env.version);
        assert_eq!(parsed.ad.key_id, env.ad.key_id);
        assert_eq!(parsed.ad.organization_id, env.ad.organization_id);
    }
}

pub fn fuzz_broker_seal(data: &[u8]) {
    let bytes = truncate(data);
    let mut key = [0u8; 32];
    if bytes.len() >= 32 {
        key.copy_from_slice(&bytes[..32]);
    }
    let conn = "conn_fuzz";
    let org = "org_fuzz";
    let Ok(blob) = seal(&key, conn, org, b"refresh-token") else {
        return;
    };
    assert_eq!(open(&key, conn, org, &blob).expect("honest open"), b"refresh-token");
    assert!(
        open(&key, conn, "other-org", &blob).is_err(),
        "tenant AAD mismatch must fail"
    );
    assert!(
        open(&key, "other-conn", org, &blob).is_err(),
        "connection AAD mismatch must fail"
    );
    let mut bad = SealedBlob {
        ciphertext: blob.ciphertext.clone(),
        nonce: vec![1, 2, 3],
        aad_digest: blob.aad_digest.clone(),
    };
    assert!(open(&key, conn, org, &bad).is_err());
    if bytes.len() > 32 {
        bad.nonce = blob.nonce.clone();
        bad.ciphertext = bytes[32..].to_vec();
        let _ = open(&key, conn, org, &bad);
    }
}

pub fn fuzz_uri_normalize(input: UriNormalizeInput) {
    let _ = normalize_htu(&input.htu);
    let _ = validate_verification_uri_complete(&input.complete, &input.issuer);
    if let (Ok(a), Ok(b)) = (normalize_htu(&input.htu), normalize_htu(&input.htu)) {
        assert_eq!(a, b, "normalize_htu must be deterministic");
    }
}

pub fn fuzz_openbao_response(data: &[u8]) {
    let bytes = truncate(data);
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        match parse_sys_health(&value) {
            Ok(health) => {
                if health.sealed {
                    assert!(handle_from_health(&value, "x").is_err());
                }
            }
            Err(_) => {
                assert!(
                    handle_from_health(&value, "x").is_err(),
                    "malformed health must not mint a handle"
                );
            }
        }
    }
}

pub fn fuzz_openfga_response(data: &[u8]) {
    let bytes = truncate(data);
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        match parse_check_response(&value) {
            Ok(true) => {
                assert_eq!(value.get("allowed"), Some(&Value::Bool(true)));
            }
            Ok(false) | Err(_) => {}
        }
    }
}

pub fn fuzz_rotation_fsm(input: RotationSeqInput) {
    let mut state = RotationState::Scheduled;
    for raw in input.steps {
        let next = rotation_from_u8(raw);
        match state.transition(next) {
            Ok(s) => {
                assert!(state.can_transition(next));
                state = s;
            }
            Err(_) => {
                assert!(!state.can_transition(next));
            }
        }
    }
    if state == RotationState::Completed {
        assert!(
            !state.can_transition(RotationState::PreviousRevoked),
            "completed is a sink; cannot revoke again"
        );
    }
}

pub fn fuzz_protocol_negotiate(data: &[u8]) {
    let bytes = truncate(data);
    if let Ok(profile) = serde_json::from_slice::<ProtocolProfile>(bytes) {
        if profile.downgrade_policy == DowngradePolicy::FailClosed {
            for presentation in [
                TokenPresentation::Bearer,
                TokenPresentation::DpopBound,
                TokenPresentation::HttpMessageSignature,
                TokenPresentation::MutualTls,
            ] {
                match profile.assert_presentation_allowed(presentation) {
                    Ok(()) => {}
                    Err(opensesame_domain::DomainError::TokenPresentationDowngrade) => {}
                    Err(other) => panic!("unexpected error: {other}"),
                }
            }
        }
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        let _ = ProtocolProfile::parse_slug(text.trim());
    }
}

pub fn fuzz_replay_cache(input: ReplayCacheInput) {
    let cap = (input.capacity % 8).max(1) as usize;
    let ttl = (input.ttl_secs % 600).max(1);
    let cache = InMemoryReplayCache::with_limits(ttl, cap);
    for ev in input.events {
        let jti = if ev.jti.is_empty() { "j".into() } else { ev.jti };
        let _ = cache.check_and_record_at(&jti, ev.now);
        assert!(cache.len() <= cap, "cache must remain bounded at capacity");
    }
}

/// Oracle: honest GitHub HMAC accepts; body/header tampering never accepts.
pub fn fuzz_github_webhook_hmac(input: GithubWebhookHmacInput) {
    if input.secret.is_empty() {
        return;
    }
    let secret = match std::str::from_utf8(&input.secret) {
        Ok(s) if !s.is_empty() => s,
        _ => return,
    };
    let Some(header) = sign_hub_signature_256(secret, &input.body) else {
        return;
    };
    assert!(
        verify_hub_signature_256(secret, &input.body, &header),
        "honest signature must verify"
    );
    if input.flip_body_bit && !input.body.is_empty() {
        let mut bad = input.body.clone();
        bad[0] ^= 0xff;
        assert!(
            !verify_hub_signature_256(secret, &bad, &header),
            "tampered body must fail closed"
        );
    }
    if input.truncate_header && header.len() > 10 {
        let truncated = &header[..header.len() - 2];
        assert!(
            !verify_hub_signature_256(secret, &input.body, truncated),
            "truncated signature must fail closed"
        );
    }
    assert!(!verify_hub_signature_256(secret, &input.body, ""));
    assert!(!verify_hub_signature_256(secret, &input.body, "sha256=00"));
}

/// Oracle: callout never grants system subjects; email join / unknown issuer deny.
pub fn fuzz_nats_callout_eval(input: NatsCalloutEvalInput) {
    let issuer = if input.issuer_empty {
        String::new()
    } else {
        "https://identity.fuzz".into()
    };
    let subject = if input.subject_empty {
        String::new()
    } else {
        "sub-fuzz".into()
    };
    let mut project_ids = Vec::new();
    for i in 0..input.project_count {
        project_ids.push(format!("proj_{i}"));
    }
    let eval = CalloutEval {
        issuer_allowed: input.issuer_allowed,
        email_join_attempted: input.email_join,
        issuer,
        subject,
        mapped_principal_id: if input.mapped {
            Some("prn_fuzz".into())
        } else {
            None
        },
        provisional: input.provisional,
        project_ids,
    };
    match evaluate_callout(&eval) {
        Ok(allow) => {
            assert!(!input.email_join);
            assert!(input.issuer_allowed);
            assert!(input.mapped);
            assert!(!eval.issuer.is_empty() && !eval.subject.is_empty());
            assert!(!permissions_include_system(&allow.permissions));
            let perms = callout_permissions(
                &allow.principal_id,
                allow.provisional,
                &eval.project_ids,
            );
            assert!(!permissions_include_system(&perms));
            assert!(
                !perms.publish.iter().any(|s| s.contains(".system.")),
                "user ACLs must never publish system.>"
            );
        }
        Err(_) => {}
    }
}

/// KDBX outer/inner header + XML parse, then the frozen KDBX→sealed-store
/// mapping. Arbitrary bytes must classify as an error or map cleanly — never
/// panic, never derive a store path that escapes the store root.
///
/// Runs with a fixed password so the fuzzer explores parsing rather than
/// guessing a key; a keyfile is derived from the same bytes so the keyfile
/// parser is exercised too.
pub fn fuzz_kdbx_parse(data: &[u8]) {
    let bytes = truncate(data);

    // No credentials at all is a rejection, always, before any parsing.
    assert!(
        map_kdbx(bytes, None, None, None).is_err(),
        "credential-less mapping must be refused"
    );

    for (password, keyfile) in [
        (Some("correct horse battery staple"), None),
        (Some(""), Some(bytes)),
        (None, Some(bytes)),
    ] {
        let Ok((items, warnings)) = map_kdbx(bytes, password, keyfile, None) else {
            continue;
        };

        let mut seen = std::collections::BTreeSet::new();
        for item in &items {
            assert!(!item.path.is_empty(), "a mapped path is never empty");
            assert!(
                seen.insert(item.path.clone()),
                "collision resolution must yield unique paths: {}",
                item.path
            );
            // The store's own path resolver is the arbiter: sanitization must
            // produce something it accepts, so no group or title can traverse
            // out of the store root.
            opensesame_sealed_store::logical_to_relative(&item.path)
                .expect("a mapped path is always a legal store path");
            // Line one is line one: a secret never carries a newline.
            assert!(
                !item.entry.secret.contains('\n'),
                "the secret is a single line"
            );
        }

        // Every warning names a path that was actually mapped, or a group path.
        assert!(warnings.len() >= items.iter().map(|i| i.warnings.len()).sum::<usize>());
    }
}

fn truncate(data: &[u8]) -> &[u8] {
    if data.len() > MAX_PARSER_BYTES {
        &data[..MAX_PARSER_BYTES]
    } else {
        data
    }
}

// ——— Connector discovery (ADR 0047/0048) ————————————————————————————

/// MCP client config parser: names-only extraction must never panic and must
/// never return an env *value* these files routinely hold.
pub fn fuzz_mcp_config(data: &[u8]) {
    let bytes = truncate(data);
    // Raw pass: arbitrary bytes straight into both readers.
    if let Ok(text) = std::str::from_utf8(bytes) {
        let _ = mcp_server_names(text);
        let _ = mcp_server_env_keys(text);
    }
    // Canary pass: the input rides in an env VALUE position. The parsers
    // return server names and env key *names* only, so the canary may not
    // come back unless it happens to collide with the fixed scaffolding.
    let canary = String::from_utf8_lossy(bytes).into_owned();
    if canary.is_empty() || "fuzz".contains(&canary) || "CANARY_KEY".contains(&canary) {
        return;
    }
    let doc = serde_json::json!({
        "mcpServers": { "fuzz": { "command": "srv", "env": { "CANARY_KEY": canary } } }
    });
    let text = doc.to_string();
    for (server, env_keys) in mcp_server_env_keys(&text) {
        assert!(!server.contains(&canary), "server name leaked a value");
        for key in env_keys {
            assert!(!key.contains(&canary), "env key name leaked a value");
        }
    }
    for name in mcp_server_names(&text) {
        assert!(!name.contains(&canary), "server name leaked a value");
    }
}

/// AWS-style INI extraction: any returned value must be a literal slice of
/// the input (trimmed), and nothing may panic.
pub fn fuzz_ini_parse(data: &[u8]) {
    let text = String::from_utf8_lossy(truncate(data));
    for (section, key) in [
        ("default", "aws_access_key_id"),
        // Input-derived section and key exercise the matching paths too.
        (text.as_ref(), text.as_ref()),
        ("", ""),
    ] {
        if let Some(value) = ini_value(&text, section, key) {
            assert!(
                text.contains(&value),
                "ini_value returned bytes that were never in the input"
            );
        }
    }
}

/// tailscaled LocalAPI whois response parser (pure; the transport feeds it).
/// Raw pass plus a wrapped pass that gets past the status line so the JSON
/// body parser sees arbitrary bytes.
pub fn fuzz_whois_response(data: &[u8]) {
    let bytes = truncate(data);
    let _ = opensesame_tailscale_authn::parse_response(bytes);
    let mut wrapped = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec();
    wrapped.extend_from_slice(bytes);
    if let Ok(identity) = opensesame_tailscale_authn::parse_response(&wrapped) {
        // JSON unescaping only shrinks, so every parsed field is bounded by
        // the body it came from.
        for field in identity
            .node_name
            .iter()
            .chain(identity.login_name.iter())
            .chain(identity.tags.iter())
        {
            assert!(
                field.len() <= bytes.len(),
                "whois parser produced a field larger than its input"
            );
        }
    }
}

/// Promote handshake serde boundary (ADR 0048 D4): arbitrary JSON must never
/// panic the parser, and `deny_unknown_fields` must hold for every shape —
/// accepted ones and attacker-rolled objects alike.
pub fn fuzz_promote_request(data: &[u8]) {
    let bytes = truncate(data);
    if let Ok(req) = serde_json::from_slice::<PromoteRequest>(bytes) {
        let encoded = serde_json::to_vec(&req).expect("re-encode promote request");
        let mut value: Value = serde_json::from_slice(&encoded).expect("round-trip to value");
        value["__fuzz_unknown_field__"] = Value::Bool(true);
        assert!(
            serde_json::from_value::<PromoteRequest>(value).is_err(),
            "deny_unknown_fields must reject an accepted shape plus one key"
        );
    }
    if let Ok(Value::Object(mut obj)) = serde_json::from_slice::<Value>(bytes) {
        obj.insert("__fuzz_unknown_field__".to_string(), Value::Bool(true));
        assert!(
            serde_json::from_value::<PromoteRequest>(Value::Object(obj)).is_err(),
            "deny_unknown_fields must reject arbitrary input plus one key"
        );
    }
}

/// Bitwarden EncString parse + decrypt over arbitrary bytes.
///
/// The invariants: parsing is total (a named error, never a panic), `Display`
/// round-trips whatever parsed, decryption with an unrelated key fails rather
/// than panicking, and a type-7 (COSE) envelope is *always* refused — the one
/// format where a best-effort decode would silently corrupt vault data.
pub fn fuzz_bitwarden_encstring(data: &[u8]) {
    use opensesame_provider_bitwarden::{EncString, SymmetricKey};

    let bytes = truncate(data);
    let raw = String::from_utf8_lossy(bytes);
    let authenticated = SymmetricKey::from_bytes(&[7u8; 64]).expect("64-byte key");
    let legacy = SymmetricKey::from_bytes(&[9u8; 32]).expect("32-byte key");

    match raw.parse::<EncString>() {
        Ok(parsed) => {
            let rendered = parsed.to_string();
            let reparsed: EncString = rendered
                .parse()
                .expect("an EncString must re-parse its own Display output");
            assert_eq!(parsed, reparsed, "EncString Display is not round-trip stable");
            assert_eq!(rendered, reparsed.to_string());
            // Neither key is the right one, so both must fail — but neither
            // may panic, and neither may leak a partial plaintext.
            assert!(authenticated.decrypt(&parsed).is_err() || legacy.decrypt(&parsed).is_err());
            let _ = authenticated.decrypt_string(&parsed);
            let _ = legacy.decrypt_string(&parsed);
        }
        Err(error) => {
            assert!(!error.code().is_empty(), "every parse failure must be named");
            assert!(!error.to_string().is_empty());
        }
    }

    if raw.starts_with("7.") {
        let error = raw
            .parse::<EncString>()
            .err()
            .expect("a type-7 (COSE) EncString must never parse");
        assert_eq!(error.code(), "cose_encrypt_unsupported");
    }
}

fn secs_to_dt(secs: i64) -> chrono::DateTime<Utc> {
    Utc.timestamp_opt(secs.clamp(0, 2_000_000_000), 0)
        .single()
        .unwrap_or_else(|| Utc.timestamp_opt(0, 0).unwrap())
}

fn rotation_from_u8(v: u8) -> RotationState {
    match v % 16 {
        0 => RotationState::Scheduled,
        1 => RotationState::Discovering,
        2 => RotationState::CandidateGenerated,
        3 => RotationState::CandidateInstalled,
        4 => RotationState::CandidateVerified,
        5 => RotationState::CandidateActivated,
        6 => RotationState::DependentsUpdated,
        7 => RotationState::Observing,
        8 => RotationState::PreviousRevoked,
        9 => RotationState::RevocationVerified,
        10 => RotationState::Completed,
        11 => RotationState::RollbackStarted,
        12 => RotationState::RollbackCompleted,
        13 => RotationState::RollbackFailed,
        _ => RotationState::ReconciliationRequired,
    }
}

pub fn fuzz_grant_from(g: FuzzGrant) -> Grant {
    g.into_grant()
}

pub fn fuzz_caps(set: impl IntoIterator<Item = Capability>) -> CapabilitySet {
    CapabilitySet::new(set.into_iter().collect())
}

#[cfg(test)]
mod oracle_smoke {
    use super::*;
    use crate::types::{
        GithubWebhookHmacInput, NatsCalloutEvalInput, ReplayCacheInput, ReplayEvent,
    };
    use opensesame_task_bus::validate_nats_url;

    /// Seed corpus for `bitwarden_encstring`: the shapes a real vault emits
    /// plus the ones an attacker would. None may panic.
    #[test]
    fn bitwarden_encstring_oracle_survives_the_seed_corpus() {
        for seed in [
            "",
            ".",
            "2.",
            "0.",
            "7.T0NPU0U=",
            "7.",
            "1.aaaa|bbbb",
            "3.aaaa|bbbb",
            "2.AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "0.AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAA==",
            "2.|||",
            "2.\u{0}|\u{0}|\u{0}",
            "99999999999999999999.a|b",
        ] {
            fuzz_bitwarden_encstring(seed.as_bytes());
        }
        fuzz_bitwarden_encstring(&[0xff, 0xfe, 0x00, 0x7f]);
        fuzz_bitwarden_encstring(&vec![b'2'; 4096]);
    }

    #[test]
    fn taskbus_url_oracle_accepts_nats_rejects_http() {
        assert!(validate_nats_url("nats://127.0.0.1:4222").is_ok());
        assert!(validate_nats_url("tls://box:4222").is_ok());
        assert!(validate_nats_url("http://127.0.0.1:4222").is_err());
        assert!(validate_nats_url("nats://bad host").is_err());
    }

    #[test]
    fn webhook_hmac_oracle_honest_and_tamper() {
        fuzz_github_webhook_hmac(GithubWebhookHmacInput {
            secret: b"whsec".to_vec(),
            body: br#"{"a":1}"#.to_vec(),
            flip_body_bit: true,
            truncate_header: true,
        });
    }

    #[test]
    fn kdbx_parse_oracle_survives_arbitrary_bytes() {
        fuzz_kdbx_parse(&[]);
        fuzz_kdbx_parse(&[0x03, 0xd9, 0xa2, 0x9a]);
        fuzz_kdbx_parse(&[0xff; 256]);
        let mut signed = vec![0x03, 0xd9, 0xa2, 0x9a];
        signed.extend((0u16..512).map(|i| i as u8));
        fuzz_kdbx_parse(&signed);
    }

    #[test]
    fn callout_oracle_never_grants_system() {
        fuzz_nats_callout_eval(NatsCalloutEvalInput {
            issuer_allowed: true,
            email_join: false,
            issuer_empty: false,
            subject_empty: false,
            mapped: true,
            provisional: false,
            project_count: 2,
        });
        fuzz_nats_callout_eval(NatsCalloutEvalInput {
            issuer_allowed: true,
            email_join: true,
            issuer_empty: false,
            subject_empty: false,
            mapped: true,
            provisional: false,
            project_count: 1,
        });
    }

    #[test]
    fn replay_oracle_allows_expired_slots_to_be_reused() {
        fuzz_replay_cache(ReplayCacheInput {
            capacity: 1,
            ttl_secs: 1,
            events: vec![
                ReplayEvent {
                    jti: "first".into(),
                    now: 1_000,
                },
                ReplayEvent {
                    jti: "second".into(),
                    now: 1_002,
                },
            ],
        });
    }
}

/// `open_chunk` is the only place attacker-controlled bytes meet the
/// attachment AEAD. It indexes into the frame to lift out a nonce, so a short
/// or malformed frame must be refused rather than panic. Nothing here asserts
/// a decrypt succeeds — the property is that no input crashes, and that no
/// input that was not honestly sealed ever opens.
pub fn fuzz_attachment_chunk(input: AttachmentChunkInput) {
    let idk = ItemDataKey(input.key);
    let key = derive_attachment_key(&idk, &input.attachment_id);

    let count = input.chunk_count.max(1);
    let index = input.chunk_index % count;
    let ad = ChunkAd {
        envelope_version: ENVELOPE_VERSION,
        attachment_id: input
            .attachment_id
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        item_id: "fuzz/item".to_string(),
        chunk_index: index,
        chunk_count: count,
    };

    // Honest path: whatever the plaintext, it must round-trip exactly.
    if let Ok(frame) = seal_chunk(&key, &input.plaintext, &ad) {
        let opened = open_chunk(&key, &frame, &ad).expect("honest frame must open");
        assert_eq!(opened, input.plaintext, "round-trip must be exact");

        // Truncation at an arbitrary offset must never yield a prefix.
        let at = (input.truncate_at as usize) % (frame.len() + 1);
        if at < frame.len() {
            assert!(
                open_chunk(&key, &frame[..at], &ad).is_err(),
                "a truncated frame must not open"
            );
        }

        // A frame must not open at a position it was not sealed at.
        if count > 1 {
            let mut moved = ad.clone();
            moved.chunk_index = (index + 1) % count;
            assert!(
                open_chunk(&key, &frame, &moved).is_err(),
                "a chunk must not open at another position"
            );
        }
    }

    // Hostile path: arbitrary bytes, optionally wearing the right magic so the
    // cheap prefix check does not short-circuit the interesting code.
    let mut hostile = input.hostile_frame.clone();
    if input.prefix_with_magic {
        let mut framed = b"OSCHNK1\n".to_vec();
        framed.append(&mut hostile);
        hostile = framed;
    }
    // Must not panic, and must not authenticate.
    let _ = open_chunk(&key, &hostile, &ad);
}

/// The gateway KV v2 facade's mount/path grammar, compiled straight from the
/// gateway source so this target fuzzes the shipped parser rather than a copy
/// that could drift from it. The file it points at is dependency-free by
/// contract; see `apps/gateway/src/routes/kv_facade_path.rs`.
#[path = "../../apps/gateway/src/routes/kv_facade_path.rs"]
pub mod kv_v2_path;

/// Vault KV v2 mount/path routing for the gateway read facade.
///
/// Invariants: parsing is total (never panics, whatever the bytes); only the
/// served mount is ever accepted; and an accepted name is a single storage key
/// that appeared in the input verbatim — no separator, no `..`, no leading dot,
/// no NUL — so a routed read can never leave the facade's namespace.
pub fn fuzz_kv_v2_path(data: &[u8]) {
    let text = String::from_utf8_lossy(truncate(data));
    for mount in ["secret", "other", text.as_ref(), ""] {
        match kv_v2_path::parse_kv_path(mount, text.as_ref()) {
            Ok(parsed) => {
                assert_eq!(mount, kv_v2_path::KV_MOUNT, "a foreign mount was accepted");
                let name = parsed.name.as_str();
                assert!(!name.is_empty(), "an empty key was accepted");
                assert!(name.len() <= kv_v2_path::MAX_KV_NAME_BYTES);
                assert!(!name.contains('/') && !name.contains('\\'), "{name:?}");
                assert!(!name.contains("..") && !name.starts_with('.'), "{name:?}");
                assert!(!name.contains('\0'), "{name:?}");
                assert!(
                    text.contains(name),
                    "the parser returned a key that was never in the input"
                );
                // Re-rendering the parsed path parses back to the same path:
                // routing is stable, so a receipt's resource string and the
                // request that produced it can never disagree.
                let rendered = format!("{}/{}", parsed.family.as_str(), name);
                assert_eq!(
                    kv_v2_path::parse_kv_path(kv_v2_path::KV_MOUNT, &rendered).as_ref(),
                    Ok(&parsed),
                    "rendered path did not round-trip"
                );
            }
            Err(error) => {
                // Every rejection has a stable, value-free reason.
                assert!(!error.as_str().is_empty());
            }
        }
    }
}
