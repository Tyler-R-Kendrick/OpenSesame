//! The certificate policy evaluator (ADR 0066 domain model).
//!
//! One implementation of the three-state rule semantics, used by policy
//! writes, profile-default validation, and every enrollment path (API, ACME,
//! EST, SCEP). The semantics, in full:
//!
//! * [`RuleMode::Unset`] — the field is unconstrained.
//! * [`RuleMode::Allow`] with an **empty** value list — *every* value is
//!   denied. This is the deliberate, load-bearing asymmetry: "allow nothing"
//!   is how a policy switches a field off, and an operator who leaves the list
//!   empty by accident gets a closed door rather than an open one.
//! * [`RuleMode::Allow`] with values — a whitelist; each value present must
//!   match one pattern.
//! * [`RuleMode::Require`] — the field must be present, and must match the
//!   whitelist when one is given. An empty value list under `Require` means
//!   presence alone is demanded.
//! * [`RuleMode::Deny`] — anything matching a pattern is rejected; everything
//!   else passes.
//!
//! Patterns are `*`-globs. A bare `*` matches anything; every other `*`
//! matches a run of characters that does **not** cross a `.`, so
//! `*.example.com` accepts `api.example.com` and rejects
//! `api.internal.example.com`. IP rules additionally accept CIDR blocks such
//! as `10.0.0.0/8`, matched by prefix containment.
//!
//! Secrecy invariant: this module sees only names, usages and algorithms —
//! public certificate material. A [`PolicyViolation`] names a field and a
//! reason and is safe to return to an API caller.

use std::net::IpAddr;

use serde::{Deserialize, Serialize};

use crate::error::PkiError;
use crate::types::{
    BasicConstraintRule, BasicConstraints, CaRule, Constraint, ConstraintMode, DcRule,
    ExtendedKeyUsage, FieldRule, KeyAlgorithm, KeyUsage, PolicyPreset, PolicyRules,
    ProfileDefaults, RuleMode, SanEntry, SanRules, SignatureAlgorithm, SubjectDn, SubjectRules,
};

/// One reason a candidate was rejected, naming the field it failed on.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct PolicyViolation {
    /// Dotted path of the offending field, e.g. `subject.cn` or `san.dns`.
    pub field: String,
    /// Human-readable reason, safe to surface to an API caller.
    pub reason: String,
}

impl PolicyViolation {
    /// Builds a violation for `field`.
    fn new(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            reason: reason.into(),
        }
    }
}

/// The certificate a caller is asking to have issued, reduced to the facts a
/// policy can decide on.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct PolicyCandidate {
    /// The requested subject.
    pub subject: SubjectDn,
    /// The requested subject alternative names.
    pub sans: Vec<SanEntry>,
    /// The subject key algorithm, when known.
    pub key_algorithm: Option<KeyAlgorithm>,
    /// The signature algorithm the certificate would be signed with, when
    /// known.
    pub signature_algorithm: Option<SignatureAlgorithm>,
    /// The requested key usages.
    pub key_usages: Vec<KeyUsage>,
    /// The requested extended key usages.
    pub ext_key_usages: Vec<ExtendedKeyUsage>,
    /// The requested basic constraints.
    pub basic_constraints: Option<BasicConstraints>,
    /// The requested lifetime in seconds. Unconstrained by [`evaluate`]; see
    /// [`evaluate_with_max_validity`], which layers the policy row's
    /// `max_validity_seconds` column on top.
    pub ttl_seconds: Option<u64>,
}

/// Evaluates `req` against `rules`.
///
/// # Errors
/// Returns every [`PolicyViolation`] the candidate produced, in a stable order
/// (subject, SANs, algorithms, usages, basic constraints), so an API response
/// and a snapshot test both stay deterministic.
pub fn evaluate(rules: &PolicyRules, req: &PolicyCandidate) -> Result<(), Vec<PolicyViolation>> {
    let violations = collect(rules, req, true);
    if violations.is_empty() {
        Ok(())
    } else {
        Err(violations)
    }
}

/// Evaluates `req` against `rules` and additionally enforces the policy row's
/// `max_validity_seconds` column, which is stored beside the rules document
/// rather than inside it.
///
/// # Errors
/// As [`evaluate`], plus a `ttl_seconds` violation when the requested lifetime
/// exceeds `max_validity_seconds`.
pub fn evaluate_with_max_validity(
    rules: &PolicyRules,
    max_validity_seconds: Option<u64>,
    req: &PolicyCandidate,
) -> Result<(), Vec<PolicyViolation>> {
    let mut violations = collect(rules, req, true);
    if let (Some(limit), Some(requested)) = (max_validity_seconds, req.ttl_seconds) {
        if requested > limit {
            violations.push(PolicyViolation::new(
                "ttl_seconds",
                format!("lifetime {requested}s exceeds the maximum of {limit}s"),
            ));
        }
    }
    if violations.is_empty() {
        Ok(())
    } else {
        Err(violations)
    }
}

/// Checks that a profile's defaults could never produce a certificate its own
/// policy would reject.
///
/// Presence requirements are *not* applied: a default document only fills in
/// what a request omitted, so a policy that requires a common name is not
/// violated by defaults that leave it to the request. Every value the defaults
/// *do* set must be permitted.
///
/// # Errors
/// Returns the violations the defaults would cause.
pub fn validate_defaults_against_policy(
    defaults: &ProfileDefaults,
    rules: &PolicyRules,
) -> Result<(), Vec<PolicyViolation>> {
    let candidate = PolicyCandidate {
        subject: defaults.subject.clone().unwrap_or_default(),
        sans: Vec::new(),
        key_algorithm: defaults.key_algorithm,
        signature_algorithm: defaults.signature_algorithm,
        key_usages: defaults.key_usages.clone(),
        ext_key_usages: defaults.ext_key_usages.clone(),
        basic_constraints: defaults.basic_constraints,
        ttl_seconds: defaults.ttl_seconds,
    };
    let violations = collect(rules, &candidate, false);
    if violations.is_empty() {
        Ok(())
    } else {
        Err(violations)
    }
}

/// Runs every rule class. `require_presence` is false when validating profile
/// defaults, where absence is legitimate.
fn collect(
    rules: &PolicyRules,
    req: &PolicyCandidate,
    require_presence: bool,
) -> Vec<PolicyViolation> {
    let mut out = Vec::new();
    check_subject(&rules.subject, &req.subject, require_presence, &mut out);
    check_sans(&rules.san, &req.sans, require_presence, &mut out);
    check_scalar(
        "signature_algorithms",
        &rules.signature_algorithms,
        req.signature_algorithm,
        require_presence,
        &mut out,
    );
    check_scalar(
        "key_algorithms",
        &rules.key_algorithms,
        req.key_algorithm,
        require_presence,
        &mut out,
    );
    check_set(
        "key_usages",
        &rules.key_usages,
        &req.key_usages,
        require_presence,
        &mut out,
    );
    check_set(
        "ext_key_usages",
        &rules.ext_key_usages,
        &req.ext_key_usages,
        require_presence,
        &mut out,
    );
    check_basic_constraints(
        rules.basic_constraints,
        req.basic_constraints,
        require_presence,
        &mut out,
    );
    out
}

