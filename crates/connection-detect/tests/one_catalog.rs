//! Every provider discovery names is a row of the one integration catalog,
//! `spec/connectors/catalog.json`, by id or alias.
use std::collections::BTreeSet;

use opensesame_connection_detect::{ALIASES, GENERIC_API_KEY_PROVIDERS, MINT_CAPABLE_PROVIDERS};

fn catalog_names() -> BTreeSet<String> {
    let raw: serde_json::Value =
        serde_json::from_str(include_str!("../../../spec/connectors/catalog.json")).unwrap();
    let mut names = BTreeSet::new();
    for row in raw["providers"].as_array().unwrap() {
        names.insert(row["id"].as_str().unwrap().to_owned());
        for alias in row["aliases"].as_array().into_iter().flatten() {
            names.insert(alias.as_str().unwrap().to_owned());
        }
    }
    names
}

#[test]
fn every_discovered_provider_is_a_catalog_row() {
    let names = catalog_names();
    let missing: BTreeSet<&str> = ALIASES
        .iter()
        .map(|entry| entry.provider_id)
        .chain(GENERIC_API_KEY_PROVIDERS.iter().copied())
        .chain(MINT_CAPABLE_PROVIDERS.iter().copied())
        .filter(|id| !names.contains(*id))
        .collect();
    assert!(
        missing.is_empty(),
        "not in spec/connectors/catalog.json: {missing:?}"
    );
}
