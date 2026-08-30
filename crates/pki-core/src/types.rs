//! Serde domain types shared by every certificate-manager layer (ADR 0066
//! domain model, ADR 0067 revocation).
//!
//! These are the shapes written into the `*_json` columns of migration
//! `0016_certificate_manager.sql` and re-exported to the gateway, the CLI and
//! the agent surfaces. Two properties matter and are pinned by the `pact`
//! tests in this module:
//!
//! * the textual form of every enum is stable, because storage round-trips it
//!   through a `TEXT` column guarded by a `CHECK` constraint;
//! * nothing here is secret-bearing. Every type in this module describes
//!   *public* certificate material or *policy*, so `Clone`, `Serialize` and a
//!   plain `Debug` are safe. Private-key custody lives in [`crate::keys`],
//!   which deliberately implements none of those.

use std::net::IpAddr;

use serde::{Deserialize, Serialize};

use crate::error::PkiError;

/// Declares an enum whose textual form is a storage and wire contract.
///
/// The generated `as_str`/`Display`/`FromStr` triple and the serde renames all
/// read from one literal per variant, so the database `CHECK` value, the JSON
/// value and the CLI value cannot drift apart.
macro_rules! text_enum {
    (
        $(#[$meta:meta])*
        $name:ident { $( $(#[$variant_meta:meta])* $variant:ident => $text:literal ),+ $(,)? }
    ) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
        pub enum $name {
            $(
                $(#[$variant_meta])*
                #[serde(rename = $text)]
                $variant,
            )+
        }

        impl $name {
            /// Every variant, in declaration order.
            pub const ALL: &'static [Self] = &[$(Self::$variant,)+];

            /// The stable textual form used by storage `TEXT` columns, JSON
            /// documents and command-line arguments.
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text,)+
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(self.as_str())
            }
        }

        impl std::str::FromStr for $name {
            type Err = PkiError;

            /// # Errors
            /// Returns [`PkiError::UnknownEnumValue`] when the text does not
            /// name a variant.
            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    $($text => Ok(Self::$variant),)+
                    _ => Err(PkiError::UnknownEnumValue),
                }
            }
        }
    };
}

text_enum! {
    /// Subject key algorithm.
    ///
    /// Textual forms match the `key_algorithm` `CHECK` constraint on
    /// `certificate_authorities` and `issued_certificates`.
    KeyAlgorithm {
        /// RSA with a 2048-bit modulus.
        Rsa2048 => "rsa-2048",
        /// RSA with a 4096-bit modulus.
        Rsa4096 => "rsa-4096",
        /// ECDSA over NIST P-256 (secp256r1).
        EcdsaP256 => "ecdsa-p256",
        /// ECDSA over NIST P-384 (secp384r1).
        EcdsaP384 => "ecdsa-p384",
        /// Ed25519 (RFC 8032).
        Ed25519 => "ed25519",
    }
}

impl KeyAlgorithm {
    /// The signature algorithm this crate uses by default for a key of this
    /// kind, both when signing a certificate and when signing an OCSP
    /// response.
    pub const fn default_signature_algorithm(self) -> SignatureAlgorithm {
        match self {
            Self::Rsa2048 | Self::Rsa4096 => SignatureAlgorithm::Sha256Rsa,
            Self::EcdsaP256 => SignatureAlgorithm::Sha256Ecdsa,
            Self::EcdsaP384 => SignatureAlgorithm::Sha384Ecdsa,
            Self::Ed25519 => SignatureAlgorithm::Ed25519,
        }
    }

    /// Whether `signature` can be produced by a key of this kind.
    pub const fn supports(self, signature: SignatureAlgorithm) -> bool {
        matches!(
            (self, signature),
            (
                Self::Rsa2048 | Self::Rsa4096,
                SignatureAlgorithm::Sha256Rsa
                    | SignatureAlgorithm::Sha384Rsa
                    | SignatureAlgorithm::Sha512Rsa
            ) | (Self::EcdsaP256, SignatureAlgorithm::Sha256Ecdsa)
                | (Self::EcdsaP384, SignatureAlgorithm::Sha384Ecdsa)
                | (Self::Ed25519, SignatureAlgorithm::Ed25519)
        )
    }
}

