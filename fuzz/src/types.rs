//! Bounded Arbitrary types. Algebra targets get structured ops, not raw bytes.

use arbitrary::{Arbitrary, Result, Unstructured};
use chrono::{TimeZone, Utc};
use opensesame_domain::{
    Capability, CapabilitySet, ConnectionId, EnvironmentId, Grant, GrantConstraints, GrantId,
    OfflineUse, OrganizationId, PrincipalId, ProjectId, ResourceSelector,
};
use serde_json::{Number, Value};
use uuid::Uuid;

const MAX_STR: usize = 12;
const MAX_VEC: usize = 4;

#[derive(Clone, Debug)]
pub struct FuzzStr(pub String);

impl<'a> Arbitrary<'a> for FuzzStr {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        let n = u.int_in_range(0..=MAX_STR)?;
        let mut s = String::with_capacity(n);
        for _ in 0..n {
            s.push(u.int_in_range(b'a'..=b'z')? as char);
        }
        Ok(Self(s))
    }
}

#[derive(Clone, Debug)]
pub struct FuzzSelector {
    enumerated: bool,
    values: Vec<FuzzStr>,
}

impl<'a> Arbitrary<'a> for FuzzSelector {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        let n = u.int_in_range(1..=MAX_VEC)?;
        let mut values = Vec::with_capacity(n);
        for _ in 0..n {
            values.push(FuzzStr::arbitrary(u)?);
        }
        Ok(Self {
            enumerated: bool::arbitrary(u)?,
            values,
        })
    }
}

impl FuzzSelector {
    pub fn into_selector(self) -> ResourceSelector {
        if !self.enumerated || self.values.len() == 1 {
            ResourceSelector::exact(
                self.values
                    .into_iter()
                    .next()
                    .map(|s| s.0)
                    .unwrap_or_default(),
            )
        } else {
            ResourceSelector::enumerated(self.values.into_iter().map(|s| s.0))
        }
    }
}

#[derive(Clone, Debug)]
pub struct FuzzCap {
    action: FuzzStr,
    resource: FuzzSelector,
}

impl<'a> Arbitrary<'a> for FuzzCap {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        Ok(Self {
            action: FuzzStr::arbitrary(u)?,
            resource: FuzzSelector::arbitrary(u)?,
        })
    }
}

impl FuzzCap {
    pub fn into_cap(self) -> Capability {
        Capability::new(self.action.0, self.resource.into_selector())
    }
}

#[derive(Clone, Debug)]
pub struct FuzzCapSet {
    caps: Vec<FuzzCap>,
}

impl<'a> Arbitrary<'a> for FuzzCapSet {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        let n = u.int_in_range(0..=MAX_VEC)?;
        let mut caps = Vec::with_capacity(n);
        for _ in 0..n {
            caps.push(FuzzCap::arbitrary(u)?);
        }
        Ok(Self { caps })
    }
}

impl FuzzCapSet {
    pub fn into_set(self) -> CapabilitySet {
        CapabilitySet::new(self.caps.into_iter().map(FuzzCap::into_cap).collect()).canonicalize()
    }
}

#[derive(Clone, Debug)]
pub struct CapabilityAlgebraInput {
    pub a: FuzzCapSet,
    pub b: FuzzCapSet,
    pub remove_action: String,
    pub remove_sel: FuzzSelector,
}

impl<'a> Arbitrary<'a> for CapabilityAlgebraInput {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        Ok(Self {
            a: FuzzCapSet::arbitrary(u)?,
            b: FuzzCapSet::arbitrary(u)?,
            remove_action: FuzzStr::arbitrary(u)?.0,
            remove_sel: FuzzSelector::arbitrary(u)?,
        })
    }
}

#[derive(Clone, Debug)]
pub struct FuzzGrant {
    actions: Vec<FuzzStr>,
    resources: Vec<FuzzStr>,
    audiences: Vec<FuzzStr>,
    budget: i64,
    max_depth: u32,
    depth: u32,
    export: bool,
    revoked: bool,
    nbf_delta: i64,
    exp_delta: i64,
    org_seed: u128,
}

