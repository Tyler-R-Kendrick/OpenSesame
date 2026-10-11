//! SLIP-0039 against the standard's own vectors, read from the one copy in
//! `spec/conformance/slip39/` that the TypeScript reader also reads (ADR 0139).

use opensesame_quorum_recovery::slip39::{self, CombineOptions, Slip39Error};

const VECTORS: &str = include_str!("../../../spec/conformance/slip39/vectors.json");
const WORDLIST: &str = include_str!("../../../spec/conformance/slip39/wordlist.txt");

type Vector = (String, Vec<String>, String, String);

fn vectors() -> Vec<Vector> {
    serde_json::from_str(VECTORS).expect("vectors.json is a list of quadruples")
}

fn trezor() -> CombineOptions<'static> {
    CombineOptions {
        passphrase: "TREZOR",
        max_iteration_exponent: slip39::MAX_ITERATION_EXPONENT,
    }
}

#[test]
fn the_embedded_wordlist_is_the_vendored_file() {
    let file: Vec<&str> = WORDLIST.lines().filter(|l| !l.is_empty()).collect();
    assert_eq!(file.len(), 1024);
    assert_eq!(slip39::wordlist(), &file[..]);
}

#[test]
fn has_every_vector_the_standard_publishes() {
    assert_eq!(vectors().len(), 45);
}

#[test]
fn every_valid_vector_recombines_to_the_published_master_secret() {
    let mut valid = 0;
    for (description, mnemonics, secret, _xprv) in vectors() {
        if secret.is_empty() {
            continue;
        }
        let combined = slip39::combine(&mnemonics, &trezor())
            .unwrap_or_else(|error| panic!("{description}: {error}"));
        assert_eq!(hex::encode(combined.expose()), secret, "{description}");
        valid += 1;
    }
    assert_eq!(valid, 15);
}

#[test]
fn every_invalid_vector_is_refused() {
    let mut invalid = 0;
    for (description, mnemonics, secret, _xprv) in vectors() {
        if !secret.is_empty() {
            continue;
        }
        assert!(
            slip39::combine(&mnemonics, &trezor()).is_err(),
            "{description} must be refused"
        );
        invalid += 1;
    }
    assert_eq!(invalid, 30);
}

/// Refused for the rule the vector is named for, not by accident of another.
#[test]
fn invalid_vectors_fail_for_the_reason_they_are_named_for() {
    let by_number: std::collections::BTreeMap<usize, Vector> = vectors()
        .into_iter()
        .map(|v| {
            let number = v.0.split('.').next().unwrap().parse().unwrap();
            (number, v)
        })
        .collect();
    let refusal = |number: usize| {
        let (_, mnemonics, _, _) = &by_number[&number];
        slip39::combine(mnemonics, &trezor()).unwrap_err()
    };
    for number in [2, 21] {
        assert_eq!(refusal(number), Slip39Error::Checksum, "vector {number}");
    }
    for number in [3, 22] {
        assert_eq!(refusal(number), Slip39Error::Padding, "vector {number}");
    }
    for number in [6, 7, 8, 9, 25, 26, 27, 28] {
        assert_eq!(refusal(number), Slip39Error::Mismatch, "vector {number}");
    }
    for number in [11, 30] {
        assert_eq!(
            refusal(number),
            Slip39Error::DuplicateMember,
            "vector {number}"
        );
    }
    for number in [12, 31] {
        assert_eq!(
            refusal(number),
            Slip39Error::MemberThreshold,
            "vector {number}"
        );
    }
    for number in [13, 32] {
        assert_eq!(refusal(number), Slip39Error::Digest, "vector {number}");
    }
    for number in [14, 15, 33, 34] {
        assert!(
            matches!(refusal(number), Slip39Error::GroupCount { .. }),
            "vector {number}"
        );
    }
    for number in [5, 16, 24, 35] {
        assert!(
            matches!(refusal(number), Slip39Error::GroupSize { .. }),
            "vector {number}"
        );
    }
    assert!(matches!(refusal(39), Slip39Error::TooShort { .. }));
}

#[test]
fn the_passphrase_matters_and_a_wrong_one_gives_a_different_secret() {
    let (_, mnemonics, secret, _) = &vectors()[3];
    let wrong = slip39::combine(mnemonics, &CombineOptions::default()).unwrap();
    assert_ne!(hex::encode(wrong.expose()), *secret);
}
