//! Structural soundness (`assertPolicySound` in `policy.ts`): a failure here
//! means the policy cannot be used. Each rule keeps the TypeScript code name.

use std::collections::BTreeSet;

use super::{CirclePolicy, Operation, PolicyError};

fn unsound<T>(code: &'static str, message: impl Into<String>) -> Result<T, PolicyError> {
    Err(PolicyError::Unsound {
        code,
        message: message.into(),
    })
}

fn check_chain(policy: &CirclePolicy) -> Result<(), PolicyError> {
    if policy.epoch == 1 && policy.supersedes.is_some() {
        return unsound("chain", "the first epoch replaces nothing");
    }
    if policy.epoch > 1 && policy.supersedes.as_ref().map(|s| s.epoch) != Some(policy.epoch - 1) {
        return unsound("chain", "a later epoch must name the epoch before it");
    }
    Ok(())
}

fn count(len: usize) -> u64 {
    u64::try_from(len).unwrap_or(u64::MAX)
}

fn has_duplicates<'a>(items: impl Iterator<Item = &'a String>) -> bool {
    let mut seen = BTreeSet::new();
    items.into_iter().any(|item| !seen.insert(item))
}

fn check_graph(policy: &CirclePolicy) -> Result<(), PolicyError> {
    if has_duplicates(policy.guardians.iter().map(|g| &g.id)) {
        return unsound("duplicate_guardian", "guardian ids must be unique");
    }
    let members: Vec<&String> = policy.groups.iter().flat_map(|g| &g.guardian_ids).collect();
    if has_duplicates(members.iter().copied()) {
        return unsound(
            "guardian_in_two_groups",
            "a guardian holds one share, so sits in one group",
        );
    }
    let ids: BTreeSet<&String> = policy.guardians.iter().map(|g| &g.id).collect();
    if members.iter().any(|m| !ids.contains(m)) || ids.iter().any(|id| !members.contains(id)) {
        return unsound("group_membership", "every guardian is in exactly one group");
    }
    if policy.group_threshold > count(policy.groups.len()) {
        return unsound(
            "group_threshold",
            "the group threshold exceeds the group count",
        );
    }
    for group in &policy.groups {
        let size = count(group.guardian_ids.len());
        if group.threshold > size {
            return unsound(
                "member_threshold",
                format!("group {} needs more guardians than it has", group.id),
            );
        }
        if group.threshold == 1 && size > 1 {
            return unsound(
                "member_threshold_one",
                "a 1-of-N group adds no security: use one guardian",
            );
        }
    }
    Ok(())
}

fn check_credentials(policy: &CirclePolicy) -> Result<(), PolicyError> {
    let protects = policy.operations.contains(&Operation::RecoverCollection);
    let mut seen = BTreeSet::new();
    for guardian in &policy.guardians {
        for credential in &guardian.credentials {
            if !seen.insert(&credential.credential_id) {
                return unsound(
                    "shared_credential",
                    "a credential belongs to one guardian only",
                );
            }
        }
        if protects && !guardian.credentials.iter().any(|c| c.prf) {
            return unsound(
                "no_prf",
                format!(
                    "{} has no key that can protect a share (WebAuthn PRF)",
                    guardian.name
                ),
            );
        }
    }
    // A circle that holds shares commits to each; one that only authorizes
    // actions holds none, and says so by committing to nothing.
    let committed: BTreeSet<&String> = policy.share_commitments.keys().collect();
    let expected: BTreeSet<&String> = if protects {
        policy.guardians.iter().map(|g| &g.id).collect()
    } else {
        BTreeSet::new()
    };
    if committed != expected {
        return unsound(
            "commitments",
            "a share commitment is needed for each guardian of a recovering circle, and for no other",
        );
    }
    Ok(())
}

fn host_of(origin: &str) -> String {
    url::Url::parse(origin)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_default()
}

fn check_origins_and_time(policy: &CirclePolicy) -> Result<(), PolicyError> {
    let suffix = format!(".{}", policy.rp_id);
    for origin in &policy.origins {
        let host = host_of(origin);
        if host != policy.rp_id && !host.ends_with(&suffix) {
            return unsound(
                "rp_id",
                format!("{origin} is not under the RP ID {}", policy.rp_id),
            );
        }
    }
    if policy.approval_window_sec > policy.request_lifetime_sec {
        return unsound("lifetime", "the approval window outlasts the request");
    }
    if policy.release_delay_sec >= policy.request_lifetime_sec {
        return unsound(
            "lifetime",
            "the request would expire before any share could be released",
        );
    }
    Ok(())
}

/// The soundness rules, in `policy.ts`'s order: chain, graph, credentials,
/// origins and time.
///
/// # Errors
/// [`PolicyError::Unsound`] with the first rule broken.
pub fn assert_sound(policy: &CirclePolicy) -> Result<(), PolicyError> {
    check_chain(policy)?;
    check_graph(policy)?;
    check_credentials(policy)?;
    check_origins_and_time(policy)
}
