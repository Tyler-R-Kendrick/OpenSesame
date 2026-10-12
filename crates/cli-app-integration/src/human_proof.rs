//! Human proof tokens minted in Pages (`oschip1:pin:` / `oschip1:passkey:` + 64 hex).

/// Pages mints `oschip1:pin:` / `oschip1:passkey:` + 64 hex (see app-core human-proof).
pub(crate) fn human_proof_valid(proof: &str) -> bool {
    let t = proof.trim();
    let Some(rest) = t.strip_prefix("oschip1:") else {
        return false;
    };
    let Some((kind, mac)) = rest.split_once(':') else {
        return false;
    };
    if kind != "pin" && kind != "passkey" {
        return false;
    }
    mac.len() == 64 && mac.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
pub(crate) const TEST_HUMAN_PROOF: &str =
    "oschip1:passkey:0000000000000000000000000000000000000000000000000000000000000000";