impl<'a> Arbitrary<'a> for FuzzGrant {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        let n_act = u.int_in_range(0..=MAX_VEC)?;
        let n_res = u.int_in_range(0..=MAX_VEC)?;
        let n_aud = u.int_in_range(0..=MAX_VEC)?;
        let mut actions = Vec::with_capacity(n_act);
        for _ in 0..n_act {
            actions.push(FuzzStr::arbitrary(u)?);
        }
        let mut resources = Vec::with_capacity(n_res);
        for _ in 0..n_res {
            resources.push(FuzzStr::arbitrary(u)?);
        }
        let mut audiences = Vec::with_capacity(n_aud);
        for _ in 0..n_aud {
            audiences.push(FuzzStr::arbitrary(u)?);
        }
        Ok(Self {
            actions,
            resources,
            audiences,
            budget: i64::arbitrary(u)?.saturating_abs() % 1_000,
            max_depth: u.int_in_range(0..=4)?,
            depth: u.int_in_range(0..=4)?,
            export: bool::arbitrary(u)?,
            revoked: bool::arbitrary(u)?,
            nbf_delta: i64::arbitrary(u)? % 10_000,
            exp_delta: (i64::arbitrary(u)?.saturating_abs() % 86_400) + 1,
            org_seed: u128::arbitrary(u)?,
        })
    }
}

impl FuzzGrant {
    pub fn into_grant(self) -> Grant {
        let created = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
        let expires = created + chrono::Duration::seconds(self.exp_delta);
        let nbf = if self.nbf_delta > 0 {
            Some(created + chrono::Duration::seconds(self.nbf_delta.min(1_000)))
        } else {
            None
        };
        Grant {
            id: GrantId::from_uuid(Uuid::from_u128(self.org_seed.wrapping_add(1))),
            version: 1,
            issuer_principal_id: PrincipalId::from_uuid(Uuid::from_u128(2)),
            beneficiary_principal_id: PrincipalId::from_uuid(Uuid::from_u128(3)),
            actor_id: None,
            client_id: None,
            actor_instance_id: None,
            proof_key_thumbprint: None,
            organization_id: OrganizationId::from_uuid(Uuid::from_u128(self.org_seed)),
            project_id: Some(ProjectId::from_uuid(Uuid::from_u128(4))),
            environment_id: Some(EnvironmentId::from_uuid(Uuid::from_u128(5))),
            connection_id: Some(ConnectionId::from_uuid(Uuid::from_u128(6))),
            actions: self.actions.into_iter().map(|s| s.0).collect(),
            resources: self.resources.into_iter().map(|s| s.0).collect(),
            constraints: GrantConstraints {
                audiences: self.audiences.into_iter().map(|s| s.0).collect(),
                not_before: nbf,
                expires_at: expires,
                required_assurance: None,
                authentication_max_age_seconds: None,
                allowed_networks: vec![],
                parameter_rules_digest: None,
                budgets: [("calls".into(), self.budget)].into_iter().collect(),
                maximum_delegation_depth: self.max_depth,
                offline_use: OfflineUse::Forbidden,
                raw_credential_export: self.export,
            },
            parent_grant_id: None,
            delegation_depth: self.depth,
            created_at: created,
            revoked_at: if self.revoked { Some(created) } else { None },
        }
    }
}

#[derive(Clone, Debug)]
pub struct GrantPairInput {
    pub parent: FuzzGrant,
    pub child: FuzzGrant,
    pub now_secs: i64,
}

impl<'a> Arbitrary<'a> for GrantPairInput {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        Ok(Self {
            parent: FuzzGrant::arbitrary(u)?,
            child: FuzzGrant::arbitrary(u)?,
            now_secs: 1_700_000_000 + (i64::arbitrary(u)? % 86_400).saturating_abs(),
        })
    }
}

#[derive(Clone, Debug)]
pub struct BoundedJson(pub Value);

impl<'a> Arbitrary<'a> for BoundedJson {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        Ok(Self(bounded_json(u, 4)?))
    }
}

fn bounded_json(u: &mut Unstructured<'_>, depth: u8) -> Result<Value> {
    if depth == 0 {
        return Ok(Value::Null);
    }
    match u.int_in_range(0..=5)? {
        0 => Ok(Value::Null),
        1 => Ok(Value::Bool(bool::arbitrary(u)?)),
        2 => Ok(Value::Number(Number::from(i64::arbitrary(u)?))),
        3 => Ok(Value::String(FuzzStr::arbitrary(u)?.0)),
        4 => {
            let n = u.int_in_range(0..=3)?;
            let mut arr = Vec::with_capacity(n);
            for _ in 0..n {
                arr.push(bounded_json(u, depth - 1)?);
            }
            Ok(Value::Array(arr))
        }
        _ => {
            let n = u.int_in_range(0..=4)?;
            let mut map = serde_json::Map::new();
            for _ in 0..n {
                map.insert(FuzzStr::arbitrary(u)?.0, bounded_json(u, depth - 1)?);
            }
            Ok(Value::Object(map))
        }
    }
}

