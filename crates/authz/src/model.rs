/// OpenFGA model identifier for deployed policy.
pub const OPENFGA_MODEL_ID: &str = "opensesame-authz-v1";

pub fn policy_version_digest() -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(OPENFGA_MODEL_ID.as_bytes());
    h.update(include_str!("../../../policy/openfga/model.fga").as_bytes());
    format!("sha256:{:x}", h.finalize())
}
