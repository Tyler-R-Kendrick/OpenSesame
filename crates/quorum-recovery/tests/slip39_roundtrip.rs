//! Generate then combine, and the refusals the vectors do not reach. Randomness
//! is seeded, so a failure reproduces.

use opensesame_quorum_recovery::slip39::{
    self, CombineOptions, GenerateParams, GroupSpec, Slip39Error,
};
use rand::{rngs::StdRng, SeedableRng};

fn group(threshold: u8, count: u8) -> GroupSpec {
    GroupSpec { threshold, count }
}

fn params<'a>(
    group_threshold: u8,
    groups: &'a [GroupSpec],
    secret: &'a [u8],
) -> GenerateParams<'a> {
    GenerateParams {
        group_threshold,
        groups,
        master_secret: secret,
        passphrase: "",
        iteration_exponent: 1,
        extendable: true,
    }
}

fn combine(mnemonics: &[&String]) -> Result<Vec<u8>, Slip39Error> {
    slip39::combine(mnemonics, &CombineOptions::default()).map(|s| s.expose().to_vec())
}

#[test]
fn a_plain_three_of_five_gives_twenty_words_per_128_bit_share() {
    let mut rng = StdRng::seed_from_u64(1);
    let secret = hex::decode("bb54aac4b89dc868ba37d9cc21b2cece").unwrap();
    let groups = [group(3, 5)];
    let made = slip39::generate(&params(1, &groups, &secret), &mut rng).unwrap();
    assert_eq!(made.len(), 1);
    assert_eq!(made[0].len(), 5);
    assert!(made[0].iter().all(|m| m.split(' ').count() == 20));
    let pick = [&made[0][4], &made[0][0], &made[0][2]];
    assert_eq!(combine(&pick).unwrap(), secret);
}

#[test]
fn a_256_bit_secret_gives_33_words_and_honours_the_passphrase() {
    let mut rng = StdRng::seed_from_u64(2);
    let secret: Vec<u8> = (0..32).map(|i| i * 3).collect();
    let groups = [group(2, 3)];
    let mut p = params(1, &groups, &secret);
    p.passphrase = "correct horse";
    let made = slip39::generate(&p, &mut rng).unwrap();
    assert!(made[0][0].split(' ').count() == 33);
    let pick = [&made[0][1], &made[0][2]];
    let with = CombineOptions {
        passphrase: "correct horse",
        ..CombineOptions::default()
    };
    assert_eq!(slip39::combine(&pick, &with).unwrap().expose(), &secret[..]);
    assert_ne!(combine(&pick).unwrap(), secret);
}

#[test]
fn the_original_salt_format_round_trips_too() {
    let mut rng = StdRng::seed_from_u64(3);
    let secret = vec![0x5a; 16];
    let groups = [group(2, 2)];
    let mut p = params(1, &groups, &secret);
    p.extendable = false;
    let made = slip39::generate(&p, &mut rng).unwrap();
    assert!(!slip39::describe(&made[0][0]).unwrap().extendable);
    assert_eq!(combine(&[&made[0][0], &made[0][1]]).unwrap(), secret);
}

#[test]
fn two_levels_each_with_its_own_member_threshold() {
    let mut rng = StdRng::seed_from_u64(4);
    let secret: Vec<u8> = (100..132).collect();
    let groups = [group(1, 1), group(3, 5), group(2, 3)];
    let made = slip39::generate(&params(2, &groups, &secret), &mut rng).unwrap();
    let pick = [
        &made[1][0],
        &made[1][2],
        &made[1][4],
        &made[2][1],
        &made[2][2],
    ];
    assert_eq!(combine(&pick).unwrap(), secret);
}

#[test]
fn one_share_too_few_one_group_too_few_and_too_many_are_refused() {
    let mut rng = StdRng::seed_from_u64(5);
    let secret = vec![1_u8; 16];
    let groups = [group(2, 3), group(2, 3)];
    let made = slip39::generate(&params(2, &groups, &secret), &mut rng).unwrap();
    let (g0, g1) = (&made[0], &made[1]);
    assert!(matches!(
        combine(&[&g0[0], &g0[1]]).unwrap_err(),
        Slip39Error::GroupCount { .. }
    ));
    assert!(matches!(
        combine(&[&g0[0], &g0[1], &g1[0]]).unwrap_err(),
        Slip39Error::GroupSize {
            expected: 2,
            got: 1
        }
    ));
    assert!(matches!(
        combine(&[&g0[0], &g0[1], &g0[2], &g1[0]]).unwrap_err(),
        Slip39Error::GroupSize { expected: 2, .. }
    ));
}

#[test]
fn shares_of_two_backups_do_not_combine() {
    let mut rng = StdRng::seed_from_u64(6);
    let secret = vec![2_u8; 16];
    let groups = [group(2, 3)];
    let a = slip39::generate(&params(1, &groups, &secret), &mut rng).unwrap();
    let b = slip39::generate(&params(1, &groups, &secret), &mut rng).unwrap();
    assert!(combine(&[&a[0][0], &b[0][1]]).is_err());
}

#[test]
fn generation_refuses_what_the_standard_does_not_allow() {
    let mut rng = StdRng::seed_from_u64(7);
    let secret = vec![3_u8; 16];
    let one_of_three = [group(1, 3)];
    assert!(slip39::generate(&params(1, &one_of_three, &secret), &mut rng).is_err());
    let two_of_three = [group(2, 3)];
    assert!(slip39::generate(&params(1, &two_of_three, &[0; 15]), &mut rng).is_err());
    assert!(slip39::generate(&params(1, &two_of_three, &[0; 17]), &mut rng).is_err());
    assert!(slip39::generate(&params(2, &two_of_three, &secret), &mut rng).is_err());
    let mut bad_passphrase = params(1, &two_of_three, &secret);
    bad_passphrase.passphrase = "pässword";
    assert_eq!(
        slip39::generate(&bad_passphrase, &mut rng).unwrap_err(),
        Slip39Error::Passphrase
    );
}

#[test]
fn a_share_asking_for_more_work_than_the_caller_allows_is_refused() {
    let mut rng = StdRng::seed_from_u64(8);
    let secret = vec![4_u8; 16];
    let groups = [group(2, 2)];
    let mut p = params(1, &groups, &secret);
    p.iteration_exponent = 4;
    let made = slip39::generate(&p, &mut rng).unwrap();
    let pick = [&made[0][0], &made[0][1]];
    let strict = CombineOptions {
        passphrase: "",
        max_iteration_exponent: 2,
    };
    assert_eq!(
        slip39::combine(&pick, &strict).unwrap_err(),
        Slip39Error::IterationExponent { got: 4, limit: 2 }
    );
    let allowed = CombineOptions {
        max_iteration_exponent: 4,
        ..CombineOptions::default()
    };
    assert_eq!(
        slip39::combine(&pick, &allowed).unwrap().expose(),
        &secret[..]
    );
}

#[test]
fn any_single_changed_word_is_caught_by_the_checksum() {
    let mut rng = StdRng::seed_from_u64(9);
    let groups = [group(2, 3)];
    let made = slip39::generate(&params(1, &groups, &[5; 16]), &mut rng).unwrap();
    let words: Vec<&str> = made[0][0].split(' ').collect();
    for at in [0, 5, 10, words.len() - 1] {
        let mut changed = words.clone();
        changed[at] = if changed[at] == "academic" {
            "acid"
        } else {
            "academic"
        };
        assert_eq!(
            slip39::decode_share(&changed.join(" ")).unwrap_err(),
            Slip39Error::Checksum
        );
    }
}
