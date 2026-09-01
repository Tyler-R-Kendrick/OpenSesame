//! The ceremony catalog cannot name a provider the connection catalog does not
//! have.
//!
//! Two checked-in files that have to agree, in different crates, edited by
//! different changes. ADR 0082 §7 puts ceremony recipes "alongside the provider
//! it belongs to"; this is what makes "alongside" mean something after the
//! review that put them there.
//!
//! Read from `crates/connection-broker/src/catalog.json` by path rather than
//! by depending on the crate: `opensesame-ceremony` is pure and stays that way,
//! and a dev-only file read in a test is not a dependency of the shipped
//! vocabulary.

use std::collections::BTreeSet;
use std::path::PathBuf;

use opensesame_ceremony::Catalog;

fn connection_catalog_providers() -> BTreeSet<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates/")
        .join("connection-broker/src/catalog.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("reading {}: {error}", path.display()));
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).expect("the connection catalog is valid JSON");
    parsed["providers"]
        .as_array()
        .expect("the connection catalog has a providers array")
        .iter()
        .filter_map(|provider| provider["id"].as_str().map(str::to_string))
        .collect()
}

#[test]
fn every_ceremony_names_a_provider_the_connection_catalog_knows() {
    // A ceremony entry for a provider that does not exist is a ceremony nobody
    // can start, listed as if they could.
    let known = connection_catalog_providers();
    for entry in Catalog::load().entries() {
        assert!(
            known.contains(&entry.provider_id),
            "ceremony catalog names `{}`, which is not a provider in \
             crates/connection-broker/src/catalog.json",
            entry.provider_id,
        );
    }
}

#[test]
fn the_connection_catalog_is_the_larger_set() {
    // Not every provider needs a ceremony — most are API keys pasted into a
    // field, and ADR 0082 is about the ones behind a registration form. What
    // would be wrong is the reverse: more ceremonies than providers means the
    // ceremony catalog has grown its own idea of what exists.
    let known = connection_catalog_providers();
    let ceremonies = Catalog::load();
    assert!(
        ceremonies.entries().len() <= known.len(),
        "there are more ceremonies than providers",
    );
}