text_enum! {
    /// Certificate signature algorithm.
    SignatureAlgorithm {
        /// RSASSA-PKCS1-v1_5 with SHA-256 (OID 1.2.840.113549.1.1.11).
        Sha256Rsa => "sha256-rsa",
        /// RSASSA-PKCS1-v1_5 with SHA-384 (OID 1.2.840.113549.1.1.12).
        Sha384Rsa => "sha384-rsa",
        /// RSASSA-PKCS1-v1_5 with SHA-512 (OID 1.2.840.113549.1.1.13).
        Sha512Rsa => "sha512-rsa",
        /// ECDSA with SHA-256 (OID 1.2.840.10045.4.3.2).
        Sha256Ecdsa => "sha256-ecdsa",
        /// ECDSA with SHA-384 (OID 1.2.840.10045.4.3.3).
        Sha384Ecdsa => "sha384-ecdsa",
        /// Ed25519 (OID 1.3.101.112).
        Ed25519 => "ed25519",
    }
}

text_enum! {
    /// A single RFC 5280 §4.2.1.3 key-usage bit.
    KeyUsage {
        /// `digitalSignature`.
        DigitalSignature => "digital_signature",
        /// `contentCommitment`, historically `nonRepudiation`.
        NonRepudiation => "non_repudiation",
        /// `keyEncipherment`.
        KeyEncipherment => "key_encipherment",
        /// `dataEncipherment`.
        DataEncipherment => "data_encipherment",
        /// `keyAgreement`.
        KeyAgreement => "key_agreement",
        /// `keyCertSign`.
        KeyCertSign => "key_cert_sign",
        /// `cRLSign`.
        CrlSign => "crl_sign",
        /// `encipherOnly`.
        EncipherOnly => "encipher_only",
        /// `decipherOnly`.
        DecipherOnly => "decipher_only",
    }
}

text_enum! {
    /// A single RFC 5280 §4.2.1.12 extended-key-usage purpose.
    ExtendedKeyUsage {
        /// `id-kp-serverAuth`.
        ServerAuth => "server_auth",
        /// `id-kp-clientAuth`.
        ClientAuth => "client_auth",
        /// `id-kp-codeSigning`.
        CodeSigning => "code_signing",
        /// `id-kp-emailProtection`.
        EmailProtection => "email_protection",
        /// `id-kp-OCSPSigning`.
        OcspSigning => "ocsp_signing",
        /// `id-kp-timeStamping`.
        TimeStamping => "time_stamping",
        /// `anyExtendedKeyUsage`.
        Any => "any",
    }
}

text_enum! {
    /// How a [`FieldRule`] or [`DcRule`] constrains one subject or SAN field.
    ///
    /// The three-state semantics are the load-bearing part and are implemented
    /// once, in [`crate::policy::evaluate`].
    RuleMode {
        /// The field is unconstrained.
        Unset => "unset",
        /// The field must be present, and must match `values` when those are
        /// non-empty.
        Require => "require",
        /// The field is optional, but any value present must match `values`.
        /// An **empty** `values` list therefore denies every value.
        Allow => "allow",
        /// Any value matching `values` is rejected; everything else passes.
        Deny => "deny",
    }
}

text_enum! {
    /// How a [`Constraint`] restricts a set or scalar of enum values.
    ConstraintMode {
        /// Unconstrained.
        Unset => "unset",
        /// Restricted to `allowed`; an empty `allowed` denies everything.
        Allow => "allow",
        /// Restricted to `allowed`, and every element of `required` must be
        /// present.
        Require => "require",
    }
}

text_enum! {
    /// How a policy treats the `basicConstraints` CA bit.
    CaRule {
        /// The candidate must not be a CA.
        Forbid => "forbid",
        /// The candidate may be a CA.
        Allow => "allow",
        /// The candidate must be a CA.
        Require => "require",
    }
}

