//! Property tests for the PKI engine (ADR 0066 domain model, ADR 0067
//! revocation).
//!
//! Two families of invariant:
//!
//! * **Totality.** Every parser reachable from an unauthenticated endpoint is
//!   a total function over arbitrary bytes — it returns `Result`, and never
//!   panics, for any input `proptest` can produce.
//! * **Determinism.** Policy evaluation is a pure function of `(rules,
//!   candidate)`: the same pair always yields the same verdict and the same
//!   violation list, so two replicas of the gateway can never disagree about
//!   whether a request is permitted.

use opensesame_pki_core::policy::{self, PolicyCandidate};
use opensesame_pki_core::types::{
    BasicConstraints, ExtendedKeyUsage, FieldRule, KeyAlgorithm, KeyUsage, PolicyPreset,
    PolicyRules, RuleMode, SanEntry, SignatureAlgorithm, SubjectDn, SubjectRules,
};
use opensesame_pki_core::{bundle, ca, csr, revocation};
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// `parse_csr` is total over arbitrary text.
    #[test]
    fn property_parse_csr_never_panics(input in ".{0,4096}") {
        let _ = csr::parse_csr(&input);
    }

    /// `parse_csr` is total over arbitrary bytes wearing CSR armour, which is
    /// the shape an ACME or EST enrollment actually delivers.
    #[test]
    fn property_parse_csr_never_panics_on_armoured_bytes(bytes in proptest::collection::vec(any::<u8>(), 0..2048)) {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine as _;

        let document = format!(
            "-----BEGIN CERTIFICATE REQUEST-----\n{}\n-----END CERTIFICATE REQUEST-----\n",
            STANDARD.encode(&bytes)
        );
        let _ = csr::parse_csr(&document);
    }

    /// `parse_pkcs12` is total over arbitrary bytes and arbitrary passwords.
    #[test]
    fn property_parse_pkcs12_never_panics(
        bytes in proptest::collection::vec(any::<u8>(), 0..4096),
        password in ".{0,64}",
    ) {
        let _ = bundle::parse_pkcs12(&bytes, &password);
    }

    /// `parse_crl` and `verify_crl` are total over arbitrary bytes.
    #[test]
    fn property_parse_crl_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..4096)) {
        let _ = revocation::parse_crl(&bytes);
        let _ = revocation::verify_crl(&bytes, "");
    }

    /// The OCSP request and response parsers are total over arbitrary bytes.
    #[test]
    fn property_parse_ocsp_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..4096)) {
        let _ = revocation::parse_ocsp_request(&bytes);
        let _ = revocation::parse_ocsp_response(&bytes);
        let _ = revocation::verify_ocsp_response(&bytes, &bytes);
    }

    /// Chain normalization and the certificate reader are total over arbitrary
    /// text.
    #[test]
    fn property_chain_and_certificate_readers_never_panic(input in ".{0,4096}") {
        let _ = bundle::normalize_chain(&input);
        let _ = bundle::fingerprint_sha256(&input);
        let _ = bundle::verify_sans(&input, &[SanEntry::Dns("x.example.com".into())]);
        let _ = ca::validate_ca(&input, None);
    }

    /// Policy evaluation is deterministic and total: the same inputs always
    /// produce the same verdict, whatever names and usages they carry.
    #[test]
    fn property_policy_evaluation_is_deterministic(
        preset_index in 0usize..PolicyPreset::ALL.len(),
        common_name in ".{0,128}",
        dns_names in proptest::collection::vec(".{0,64}", 0..8),
        usage_bits in any::<u16>(),
        eku_bits in any::<u8>(),
        is_ca in any::<bool>(),
        path_len in proptest::option::of(any::<u8>()),
    ) {
        let rules = policy::preset(PolicyPreset::ALL[preset_index]);
        let candidate = PolicyCandidate {
            subject: if common_name.is_empty() {
                SubjectDn::default()
            } else {
                SubjectDn::common_name(common_name)
            },
            sans: dns_names.into_iter().map(SanEntry::Dns).collect(),
            key_algorithm: Some(KeyAlgorithm::ALL[usize::from(usage_bits) % KeyAlgorithm::ALL.len()]),
            signature_algorithm: Some(
                SignatureAlgorithm::ALL[usize::from(eku_bits) % SignatureAlgorithm::ALL.len()],
            ),
            key_usages: KeyUsage::ALL
                .iter()
                .enumerate()
                .filter(|(index, _)| usage_bits & (1 << index) != 0)
                .map(|(_, usage)| *usage)
                .collect(),
            ext_key_usages: ExtendedKeyUsage::ALL
                .iter()
                .enumerate()
                .filter(|(index, _)| eku_bits & (1 << index) != 0)
                .map(|(_, usage)| *usage)
                .collect(),
            basic_constraints: Some(BasicConstraints { ca: is_ca, max_path_len: path_len }),
            ttl_seconds: Some(3600),
        };
        let first = policy::evaluate(&rules, &candidate);
        let second = policy::evaluate(&rules, &candidate);
        prop_assert_eq!(first, second);
    }

    /// An unset policy accepts every candidate: the permissive default can
    /// never be the thing that rejects a request.
    #[test]
    fn property_the_default_policy_accepts_everything(
        common_name in ".{0,128}",
        dns_names in proptest::collection::vec(".{0,64}", 0..8),
        is_ca in any::<bool>(),
    ) {
        let candidate = PolicyCandidate {
            subject: SubjectDn::common_name(common_name),
            sans: dns_names.into_iter().map(SanEntry::Dns).collect(),
            key_usages: KeyUsage::ALL.to_vec(),
            ext_key_usages: ExtendedKeyUsage::ALL.to_vec(),
            basic_constraints: Some(BasicConstraints { ca: is_ca, max_path_len: None }),
            ..PolicyCandidate::default()
        };
        prop_assert!(policy::evaluate(&PolicyRules::default(), &candidate).is_ok());
    }

    /// `allow` with an empty value list denies every non-empty value, and
    /// `deny` with an empty list denies none — the two ends of the three-state
    /// asymmetry, checked over arbitrary names.
    #[test]
    fn property_empty_allow_denies_and_empty_deny_permits(name in "[a-z][a-z0-9.-]{0,40}") {
        let candidate = PolicyCandidate {
            subject: SubjectDn::common_name(name),
            ..PolicyCandidate::default()
        };
        let deny_all = PolicyRules {
            subject: SubjectRules {
                cn: FieldRule::allow(Vec::<String>::new()),
                ..SubjectRules::default()
            },
            ..PolicyRules::default()
        };
        let permit_all = PolicyRules {
            subject: SubjectRules {
                cn: FieldRule::deny(Vec::<String>::new()),
                ..SubjectRules::default()
            },
            ..PolicyRules::default()
        };
        prop_assert!(policy::evaluate(&deny_all, &candidate).is_err());
        prop_assert!(policy::evaluate(&permit_all, &candidate).is_ok());
    }

    /// A `deny` rule and an `allow` rule over the same pattern set partition
    /// the value space: exactly one of them accepts any given name.
    #[test]
    fn property_allow_and_deny_over_one_pattern_are_complementary(
        name in "[a-z][a-z0-9-]{0,20}\\.(example|evil)\\.(com|test)",
    ) {
        let candidate = PolicyCandidate {
            subject: SubjectDn::common_name(name),
            ..PolicyCandidate::default()
        };
        let with_mode = |mode: RuleMode| PolicyRules {
            subject: SubjectRules {
                cn: FieldRule {
                    mode,
                    values: vec!["*.example.com".into()],
                },
                ..SubjectRules::default()
            },
            ..PolicyRules::default()
        };
        let allowed = policy::evaluate(&with_mode(RuleMode::Allow), &candidate).is_ok();
        let denied = policy::evaluate(&with_mode(RuleMode::Deny), &candidate).is_ok();
        prop_assert_ne!(allowed, denied);
    }

    /// Every enum this crate persists as `TEXT` survives a round trip through
    /// its textual form, for any variant.
    #[test]
    fn property_text_enums_round_trip(index in 0usize..64) {
        use std::str::FromStr as _;

        let algorithm = KeyAlgorithm::ALL[index % KeyAlgorithm::ALL.len()];
        prop_assert_eq!(KeyAlgorithm::from_str(algorithm.as_str()).unwrap(), algorithm);
        let usage = KeyUsage::ALL[index % KeyUsage::ALL.len()];
        prop_assert_eq!(KeyUsage::from_str(usage.as_str()).unwrap(), usage);
        let eku = ExtendedKeyUsage::ALL[index % ExtendedKeyUsage::ALL.len()];
        prop_assert_eq!(ExtendedKeyUsage::from_str(eku.as_str()).unwrap(), eku);
        let preset = PolicyPreset::ALL[index % PolicyPreset::ALL.len()];
        prop_assert_eq!(PolicyPreset::from_str(preset.as_str()).unwrap(), preset);
    }
}
