//! The RS1024 checksum: a Reed-Solomon code over GF(1024) that detects any
//! error touching at most three words (SLIP-0039, "Checksum"). The
//! customization string is fed in first, one US-ASCII value per character.

const GENERATOR: [u32; 10] = [
    0x00e0_e040,
    0x01c1_c080,
    0x0383_8100,
    0x0707_0200,
    0x0e0e_0009,
    0x1c0c_2412,
    0x3808_6c24,
    0x3090_fc48,
    0x21b1_f890,
    0x03f3_f120,
];

/// The words of a share that was not written as extendable.
const CUSTOMIZATION_ORIGINAL: &str = "shamir";
/// The words of an extendable share.
const CUSTOMIZATION_EXTENDABLE: &str = "shamir_extendable";

/// Checksum length in words.
pub const CHECKSUM_WORDS: usize = 3;

fn polymod(values: impl Iterator<Item = u32>) -> u32 {
    let mut chk = 1_u32;
    for value in values {
        let top = chk >> 20;
        chk = ((chk & 0x000f_ffff) << 10) ^ value;
        for (bit, generator) in GENERATOR.iter().enumerate() {
            if (top >> bit) & 1 == 1 {
                chk ^= generator;
            }
        }
    }
    chk
}

fn customization_values(extendable: bool) -> impl Iterator<Item = u32> {
    let text = if extendable {
        CUSTOMIZATION_EXTENDABLE
    } else {
        CUSTOMIZATION_ORIGINAL
    };
    text.bytes().map(u32::from)
}

/// True when the 10-bit `words` (checksum included) verify.
#[must_use]
pub fn verify_checksum(extendable: bool, words: &[u16]) -> bool {
    polymod(customization_values(extendable).chain(words.iter().copied().map(u32::from))) == 1
}

/// The three checksum words for `data`.
#[must_use]
pub fn create_checksum(extendable: bool, data: &[u16]) -> [u16; CHECKSUM_WORDS] {
    let values = customization_values(extendable)
        .chain(data.iter().copied().map(u32::from))
        .chain([0, 0, 0]);
    let poly = polymod(values) ^ 1;
    let mut out = [0_u16; CHECKSUM_WORDS];
    for (i, slot) in out.iter_mut().enumerate() {
        // Ten bits each, so the cast cannot lose any.
        #[allow(clippy::cast_possible_truncation)]
        let word = ((poly >> (10 * (2 - i))) & 1023) as u16;
        *slot = word;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{create_checksum, verify_checksum};

    #[test]
    fn a_checksum_verifies_and_one_changed_word_does_not() {
        for extendable in [false, true] {
            let data: Vec<u16> = (0..17).map(|i| (i * 61 + 7) % 1024).collect();
            let sum = create_checksum(extendable, &data);
            let mut all = data.clone();
            all.extend_from_slice(&sum);
            assert!(verify_checksum(extendable, &all));
            assert!(!verify_checksum(!extendable, &all));
            for at in 0..all.len() {
                let mut bad = all.clone();
                bad[at] = (bad[at] + 1) % 1024;
                assert!(!verify_checksum(extendable, &bad), "word {at}");
            }
        }
    }
}