text_enum! {
    /// The named policy presets shipped with the engine.
    ///
    /// Textual forms match the `preset` `CHECK` constraint on
    /// `certificate_policies`, minus `custom`, which by definition has no
    /// preset rules to build.
    PolicyPreset {
        /// TLS server certificates.
        TlsServer => "tls_server",
        /// TLS client certificates.
        TlsClient => "tls_client",
        /// Authenticode-style code-signing certificates.
        CodeSigning => "code_signing",
        /// Device / mTLS identity certificates.
        Device => "device",
        /// Human user certificates (smart card / client auth).
        User => "user",
        /// S/MIME e-mail protection certificates.
        EmailProtection => "email_protection",
        /// Certificates usable as both TLS server and TLS client.
        DualPurposeServer => "dual_purpose_server",
        /// Subordinate certificate authorities.
        IntermediateCa => "intermediate_ca",
    }
}

/// An X.501 subject distinguished name, restricted to the attribute types the
/// certificate manager exposes.
///
/// `dc` is an ordered sequence of `domainComponent` values, most significant
/// first (`["example", "com"]` for `DC=example,DC=com`).
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectDn {
    /// `commonName`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cn: Option<String>,
    /// `organizationName`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub o: Option<String>,
    /// `organizationalUnitName`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ou: Option<String>,
    /// `countryName`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub c: Option<String>,
    /// `stateOrProvinceName`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub st: Option<String>,
    /// `localityName`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub l: Option<String>,
    /// `domainComponent` sequence, most significant first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dc: Vec<String>,
}

impl SubjectDn {
    /// A distinguished name carrying only a common name.
    pub fn common_name(cn: impl Into<String>) -> Self {
        Self {
            cn: Some(cn.into()),
            ..Self::default()
        }
    }

    /// Whether every attribute is absent.
    pub fn is_empty(&self) -> bool {
        self.cn.is_none()
            && self.o.is_none()
            && self.ou.is_none()
            && self.c.is_none()
            && self.st.is_none()
            && self.l.is_none()
            && self.dc.is_empty()
    }
}

/// One subject alternative name.
///
/// Serialized externally tagged, so a DNS name is `{"dns": "a.example.com"}`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SanEntry {
    /// `dNSName`.
    Dns(String),
    /// `iPAddress`.
    Ip(IpAddr),
    /// `rfc822Name`.
    Email(String),
    /// `uniformResourceIdentifier`.
    Uri(String),
    /// `otherName` carrying a Microsoft user principal name
    /// (OID 1.3.6.1.4.1.311.20.2.3).
    Upn(String),
}

impl SanEntry {
    /// The SAN class this entry belongs to, matching the key used by
    /// [`SanRules`].
    pub const fn class(&self) -> &'static str {
        match self {
            Self::Dns(_) => "dns",
            Self::Ip(_) => "ip",
            Self::Email(_) => "email",
            Self::Uri(_) => "uri",
            Self::Upn(_) => "upn",
        }
    }

    /// The entry's value rendered as text, for policy matching and display.
    pub fn value(&self) -> String {
        match self {
            Self::Dns(value) | Self::Email(value) | Self::Uri(value) | Self::Upn(value) => {
                value.clone()
            }
            Self::Ip(address) => address.to_string(),
        }
    }
}

/// RFC 5280 §4.2.1.9 basic constraints.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BasicConstraints {
    /// Whether the subject is a certificate authority.
    pub ca: bool,
    /// Maximum number of non-self-issued intermediates that may follow this
    /// certificate. `None` means unconstrained.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_path_len: Option<u8>,
}

/// A three-state rule over one textual field.
///
/// See [`RuleMode`] for the semantics; the evaluator lives in
/// [`crate::policy`].
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldRule {
    /// How `values` is interpreted.
    #[serde(default)]
    pub mode: RuleMode,
    /// Fixed values or `*`-wildcard patterns.
    #[serde(default)]
    pub values: Vec<String>,
}