#[derive(Clone, Debug)]
pub struct ResourceMatchInput {
    pub pattern: String,
    pub resource: String,
    pub audience: String,
    pub request_uri: String,
    pub token_aud: String,
}

impl<'a> Arbitrary<'a> for ResourceMatchInput {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        Ok(Self {
            pattern: bounded_text(u, 32)?,
            resource: bounded_text(u, 32)?,
            audience: bounded_text(u, 48)?,
            request_uri: bounded_text(u, 48)?,
            token_aud: bounded_text(u, 48)?,
        })
    }
}

#[derive(Clone, Debug)]
pub struct JwtJwkInput {
    pub jwk_json: Vec<u8>,
    pub jwt: Vec<u8>,
    pub htu: String,
}

impl<'a> Arbitrary<'a> for JwtJwkInput {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        Ok(Self {
            jwk_json: bounded_bytes(u, 512)?,
            jwt: bounded_bytes(u, 512)?,
            htu: bounded_text(u, 64)?,
        })
    }
}

#[derive(Clone, Debug)]
pub struct TokenAudienceInput {
    pub token_aud: Vec<String>,
    pub required: String,
}

impl<'a> Arbitrary<'a> for TokenAudienceInput {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        let n = u.int_in_range(0..=MAX_VEC)?;
        let mut token_aud = Vec::with_capacity(n);
        for _ in 0..n {
            token_aud.push(bounded_text(u, 32)?);
        }
        Ok(Self {
            token_aud,
            required: bounded_text(u, 32)?,
        })
    }
}

#[derive(Clone, Debug)]
pub struct DeviceAuthInput {
    pub interval: u64,
    pub expires_secs: i64,
    pub now_secs: i64,
    pub cancelled: bool,
    pub status: u8,
    pub complete_uri: String,
    pub issuer: String,
}

impl<'a> Arbitrary<'a> for DeviceAuthInput {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        Ok(Self {
            interval: u.int_in_range(0..=30)?,
            expires_secs: 1_700_000_000 + u.int_in_range(0..=86_400)?,
            now_secs: 1_700_000_000 + u.int_in_range(0..=86_400)?,
            cancelled: bool::arbitrary(u)?,
            status: u8::arbitrary(u)?,
            complete_uri: bounded_text(u, 64)?,
            issuer: bounded_text(u, 64)?,
        })
    }
}

#[derive(Clone, Debug)]
pub struct ClaimReplayInput {
    pub token: String,
    pub expires_secs: i64,
    pub now_secs: i64,
    pub start_claimed: bool,
}

impl<'a> Arbitrary<'a> for ClaimReplayInput {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        Ok(Self {
            token: bounded_text(u, 24)?,
            expires_secs: 1_700_000_000 + u.int_in_range(0..=3_600)?,
            now_secs: 1_700_000_000 + u.int_in_range(0..=3_600)?,
            start_claimed: bool::arbitrary(u)?,
        })
    }
}

#[derive(Clone, Debug)]
pub struct RedactionInput {
    pub fields: Vec<(String, String)>,
    pub secret_keys: Vec<String>,
    pub text: String,
}

impl<'a> Arbitrary<'a> for RedactionInput {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        let n = u.int_in_range(0..=MAX_VEC)?;
        let mut fields = Vec::with_capacity(n);
        for _ in 0..n {
            fields.push((FuzzStr::arbitrary(u)?.0, FuzzStr::arbitrary(u)?.0));
        }
        let secrets = ["password", "access_token", "refresh_token", "client_secret"];
        let k = u.int_in_range(0..=secrets.len())?;
        Ok(Self {
            fields,
            secret_keys: secrets.iter().take(k).map(|s| (*s).to_string()).collect(),
            text: bounded_text(u, 80)?,
        })
    }
}