/// Applies the per-attribute subject rules.
fn check_subject(
    rules: &SubjectRules,
    subject: &SubjectDn,
    require_presence: bool,
    out: &mut Vec<PolicyViolation>,
) {
    for (field, rule, value) in [
        ("subject.cn", &rules.cn, subject.cn.as_deref()),
        ("subject.o", &rules.o, subject.o.as_deref()),
        ("subject.ou", &rules.ou, subject.ou.as_deref()),
        ("subject.c", &rules.c, subject.c.as_deref()),
        ("subject.st", &rules.st, subject.st.as_deref()),
        ("subject.l", &rules.l, subject.l.as_deref()),
    ] {
        check_single(field, rule, value, require_presence, out);
    }
    check_dc(&rules.dc, &subject.dc, require_presence, out);
}

/// Applies the per-class SAN rules.
fn check_sans(
    rules: &SanRules,
    sans: &[SanEntry],
    require_presence: bool,
    out: &mut Vec<PolicyViolation>,
) {
    let values = |wanted: &str| -> Vec<String> {
        sans.iter()
            .filter(|entry| entry.class() == wanted)
            .map(SanEntry::value)
            .collect()
    };
    for (field, rule, class) in [
        ("san.dns", &rules.dns, "dns"),
        ("san.ip", &rules.ip, "ip"),
        ("san.email", &rules.email, "email"),
        ("san.uri", &rules.uri, "uri"),
        ("san.upn", &rules.upn, "upn"),
    ] {
        check_multi(
            field,
            rule,
            &values(class),
            class == "ip",
            require_presence,
            out,
        );
    }
}

/// Applies one [`FieldRule`] to a single-valued field.
fn check_single(
    field: &str,
    rule: &FieldRule,
    value: Option<&str>,
    require_presence: bool,
    out: &mut Vec<PolicyViolation>,
) {
    match rule.mode {
        RuleMode::Unset => {}
        RuleMode::Allow => {
            if let Some(value) = value {
                if rule.values.is_empty() {
                    out.push(PolicyViolation::new(field, NO_VALUE_PERMITTED));
                } else if !matches_any(&rule.values, value, false) {
                    out.push(PolicyViolation::new(field, not_permitted(value)));
                }
            }
        }
        RuleMode::Require => match value {
            None => {
                if require_presence {
                    out.push(PolicyViolation::new(field, REQUIRED_BUT_ABSENT));
                }
            }
            Some(value) => {
                if !rule.values.is_empty() && !matches_any(&rule.values, value, false) {
                    out.push(PolicyViolation::new(field, not_permitted(value)));
                }
            }
        },
        RuleMode::Deny => {
            if let Some(value) = value {
                if matches_any(&rule.values, value, false) {
                    out.push(PolicyViolation::new(field, denied(value)));
                }
            }
        }
    }
}

/// The violation a whitelist rule produces for one value, if any.
///
/// An empty pattern list means the field permits nothing, which is the
/// deliberate `allow`-with-no-values semantics documented on [`RuleMode`].
fn whitelist_violation(
    field: &str,
    rule: &FieldRule,
    value: &str,
    numeric: bool,
) -> Option<PolicyViolation> {
    if rule.values.is_empty() {
        Some(PolicyViolation::new(field, NO_VALUE_PERMITTED))
    } else if matches_any(&rule.values, value, numeric) {
        None
    } else {
        Some(PolicyViolation::new(field, not_permitted(value)))
    }
}

/// Applies one [`FieldRule`] to a multi-valued field such as a SAN class.
fn check_multi(
    field: &str,
    rule: &FieldRule,
    values: &[String],
    numeric: bool,
    require_presence: bool,
    out: &mut Vec<PolicyViolation>,
) {
    match rule.mode {
        RuleMode::Unset => {}
        RuleMode::Allow => out.extend(
            values
                .iter()
                .filter_map(|value| whitelist_violation(field, rule, value, numeric)),
        ),
        RuleMode::Require if values.is_empty() => {
            if require_presence {
                out.push(PolicyViolation::new(field, AT_LEAST_ONE_REQUIRED));
            }
        }
        RuleMode::Require => out.extend(
            values
                .iter()
                .filter(|_| !rule.values.is_empty())
                .filter_map(|value| whitelist_violation(field, rule, value, numeric)),
        ),
        RuleMode::Deny => out.extend(
            values
                .iter()
                .filter(|value| matches_any(&rule.values, value, numeric))
                .map(|value| PolicyViolation::new(field, denied(value))),
        ),
    }
}

/// Applies the ordered-sequence `domainComponent` rule.
fn check_dc(
    rule: &DcRule,
    components: &[String],
    require_presence: bool,
    out: &mut Vec<PolicyViolation>,
) {
    let field = "subject.dc";
    let rendered = components.join(",");
    let sequence_matches = || {
        rule.components.len() == components.len()
            && rule
                .components
                .iter()
                .zip(components)
                .all(|(pattern, value)| glob_matches(pattern, value))
    };
    match rule.mode {
        RuleMode::Unset => {}
        RuleMode::Allow => {
            if !components.is_empty() {
                if rule.components.is_empty() {
                    out.push(PolicyViolation::new(field, NO_VALUE_PERMITTED));
                } else if !sequence_matches() {
                    out.push(PolicyViolation::new(field, not_permitted(&rendered)));
                }
            }
        }
        RuleMode::Require => {
            if components.is_empty() {
                if require_presence {
                    out.push(PolicyViolation::new(field, AT_LEAST_ONE_REQUIRED));
                }
            } else if !rule.components.is_empty() && !sequence_matches() {
                out.push(PolicyViolation::new(field, not_permitted(&rendered)));
            }
        }
        RuleMode::Deny => {
            if !components.is_empty() && sequence_matches() {
                out.push(PolicyViolation::new(field, denied(&rendered)));
            }
        }
    }
}

