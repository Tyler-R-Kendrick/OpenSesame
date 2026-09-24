//! The EST enrollment core (ADR 0068 §4): a parsed CSR becomes a policy
//! candidate, the profile's policy decides it, and the profile's authority
//! signs it.
//!
//! Pure decision code over `opensesame_pki_core` — no HTTP, no authentication,
//! no storage. The route module owns those. A policy-violating request is
//! refused **whole**, never narrowed: the threat model's row is "Enrollment CSR
//! requests attributes the operator never intended → violating CSR refused,
//! never narrowed", and `decide` is that row.
//!
//! Secrecy invariant: every type here is public material. The issuer key
//! arrives as a borrowed [`KeyPair`] and leaves as a borrow.

use opensesame_pki_core::bundle;
use opensesame_pki_core::csr::CsrFacts;
use opensesame_pki_core::keys::KeyPair;
use opensesame_pki_core::leaf::{self, IssuedLeaf, LeafParams};
use opensesame_pki_core::pkcs7;
use opensesame_pki_core::policy::{self, PolicyCandidate, PolicyViolation};
use opensesame_pki_core::types::{
    BasicConstraints, ExtendedKeyUsage, KeyUsage, ProfileDefaults, SubjectDn,
};
use opensesame_pki_core::PolicyRules;
use time::{Duration, OffsetDateTime};

/// Default certificate lifetime when neither the request nor the profile
/// defaults name one (30 days).
pub const DEFAULT_TTL_SECONDS: u64 = 30 * 24 * 3_600;
/// Hard lifetime ceiling regardless of policy (398 days — the browser
/// maximum; a policy can only lower it via `max_validity_seconds`).
pub const MAX_TTL_SECONDS: u64 = 398 * 24 * 3_600;

/// Why an enrollment was refused, as stable wire codes.
#[derive(Debug, Eq, PartialEq)]
pub enum EstError {
    /// The CSR is malformed or fails proof of possession.
    InvalidCsr,
    /// The profile's policy refused the request outright.
    PolicyDenied(Vec<PolicyViolation>),
    /// The profile's authority could not sign.
    IssuerUnavailable,
}

impl EstError {
    /// The stable error code this refusal travels as.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidCsr => "csr_invalid",
            Self::PolicyDenied(_) => "policy_denied",
            Self::IssuerUnavailable => "issuer_unavailable",
        }
    }
}

/// The lifetime the profile grants: the request's wish, filled by defaults,
/// clamped to the hard ceiling. Policy's own maximum is enforced separately
/// by [`decide`] (a violation, not a narrowing).
#[must_use]
pub fn ttl_seconds(defaults: &ProfileDefaults, requested: Option<u64>) -> u64 {
    requested
        .or(defaults.ttl_seconds)
        .unwrap_or(DEFAULT_TTL_SECONDS)
        .clamp(1, MAX_TTL_SECONDS)
}

/// Fills omitted subject fields from the profile defaults — only what the
/// request left empty, never overwriting it.
#[must_use]
pub fn merge_subject(subject: &SubjectDn, defaults: &ProfileDefaults) -> SubjectDn {
    let fallback = defaults.subject.clone().unwrap_or_default();
    let mut merged = subject.clone();
    merged.cn = merged.cn.clone().or(fallback.cn);
    merged.o = merged.o.clone().or(fallback.o);
    merged.ou = merged.ou.clone().or(fallback.ou);
    merged.c = merged.c.clone().or(fallback.c);
    merged.st = merged.st.clone().or(fallback.st);
    merged.l = merged.l.clone().or(fallback.l);
    if merged.dc.is_empty() {
        merged.dc = fallback.dc;
    }
    merged
}

/// Reduces the facts a request asserts (plus profile defaults) to the
/// candidate a policy decides on.
#[must_use]
pub fn candidate(
    facts: &CsrFacts,
    defaults: &ProfileDefaults,
    requested_ttl: Option<u64>,
) -> PolicyCandidate {
    PolicyCandidate {
        subject: merge_subject(&facts.subject, defaults),
        sans: facts.sans.clone(),
        key_algorithm: Some(facts.key_algorithm),
        signature_algorithm: None,
        key_usages: defaults.key_usages.clone(),
        ext_key_usages: defaults.ext_key_usages.clone(),
        basic_constraints: defaults.basic_constraints.clone(),
        ttl_seconds: Some(ttl_seconds(defaults, requested_ttl)),
    }
}

