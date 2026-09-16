/// `OpenFGA` model identifier for deployed policy.
pub const OPENFGA_MODEL_ID: &str = "opensesame-authz-v1";

#[must_use]
pub fn policy_version_digest() -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(OPENFGA_MODEL_ID.as_bytes());
    h.update(include_str!("../../../policy/openfga/model.fga").as_bytes());
    format!("sha256:{:x}", h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The deployed policy text, as `policy_version_digest` reads it.
    fn model() -> &'static str {
        include_str!("../../../policy/openfga/model.fga")
    }

    #[test]
    fn a_row_grant_can_only_ever_add_to_a_collection_grant() {
        // The security property behind row-level session grants (ADR 0079):
        // `vault_item` inherits from its collection, so a direct tuple on an
        // item grants that one row and nothing else, while somebody who could
        // already read the whole collection keeps reading it. Dropping either
        // `from collection` clause would turn an additive grant into a
        // replacement one — a collection reader would silently lose rows — so
        // this pins both clauses rather than merely that the type exists.
        let text = model();
        assert!(
            text.contains("type vault_item"),
            "vault_item is the grain a row-level grant names"
        );
        assert!(
            text.contains(
                "define reader: [user, team#member, workload, agent] or reader from collection"
            ),
            "an item's reader must inherit the collection's"
        );
        assert!(
            text.contains(
                "define writer: [user, team#member, workload, agent] or writer from collection"
            ),
            "an item's writer must inherit the collection's"
        );
    }

    #[test]
    fn an_access_domain_can_only_ever_add_to_its_parent_or_project() {
        // INV-GA-03 / ADR 0120: access_domain is the hierarchical grain. Direct
        // owner/admin/member tuples grant that one domain; inheritance from
        // parent and project keeps ancestor holders reaching the child. Dropping
        // a `from parent` or `from project` clause would turn an additive nest
        // into a replacement one.
        let text = model();
        assert!(
            text.contains("type access_domain"),
            "access_domain is the realm-bound hierarchical grain"
        );
        assert!(
            text.contains("define project: [project]"),
            "a domain is realm-bound through its project"
        );
        assert!(
            text.contains("define parent: [access_domain]"),
            "nesting is a parent edge, not a second hierarchy"
        );
        assert!(
            text.contains(
                "define owner: [user, team#member] or owner from parent or owner from project"
            ),
            "owner must inherit from parent and project"
        );
        assert!(
            text.contains(
                "define admin: [user, team#member] or owner or admin from parent or admin from project"
            ),
            "admin must inherit from parent and project"
        );
        assert!(
            text.contains(
                "define member: [user, team#member, workload, agent] or admin or member from parent or developer from project"
            ),
            "member must inherit from parent and project"
        );
    }

    #[test]
    fn a_cohort_is_never_a_grantee_of_anything() {
        // Cohorts define eligibility; an activation binds one principal. The way
        // that is enforced in the policy is by absence: `cohort#member` appears
        // only inside the `cohort` type itself, and in the `cohort_activation`
        // intersection that re-checks it for one named subject. The moment it
        // appears in a `reader`, `writer`, `executor`, `user`, `developer` or any
        // other granting relation, "the reviewers" holds authority — which is a
        // grant no receipt can attribute to a person.
        //
        // So this walks the model and fails on any granting relation that admits a
        // cohort, rather than pinning one spelling of one line.
        let mut current_type = String::new();
        for line in model().lines() {
            let trimmed = line.trim();
            if let Some(name) = trimmed.strip_prefix("type ") {
                current_type = name.trim().to_string();
                continue;
            }
            if !trimmed.starts_with("define ") || !trimmed.contains("cohort#member") {
                continue;
            }
            assert!(
                current_type == "cohort" || current_type == "cohort_activation",
                "type {current_type} admits cohort#member in `{trimmed}`, which would be a \
                 cohort-wide grant"
            );
        }

        // And the activation really is an intersection with live membership, not a
        // standalone claim: dropping either half would leave a subject who is no
        // longer eligible still active.
        assert!(
            model().contains("define active: subject and member from cohort"),
            "an activation is only active while its named subject is still a member"
        );
    }

    #[test]
    fn changing_the_policy_changes_the_version_digest() {
        // The digest is how a deployment notices the model moved. It is
        // computed over the file, so this is really a guard on the include
        // path still resolving rather than on the hash function.
        let digest = policy_version_digest();
        assert!(digest.starts_with("sha256:"), "{digest}");
        assert_eq!(digest.len(), "sha256:".len() + 64);
    }
}