/// Applies a [`Constraint`] to a scalar value.
fn check_scalar<T>(
    field: &str,
    constraint: &Constraint<T>,
    value: Option<T>,
    require_presence: bool,
    out: &mut Vec<PolicyViolation>,
) where
    T: Copy + PartialEq + std::fmt::Display,
{
    match constraint.mode {
        ConstraintMode::Unset => {}
        ConstraintMode::Allow => {
            if let Some(value) = value {
                if constraint.allowed.is_empty() {
                    out.push(PolicyViolation::new(field, NO_VALUE_PERMITTED));
                } else if !constraint.allowed.contains(&value) {
                    out.push(PolicyViolation::new(
                        field,
                        not_permitted(&value.to_string()),
                    ));
                }
            }
        }
        ConstraintMode::Require => match value {
            None => {
                if require_presence {
                    out.push(PolicyViolation::new(field, REQUIRED_BUT_ABSENT));
                }
            }
            Some(value) => {
                if !constraint.allowed.is_empty() && !constraint.allowed.contains(&value) {
                    out.push(PolicyViolation::new(
                        field,
                        not_permitted(&value.to_string()),
                    ));
                }
                if !constraint.required.is_empty() && !constraint.required.contains(&value) {
                    out.push(PolicyViolation::new(
                        field,
                        format!("value \"{value}\" is not among the required values"),
                    ));
                }
            }
        },
    }
}

/// Applies a [`Constraint`] to a set of values.
///
/// `require_presence` is false when validating profile defaults, where a
/// `required` value the defaults omit will still be supplied by the request.
fn check_set<T>(
    field: &str,
    constraint: &Constraint<T>,
    values: &[T],
    require_presence: bool,
    out: &mut Vec<PolicyViolation>,
) where
    T: Copy + PartialEq + std::fmt::Display,
{
    match constraint.mode {
        ConstraintMode::Unset => {}
        ConstraintMode::Allow | ConstraintMode::Require => {
            for value in values {
                if constraint.allowed.is_empty() {
                    out.push(PolicyViolation::new(field, NO_VALUE_PERMITTED));
                } else if !constraint.allowed.contains(value) {
                    out.push(PolicyViolation::new(
                        field,
                        not_permitted(&value.to_string()),
                    ));
                }
            }
            if constraint.mode == ConstraintMode::Require && require_presence {
                out.extend(
                    constraint
                        .required
                        .iter()
                        .filter(|wanted| !values.contains(wanted))
                        .map(|wanted| {
                            PolicyViolation::new(
                                field,
                                format!("required value \"{wanted}\" is absent"),
                            )
                        }),
                );
            }
        }
    }
}

/// Applies the `basicConstraints` rule.
fn check_basic_constraints(
    rule: BasicConstraintRule,
    candidate: Option<BasicConstraints>,
    require_presence: bool,
    out: &mut Vec<PolicyViolation>,
) {
    let is_ca = candidate.is_some_and(|value| value.ca);
    match rule.ca {
        CaRule::Allow => {}
        CaRule::Forbid => {
            if is_ca {
                out.push(PolicyViolation::new(
                    "basic_constraints.ca",
                    "certificate authority certificates are forbidden",
                ));
            }
        }
        CaRule::Require => {
            if !is_ca && (require_presence || candidate.is_some()) {
                out.push(PolicyViolation::new(
                    "basic_constraints.ca",
                    "certificate authority certificates are required",
                ));
            }
        }
    }
    if let (Some(limit), true) = (rule.max_path_len, is_ca) {
        match candidate.and_then(|value| value.max_path_len) {
            None => out.push(PolicyViolation::new(
                "basic_constraints.max_path_len",
                "an unconstrained path length is not permitted",
            )),
            Some(requested) if requested > limit => out.push(PolicyViolation::new(
                "basic_constraints.max_path_len",
                format!("path length {requested} exceeds the maximum of {limit}"),
            )),
            Some(_) => {}
        }
    }
}

/// Reason text for a field whose rule permits nothing.
const NO_VALUE_PERMITTED: &str = "no value is permitted for this field";

/// Reason text for a required field that was absent.
const REQUIRED_BUT_ABSENT: &str = "field is required but absent";

/// Reason text for a required multi-valued field that was empty.
const AT_LEAST_ONE_REQUIRED: &str = "at least one value is required";

/// Reason text for a value outside the whitelist.
fn not_permitted(value: &str) -> String {
    format!("value \"{value}\" is not permitted")
}

/// Reason text for a value the policy explicitly denies.
fn denied(value: &str) -> String {
    format!("value \"{value}\" is explicitly denied")
}

/// Whether `value` matches any pattern, using CIDR containment for numeric
/// (IP) fields and glob matching elsewhere.
fn matches_any(patterns: &[String], value: &str, numeric: bool) -> bool {
    patterns.iter().any(|pattern| {
        if numeric {
            ip_matches(pattern, value)
        } else {
            glob_matches(pattern, value)
        }
    })
}

/// Whether `value` matches `pattern`, where a lone `*` matches anything and
/// any other `*` matches a run of characters not containing a `.`.
///
/// Matching is ASCII-case-insensitive, as DNS names are.
fn glob_matches(pattern: &str, value: &str) -> bool {
    /// Largest number of wildcard segments considered, so a pathological
    /// pattern cannot drive quadratic scanning.
    const MAX_SEGMENTS: usize = 8;

    if pattern == "*" {
        return true;
    }
    let pattern = pattern.to_ascii_lowercase();
    let value = value.to_ascii_lowercase();
    let segments: Vec<&str> = pattern.split('*').collect();
    if segments.len() == 1 {
        return pattern == value;
    }
    if segments.len() > MAX_SEGMENTS {
        return false;
    }
    let first = segments[0];
    if !value.starts_with(first) {
        return false;
    }
    let mut position = first.len();
    for segment in &segments[1..segments.len() - 1] {
        let Some(offset) = value[position..].find(segment) else {
            return false;
        };
        if value[position..position + offset].contains('.') {
            return false;
        }
        position += offset + segment.len();
    }
    let last = segments[segments.len() - 1];
    if value.len() < position + last.len() || !value[position..].ends_with(last) {
        return false;
    }
    !value[position..value.len() - last.len()].contains('.')
}

/// Whether `value` is inside `pattern`, which may be a literal address, a
/// CIDR block, or a glob over the textual form.
fn ip_matches(pattern: &str, value: &str) -> bool {
    if let Some((network, prefix)) = pattern.split_once('/') {
        let (Ok(network), Ok(prefix), Ok(address)) = (
            network.parse::<IpAddr>(),
            prefix.parse::<u8>(),
            value.parse::<IpAddr>(),
        ) else {
            return false;
        };
        return cidr_contains(network, prefix, address);
    }
    match (pattern.parse::<IpAddr>(), value.parse::<IpAddr>()) {
        (Ok(expected), Ok(actual)) => expected == actual,
        _ => glob_matches(pattern, value),
    }
}

/// Whether `address` falls inside `network/prefix`, comparing raw octets so no
/// additional dependency is needed.
fn cidr_contains(network: IpAddr, prefix: u8, address: IpAddr) -> bool {
    let (network, address) = match (network, address) {
        (IpAddr::V4(network), IpAddr::V4(address)) => {
            (network.octets().to_vec(), address.octets().to_vec())
        }
        (IpAddr::V6(network), IpAddr::V6(address)) => {
            (network.octets().to_vec(), address.octets().to_vec())
        }
        _ => return false,
    };
    let bits = network.len() * 8;
    if usize::from(prefix) > bits {
        return false;
    }
    let whole = usize::from(prefix) / 8;
    let remainder = u32::from(prefix) % 8;
    if network[..whole] != address[..whole] {
        return false;
    }
    if remainder == 0 {
        return true;
    }
    let mask = 0xffu8 << (8 - remainder);
    network[whole] & mask == address[whole] & mask
}