/// The whole policy decision: every violation refuses the request.
///
/// # Errors
/// Returns [`EstError::PolicyDenied`] carrying every violation when the
/// candidate does not fit the policy or its maximum validity.
pub fn decide(
    rules: &PolicyRules,
    max_validity_seconds: Option<i64>,
    req: &PolicyCandidate,
) -> Result<(), EstError> {
    let maximum = max_validity_seconds.and_then(|value| u64::try_from(value).ok());
    policy::evaluate_with_max_validity(rules, maximum, req).map_err(EstError::PolicyDenied)
}

/// Signs the request under the profile's authority, exactly as the policy
/// candidate approved it (nothing is narrowed after [`decide`]).
///
/// # Errors
/// Returns [`EstError::InvalidCsr`] for a bad request,
/// [`EstError::IssuerUnavailable`] when the issuer will not sign.
pub fn issue(
    issuer_cert_pem: &str,
    issuer_key: &KeyPair,
    csr_der: &[u8],
    req: &PolicyCandidate,
) -> Result<IssuedLeaf, EstError> {
    let now = OffsetDateTime::now_utc();
    let ttl = req.ttl_seconds.unwrap_or(DEFAULT_TTL_SECONDS);
    let params = LeafParams {
        subject: req.subject.clone(),
        sans: req.sans.clone(),
        not_before: now - Duration::minutes(5),
        not_after: now + Duration::seconds(i64::try_from(ttl).unwrap_or_default()),
        key_usages: req.key_usages.clone(),
        ext_key_usages: req.ext_key_usages.clone(),
        basic_constraints: req.basic_constraints.clone(),
        crl_distribution_points: Vec::new(),
        ocsp_urls: Vec::new(),
        serial: None,
    };
    let issued = leaf::issue_leaf_from_csr_der(issuer_cert_pem, issuer_key, csr_der, &params)
        .map_err(|error| match error {
            opensesame_pki_core::PkiError::CsrParse
            | opensesame_pki_core::PkiError::TooLarge
            | opensesame_pki_core::PkiError::UnsupportedAlgorithm
            | opensesame_pki_core::PkiError::InvalidName
            | opensesame_pki_core::PkiError::InvalidPem => EstError::InvalidCsr,
            _ => EstError::IssuerUnavailable,
        })?;
    Ok(issued)
}

/// The EST `simpleenroll` response body: the issued certificate and its
/// issuer chain (leaf first, root included) as a `certs-only` object.
///
/// # Errors
/// Returns [`EstError::IssuerUnavailable`] when the material will not encode.
pub fn response_p7(issued: &IssuedLeaf) -> Result<Vec<u8>, EstError> {
    let mut certs = vec![pem_to_der(&issued.certificate_pem)?];
    certs.extend(
        bundle::certificates_der(&issued.chain_pem).map_err(|_| EstError::IssuerUnavailable)?,
    );
    pkcs7::certs_only(&certs).map_err(|_| EstError::IssuerUnavailable)
}

/// The EST `cacerts` response body: every certificate in `chain_pem` as a
/// `certs-only` object (the trust distribution format of RFC 7030 §4.1).
///
/// # Errors
/// Returns [`EstError::IssuerUnavailable`] when the chain will not encode.
pub fn chain_p7(chain_pem: &str) -> Result<Vec<u8>, EstError> {
    let certs = bundle::certificates_der(chain_pem).map_err(|_| EstError::IssuerUnavailable)?;
    pkcs7::certs_only(&certs).map_err(|_| EstError::IssuerUnavailable)
}

fn pem_to_der(pem: &str) -> Result<Vec<u8>, EstError> {
    bundle::certificates_der(pem)
        .map_err(|_| EstError::IssuerUnavailable)?
        .into_iter()
        .next()
        .ok_or(EstError::IssuerUnavailable)
}

/// Key usages a client-authentication enrollment asserts when the profile
/// defaults name none: digital signature plus key encipherment — the RFC 5280
/// client-authentication profile, and nothing a server or CA would carry.
#[must_use]
pub fn client_auth_usages() -> (
    Vec<KeyUsage>,
    Vec<ExtendedKeyUsage>,
    Option<BasicConstraints>,
) {
    (
        vec![KeyUsage::DigitalSignature, KeyUsage::KeyEncipherment],
        vec![ExtendedKeyUsage::ClientAuth],
        None,
    )
}

#[cfg(test)]
#[path = "est_enrollment_tests.rs"]
mod tests;
