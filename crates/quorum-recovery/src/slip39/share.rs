//! The share mnemonic (SLIP-0039, "Format of the share mnemonic"): 40 bits of
//! header (id 15, ext 1, e 4, GI 4, Gt 4, g 4, I 4, t 4), a padded share value
//! and a 30-bit RS1024 checksum, written as 10-bit words.

use super::error::Slip39Error;
use super::rs1024::{create_checksum, verify_checksum, CHECKSUM_WORDS};
use super::wordlist::{index_of, words};
use crate::secret::Secret;

const RADIX_BITS: usize = 10;
const HEADER_WORDS: usize = 4;
/// 128 bits of value, padded to 13 words, plus the header and the checksum.
pub const MIN_MNEMONIC_WORDS: usize = HEADER_WORDS + 13 + CHECKSUM_WORDS;
const MAX_PADDING_BITS: usize = 8;

/// A decoded share. The value is secret; the header is not.
#[derive(Debug, Clone)]
pub struct Share {
    /// The 15-bit identifier shared by every share of one backup.
    pub identifier: u16,
    /// Whether the backup uses the extendable (empty) salt.
    pub extendable: bool,
    /// PBKDF2 work: 10 000 x 2^e iterations.
    pub iteration_exponent: u8,
    /// Which group this share belongs to.
    pub group_index: u8,
    /// How many groups recover the secret.
    pub group_threshold: u8,
    /// How many groups there are.
    pub group_count: u8,
    /// This share's index within its group.
    pub member_index: u8,
    /// How many shares of the group recover its secret.
    pub member_threshold: u8,
    /// The share value, as many bytes as the master secret.
    pub value: Secret,
}

/// Bits `shift..shift + width` of `value`, `width <= 8`.
fn bits(value: u32, shift: u32, width: u32) -> u8 {
    // Masked to at most eight bits, so the cast cannot lose any.
    #[allow(clippy::cast_possible_truncation)]
    let field = ((value >> shift) & ((1 << width) - 1)) as u8;
    field
}

fn parse_words(mnemonic: &str) -> Result<Vec<u16>, Slip39Error> {
    mnemonic
        .split_whitespace()
        .enumerate()
        .map(|(i, word)| index_of(word).ok_or(Slip39Error::UnknownWord { position: i + 1 }))
        .collect()
}

/// The value bytes in `words` (10 bits each, left-padded with zero bits to a
/// whole number of 16-bit words).
fn value_from(words: &[u16]) -> Result<Vec<u8>, Slip39Error> {
    let total = RADIX_BITS * words.len();
    let padding = total % 16;
    if padding > MAX_PADDING_BITS {
        return Err(Slip39Error::Padding);
    }
    let mut stream = Vec::with_capacity(total);
    for &word in words {
        for bit in (0..RADIX_BITS).rev() {
            stream.push((word >> bit) & 1 == 1);
        }
    }
    let (pad, payload) = stream.split_at(padding);
    if pad.iter().any(|&bit| bit) {
        return Err(Slip39Error::Padding);
    }
    Ok(payload
        .chunks(8)
        .map(|byte| {
            byte.iter()
                .fold(0_u8, |acc, &bit| (acc << 1) | u8::from(bit))
        })
        .collect())
}

/// Decode a mnemonic: the words, the checksum, the header and the value.
///
/// # Errors
/// [`Slip39Error`] naming the rule broken; a word of the share is never quoted.
pub fn decode_share(mnemonic: &str) -> Result<Share, Slip39Error> {
    let words = parse_words(mnemonic)?;
    if words.len() < MIN_MNEMONIC_WORDS {
        return Err(Slip39Error::TooShort {
            min: MIN_MNEMONIC_WORDS,
            got: words.len(),
        });
    }
    let id_exp = (u32::from(words[0]) << 10) | u32::from(words[1]);
    let extendable = (id_exp >> 4) & 1 == 1;
    if !verify_checksum(extendable, &words) {
        return Err(Slip39Error::Checksum);
    }
    let position = (u32::from(words[2]) << 10) | u32::from(words[3]);
    // The identifier is the top 15 bits of a 20-bit value.
    #[allow(clippy::cast_possible_truncation)]
    let identifier = (id_exp >> 5) as u16;
    let share = Share {
        identifier,
        extendable,
        iteration_exponent: bits(id_exp, 0, 4),
        group_index: bits(position, 16, 4),
        group_threshold: bits(position, 12, 4) + 1,
        group_count: bits(position, 8, 4) + 1,
        member_index: bits(position, 4, 4),
        member_threshold: bits(position, 0, 4) + 1,
        value: Secret::new(value_from(
            &words[HEADER_WORDS..words.len() - CHECKSUM_WORDS],
        )?),
    };
    if share.group_threshold > share.group_count {
        return Err(Slip39Error::GroupThreshold);
    }
    Ok(share)
}