/// Builds the rules for one of the shipped presets.
pub fn preset(preset: PolicyPreset) -> PolicyRules {
    match preset {
        PolicyPreset::TlsServer => tls_server_preset(),
        PolicyPreset::TlsClient => tls_client_preset(),
        PolicyPreset::CodeSigning => code_signing_preset(),
        PolicyPreset::Device => device_preset(),
        PolicyPreset::User => user_preset(),
        PolicyPreset::EmailProtection => email_protection_preset(),
        PolicyPreset::DualPurposeServer => dual_purpose_server_preset(),
        PolicyPreset::IntermediateCa => intermediate_ca_preset(),
    }
}

/// Rules permitting only the key and signature algorithms that are broadly
/// interoperable for TLS. Ed25519 is excluded: no mainstream browser accepts
/// it in a server certificate today.
fn tls_algorithm_rules() -> PolicyRules {
    PolicyRules {
        key_algorithms: Constraint::allow([
            KeyAlgorithm::Rsa2048,
            KeyAlgorithm::Rsa4096,
            KeyAlgorithm::EcdsaP256,
            KeyAlgorithm::EcdsaP384,
        ]),
        signature_algorithms: Constraint::allow([
            SignatureAlgorithm::Sha256Rsa,
            SignatureAlgorithm::Sha384Rsa,
            SignatureAlgorithm::Sha256Ecdsa,
            SignatureAlgorithm::Sha384Ecdsa,
        ]),
        ..PolicyRules::default()
    }
}

/// A rule demanding the field be present, with no whitelist.
fn present() -> FieldRule {
    FieldRule::require(Vec::<String>::new())
}

/// TLS server certificates: at least one DNS name, `serverAuth`, never a CA.
fn tls_server_preset() -> PolicyRules {
    let mut rules = tls_algorithm_rules();
    rules.san.dns = present();
    rules.key_usages = Constraint::require(
        [
            KeyUsage::DigitalSignature,
            KeyUsage::KeyEncipherment,
            KeyUsage::KeyAgreement,
        ],
        [KeyUsage::DigitalSignature],
    );
    rules.ext_key_usages = Constraint::require(
        [ExtendedKeyUsage::ServerAuth],
        [ExtendedKeyUsage::ServerAuth],
    );
    rules.basic_constraints.ca = CaRule::Forbid;
    rules
}

/// TLS client certificates: `clientAuth`, never a CA.
fn tls_client_preset() -> PolicyRules {
    let mut rules = tls_algorithm_rules();
    rules.key_usages = Constraint::require(
        [KeyUsage::DigitalSignature, KeyUsage::KeyAgreement],
        [KeyUsage::DigitalSignature],
    );
    rules.ext_key_usages = Constraint::require(
        [ExtendedKeyUsage::ClientAuth],
        [ExtendedKeyUsage::ClientAuth],
    );
    rules.basic_constraints.ca = CaRule::Forbid;
    rules
}

/// Code-signing certificates: a named subject, `codeSigning`, never a CA.
fn code_signing_preset() -> PolicyRules {
    PolicyRules {
        subject: SubjectRules {
            cn: present(),
            ..SubjectRules::default()
        },
        key_usages: Constraint::require(
            [KeyUsage::DigitalSignature, KeyUsage::NonRepudiation],
            [KeyUsage::DigitalSignature],
        ),
        ext_key_usages: Constraint::require(
            [
                ExtendedKeyUsage::CodeSigning,
                ExtendedKeyUsage::TimeStamping,
            ],
            [ExtendedKeyUsage::CodeSigning],
        ),
        basic_constraints: BasicConstraintRule {
            ca: CaRule::Forbid,
            max_path_len: None,
        },
        ..PolicyRules::default()
    }
}

/// Device identity certificates: `clientAuth`, optionally `serverAuth` for
/// mutually authenticated device-to-device TLS, never a CA.
fn device_preset() -> PolicyRules {
    PolicyRules {
        key_usages: Constraint::require(
            [
                KeyUsage::DigitalSignature,
                KeyUsage::KeyEncipherment,
                KeyUsage::KeyAgreement,
            ],
            [KeyUsage::DigitalSignature],
        ),
        ext_key_usages: Constraint::require(
            [ExtendedKeyUsage::ClientAuth, ExtendedKeyUsage::ServerAuth],
            [ExtendedKeyUsage::ClientAuth],
        ),
        basic_constraints: BasicConstraintRule {
            ca: CaRule::Forbid,
            max_path_len: None,
        },
        ..PolicyRules::default()
    }
}

/// Human user certificates: a named subject, `clientAuth`, never a CA.
fn user_preset() -> PolicyRules {
    PolicyRules {
        subject: SubjectRules {
            cn: present(),
            ..SubjectRules::default()
        },
        key_usages: Constraint::require(
            [
                KeyUsage::DigitalSignature,
                KeyUsage::NonRepudiation,
                KeyUsage::KeyEncipherment,
            ],
            [KeyUsage::DigitalSignature],
        ),
        ext_key_usages: Constraint::require(
            [
                ExtendedKeyUsage::ClientAuth,
                ExtendedKeyUsage::EmailProtection,
            ],
            [ExtendedKeyUsage::ClientAuth],
        ),
        basic_constraints: BasicConstraintRule {
            ca: CaRule::Forbid,
            max_path_len: None,
        },
        ..PolicyRules::default()
    }
}

/// S/MIME certificates: at least one e-mail SAN, `emailProtection`, never a CA.
fn email_protection_preset() -> PolicyRules {
    PolicyRules {
        san: SanRules {
            email: present(),
            ..SanRules::default()
        },
        key_usages: Constraint::require(
            [
                KeyUsage::DigitalSignature,
                KeyUsage::NonRepudiation,
                KeyUsage::KeyEncipherment,
            ],
            [KeyUsage::DigitalSignature],
        ),
        ext_key_usages: Constraint::require(
            [ExtendedKeyUsage::EmailProtection],
            [ExtendedKeyUsage::EmailProtection],
        ),
        basic_constraints: BasicConstraintRule {
            ca: CaRule::Forbid,
            max_path_len: None,
        },
        ..PolicyRules::default()
    }
}