impl FieldRule {
    /// A rule that permits only the listed patterns.
    pub fn allow<I, S>(values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            mode: RuleMode::Allow,
            values: values.into_iter().map(Into::into).collect(),
        }
    }

    /// A rule that demands the field be present, restricted to the listed
    /// patterns when any are given.
    pub fn require<I, S>(values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            mode: RuleMode::Require,
            values: values.into_iter().map(Into::into).collect(),
        }
    }

    /// A rule that rejects the listed patterns and permits everything else.
    pub fn deny<I, S>(values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            mode: RuleMode::Deny,
            values: values.into_iter().map(Into::into).collect(),
        }
    }
}

/// A [`FieldRule`] applied to one class of subject alternative name.
pub type SanRule = FieldRule;

impl Default for RuleMode {
    fn default() -> Self {
        Self::Unset
    }
}

impl Default for ConstraintMode {
    fn default() -> Self {
        Self::Unset
    }
}

impl Default for CaRule {
    fn default() -> Self {
        Self::Allow
    }
}

/// An ordered-sequence rule over the `domainComponent` attributes of a
/// subject.
///
/// `components` is matched positionally against the candidate's `dc` list,
/// each entry a fixed value or a `*`-wildcard pattern, so
/// `["*", "example", "com"]` accepts `DC=corp,DC=example,DC=com` but not
/// `DC=example,DC=com`.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DcRule {
    /// How `components` is interpreted.
    #[serde(default)]
    pub mode: RuleMode,
    /// The positional pattern sequence.
    #[serde(default)]
    pub components: Vec<String>,
}

/// Per-attribute rules for the certificate subject.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectRules {
    /// Rule for `commonName`.
    #[serde(default)]
    pub cn: FieldRule,
    /// Rule for `organizationName`.
    #[serde(default)]
    pub o: FieldRule,
    /// Rule for `organizationalUnitName`.
    #[serde(default)]
    pub ou: FieldRule,
    /// Rule for `countryName`.
    #[serde(default)]
    pub c: FieldRule,
    /// Rule for `stateOrProvinceName`.
    #[serde(default)]
    pub st: FieldRule,
    /// Rule for `localityName`.
    #[serde(default)]
    pub l: FieldRule,
    /// Rule for the `domainComponent` sequence.
    #[serde(default)]
    pub dc: DcRule,
}

/// Per-class rules for subject alternative names.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SanRules {
    /// Rule for `dNSName` entries; patterns may use `*` wildcards.
    #[serde(default)]
    pub dns: SanRule,
    /// Rule for `iPAddress` entries; patterns may be literal addresses or
    /// CIDR blocks such as `10.0.0.0/8`.
    #[serde(default)]
    pub ip: SanRule,
    /// Rule for `rfc822Name` entries.
    #[serde(default)]
    pub email: SanRule,
    /// Rule for `uniformResourceIdentifier` entries.
    #[serde(default)]
    pub uri: SanRule,
    /// Rule for user-principal-name `otherName` entries.
    #[serde(default)]
    pub upn: SanRule,
}

/// A three-state constraint over a set or scalar of enum values.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(bound(serialize = "T: Serialize", deserialize = "T: Deserialize<'de>"))]
pub struct Constraint<T> {
    /// How `allowed` and `required` are interpreted.
    #[serde(default)]
    pub mode: ConstraintMode,
    /// The permitted values. Empty under [`ConstraintMode::Allow`] denies
    /// everything.
    #[serde(default)]
    pub allowed: Vec<T>,
    /// Values that must be present under [`ConstraintMode::Require`].
    #[serde(default)]
    pub required: Vec<T>,
}

impl<T> Default for Constraint<T> {
    fn default() -> Self {
        Self {
            mode: ConstraintMode::Unset,
            allowed: Vec::new(),
            required: Vec::new(),
        }
    }
}

impl<T> Constraint<T> {
    /// A constraint permitting only `allowed`.
    pub fn allow<I: IntoIterator<Item = T>>(allowed: I) -> Self {
        Self {
            mode: ConstraintMode::Allow,
            allowed: allowed.into_iter().collect(),
            required: Vec::new(),
        }
    }

