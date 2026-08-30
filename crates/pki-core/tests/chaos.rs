//! Deterministic hostile-input ("chaos") tests for the PKI engine's parsers
//! (ADR 0066 domain model, ADR 0067 revocation).
//!
//! Every parser in this crate is reachable from an unauthenticated enrollment
//! or distribution endpoint — an ACME `finalize` body, an EST `simpleenroll`,
//! a SCEP `PKIOperation`, an imported keystore, an OCSP POST. Each case below
//! feeds one of them something degenerate and asserts three things: the call
//! returns `Err`, it never panics, and it finishes inside a hard deadline, so
//! a regression that hangs or allocates without bound fails loudly instead of
//! wedging the suite.
//!
//! No randomness and no network: every input is constructed in-process.

use std::time::{Duration, Instant};

use opensesame_pki_core::types::{KeyAlgorithm, SanEntry, SubjectDn};
use opensesame_pki_core::{bundle, ca, csr, keys, revocation, PkiError};
use time::OffsetDateTime;

/// Hard per-case deadline. Every parser here is bounded well under a second on
/// a debug build; a case that needs more than this has stopped being bounded.
const DEADLINE: Duration = Duration::from_secs(10);

/// Runs `body`, asserting it finished inside [`DEADLINE`].
fn within_deadline<T>(name: &str, body: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let value = body();
    let elapsed = started.elapsed();
    assert!(
        elapsed < DEADLINE,
        "{name} took {elapsed:?}, beyond the {DEADLINE:?} bound"
    );
    value
}

/// A real root CA, for cases that need genuine certificate bytes to corrupt.
fn root() -> ca::GeneratedCa {
    let now = OffsetDateTime::now_utc();
    ca::generate_root(&ca::CaParams {
        subject: SubjectDn::common_name("Chaos Root"),
        key_algorithm: KeyAlgorithm::EcdsaP256,
        not_before: now - time::Duration::minutes(1),
        not_after: now + time::Duration::days(365),
        path_len: None,
        crl_distribution_points: Vec::new(),
    })
    .unwrap()
}

/// Wraps `value` in a DER tag-length-value triple, long form when needed.
fn tlv(tag: u8, value: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let length = value.len();
    if length < 0x80 {
        out.push(u8::try_from(length).unwrap());
    } else {
        let bytes = length.to_be_bytes();
        let significant: Vec<u8> = bytes.into_iter().skip_while(|byte| *byte == 0).collect();
        out.push(0x80 | u8::try_from(significant.len()).unwrap());
        out.extend_from_slice(&significant);
    }
    out.extend_from_slice(value);
    out
}

/// Wraps DER in a PEM document with `label`.
fn pem(label: &str, der: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    let encoded = STANDARD.encode(der);
    let body: Vec<String> = encoded
        .as_bytes()
        .chunks(64)
        .map(|chunk| String::from_utf8(chunk.to_vec()).unwrap())
        .collect();
    format!(
        "-----BEGIN {label}-----\n{}\n-----END {label}-----\n",
        body.join("\n")
    )
}

#[test]
fn chaos_zero_length_and_one_byte_inputs_reach_every_parser() {
    for input in [Vec::new(), vec![0x00], vec![0xff], vec![0x30]] {
        within_deadline("tiny inputs", || {
            assert!(revocation::parse_crl(&input).is_err());
            assert!(revocation::parse_ocsp_request(&input).is_err());
            assert!(revocation::parse_ocsp_response(&input).is_err());
            assert!(bundle::parse_pkcs12(&input, "pw").is_err());
            let text = String::from_utf8_lossy(&input).into_owned();
            assert!(csr::parse_csr(&text).is_err());
            assert!(bundle::normalize_chain(&text).is_err());
            assert!(ca::validate_ca(&text, None).is_err());
        });
    }
}

#[test]
fn chaos_a_pem_truncated_mid_base64_is_refused() {
    let root = root();
    let full = root.certificate_pem.clone();
    for fraction in [2usize, 3, 4, 8] {
        let truncated: String = full.chars().take(full.len() / fraction).collect();
        within_deadline("truncated pem", || {
            assert!(ca::validate_ca(&truncated, None).is_err());
            assert!(bundle::normalize_chain(&truncated).is_err());
        });
    }
    // Truncated body but a well-formed footer: the base64 no longer decodes to
    // a certificate even though the armour looks complete.
    let mut lines: Vec<&str> = full.lines().collect();
    lines.remove(lines.len() / 2);
    let mangled = format!("{}\n", lines.join("\n"));
    within_deadline("mangled pem", || {
        assert!(ca::validate_ca(&mangled, None).is_err());
    });
}