/// Certificates usable as both TLS server and TLS client.
fn dual_purpose_server_preset() -> PolicyRules {
    let mut rules = tls_algorithm_rules();
    rules.san.dns = present();
    rules.key_usages = Constraint::require(
        [
            KeyUsage::DigitalSignature,
            KeyUsage::KeyEncipherment,
            KeyUsage::KeyAgreement,
        ],
        [KeyUsage::DigitalSignature],
    );
    rules.ext_key_usages = Constraint::require(
        [ExtendedKeyUsage::ServerAuth, ExtendedKeyUsage::ClientAuth],
        [ExtendedKeyUsage::ServerAuth, ExtendedKeyUsage::ClientAuth],
    );
    rules.basic_constraints.ca = CaRule::Forbid;
    rules
}

/// Subordinate authorities: a named subject, `keyCertSign` and `cRLSign`, a CA
/// with no further chaining, and no subject alternative names at all — an
/// authority certifies names, it does not carry them. Every SAN class is
/// switched off with the `allow`-with-no-values form.
fn intermediate_ca_preset() -> PolicyRules {
    let none = FieldRule::allow(Vec::<String>::new());
    PolicyRules {
        subject: SubjectRules {
            cn: present(),
            ..SubjectRules::default()
        },
        san: SanRules {
            dns: none.clone(),
            ip: none.clone(),
            email: none.clone(),
            uri: none.clone(),
            upn: none,
        },
        key_usages: Constraint::require(
            [
                KeyUsage::DigitalSignature,
                KeyUsage::KeyCertSign,
                KeyUsage::CrlSign,
            ],
            [KeyUsage::KeyCertSign, KeyUsage::CrlSign],
        ),
        basic_constraints: BasicConstraintRule {
            ca: CaRule::Require,
            max_path_len: Some(0),
        },
        ..PolicyRules::default()
    }
}

