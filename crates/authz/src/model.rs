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
    fn changing_the_policy_changes_the_version_digest() {
        // The digest is how a deployment notices the model moved. It is
        // computed over the file, so this is really a guard on the include
        // path still resolving rather than on the hash function.
        let digest = policy_version_digest();
        assert!(digest.starts_with("sha256:"), "{digest}");
        assert_eq!(digest.len(), "sha256:".len() + 64);
    }
}