/// Drives the attachment chunk primitive with attacker-shaped input: an
/// arbitrary byte string presented as a sealed frame, plus arbitrary
/// associated data to open it under.
#[derive(Clone, Debug, Arbitrary)]
pub struct AttachmentChunkInput {
    pub key: [u8; 32],
    pub attachment_id: [u8; 16],
    pub plaintext: Vec<u8>,
    /// Bytes handed to `open_chunk` as though they were a frame.
    pub hostile_frame: Vec<u8>,
    pub chunk_index: u32,
    pub chunk_count: u32,
    pub prefix_with_magic: bool,
    pub truncate_at: u16,
}

#[derive(Clone, Debug, Arbitrary)]
pub struct VaultMutateInput {
    pub key: [u8; 32],
    pub bump_version: bool,
    pub flip_ad_version: bool,
    pub corrupt_nonce: bool,
    pub swap_org: bool,
}

#[derive(Clone, Debug)]
pub struct UriNormalizeInput {
    pub htu: String,
    pub complete: String,
    pub issuer: String,
}

impl<'a> Arbitrary<'a> for UriNormalizeInput {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        Ok(Self {
            htu: bounded_text(u, 64)?,
            complete: bounded_text(u, 64)?,
            issuer: bounded_text(u, 64)?,
        })
    }
}

#[derive(Clone, Debug)]
pub struct RotationSeqInput {
    pub steps: Vec<u8>,
}

impl<'a> Arbitrary<'a> for RotationSeqInput {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        let n = u.int_in_range(0..=12)?;
        let mut steps = Vec::with_capacity(n);
        for _ in 0..n {
            steps.push(u8::arbitrary(u)?);
        }
        Ok(Self { steps })
    }
}

#[derive(Clone, Debug)]
pub struct ReplayEvent {
    pub jti: String,
    pub now: i64,
}

impl<'a> Arbitrary<'a> for ReplayEvent {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        Ok(Self {
            jti: bounded_text(u, 16)?,
            now: 1_000 + u.int_in_range(0..=2_000)?,
        })
    }
}

#[derive(Clone, Debug)]
pub struct ReplayCacheInput {
    pub capacity: u8,
    pub ttl_secs: i64,
    pub events: Vec<ReplayEvent>,
}

impl<'a> Arbitrary<'a> for ReplayCacheInput {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        let n = u.int_in_range(0..=8)?;
        let mut events = Vec::with_capacity(n);
        for _ in 0..n {
            events.push(ReplayEvent::arbitrary(u)?);
        }
        Ok(Self {
            capacity: u.int_in_range(1..=8)?,
            ttl_secs: u.int_in_range(1..=600)?,
            events,
        })
    }
}

#[derive(Clone, Debug)]
pub struct GithubWebhookHmacInput {
    pub secret: Vec<u8>,
    pub body: Vec<u8>,
    pub flip_body_bit: bool,
    pub truncate_header: bool,
}

impl<'a> Arbitrary<'a> for GithubWebhookHmacInput {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        Ok(Self {
            secret: bounded_bytes(u, 64)?,
            body: bounded_bytes(u, 512)?,
            flip_body_bit: bool::arbitrary(u)?,
            truncate_header: bool::arbitrary(u)?,
        })
    }
}

#[derive(Clone, Debug)]
pub struct NatsCalloutEvalInput {
    pub issuer_allowed: bool,
    pub email_join: bool,
    pub issuer_empty: bool,
    pub subject_empty: bool,
    pub mapped: bool,
    pub provisional: bool,
    pub project_count: u8,
}

impl<'a> Arbitrary<'a> for NatsCalloutEvalInput {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        Ok(Self {
            issuer_allowed: bool::arbitrary(u)?,
            email_join: bool::arbitrary(u)?,
            issuer_empty: bool::arbitrary(u)?,
            subject_empty: bool::arbitrary(u)?,
            mapped: bool::arbitrary(u)?,
            provisional: bool::arbitrary(u)?,
            project_count: u.int_in_range(0..=4)?,
        })
    }
}

fn bounded_text(u: &mut Unstructured<'_>, max: usize) -> Result<String> {
    let n = u.int_in_range(0..=max)?;
    let mut s = String::with_capacity(n);
    for _ in 0..n {
        s.push(u.int_in_range(32u8..=126)? as char);
    }
    Ok(s)
}

fn bounded_bytes(u: &mut Unstructured<'_>, max: usize) -> Result<Vec<u8>> {
    let n = u.int_in_range(0..=max)?;
    let mut out = vec![0u8; n];
    u.fill_buffer(&mut out)?;
    Ok(out)
}
