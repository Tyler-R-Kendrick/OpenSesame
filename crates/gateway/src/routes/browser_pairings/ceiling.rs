//! What a paired browser may ask for, and what passkey verification adds.
//!
//! A pairing asks either for ciphertext sync or — alone — to join (ADR
//! 0136). Verification then widens a sync pairing to the authenticated
//! browser's routes, and a join pairing to the join routes and nothing else:
//! a browser that came to accept one invite never holds connection, config,
//! relay or agent authority on the way.

/// The ceiling a join ceremony pairs under. It reaches nothing by itself.
const JOIN_CEILING: &str = "host.join";
/// The same ceiling as a pairing stores it.
pub(super) const JOIN_CEILING_JSON: &str = r#"["host.join"]"#;

/// What a verified join grant may do: look up and accept an invite, list
/// open sessions and ask into one.
const JOIN_CAPABILITIES: &[&str] = &["host.delegations.claim", "host.sessions.join"];

pub(super) fn allowed_capabilities(capabilities: &[String]) -> bool {
    if capabilities.len() == 1 && capabilities[0] == JOIN_CEILING {
        return true;
    }
    !capabilities.is_empty()
        && capabilities.len() <= 2
        && capabilities
            .iter()
            .all(|cap| matches!(cap.as_str(), "host.sync.read" | "host.sync.write"))
}

/// Whether approving a pairing that asked for `requested` makes its person a
/// member of the Host's organization. A join pairing never does: accepting
/// one invite or asking into one session is not joining the organization,
/// and the join routes read no organization role.
pub(super) fn provisions_membership(requested: &[String]) -> bool {
    !(requested.len() == 1 && requested[0] == JOIN_CEILING)
}

/// What a passkey check adds to a grant that asked for `requested`.
pub(super) fn verified_ceiling(requested: &[String]) -> Vec<String> {
    if requested.len() == 1 && requested[0] == JOIN_CEILING {
        return JOIN_CAPABILITIES
            .iter()
            .map(|value| (*value).to_owned())
            .collect();
    }
    ["host.agent.observe", "host.agent.control"]
        .into_iter()
        .chain(
            crate::middleware::browser_user_routes::CAPABILITIES
                .iter()
                .copied(),
        )
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn join_stands_alone_and_sync_keeps_its_shape() {
        assert!(allowed_capabilities(&owned(&["host.join"])));
        assert!(allowed_capabilities(&owned(&["host.sync.read"])));
        assert!(allowed_capabilities(&owned(&[
            "host.sync.read",
            "host.sync.write"
        ])));
        for refused in [
            &[][..],
            &["host.join", "host.sync.read"][..],
            &["host.join", "host.join"][..],
            &["host.delegations.claim"][..],
            &["host.sessions.join"][..],
            &["host.connections.write"][..],
        ] {
            assert!(!allowed_capabilities(&owned(refused)), "{refused:?}");
        }
    }

    #[test]
    fn only_a_sync_pairing_makes_a_member() {
        assert!(!provisions_membership(&owned(&["host.join"])));
        assert!(provisions_membership(&owned(&["host.sync.read"])));
    }

    #[test]
    fn a_verified_join_grant_gets_the_join_routes_and_nothing_else() {
        assert_eq!(
            verified_ceiling(&owned(&["host.join"])),
            owned(&["host.delegations.claim", "host.sessions.join"])
        );
        let sync = verified_ceiling(&owned(&["host.sync.read"]));
        for expected in [
            "host.connections.write",
            "host.delegations.claim",
            "host.agent.control",
        ] {
            assert!(sync.iter().any(|cap| cap == expected), "{expected}");
        }
    }
}