    /// A constraint permitting only `allowed` and demanding every element of
    /// `required`.
    pub fn require<A: IntoIterator<Item = T>, R: IntoIterator<Item = T>>(
        allowed: A,
        required: R,
    ) -> Self {
        Self {
            mode: ConstraintMode::Require,
            allowed: allowed.into_iter().collect(),
            required: required.into_iter().collect(),
        }
    }
}

/// How a policy treats `basicConstraints`.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BasicConstraintRule {
    /// Whether the candidate may, must, or must not be a CA.
    #[serde(default)]
    pub ca: CaRule,
    /// The largest `pathLenConstraint` a CA candidate may carry. A candidate
    /// asking for an unconstrained path length is rejected when this is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_path_len: Option<u8>,
}

/// The `rules_json` document stored on `certificate_policies`.
///
/// [`Default`] is fully permissive: every field rule and constraint is unset
/// and `basicConstraints` is [`CaRule::Allow`].
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyRules {
    /// Rules for the certificate subject.
    #[serde(default)]
    pub subject: SubjectRules,
    /// Rules for subject alternative names.
    #[serde(default)]
    pub san: SanRules,
    /// Permitted signature algorithms.
    #[serde(default)]
    pub signature_algorithms: Constraint<SignatureAlgorithm>,
    /// Permitted key algorithms.
    #[serde(default)]
    pub key_algorithms: Constraint<KeyAlgorithm>,
    /// Permitted and required key usages.
    #[serde(default)]
    pub key_usages: Constraint<KeyUsage>,
    /// Permitted and required extended key usages.
    #[serde(default)]
    pub ext_key_usages: Constraint<ExtendedKeyUsage>,
    /// Rule for `basicConstraints`.
    #[serde(default)]
    pub basic_constraints: BasicConstraintRule,
}

