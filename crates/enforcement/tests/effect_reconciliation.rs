//! What the passage of time alone is allowed to settle.
//!
//! `effect_ledger.rs` covers the reports: who may make one, about what, and
//! what happens when one contradicts the demand. This file covers the case
//! where *nothing* reports and the budget runs out anyway, because that is
//! where the three observability levels stop being a label and start deciding
//! whether an operator is paged.
//!
//! The three answers are deliberately different, and each platform is walked
//! through the real path — the catalogue, then the grant preflight, then the
//! ledger — rather than a hand-built descriptor, so what gets judged is the
//! guarantee this repository actually publishes:
//!
//! - A reported guarantee promised a report. The budget passing with nothing
//!   recorded is a fault in the enforcement path, not a missed deadline, so it
//!   diverges.
//! - An inferred guarantee never promised one. We set the lifetime, and the
//!   budget passing is the whole of the evidence that mechanism was ever going
//!   to offer, so it converges.
//!
//! Collapsing the two would either cry wolf about every provider token or stay
//! silent about a broker that went quiet.

use opensesame_enforcement::grant::{GrantTerms, OfflineUse};
use opensesame_enforcement::{
    catalog, preflight_grant, Dimension, Divergence, EffectLedger, Observability, Reconciliation,
};

/// The value is handed to the subject, so these terms demand no isolation —
/// which is what lets a minted-credential platform be admitted at all.
const EXPORTED: GrantTerms = GrantTerms {
    offline_use: OfflineUse::Forbidden,
    raw_credential_export: true,
};

fn ledger_for(platform: &str, now_seconds: u64) -> EffectLedger {
    let catalog = catalog().expect("the catalogue audits clean");
    let descriptor = catalog.find(platform).expect("platform is catalogued");
    preflight_grant(EXPORTED, descriptor)
        .expect("this platform can carry the exported terms")
        .open_ledger(now_seconds)
}

#[test]
fn an_inferred_guarantee_converges_on_its_budget_and_a_reported_one_does_not() {
    // Both dimensions belong to the same provider on the same platform, and
    // nothing has reported on either. The only thing separating them is what
    // each mechanism claimed it would tell us.
    let ledger = ledger_for("host-minted-token-revocable", 0);

    let expiry = ledger.effect(Dimension::Expiry).expect("expiry is tracked");
    assert_eq!(expiry.guarantee().observability, Observability::Inferred);
    let budget = expiry
        .guarantee()
        .latency
        .budget_seconds()
        .expect("a provider TTL states a bound");
    assert!(matches!(
        expiry.reconcile(u64::from(budget)),
        Reconciliation::Awaiting { .. }
    ));
    assert_eq!(
        expiry.reconcile(u64::from(budget) + 1),
        Reconciliation::Converged
    );

    let termination = ledger
        .effect(Dimension::Termination)
        .expect("termination is tracked");
    assert_eq!(
        termination.guarantee().observability,
        Observability::Reported
    );
    let budget = termination
        .guarantee()
        .latency
        .budget_seconds()
        .expect("a revocation call states a bound");
    assert!(matches!(
        termination.reconcile(u64::from(budget)),
        Reconciliation::Awaiting { .. }
    ));
    assert!(matches!(
        termination.reconcile(u64::from(budget) + 1),
        Reconciliation::Diverged(Divergence::Overdue { .. })
    ));
}

#[test]
fn a_provider_that_offers_no_revocation_is_refused_rather_than_tracked() {
    // The companion to the above: `host-minted-token` has no termination story
    // and every grant is revocable, so there is no ledger entry to go overdue
    // because there is no grant.
    let catalog = catalog().expect("the catalogue audits clean");
    let descriptor = catalog
        .find("host-minted-token")
        .expect("the non-revocable minted platform is catalogued");
    let refusal =
        preflight_grant(EXPORTED, descriptor).expect_err("a grant nothing can pull is not one");
    assert!(refusal.cites_unsupported());
    assert_eq!(
        refusal
            .unsupported()
            .iter()
            .map(|response| response.dimension)
            .collect::<Vec<_>>(),
        vec![Dimension::Termination]
    );
}

#[test]
fn a_ledger_reconciled_before_it_was_opened_does_not_look_overdue() {
    // The caller supplies the clock, so nothing stops a reading older than the
    // one the ledger opened on. Saturating rather than wrapping is what keeps
    // that from presenting as a very old, very overdue demand.
    let ledger = ledger_for("host-minted-token-revocable", 1_700_000_000);
    let expiry = ledger.effect(Dimension::Expiry).expect("expiry is tracked");
    assert_eq!(expiry.desired_since(), 1_700_000_000);
    assert!(matches!(
        expiry.reconcile(0),
        Reconciliation::Awaiting { for_seconds: 0, .. }
    ));
}
