//! IOP-SPIFFE — a real SPIRE 1.12.6 deployment, with **removal** as the
//! subject rather than addition.
//!
//! SW-SPIFFE's reference run already proves, against a real agent, that the
//! adapter selects the *configured* SVID among several and withdraws when the
//! entry is deleted. Two things it could not show are covered here:
//!
//! 1. **Federated bundle removal.** A bundle can only be removed if it was
//!    added, and SW-SPIFFE's bundle-removal coverage is against its in-process
//!    fake. Here a second trust domain's root is installed on a real
//!    `spire-server`, an entry federates with it, the Workload API starts
//!    handing the workload that federated bundle, and then the bundle is
//!    deleted and the Workload API stops handing it over.
//! 2. **An independent view of the Workload API.** Every observation is made
//!    with `spire-agent api fetch x509` — SPIRE's own Go client — rather than
//!    with the Rust `spiffe` SDK the adapter is built on, so agreement
//!    between them is evidence about the *agent*, not about the SDK.
//!
//! Synthetic-fixture results and real-issuer results are kept apart by name:
//! everything in this file is `REAL-SPIRE`. Nothing here uses a fake.

#[path = "support/spire.rs"]
mod spire;

use std::time::Duration;

use anyhow::Result;
use opensesame_mtls_interop::pki::{LeafSpec, Pki};
use opensesame_mtls_interop::{fixtures_enabled, record};

const WORKLOAD: &str = "spiffe://iop.test/opensesame/gateway";
const DECOY: &str = "spiffe://iop.test/opensesame/worker";

/// Adding and then **removing** a federated bundle on a real SPIRE, watched
/// through the Workload API.
#[test]
#[ignore = "real SPIRE; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
fn real_spire_stops_delivering_a_federated_bundle_once_it_is_deleted() -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let spire = spire::Spire::start()?;

    // The partner trust domain's root. It is an ordinary self-signed CA
    // minted by the system `openssl`; SPIRE never issued it and never sees
    // its key.
    let pki = Pki::new()?;
    let partner = pki.root("iop-partner-root")?;
    // Prove the material is a usable CA before handing it to SPIRE, so a
    // later failure cannot be blamed on the fixture.
    let _ = partner.issue(&LeafSpec::server("partner-probe", "partner.iop.test"))?;

    spire.set_bundle(spire::PARTNER_DOMAIN, &partner.cert)?;
    let entry = spire.create_entry(WORKLOAD, Some(spire::PARTNER_DOMAIN))?;

    // The agent must start handing this workload the federated bundle.
    let with_bundle = spire.wait_for_fetch(
        "the federated bundle to appear at the Workload API",
        Duration::from_secs(120),
        |text| text.contains(WORKLOAD) && text.contains(spire::PARTNER_DOMAIN),
    )?;
    assert!(
        with_bundle.contains(spire::PARTNER_DOMAIN),
        "federated bundle missing:\n{with_bundle}"
    );

    // Remove it. Addition is the easy direction; this is the one that has to
    // work for a federation to be revocable at all.
    spire.delete_bundle(spire::PARTNER_DOMAIN)?;
    let without_bundle = spire.wait_for_fetch(
        "the federated bundle to disappear from the Workload API",
        Duration::from_secs(120),
        |text| text.contains(WORKLOAD) && !text.contains(spire::PARTNER_DOMAIN),
    )?;
    assert!(
        !without_bundle.contains(spire::PARTNER_DOMAIN),
        "the deleted bundle is still being delivered:\n{without_bundle}"
    );
    // The workload's own SVID is untouched: removing a federation is not
    // removing an identity, and conflating the two would be a real bug.
    assert!(
        without_bundle.contains(WORKLOAD),
        "deleting a federated bundle must not withdraw the workload's own SVID:\n{without_bundle}"
    );

    record(
        "REAL-SPIRE-BUNDLE-REMOVAL",
        &format!("spire {} <- spire-agent api fetch x509", spire.version),
        "federated bundle delivered, then deleted and no longer delivered; the workload's own SVID survives",
    );
    let _ = entry;
    Ok(())
}

/// Identity removal on a real SPIRE, observed by SPIRE's own client: the
/// decoy entry is registered first, so "the one that is left" is not the same
/// answer as "the first one returned".
#[test]
#[ignore = "real SPIRE; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
fn real_spire_stops_issuing_an_identity_once_its_entry_is_deleted() -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let spire = spire::Spire::start()?;
    let decoy = spire.create_entry(DECOY, None)?;
    let target = spire.create_entry(WORKLOAD, None)?;

    let both = spire.wait_for_fetch(
        "both identities to be issued",
        Duration::from_secs(120),
        |text| text.contains(WORKLOAD) && text.contains(DECOY),
    )?;
    assert!(both.contains(WORKLOAD) && both.contains(DECOY));

    spire.delete_entry(&target)?;
    let remaining = spire.wait_for_fetch(
        "the deleted identity to stop being issued",
        Duration::from_secs(120),
        |text| !text.contains(WORKLOAD),
    )?;
    assert!(
        remaining.contains(DECOY),
        "deleting one entry must not withdraw the other:\n{remaining}"
    );
    let _ = decoy;

    record(
        "REAL-SPIRE-IDENTITY-REMOVAL",
        &format!("spire {} <- spire-agent api fetch x509", spire.version),
        "one of two issued identities deleted; the agent stops issuing exactly that one",
    );
    Ok(())
}