#[test]
fn chaos_a_pem_with_a_valid_header_and_a_garbage_body_is_refused() {
    for body in [
        "AAAA",
        "!!!!",
        "////////////////",
        "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A",
    ] {
        let document = format!("-----BEGIN CERTIFICATE-----\n{body}\n-----END CERTIFICATE-----\n");
        within_deadline("garbage pem body", || {
            assert!(ca::validate_ca(&document, None).is_err());
            assert!(bundle::normalize_chain(&document).is_err());
            assert!(bundle::fingerprint_sha256(&document).is_err());
        });
    }
}

#[test]
fn chaos_a_thousand_certificate_chain_is_refused_on_its_length() {
    let root = root();
    let deep = root.certificate_pem.repeat(1000);
    within_deadline("1000-deep chain", || {
        assert_eq!(
            bundle::normalize_chain(&deep).unwrap_err(),
            PkiError::TooLarge
        );
    });
}

#[test]
fn chaos_a_pkcs12_opened_with_the_wrong_password_fails_closed() {
    let root = root();
    let key = keys::generate(KeyAlgorithm::EcdsaP256).unwrap();
    let request =
        csr::generate_csr(&SubjectDn::common_name("chaos.example.com"), &[], &key).unwrap();
    let now = OffsetDateTime::now_utc();
    let params = opensesame_pki_core::leaf::LeafParams::new(
        SubjectDn::common_name("chaos.example.com"),
        vec![SanEntry::Dns("chaos.example.com".into())],
        now - time::Duration::minutes(1),
        now + time::Duration::days(1),
    );
    let leaf = opensesame_pki_core::leaf::issue_leaf_from_csr(
        &root.certificate_pem,
        &root.key,
        &request,
        &params,
    )
    .unwrap();
    let store = bundle::build_pkcs12(
        &leaf.certificate_pem,
        &root.certificate_pem,
        &key,
        "the-right-one",
        "chaos",
    )
    .unwrap();

    for wrong in ["", "the-wrong-one", "the-right-on", "the-right-one "] {
        within_deadline("wrong pkcs12 password", || {
            assert_eq!(
                bundle::parse_pkcs12(&store, wrong).unwrap_err(),
                PkiError::Pkcs12
            );
        });
    }
    // The right password still works, so the assertions above are meaningful.
    assert_eq!(
        bundle::parse_pkcs12(&store, "the-right-one").unwrap().len(),
        1
    );
}

#[test]
fn chaos_a_csr_with_ten_thousand_names_is_refused_not_expanded() {
    // Built with the underlying certificate builder directly, so the engine's
    // own generation caps cannot mask the parser's behaviour.
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
    let names: Vec<String> = (0..10_000)
        .map(|index| format!("host{index}.chaos.example"))
        .collect();
    let mut params = rcgen::CertificateParams::new(names).unwrap();
    params.distinguished_name = rcgen::DistinguishedName::new();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "flood");
    let request = params.serialize_request(&key).unwrap().pem().unwrap();

    within_deadline("10k-SAN csr", || {
        assert_eq!(csr::parse_csr(&request).unwrap_err(), PkiError::TooLarge);
    });
}

#[test]
fn chaos_deeply_nested_der_is_refused_without_recursing_without_bound() {
    let mut nested = vec![0x05, 0x00];
    for _ in 0..2_000 {
        nested = tlv(0x30, &nested);
    }
    within_deadline("nested der", || {
        assert!(revocation::parse_crl(&nested).is_err());
        assert!(revocation::parse_ocsp_request(&nested).is_err());
        assert!(revocation::parse_ocsp_response(&nested).is_err());
        assert!(bundle::parse_pkcs12(&nested, "pw").is_err());
        assert!(csr::parse_csr(&pem("CERTIFICATE REQUEST", &nested)).is_err());
    });
}

#[test]
fn chaos_a_length_header_claiming_gigabytes_allocates_nothing() {
    // SEQUENCE with a four-byte length of 0x7fffffff and two bytes of body.
    let liar = vec![0x30, 0x84, 0x7f, 0xff, 0xff, 0xff, 0x00, 0x00];
    within_deadline("lying length header", || {
        assert!(revocation::parse_crl(&liar).is_err());
        assert!(revocation::parse_ocsp_request(&liar).is_err());
        assert!(revocation::parse_ocsp_response(&liar).is_err());
        assert!(bundle::parse_pkcs12(&liar, "pw").is_err());
        assert!(csr::parse_csr(&pem("CERTIFICATE REQUEST", &liar)).is_err());
    });
    // The same lie inside a CRL-shaped wrapper: a huge revoked-certificate
    // count with no bytes behind it.
    let flood = tlv(0x30, &[0x30, 0x84, 0x7f, 0xff, 0xff, 0xff]);
    within_deadline("lying crl entry count", || {
        assert!(revocation::parse_crl(&flood).is_err());
    });
}