/// Convenience wrapper turning an evaluation failure into a [`PkiError`].
///
/// # Errors
/// Returns [`PkiError::PolicyViolations`] carrying every violation.
pub fn enforce(rules: &PolicyRules, req: &PolicyCandidate) -> Result<(), PkiError> {
    evaluate(rules, req).map_err(PkiError::PolicyViolations)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate() -> PolicyCandidate {
        PolicyCandidate {
            subject: SubjectDn::common_name("api.example.com"),
            sans: vec![SanEntry::Dns("api.example.com".into())],
            key_algorithm: Some(KeyAlgorithm::EcdsaP256),
            signature_algorithm: Some(SignatureAlgorithm::Sha256Ecdsa),
            key_usages: vec![KeyUsage::DigitalSignature],
            ext_key_usages: vec![ExtendedKeyUsage::ServerAuth],
            basic_constraints: Some(BasicConstraints {
                ca: false,
                max_path_len: None,
            }),
            ttl_seconds: Some(3600),
        }
    }

    fn fields(violations: &[PolicyViolation]) -> Vec<&str> {
        violations
            .iter()
            .map(|violation| violation.field.as_str())
            .collect()
    }

    #[test]
    fn the_default_policy_accepts_everything() {
        assert!(evaluate(&PolicyRules::default(), &candidate()).is_ok());
        assert!(evaluate(&PolicyRules::default(), &PolicyCandidate::default()).is_ok());
    }

    #[test]
    fn single_valued_fields_cover_the_whole_three_state_matrix() {
        let with_cn = |rule: FieldRule| PolicyRules {
            subject: SubjectRules {
                cn: rule,
                ..SubjectRules::default()
            },
            ..PolicyRules::default()
        };
        let absent = PolicyCandidate {
            subject: SubjectDn::default(),
            ..candidate()
        };

        // unset: anything goes.
        assert!(evaluate(&with_cn(FieldRule::default()), &candidate()).is_ok());
        assert!(evaluate(&with_cn(FieldRule::default()), &absent).is_ok());

        // allow with an empty list: nothing goes, but absence is fine.
        let empty_allow = with_cn(FieldRule::allow(Vec::<String>::new()));
        assert_eq!(
            evaluate(&empty_allow, &candidate()).unwrap_err()[0].reason,
            NO_VALUE_PERMITTED
        );
        assert!(evaluate(&empty_allow, &absent).is_ok());

        // allow with a list: whitelist, absence still fine.
        let listed = with_cn(FieldRule::allow(["*.example.com"]));
        assert!(evaluate(&listed, &candidate()).is_ok());
        assert!(evaluate(&listed, &absent).is_ok());
        let elsewhere = PolicyCandidate {
            subject: SubjectDn::common_name("api.evil.test"),
            ..candidate()
        };
        assert_eq!(
            evaluate(&listed, &elsewhere).unwrap_err(),
            vec![PolicyViolation::new(
                "subject.cn",
                "value \"api.evil.test\" is not permitted"
            )]
        );

        // require: presence plus whitelist.
        let required = with_cn(FieldRule::require(["*.example.com"]));
        assert!(evaluate(&required, &candidate()).is_ok());
        assert_eq!(
            evaluate(&required, &absent).unwrap_err()[0].reason,
            REQUIRED_BUT_ABSENT
        );
        assert!(evaluate(
            &with_cn(FieldRule::require(Vec::<String>::new())),
            &candidate()
        )
        .is_ok());

        // deny: listed values rejected, everything else accepted.
        let denied_rule = with_cn(FieldRule::deny(["*.example.com"]));
        assert_eq!(
            evaluate(&denied_rule, &candidate()).unwrap_err()[0].reason,
            "value \"api.example.com\" is explicitly denied"
        );
        assert!(evaluate(&denied_rule, &elsewhere).is_ok());
        assert!(evaluate(&denied_rule, &absent).is_ok());
    }

    #[test]
    fn multi_valued_san_rules_cover_the_whole_three_state_matrix() {
        let with_dns = |rule: FieldRule| PolicyRules {
            san: SanRules {
                dns: rule,
                ..SanRules::default()
            },
            ..PolicyRules::default()
        };
        let no_sans = PolicyCandidate {
            sans: Vec::new(),
            ..candidate()
        };

        assert!(evaluate(&with_dns(FieldRule::default()), &candidate()).is_ok());
        assert_eq!(
            evaluate(
                &with_dns(FieldRule::allow(Vec::<String>::new())),
                &candidate()
            )
            .unwrap_err()[0]
                .reason,
            NO_VALUE_PERMITTED
        );
        assert!(evaluate(&with_dns(FieldRule::allow(Vec::<String>::new())), &no_sans).is_ok());
        assert!(evaluate(&with_dns(FieldRule::allow(["*.example.com"])), &candidate()).is_ok());
        assert_eq!(
            evaluate(
                &with_dns(FieldRule::require(Vec::<String>::new())),
                &no_sans
            )
            .unwrap_err()[0]
                .reason,
            AT_LEAST_ONE_REQUIRED
        );
        assert!(evaluate(&with_dns(FieldRule::deny(["*.evil.test"])), &candidate()).is_ok());
        assert_eq!(
            evaluate(&with_dns(FieldRule::deny(["*"])), &candidate()).unwrap_err()[0].reason,
            "value \"api.example.com\" is explicitly denied"
        );
    }

    #[test]
    fn wildcards_match_one_label_and_never_cross_a_dot() {
        assert!(glob_matches("*", "anything.at.all"));
        assert!(glob_matches("*.example.com", "api.example.com"));
        assert!(!glob_matches("*.example.com", "api.internal.example.com"));
        assert!(!glob_matches("*.example.com", "example.com"));
        assert!(glob_matches("api.example.com", "API.EXAMPLE.COM"));
        assert!(glob_matches("web-*.example.com", "web-01.example.com"));
        assert!(!glob_matches("web-*.example.com", "web-01.a.example.com"));
        assert!(glob_matches("api*", "apiserver"));
        assert!(!glob_matches("api*", "api.server"));
        assert!(!glob_matches("exact", "exactly"));
        assert!(glob_matches("", ""));
        assert!(!glob_matches("*.example.com", "com"));
        assert!(!glob_matches("*a*b*c*d*e*f*g*h*i*", "abcdefghi"));
    }

    #[test]
    fn ip_rules_match_literals_and_cidr_blocks() {
        assert!(ip_matches("10.0.0.0/8", "10.4.5.6"));
        assert!(!ip_matches("10.0.0.0/8", "11.4.5.6"));
        assert!(ip_matches("10.1.2.0/24", "10.1.2.255"));
        assert!(!ip_matches("10.1.2.0/24", "10.1.3.0"));
        assert!(ip_matches("10.1.2.3", "10.1.2.3"));
        assert!(!ip_matches("10.1.2.3", "10.1.2.4"));
        assert!(ip_matches("0.0.0.0/0", "203.0.113.9"));
        assert!(ip_matches("2001:db8::/32", "2001:db8:1234::1"));
        assert!(!ip_matches("2001:db8::/32", "2001:db9::1"));
        // Mixed families and nonsense prefixes never match.
        assert!(!ip_matches("10.0.0.0/8", "::1"));
        assert!(!ip_matches("10.0.0.0/99", "10.0.0.1"));
        assert!(!ip_matches("not-an-ip/8", "10.0.0.1"));
        // A CIDR rule applied to a non-address value fails closed.
        assert!(!ip_matches("10.0.0.0/8", "ten.zero"));
    }

    #[test]
    fn cidr_containment_handles_partial_octet_prefixes() {
        let network: IpAddr = "10.128.0.0".parse().unwrap();
        assert!(cidr_contains(network, 9, "10.129.0.1".parse().unwrap()));
        assert!(!cidr_contains(network, 9, "10.127.0.1".parse().unwrap()));
        assert!(cidr_contains(network, 0, "203.0.113.1".parse().unwrap()));
    }

    #[test]
    fn domain_components_match_positionally_with_wildcards() {
        let with_dc = |rule: DcRule| PolicyRules {
            subject: SubjectRules {
                dc: rule,
                ..SubjectRules::default()
            },
            ..PolicyRules::default()
        };
        let subject = SubjectDn {
            cn: Some("api".into()),
            dc: vec!["corp".into(), "example".into(), "com".into()],
            ..SubjectDn::default()
        };
        let with_dc_subject = PolicyCandidate {
            subject,
            ..candidate()
        };
        let allow = DcRule {
            mode: RuleMode::Allow,
            components: vec!["*".into(), "example".into(), "com".into()],
        };
        assert!(evaluate(&with_dc(allow.clone()), &with_dc_subject).is_ok());
        assert!(evaluate(&with_dc(allow.clone()), &candidate()).is_ok());

        let shorter = DcRule {
            mode: RuleMode::Allow,
            components: vec!["example".into(), "com".into()],
        };
        assert_eq!(
            fields(&evaluate(&with_dc(shorter), &with_dc_subject).unwrap_err()),
            ["subject.dc"]
        );
        assert_eq!(
            evaluate(
                &with_dc(DcRule {
                    mode: RuleMode::Require,
                    components: Vec::new()
                }),
                &candidate()
            )
            .unwrap_err()[0]
                .reason,
            AT_LEAST_ONE_REQUIRED
        );
        assert_eq!(
            evaluate(
                &with_dc(DcRule {
                    mode: RuleMode::Allow,
                    components: Vec::new()
                }),
                &with_dc_subject
            )
            .unwrap_err()[0]
                .reason,
            NO_VALUE_PERMITTED
        );
        let deny = DcRule {
            mode: RuleMode::Deny,
            components: vec!["corp".into(), "*".into(), "com".into()],
        };
        assert!(evaluate(&with_dc(deny), &with_dc_subject).is_err());
    }

    /// A `domainComponent` sequence must match the rule *entirely*, not merely
    /// agree on a common prefix.
    ///
    /// `zip` stops at the shorter of the two sequences, so length equality is
    /// what makes the comparison total. Without it, a subject that extends an
    /// allowed sequence — `corp,example,com` under a rule permitting only
    /// `corp,example` — would satisfy the zipped comparison and escape into a
    /// subtree the policy never granted, which is the whole point of ordered
    /// `dc` matching.
    ///
    /// The `shorter` case in `dc_sequence_rules_match_in_order` does not cover
    /// this: its first components already disagree, so the prefix comparison
    /// fails on its own. These assertions pin the length check itself, and a
    /// mutation run flagged it as unprotected.
    #[test]
    fn adversarial_dc_prefix_agreement_is_not_a_match() {
        let with_dc = |rule: DcRule| PolicyRules {
            subject: SubjectRules {
                dc: rule,
                ..SubjectRules::default()
            },
            ..PolicyRules::default()
        };
        let subject_of = |dc: &[&str]| PolicyCandidate {
            subject: SubjectDn {
                cn: Some("api".into()),
                dc: dc.iter().map(|part| (*part).to_string()).collect(),
                ..SubjectDn::default()
            },
            ..candidate()
        };

        // The subject extends the allowed sequence: every zipped pair agrees,
        // and only the length check rejects it.
        let allow_two = DcRule {
            mode: RuleMode::Allow,
            components: vec!["corp".into(), "example".into()],
        };
        assert_eq!(
            fields(
                &evaluate(
                    &with_dc(allow_two.clone()),
                    &subject_of(&["corp", "example", "com"])
                )
                .unwrap_err()
            ),
            ["subject.dc"],
            "a subject extending the allowed dc sequence must not be permitted"
        );

        // The exact sequence is still accepted, so the rule is not simply
        // rejecting everything.
        assert!(evaluate(&with_dc(allow_two), &subject_of(&["corp", "example"])).is_ok());

        // And the reverse: the rule is longer than the subject, which likewise
        // agrees on the zipped prefix.
        let allow_three = DcRule {
            mode: RuleMode::Allow,
            components: vec!["corp".into(), "example".into(), "com".into()],
        };
        assert_eq!(
            fields(
                &evaluate(&with_dc(allow_three), &subject_of(&["corp", "example"])).unwrap_err()
            ),
            ["subject.dc"],
            "a subject shorter than the allowed dc sequence must not be permitted"
        );

        // Wildcards must not paper over the length difference either.
        let allow_wild = DcRule {
            mode: RuleMode::Allow,
            components: vec!["*".into(), "*".into()],
        };
        assert_eq!(
            fields(
                &evaluate(
                    &with_dc(allow_wild),
                    &subject_of(&["corp", "example", "com"])
                )
                .unwrap_err()
            ),
            ["subject.dc"],
            "wildcards match components, not an arbitrary number of them"
        );
    }

    #[test]
    fn scalar_constraints_cover_every_mode() {
        let with_key = |constraint: Constraint<KeyAlgorithm>| PolicyRules {
            key_algorithms: constraint,
            ..PolicyRules::default()
        };
        let unknown = PolicyCandidate {
            key_algorithm: None,
            ..candidate()
        };
        assert!(evaluate(&with_key(Constraint::default()), &candidate()).is_ok());
        assert_eq!(
            evaluate(&with_key(Constraint::allow([])), &candidate()).unwrap_err()[0].reason,
            NO_VALUE_PERMITTED
        );
        assert!(evaluate(&with_key(Constraint::allow([])), &unknown).is_ok());
        assert!(evaluate(
            &with_key(Constraint::allow([KeyAlgorithm::EcdsaP256])),
            &candidate()
        )
        .is_ok());
        assert_eq!(
            evaluate(
                &with_key(Constraint::allow([KeyAlgorithm::Ed25519])),
                &candidate()
            )
            .unwrap_err()[0]
                .reason,
            "value \"ecdsa-p256\" is not permitted"
        );
        assert_eq!(
            evaluate(
                &with_key(Constraint::require([], [KeyAlgorithm::Ed25519])),
                &unknown
            )
            .unwrap_err()[0]
                .reason,
            REQUIRED_BUT_ABSENT
        );
        assert_eq!(
            evaluate(
                &with_key(Constraint::require([], [KeyAlgorithm::Ed25519])),
                &candidate()
            )
            .unwrap_err()[0]
                .reason,
            "value \"ecdsa-p256\" is not among the required values"
        );
    }

    #[test]
    fn set_constraints_cover_every_mode() {
        let with_eku = |constraint: Constraint<ExtendedKeyUsage>| PolicyRules {
            ext_key_usages: constraint,
            ..PolicyRules::default()
        };
        assert!(evaluate(&with_eku(Constraint::default()), &candidate()).is_ok());
        assert_eq!(
            evaluate(&with_eku(Constraint::allow([])), &candidate()).unwrap_err()[0].reason,
            NO_VALUE_PERMITTED
        );
        assert!(evaluate(
            &with_eku(Constraint::allow([ExtendedKeyUsage::ServerAuth])),
            &candidate()
        )
        .is_ok());
        assert_eq!(
            evaluate(
                &with_eku(Constraint::require(
                    [ExtendedKeyUsage::ServerAuth, ExtendedKeyUsage::ClientAuth],
                    [ExtendedKeyUsage::ClientAuth]
                )),
                &candidate()
            )
            .unwrap_err()[0]
                .reason,
            "required value \"client_auth\" is absent"
        );
    }

    #[test]
    fn basic_constraint_rules_cover_forbid_allow_and_require() {
        let ca_candidate = PolicyCandidate {
            basic_constraints: Some(BasicConstraints {
                ca: true,
                max_path_len: Some(3),
            }),
            ..candidate()
        };
        let forbid = PolicyRules {
            basic_constraints: BasicConstraintRule {
                ca: CaRule::Forbid,
                max_path_len: None,
            },
            ..PolicyRules::default()
        };
        assert!(evaluate(&forbid, &candidate()).is_ok());
        assert_eq!(
            fields(&evaluate(&forbid, &ca_candidate).unwrap_err()),
            ["basic_constraints.ca"]
        );

        let require = PolicyRules {
            basic_constraints: BasicConstraintRule {
                ca: CaRule::Require,
                max_path_len: Some(1),
            },
            ..PolicyRules::default()
        };
        assert_eq!(
            fields(&evaluate(&require, &candidate()).unwrap_err()),
            ["basic_constraints.ca"]
        );
        assert_eq!(
            evaluate(&require, &ca_candidate).unwrap_err()[0].reason,
            "path length 3 exceeds the maximum of 1"
        );
        let unconstrained = PolicyCandidate {
            basic_constraints: Some(BasicConstraints {
                ca: true,
                max_path_len: None,
            }),
            ..candidate()
        };
        assert_eq!(
            evaluate(&require, &unconstrained).unwrap_err()[0].reason,
            "an unconstrained path length is not permitted"
        );
        let allow = PolicyRules {
            basic_constraints: BasicConstraintRule {
                ca: CaRule::Allow,
                max_path_len: None,
            },
            ..PolicyRules::default()
        };
        assert!(evaluate(&allow, &ca_candidate).is_ok());
    }

    #[test]
    fn every_preset_accepts_a_conforming_request_and_rejects_a_violating_one() {
        for name in PolicyPreset::ALL {
            let rules = preset(*name);
            let (good, bad) = preset_fixtures(*name);
            assert!(
                evaluate(&rules, &good).is_ok(),
                "{name} rejected its own conforming candidate: {:?}",
                evaluate(&rules, &good).unwrap_err()
            );
            assert!(
                evaluate(&rules, &bad).is_err(),
                "{name} accepted a violating candidate"
            );
        }
    }

    /// The baseline candidate every preset fixture is derived from.
    fn preset_base() -> PolicyCandidate {
        PolicyCandidate {
            subject: SubjectDn::common_name("subject.example.com"),
            sans: vec![SanEntry::Dns("subject.example.com".into())],
            key_algorithm: Some(KeyAlgorithm::EcdsaP256),
            signature_algorithm: Some(SignatureAlgorithm::Sha256Ecdsa),
            key_usages: vec![KeyUsage::DigitalSignature],
            ext_key_usages: Vec::new(),
            basic_constraints: Some(BasicConstraints {
                ca: false,
                max_path_len: None,
            }),
            ttl_seconds: Some(3600),
        }
    }

    /// The baseline with a specific extended-key-usage set.
    fn with_ekus(usages: &[ExtendedKeyUsage]) -> PolicyCandidate {
        PolicyCandidate {
            ext_key_usages: usages.to_vec(),
            ..preset_base()
        }
    }

    /// A conforming and a violating candidate for each preset.
    pub(crate) fn preset_fixtures(name: PolicyPreset) -> (PolicyCandidate, PolicyCandidate) {
        let ca_bad = PolicyCandidate {
            basic_constraints: Some(BasicConstraints {
                ca: true,
                max_path_len: None,
            }),
            ..preset_base()
        };
        match name {
            PolicyPreset::TlsServer => (with_ekus(&[ExtendedKeyUsage::ServerAuth]), ca_bad),
            PolicyPreset::TlsClient => (
                with_ekus(&[ExtendedKeyUsage::ClientAuth]),
                with_ekus(&[ExtendedKeyUsage::ServerAuth]),
            ),
            PolicyPreset::CodeSigning => (
                with_ekus(&[ExtendedKeyUsage::CodeSigning]),
                with_ekus(&[ExtendedKeyUsage::ServerAuth]),
            ),
            PolicyPreset::Device => (
                with_ekus(&[ExtendedKeyUsage::ClientAuth]),
                with_ekus(&[ExtendedKeyUsage::CodeSigning]),
            ),
            PolicyPreset::User => (
                with_ekus(&[ExtendedKeyUsage::ClientAuth]),
                PolicyCandidate {
                    subject: SubjectDn::default(),
                    ..with_ekus(&[ExtendedKeyUsage::ClientAuth])
                },
            ),
            PolicyPreset::EmailProtection => (
                PolicyCandidate {
                    sans: vec![SanEntry::Email("ops@example.com".into())],
                    ..with_ekus(&[ExtendedKeyUsage::EmailProtection])
                },
                with_ekus(&[ExtendedKeyUsage::EmailProtection]),
            ),
            PolicyPreset::DualPurposeServer => (
                with_ekus(&[ExtendedKeyUsage::ServerAuth, ExtendedKeyUsage::ClientAuth]),
                with_ekus(&[ExtendedKeyUsage::ServerAuth]),
            ),
            PolicyPreset::IntermediateCa => {
                let authority = PolicyCandidate {
                    key_usages: vec![KeyUsage::KeyCertSign, KeyUsage::CrlSign],
                    basic_constraints: Some(BasicConstraints {
                        ca: true,
                        max_path_len: Some(0),
                    }),
                    ..preset_base()
                };
                (
                    PolicyCandidate {
                        sans: Vec::new(),
                        ..authority.clone()
                    },
                    authority,
                )
            }
        }
    }

    #[test]
    fn the_intermediate_preset_switches_every_san_class_off() {
        let rules = preset(PolicyPreset::IntermediateCa);
        for entry in [
            SanEntry::Dns("a.example.com".into()),
            SanEntry::Ip("10.0.0.1".parse().unwrap()),
            SanEntry::Email("a@example.com".into()),
            SanEntry::Uri("https://example.com".into()),
            SanEntry::Upn("a@corp".into()),
        ] {
            let (mut good, _) = preset_fixtures(PolicyPreset::IntermediateCa);
            good.sans = vec![entry];
            let violations = evaluate(&rules, &good).unwrap_err();
            assert_eq!(violations[0].reason, NO_VALUE_PERMITTED);
        }
    }

    #[test]
    fn max_validity_is_layered_on_top_of_the_rules_document() {
        let rules = PolicyRules::default();
        assert!(evaluate_with_max_validity(&rules, Some(7200), &candidate()).is_ok());
        assert!(evaluate_with_max_validity(&rules, None, &candidate()).is_ok());
        let violations = evaluate_with_max_validity(&rules, Some(60), &candidate()).unwrap_err();
        assert_eq!(violations[0].field, "ttl_seconds");
        assert_eq!(
            violations[0].reason,
            "lifetime 3600s exceeds the maximum of 60s"
        );
    }

    #[test]
    fn profile_defaults_are_checked_for_values_but_not_for_presence() {
        let rules = preset(PolicyPreset::TlsServer);
        // Defaults that set nothing are fine even though the policy requires a
        // DNS SAN and a serverAuth EKU: a request supplies those.
        assert!(validate_defaults_against_policy(&ProfileDefaults::default(), &rules).is_ok());

        let conforming = ProfileDefaults {
            key_algorithm: Some(KeyAlgorithm::EcdsaP256),
            ext_key_usages: vec![ExtendedKeyUsage::ServerAuth],
            key_usages: vec![KeyUsage::DigitalSignature],
            ..ProfileDefaults::default()
        };
        assert!(validate_defaults_against_policy(&conforming, &rules).is_ok());

        let conflicting = ProfileDefaults {
            key_algorithm: Some(KeyAlgorithm::Ed25519),
            basic_constraints: Some(BasicConstraints {
                ca: true,
                max_path_len: None,
            }),
            ..ProfileDefaults::default()
        };
        let violations = validate_defaults_against_policy(&conflicting, &rules).unwrap_err();
        assert_eq!(
            fields(&violations),
            ["key_algorithms", "basic_constraints.ca"]
        );
    }

    #[test]
    fn violations_are_reported_in_a_stable_order() {
        let mut rules = preset(PolicyPreset::TlsServer);
        rules.subject.cn = FieldRule::require(["*.internal.test"]);

        let broken = PolicyCandidate {
            sans: Vec::new(),
            key_algorithm: Some(KeyAlgorithm::Ed25519),
            ext_key_usages: Vec::new(),
            basic_constraints: Some(BasicConstraints {
                ca: true,
                max_path_len: None,
            }),
            ..candidate()
        };
        assert_eq!(
            fields(&evaluate(&rules, &broken).unwrap_err()),
            [
                "subject.cn",
                "san.dns",
                "key_algorithms",
                "ext_key_usages",
                "basic_constraints.ca",
            ]
        );
    }

    #[test]
    fn enforce_wraps_violations_into_the_crate_error() {
        let rules = preset(PolicyPreset::TlsServer);
        let bad = PolicyCandidate {
            sans: Vec::new(),
            ext_key_usages: Vec::new(),
            ..candidate()
        };
        match enforce(&rules, &bad).unwrap_err() {
            PkiError::PolicyViolations(violations) => assert_eq!(violations.len(), 2),
            other => panic!("unexpected error {other:?}"),
        }
        assert!(enforce(&PolicyRules::default(), &bad).is_ok());
    }
}

#[cfg(test)]
mod pact {
    //! The wording of a [`PolicyViolation`] reaches operators through the API,
    //! the CLI and the dashboard. These snapshots pin it so a refactor cannot
    //! quietly change what a rejected request says.

    use super::tests::preset_fixtures;
    use super::*;

    #[test]
    fn every_preset_violation_message_is_pinned() {
        let mut rendered = Vec::new();
        for name in PolicyPreset::ALL {
            let (_, bad) = preset_fixtures(*name);
            let violations = evaluate(&preset(*name), &bad).unwrap_err();
            rendered.push(serde_json::json!({
                "preset": name.as_str(),
                "violations": violations,
            }));
        }
        insta::assert_json_snapshot!("preset_violations", rendered);
    }

    #[test]
    fn every_preset_rules_document_is_pinned() {
        let rendered: Vec<_> = PolicyPreset::ALL
            .iter()
            .map(|name| serde_json::json!({ "preset": name.as_str(), "rules": preset(*name) }))
            .collect();
        insta::assert_json_snapshot!("preset_rules", rendered);
    }
}