fn check_ranges(share: &Share) -> Result<(), Slip39Error> {
    let ok = share.identifier < 1 << 15
        && share.iteration_exponent <= 15
        && share.group_index < 16
        && share.member_index < 16
        && (1..=16).contains(&share.group_count)
        && (1..=share.group_count).contains(&share.group_threshold)
        && (1..=16).contains(&share.member_threshold);
    if ok {
        Ok(())
    } else {
        Err(Slip39Error::Fields)
    }
}

/// Ten-bit words of a header field pair, high word first.
fn two_words(value: u32) -> [u16; 2] {
    // Ten bits each, so the casts cannot lose any.
    #[allow(clippy::cast_possible_truncation)]
    let split = [((value >> 10) & 1023) as u16, (value & 1023) as u16];
    split
}

/// The words of `value`, left-padded with zero bits to a multiple of ten.
fn value_words(value: &[u8]) -> Vec<u16> {
    let word_count = (value.len() * 8).div_ceil(RADIX_BITS);
    let padding = word_count * RADIX_BITS - value.len() * 8;
    let mut stream = vec![false; padding];
    for byte in value {
        for bit in (0..8).rev() {
            stream.push((byte >> bit) & 1 == 1);
        }
    }
    stream
        .chunks(RADIX_BITS)
        .map(|chunk| {
            chunk
                .iter()
                .fold(0_u16, |acc, &bit| (acc << 1) | u16::from(bit))
        })
        .collect()
}

/// Write a share as a mnemonic.
///
/// # Errors
/// [`Slip39Error::Fields`] when a header field is out of range.
pub fn encode_share(share: &Share) -> Result<String, Slip39Error> {
    check_ranges(share)?;
    let id_exp = (u32::from(share.identifier) << 5)
        | (u32::from(share.extendable) << 4)
        | u32::from(share.iteration_exponent);
    let position = (u32::from(share.group_index) << 16)
        | (u32::from(share.group_threshold - 1) << 12)
        | (u32::from(share.group_count - 1) << 8)
        | (u32::from(share.member_index) << 4)
        | u32::from(share.member_threshold - 1);
    let mut data: Vec<u16> = two_words(id_exp).to_vec();
    data.extend(two_words(position));
    data.extend(value_words(share.value.expose()));
    data.extend(create_checksum(share.extendable, &data));
    let list = words();
    Ok(data
        .iter()
        .map(|&index| list[usize::from(index)])
        .collect::<Vec<_>>()
        .join(" "))
}

#[cfg(test)]
mod tests {
    use super::{decode_share, encode_share, Share};
    use crate::secret::Secret;
    use crate::slip39::error::Slip39Error;

    fn sample(len: usize) -> Share {
        Share {
            identifier: 0x1234,
            extendable: true,
            iteration_exponent: 3,
            group_index: 2,
            group_threshold: 3,
            group_count: 4,
            member_index: 5,
            member_threshold: 6,
            value: Secret::new((0..len).map(|i| u8::try_from(i * 7 + 1).unwrap()).collect()),
        }
    }

    #[test]
    fn encodes_and_decodes_the_header_and_value() {
        for len in [16, 32] {
            let share = sample(len);
            let text = encode_share(&share).unwrap();
            assert_eq!(text.split(' ').count(), if len == 16 { 20 } else { 33 });
            let back = decode_share(&text).unwrap();
            assert_eq!(back.identifier, share.identifier);
            assert_eq!(back.extendable, share.extendable);
            assert_eq!(back.iteration_exponent, share.iteration_exponent);
            assert_eq!(back.group_index, share.group_index);
            assert_eq!(back.group_threshold, share.group_threshold);
            assert_eq!(back.group_count, share.group_count);
            assert_eq!(back.member_index, share.member_index);
            assert_eq!(back.member_threshold, share.member_threshold);
            assert_eq!(back.value.expose(), share.value.expose());
        }
    }

    #[test]
    fn is_forgiving_about_case_and_spacing_only() {
        let text = encode_share(&sample(16)).unwrap();
        let loud = format!("  {}\n", text.to_uppercase().replace(' ', "  "));
        assert!(decode_share(&loud).is_ok());
    }

    #[test]
    fn one_changed_word_fails_the_checksum() {
        let text = encode_share(&sample(16)).unwrap();
        let mut words: Vec<&str> = text.split(' ').collect();
        words[5] = if words[5] == "academic" {
            "acid"
        } else {
            "academic"
        };
        assert_eq!(
            decode_share(&words.join(" ")).unwrap_err(),
            Slip39Error::Checksum
        );
    }

    #[test]
    fn unknown_words_and_short_mnemonics_are_refused_without_quoting() {
        let err = decode_share("academic acid notaword").unwrap_err();
        assert_eq!(err, Slip39Error::UnknownWord { position: 3 });
        assert!(!err.to_string().contains("notaword"));
        assert!(matches!(
            decode_share("academic acid acne").unwrap_err(),
            Slip39Error::TooShort { .. }
        ));
    }

    #[test]
    fn out_of_range_fields_are_not_encoded() {
        let mut share = sample(16);
        share.group_threshold = 5;
        assert_eq!(encode_share(&share).unwrap_err(), Slip39Error::Fields);
    }
}