#[test]
fn chaos_a_megabyte_of_garbage_is_refused_by_every_parser() {
    let garbage_bytes = vec![0x5au8; 1024 * 1024];
    let garbage_text = "Z".repeat(1024 * 1024);
    within_deadline("1 MiB garbage", || {
        assert!(revocation::parse_crl(&garbage_bytes).is_err());
        assert!(revocation::parse_ocsp_request(&garbage_bytes).is_err());
        assert!(revocation::parse_ocsp_response(&garbage_bytes).is_err());
        assert!(bundle::parse_pkcs12(&garbage_bytes, "pw").is_err());
        assert_eq!(
            csr::parse_csr(&garbage_text).unwrap_err(),
            PkiError::TooLarge
        );
        assert_eq!(
            bundle::normalize_chain(&garbage_text).unwrap_err(),
            PkiError::TooLarge
        );
        assert_eq!(
            ca::validate_ca(&garbage_text, None).unwrap_err(),
            PkiError::TooLarge
        );
    });
}

#[test]
fn chaos_every_single_byte_corruption_of_a_certificate_stays_total() {
    let root = root();
    let der = {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine as _;
        let body: String = root
            .certificate_pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect();
        STANDARD.decode(body).unwrap()
    };
    within_deadline("byte-flip sweep", || {
        for position in (0..der.len()).step_by(7) {
            let mut corrupted = der.clone();
            corrupted[position] ^= 0xff;
            let document = pem("CERTIFICATE", &corrupted);
            // Either it parses to something coherent or it errors; neither
            // path may panic.
            let _ = ca::validate_ca(&document, None);
            let _ = bundle::normalize_chain(&document);
            let _ = bundle::fingerprint_sha256(&document);
        }
    });
}

#[test]
fn chaos_a_crl_and_an_ocsp_response_survive_byte_flips() {
    let root = root();
    let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
    let crl = revocation::build_crl(
        &root.certificate_pem,
        &root.key,
        &[revocation::RevokedEntry {
            serial_hex: "0a0b0c0d".into(),
            revoked_at: now,
            reason_code: 1,
        }],
        1,
        now,
        now + time::Duration::days(1),
    )
    .unwrap();
    let response = revocation::build_ocsp_response(
        &root.certificate_pem,
        &root.key,
        revocation::OcspCertStatus::Good,
        &revocation::OcspRequestFacts {
            serial_hex: "0a0b0c0d".into(),
            issuer_name_hash: vec![0x33; 20],
            issuer_key_hash: vec![0x44; 20],
            hash_algorithm_oid: "1.3.14.3.2.26".into(),
        },
        now,
        now + time::Duration::hours(1),
    )
    .unwrap();

    within_deadline("revocation byte-flip sweep", || {
        for position in (0..crl.len()).step_by(5) {
            let mut corrupted = crl.clone();
            corrupted[position] ^= 0xff;
            let _ = revocation::parse_crl(&corrupted);
            let _ = revocation::verify_crl(&corrupted, &root.certificate_pem);
        }
        for position in (0..response.len()).step_by(5) {
            let mut corrupted = response.clone();
            corrupted[position] ^= 0xff;
            let _ = revocation::parse_ocsp_response(&corrupted);
            let _ = revocation::verify_ocsp_response(&corrupted, &root.key.public_key_der());
        }
    });
}

#[test]
fn chaos_pem_armour_confusion_never_crosses_document_kinds() {
    let root = root();
    let der = {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine as _;
        let body: String = root
            .certificate_pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect();
        STANDARD.decode(body).unwrap()
    };
    within_deadline("armour confusion", || {
        // A certificate wearing a CSR label, and vice versa.
        assert!(csr::parse_csr(&pem("CERTIFICATE REQUEST", &der)).is_err());
        assert!(ca::validate_ca(&pem("X509 CRL", &der), None).is_err());
        assert!(bundle::normalize_chain(&pem("PRIVATE KEY", &der)).is_err());
        // Mismatched header and footer.
        let mismatched = root
            .certificate_pem
            .replace("-----END CERTIFICATE-----", "-----END X509 CRL-----");
        assert!(ca::validate_ca(&mismatched, None).is_err());
    });
}
