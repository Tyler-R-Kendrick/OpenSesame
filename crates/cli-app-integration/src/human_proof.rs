//! Human proof tokens minted in Pages after PIN or passkey unlock (`oschip1:pin|passkey:` + HMAC).

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Canonical HMAC input: `requestId`, `terminalSessionId`, `respondNonce`, `verb`.
pub(crate) fn human_proof_message(
    request_id: &str,
    terminal_session_id: &str,
    respond_nonce: &str,
    verb: &str,
) -> Vec<u8> {
    let mut msg = Vec::new();
    msg.extend_from_slice(request_id.as_bytes());
    msg.push(0);
    msg.extend_from_slice(terminal_session_id.as_bytes());
    msg.push(0);
    msg.extend_from_slice(respond_nonce.as_bytes());
    msg.push(0);
    msg.extend_from_slice(verb.as_bytes());
    msg
}

pub(crate) fn human_proof_mac_hex(
    pairing_secret: &str,
    request_id: &str,
    terminal_session_id: &str,
    respond_nonce: &str,
    verb: &str,
) -> String {
    let mut mac = HmacSha256::new_from_slice(pairing_secret.as_bytes())
        .expect("pairing secret is a valid HMAC key");
    mac.update(
        &human_proof_message(request_id, terminal_session_id, respond_nonce, verb),
    );
    hex::encode(mac.finalize().into_bytes())
}

fn same_hex(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// Verifies shape, kind, and HMAC over the pending row (constant-time MAC compare).
pub(crate) fn human_proof_verify(
    proof: &str,
    pairing_secret: &str,
    request_id: &str,
    terminal_session_id: &str,
    respond_nonce: &str,
    verb: &str,
) -> bool {
    let t = proof.trim();
    let Some(rest) = t.strip_prefix("oschip1:") else {
        return false;
    };
    let Some((kind, mac_hex)) = rest.split_once(':') else {
        return false;
    };
    if kind != "pin" && kind != "passkey" {
        return false;
    }
    if mac_hex.len() != 64 || !mac_hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    let expected = human_proof_mac_hex(
        pairing_secret,
        request_id,
        terminal_session_id,
        respond_nonce,
        verb,
    );
    same_hex(mac_hex, &expected)
}

/// Mint a human proof string (Pages uses Web Crypto; integration tests call this).
#[must_use]
pub fn mint_human_proof(
    pairing_secret: &str,
    kind: &str,
    request_id: &str,
    terminal_session_id: &str,
    respond_nonce: &str,
    verb: &str,
) -> String {
    let mac = human_proof_mac_hex(
        pairing_secret,
        request_id,
        terminal_session_id,
        respond_nonce,
        verb,
    );
    format!("oschip1:{kind}:{mac}")
}

#[cfg(test)]
pub(crate) fn mint_test_human_proof(
    pairing_secret: &str,
    request_id: &str,
    terminal_session_id: &str,
    respond_nonce: &str,
    verb: &str,
) -> String {
    mint_human_proof(
        pairing_secret,
        "passkey",
        request_id,
        terminal_session_id,
        respond_nonce,
        verb,
    )
}

#[cfg(test)]
pub(crate) const TEST_PAIRING_SECRET: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

#[cfg(test)]
pub(crate) const TEST_HUMAN_PROOF_ZEROS: &str =
    "oschip1:passkey:0000000000000000000000000000000000000000000000000000000000000000";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_all_zeros_mac() {
        assert!(!human_proof_verify(
            TEST_HUMAN_PROOF_ZEROS,
            TEST_PAIRING_SECRET,
            "clr_1",
            "term-a",
            "nonce",
            "read",
        ));
    }

    #[test]
    fn rejects_proof_for_another_request() {
        let proof = mint_test_human_proof(
            TEST_PAIRING_SECRET,
            "clr_1",
            "term-a",
            "nonce",
            "read",
        );
        assert!(!human_proof_verify(
            &proof,
            TEST_PAIRING_SECRET,
            "clr_2",
            "term-a",
            "nonce",
            "read",
        ));
    }

    #[test]
    fn rejects_replayed_proof_after_consume() {
        let mut store = crate::CliAppIntegrationStore::new();
        store.set_now_ms(1_000);
        let (_, req) = store.ensure("term-a", "read", None, false);
        let request_id = req.expect("pending");
        let (respond_nonce, verb) = {
            let row = store.pending.get(&request_id).expect("row");
            (row.respond_nonce.clone(), row.verb.clone())
        };
        let proof = mint_test_human_proof(
            TEST_PAIRING_SECRET,
            &request_id,
            "term-a",
            &respond_nonce,
            &verb,
        );
        assert_eq!(
            store.approve(
                &request_id,
                "term-a",
                &respond_nonce,
                &proof,
                TEST_PAIRING_SECRET,
            ),
            "approved"
        );
        assert_eq!(
            store.approve(
                &request_id,
                "term-a",
                &respond_nonce,
                &proof,
                TEST_PAIRING_SECRET,
            ),
            "wrongSession"
        );
    }
}
