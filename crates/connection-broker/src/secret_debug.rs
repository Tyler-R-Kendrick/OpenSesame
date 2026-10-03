//! `Debug` for the wire types that carry a bearer, once (ADR 0155).
//!
//! `#[derive(Debug)]` prints every field, so a mint response or a claim request
//! would put its token in any `{:?}`, `tracing` field or panic message handed
//! to it. Each impl prints what is metadata and `[REDACTED]` for what is not.
//! They sit apart from the types because `delegation.rs` and `model.rs` are at
//! their size ledger (ADR 0093).

use std::fmt;

use crate::delegation::{ClaimOfferRequest, MintedOffer};
use crate::model::DerivedMaterialization;

impl fmt::Debug for MintedOffer {
    /// The claim token and the user code are shown once, at mint, and nowhere after.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MintedOffer")
            .field("offer", &self.offer)
            .field("claim_token", &"[REDACTED]")
            .field("user_code", &"[REDACTED]")
            .finish()
    }
}

impl fmt::Debug for ClaimOfferRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClaimOfferRequest")
            .field("claim_token", &"[REDACTED]")
            .field("user_code", &"[REDACTED]")
            .field("accepted_item_ids", &self.accepted_item_ids)
            .finish()
    }
}

impl fmt::Debug for DerivedMaterialization {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DerivedMaterialization")
            .field("connection_id", &self.connection_id)
            .field("provider_id", &self.provider_id)
            .field("kind", &self.kind)
            .field("derived_token", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .field("subject", &self.subject)
            .field("actor", &self.actor)
            .field("issued_at", &self.issued_at)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delegation::OfferView;

    #[test]
    fn a_minted_offer_prints_neither_token_nor_code() {
        let minted = MintedOffer {
            offer: OfferView {
                id: "offer-1".into(),
                state: "pending".into(),
                manifest_digest: "digest".into(),
                expires_at: "2030-01-01T00:00:00Z".into(),
                items: Vec::new(),
            },
            claim_token: "osc_claim-12345".into(),
            user_code: "WXYZ-6789".into(),
        };
        let shown = format!("{minted:?}");
        assert!(
            shown.contains("[REDACTED]") && shown.contains("offer-1"),
            "{shown}"
        );
        for leaked in ["osc_claim-12345", "WXYZ-6789"] {
            assert!(!shown.contains(leaked), "{leaked} in {shown}");
        }
    }

    #[test]
    fn a_claim_request_prints_no_token() {
        let request = ClaimOfferRequest {
            claim_token: "osc_claim-12345".into(),
            user_code: "WXYZ-6789".into(),
            accepted_item_ids: vec!["item-1".into()],
        };
        let shown = format!("{request:?}");
        assert!(
            shown.contains("[REDACTED]") && shown.contains("item-1"),
            "{shown}"
        );
        for leaked in ["osc_claim-12345", "WXYZ-6789"] {
            assert!(!shown.contains(leaked), "{leaked} in {shown}");
        }
    }

    #[test]
    fn a_derived_materialization_prints_no_token() {
        let derived = DerivedMaterialization {
            connection_id: "conn-1".into(),
            provider_id: "github".into(),
            kind: "github_app_installation".into(),
            derived_token: "ghs_derived-12345".into(),
            expires_at: "2030-01-01T00:00:00Z".into(),
            subject: "user:a".into(),
            actor: "agent:b".into(),
            issued_at: "2029-12-31T23:00:00Z".into(),
        };
        let shown = format!("{derived:?}");
        assert!(
            shown.contains("[REDACTED]") && shown.contains("conn-1"),
            "{shown}"
        );
        assert!(!shown.contains("ghs_derived-12345"), "{shown}");
    }
}