/// The `defaults_json` document stored on `certificate_profiles`.
///
/// Every field is optional: a profile default only fills in what the request
/// left unspecified. Defaults are validated against the profile's policy at
/// write time by [`crate::policy::validate_defaults_against_policy`].
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileDefaults {
    /// Default certificate lifetime in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<u64>,
    /// Default subject attributes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<SubjectDn>,
    /// Default key algorithm for managed-key issuance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_algorithm: Option<KeyAlgorithm>,
    /// Default signature algorithm.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature_algorithm: Option<SignatureAlgorithm>,
    /// Default key usages.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_usages: Vec<KeyUsage>,
    /// Default extended key usages.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ext_key_usages: Vec<ExtendedKeyUsage>,
    /// Default basic constraints.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub basic_constraints: Option<BasicConstraints>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn every_enum_round_trips_through_its_text_form() {
        for value in KeyAlgorithm::ALL {
            assert_eq!(KeyAlgorithm::from_str(value.as_str()).unwrap(), *value);
            assert_eq!(value.to_string(), value.as_str());
        }
        for value in SignatureAlgorithm::ALL {
            assert_eq!(
                SignatureAlgorithm::from_str(value.as_str()).unwrap(),
                *value
            );
        }
        for value in KeyUsage::ALL {
            assert_eq!(KeyUsage::from_str(value.as_str()).unwrap(), *value);
        }
        for value in ExtendedKeyUsage::ALL {
            assert_eq!(ExtendedKeyUsage::from_str(value.as_str()).unwrap(), *value);
        }
        for value in PolicyPreset::ALL {
            assert_eq!(PolicyPreset::from_str(value.as_str()).unwrap(), *value);
        }
        for value in RuleMode::ALL {
            assert_eq!(RuleMode::from_str(value.as_str()).unwrap(), *value);
        }
        for value in ConstraintMode::ALL {
            assert_eq!(ConstraintMode::from_str(value.as_str()).unwrap(), *value);
        }
        for value in CaRule::ALL {
            assert_eq!(CaRule::from_str(value.as_str()).unwrap(), *value);
        }
    }

    #[test]
    fn unknown_text_is_rejected_rather_than_defaulted() {
        assert_eq!(
            KeyAlgorithm::from_str("rsa-1024").unwrap_err(),
            PkiError::UnknownEnumValue
        );
        assert_eq!(
            PolicyPreset::from_str("custom").unwrap_err(),
            PkiError::UnknownEnumValue
        );
        assert!(serde_json::from_str::<KeyAlgorithm>("\"Rsa2048\"").is_err());
    }

    #[test]
    fn default_policy_rules_are_fully_permissive() {
        let rules = PolicyRules::default();
        assert_eq!(rules.subject.cn.mode, RuleMode::Unset);
        assert_eq!(rules.san.dns.mode, RuleMode::Unset);
        assert_eq!(rules.key_algorithms.mode, ConstraintMode::Unset);
        assert_eq!(rules.ext_key_usages.mode, ConstraintMode::Unset);
        assert_eq!(rules.basic_constraints.ca, CaRule::Allow);
        assert_eq!(rules.basic_constraints.max_path_len, None);
    }

    #[test]
    fn constraint_default_is_unset_for_any_payload_type() {
        let constraint = Constraint::<KeyUsage>::default();
        assert_eq!(constraint.mode, ConstraintMode::Unset);
        assert!(constraint.allowed.is_empty());
        assert!(constraint.required.is_empty());
    }

    #[test]
    fn key_algorithm_signature_pairing_is_enforced() {
        assert_eq!(
            KeyAlgorithm::EcdsaP384.default_signature_algorithm(),
            SignatureAlgorithm::Sha384Ecdsa
        );
        assert!(KeyAlgorithm::Rsa4096.supports(SignatureAlgorithm::Sha512Rsa));
        assert!(!KeyAlgorithm::Ed25519.supports(SignatureAlgorithm::Sha256Rsa));
        assert!(!KeyAlgorithm::EcdsaP256.supports(SignatureAlgorithm::Sha384Ecdsa));
    }

    #[test]
    fn san_entry_reports_its_class_and_value() {
        let entries = [
            SanEntry::Dns("a.example.com".into()),
            SanEntry::Ip("10.1.2.3".parse().unwrap()),
            SanEntry::Email("ops@example.com".into()),
            SanEntry::Uri("https://example.com/x".into()),
            SanEntry::Upn("ops@corp.example".into()),
        ];
        let classes: Vec<_> = entries.iter().map(SanEntry::class).collect();
        assert_eq!(classes, ["dns", "ip", "email", "uri", "upn"]);
        assert_eq!(entries[1].value(), "10.1.2.3");
    }

    #[test]
    fn subject_dn_reports_emptiness_and_builds_from_a_common_name() {
        assert!(SubjectDn::default().is_empty());
        let dn = SubjectDn::common_name("leaf.example.com");
        assert!(!dn.is_empty());
        assert_eq!(dn.cn.as_deref(), Some("leaf.example.com"));
    }

    #[test]
    fn unknown_json_fields_are_rejected_on_stored_documents() {
        assert!(serde_json::from_str::<PolicyRules>(r#"{"subjekt":{}}"#).is_err());
        assert!(serde_json::from_str::<ProfileDefaults>(r#"{"ttl":1}"#).is_err());
    }
}

#[cfg(test)]
mod pact {
    //! Wire contract for the storage layer.
    //!
    //! Every enum below is persisted as `TEXT` guarded by a `CHECK`
    //! constraint in `migrations/0016_certificate_manager.sql` (plan §4.1). A
    //! rename on this side silently breaks that constraint at runtime rather
    //! than at compile time, so the exact strings are asserted here.

    use super::*;

    #[test]
    fn key_algorithm_text_matches_the_ddl_check_values() {
        assert_eq!(
            KeyAlgorithm::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            [
                "rsa-2048",
                "rsa-4096",
                "ecdsa-p256",
                "ecdsa-p384",
                "ed25519"
            ]
        );
        assert_eq!(
            serde_json::to_string(&KeyAlgorithm::EcdsaP256).unwrap(),
            "\"ecdsa-p256\""
        );
    }

    #[test]
    fn policy_preset_text_matches_the_ddl_check_values() {
        assert_eq!(
            PolicyPreset::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            [
                "tls_server",
                "tls_client",
                "code_signing",
                "device",
                "user",
                "email_protection",
                "dual_purpose_server",
                "intermediate_ca",
            ]
        );
    }

    #[test]
    fn signature_key_and_usage_text_forms_are_pinned() {
        assert_eq!(
            SignatureAlgorithm::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            [
                "sha256-rsa",
                "sha384-rsa",
                "sha512-rsa",
                "sha256-ecdsa",
                "sha384-ecdsa",
                "ed25519",
            ]
        );
        assert_eq!(
            KeyUsage::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            [
                "digital_signature",
                "non_repudiation",
                "key_encipherment",
                "data_encipherment",
                "key_agreement",
                "key_cert_sign",
                "crl_sign",
                "encipher_only",
                "decipher_only",
            ]
        );
        assert_eq!(
            ExtendedKeyUsage::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            [
                "server_auth",
                "client_auth",
                "code_signing",
                "email_protection",
                "ocsp_signing",
                "time_stamping",
                "any",
            ]
        );
    }

    #[test]
    fn policy_rules_wire_shape_is_pinned() {
        insta::assert_json_snapshot!(PolicyRules::default());
    }

    #[test]
    fn profile_defaults_wire_shape_is_pinned() {
        let defaults = ProfileDefaults {
            ttl_seconds: Some(86_400),
            subject: Some(SubjectDn {
                cn: Some("leaf.example.com".into()),
                o: Some("OpenSesame".into()),
                dc: vec!["example".into(), "com".into()],
                ..SubjectDn::default()
            }),
            key_algorithm: Some(KeyAlgorithm::EcdsaP256),
            signature_algorithm: Some(SignatureAlgorithm::Sha256Ecdsa),
            key_usages: vec![KeyUsage::DigitalSignature, KeyUsage::KeyEncipherment],
            ext_key_usages: vec![ExtendedKeyUsage::ServerAuth],
            basic_constraints: Some(BasicConstraints {
                ca: false,
                max_path_len: None,
            }),
        };
        insta::assert_json_snapshot!(defaults);
    }

    #[test]
    fn san_entry_wire_shape_is_pinned() {
        insta::assert_json_snapshot!(vec![
            SanEntry::Dns("a.example.com".into()),
            SanEntry::Ip("10.1.2.3".parse().unwrap()),
            SanEntry::Email("ops@example.com".into()),
            SanEntry::Uri("https://example.com/x".into()),
            SanEntry::Upn("ops@corp.example".into()),
        ]);
    }

    #[test]
    fn a_populated_policy_document_round_trips_through_json() {
        let rules = PolicyRules {
            subject: SubjectRules {
                cn: FieldRule::require(["*.example.com"]),
                dc: DcRule {
                    mode: RuleMode::Allow,
                    components: vec!["*".into(), "example".into(), "com".into()],
                },
                ..SubjectRules::default()
            },
            san: SanRules {
                dns: FieldRule::allow(["*.example.com"]),
                ip: FieldRule::deny(["0.0.0.0/0"]),
                ..SanRules::default()
            },
            signature_algorithms: Constraint::allow([SignatureAlgorithm::Sha256Ecdsa]),
            key_algorithms: Constraint::allow([KeyAlgorithm::EcdsaP256]),
            key_usages: Constraint::require(
                [KeyUsage::DigitalSignature, KeyUsage::KeyEncipherment],
                [KeyUsage::DigitalSignature],
            ),
            ext_key_usages: Constraint::require(
                [ExtendedKeyUsage::ServerAuth],
                [ExtendedKeyUsage::ServerAuth],
            ),
            basic_constraints: BasicConstraintRule {
                ca: CaRule::Forbid,
                max_path_len: None,
            },
        };
        let json = serde_json::to_string(&rules).unwrap();
        assert_eq!(serde_json::from_str::<PolicyRules>(&json).unwrap(), rules);
        insta::assert_json_snapshot!("populated_policy_rules", rules);
    }
}
