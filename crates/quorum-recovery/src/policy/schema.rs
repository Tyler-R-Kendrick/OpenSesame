//! The field rules of `types.ts` (the Zod schemas), applied to a parsed policy:
//! id and base64url shapes, lengths, ranges and instants. A failure names the
//! field and never a value.

use super::{CirclePolicy, Group, Guardian, GuardianCredential, PolicyError};
use crate::encoding::is_b64url_charset;

const DAY: u64 = 86_400;

fn bad<T>(what: &str) -> Result<T, PolicyError> {
    Err(PolicyError::Malformed(format!("{what} is not valid")))
}

fn ok_if(condition: bool, what: &str) -> Result<(), PolicyError> {
    if condition {
        Ok(())
    } else {
        bad(what)
    }
}

/// JavaScript string length: UTF-16 code units, which is what Zod's `.max` counts.
fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `^[A-Za-z0-9._:-]{1,64}$`
fn is_id(text: &str) -> bool {
    (1..=64).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn is_label(text: &str) -> bool {
    (1..=120).contains(&js_len(text))
}

fn is_b64url(text: &str) -> bool {
    text.len() <= 8192 && is_b64url_charset(text)
}

/// `sha256:` and 64 lower-case hex digits.
fn is_digest(text: &str) -> bool {
    text.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Parse `digits` at `text[at..at + width]` as a number.
fn number_at(text: &str, at: usize, width: usize) -> Option<u32> {
    let part = text.get(at..at + width)?;
    if part.bytes().all(|b| b.is_ascii_digit()) {
        part.parse().ok()
    } else {
        None
    }
}

fn is_offset(rest: &str) -> bool {
    if rest == "Z" {
        return true;
    }
    let Some(digits) = rest.strip_prefix(['+', '-']) else {
        return false;
    };
    let digits = digits.replacen(':', "", 1);
    matches!(digits.len(), 2 | 4)
        && digits.bytes().all(|b| b.is_ascii_digit())
        && number_at(&digits, 0, 2).is_some_and(|h| h < 24)
        && (digits.len() == 2 || number_at(&digits, 2, 2).is_some_and(|m| m < 60))
}

/// `YYYY-MM-DDTHH:MM:SS(.fff)?(Z|+HH:MM)`, with a real calendar date.
fn is_instant(text: &str) -> bool {
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        number_at(text, 0, 4),
        number_at(text, 5, 2),
        number_at(text, 8, 2),
        number_at(text, 11, 2),
        number_at(text, 14, 2),
        number_at(text, 17, 2),
    ) else {
        return false;
    };
    let shape = text.as_bytes();
    let punctuation = shape.get(4) == Some(&b'-')
        && shape.get(7) == Some(&b'-')
        && shape.get(10) == Some(&b'T')
        && shape.get(13) == Some(&b':')
        && shape.get(16) == Some(&b':');
    let rest = &text[19..];
    let (fraction, offset) = match rest.strip_prefix('.') {
        Some(after) => {
            let digits = after.bytes().take_while(u8::is_ascii_digit).count();
            (digits > 0, &after[digits..])
        }
        None => (true, rest),
    };
    punctuation
        && fraction
        && (1..=12).contains(&month)
        && (1..=days_in_month(year, month)).contains(&day)
        && hour < 24
        && minute < 60
        && second < 60
        && is_offset(offset)
}

fn check_credential(credential: &GuardianCredential) -> Result<(), PolicyError> {
    ok_if(is_b64url(&credential.credential_id), "a credential id")?;
    ok_if(is_b64url(&credential.public_key), "a credential public key")?;
    ok_if(matches!(credential.alg, -7 | -8), "a credential algorithm")?;
    ok_if(is_label(&credential.label), "a credential label")?;
    ok_if(is_instant(&credential.added_at), "a credential addedAt")
}

fn check_guardian(guardian: &Guardian) -> Result<(), PolicyError> {
    ok_if(is_id(&guardian.id), "a guardian id")?;
    ok_if(is_label(&guardian.name), "a guardian name")?;
    ok_if(
        guardian.contact_ref.as_deref().is_none_or(is_id),
        "a guardian contactRef",
    )?;
    ok_if(is_id(&guardian.custody_domain), "a guardian custodyDomain")?;
    ok_if(
        is_b64url(&guardian.hpke_public_key),
        "a guardian hpkePublicKey",
    )?;
    ok_if(
        (1..=8).contains(&guardian.credentials.len()),
        "a guardian's credential count",
    )?;
    guardian.credentials.iter().try_for_each(check_credential)
}

fn check_group(group: &Group) -> Result<(), PolicyError> {
    ok_if(is_id(&group.id), "a group id")?;
    ok_if((1..=16).contains(&group.threshold), "a group threshold")?;
    ok_if(
        (1..=16).contains(&group.guardian_ids.len()) && group.guardian_ids.iter().all(|g| is_id(g)),
        "a group's members",
    )
}

fn check_origins(origins: &[String]) -> Result<(), PolicyError> {
    ok_if((1..=8).contains(&origins.len()), "the origins")?;
    ok_if(
        origins
            .iter()
            .all(|o| js_len(o) <= 256 && url::Url::parse(o).is_ok()),
        "an origin",
    )
}

fn check_timing(policy: &CirclePolicy) -> Result<(), PolicyError> {
    ok_if(
        (60..=7 * DAY).contains(&policy.approval_window_sec),
        "approvalWindowSec",
    )?;
    ok_if(policy.release_delay_sec <= 90 * DAY, "releaseDelaySec")?;
    ok_if(
        (300..=120 * DAY).contains(&policy.request_lifetime_sec),
        "requestLifetimeSec",
    )
}

/// The `digest` and `signature` fields of a signed policy.
pub(super) fn check_signed(digest: &str, signature: &str) -> Result<(), PolicyError> {
    ok_if(is_digest(digest), "the policy digest")?;
    ok_if(is_b64url(signature), "the policy signature")
}

/// Every field rule of `CirclePolicySchema`.
pub(super) fn check_policy(policy: &CirclePolicy) -> Result<(), PolicyError> {
    ok_if(policy.v == 1, "the policy version")?;
    ok_if(is_id(&policy.circle_id), "the circle id")?;
    ok_if(policy.epoch >= 1, "the epoch")?;
    ok_if(is_label(&policy.label), "the label")?;
    ok_if(is_label(&policy.collection), "the collection")?;
    ok_if((1..=253).contains(&js_len(&policy.rp_id)), "the rpId")?;
    check_origins(&policy.origins)?;
    ok_if(is_b64url(&policy.owner_key), "the ownerKey")?;
    ok_if(
        (1..=16).contains(&policy.group_threshold),
        "the groupThreshold",
    )?;
    ok_if((1..=16).contains(&policy.groups.len()), "the groups")?;
    policy.groups.iter().try_for_each(check_group)?;
    ok_if((1..=32).contains(&policy.guardians.len()), "the guardians")?;
    policy.guardians.iter().try_for_each(check_guardian)?;
    ok_if(
        policy
            .share_commitments
            .iter()
            .all(|(id, digest)| is_id(id) && is_digest(digest)),
        "a share commitment",
    )?;
    ok_if((1..=4).contains(&policy.operations.len()), "the operations")?;
    check_timing(policy)?;
    ok_if(is_instant(&policy.created_at), "createdAt")?;
    ok_if(
        policy
            .supersedes
            .as_ref()
            .is_none_or(|s| s.epoch >= 1 && is_digest(&s.digest)),
        "supersedes",
    )
}

#[cfg(test)]
mod tests {
    use super::{is_digest, is_id, is_instant};

    #[test]
    fn ids_follow_the_schema_regex() {
        assert!(is_id("g-1.a:b_c"));
        assert!(!is_id(""));
        assert!(!is_id("has space"));
        assert!(!is_id(&"x".repeat(65)));
    }

    #[test]
    fn instants_are_real_rfc3339_with_an_offset() {
        for good in [
            "2026-10-10T12:30:45.123Z",
            "2026-10-10T12:30:45Z",
            "2026-10-10T12:30:45+02:00",
            "2024-02-29T00:00:00-0530",
        ] {
            assert!(is_instant(good), "{good}");
        }
        for bad in [
            "2026-10-10",
            "2026-13-10T12:30:45Z",
            "2026-02-29T12:30:45Z",
            "2026-10-10T24:00:00Z",
            "2026-10-10T12:30:45",
            "2026-10-10T12:30:45.Z",
            "2026-10-10 12:30:45Z",
        ] {
            assert!(!is_instant(bad), "{bad}");
        }
    }

    #[test]
    fn digests_are_lower_case_hex() {
        assert!(is_digest(&format!("sha256:{}", "a".repeat(64))));
        assert!(!is_digest(&format!("sha256:{}", "A".repeat(64))));
        assert!(!is_digest("sha256:abc"));
    }
}
