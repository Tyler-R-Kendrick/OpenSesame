//! Every provider the native connector host knows is a row of the one
//! integration catalog, `spec/connectors/catalog.json` — by id or alias — and
//! so is every provider in the fnox parity snapshot. A provider cannot exist
//! on one target and be missing from the list every target reads.
use std::collections::BTreeSet;

use opensesame_connector_host::providers::catalog;

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
fn every_native_provider_is_a_catalog_row() {
    let names = catalog_names();
    let missing: Vec<String> = catalog()
        .into_iter()
        .map(|provider| provider.id)
        .filter(|id| !names.contains(id))
        .collect();
    assert!(
        missing.is_empty(),
        "not in spec/connectors/catalog.json: {missing:?}"
    );
}

#[test]
fn every_fnox_parity_provider_is_a_catalog_row() {
    let names = catalog_names();
    let parity: serde_json::Value =
        serde_json::from_str(include_str!("../../../spec/connectors/fnox-parity.json")).unwrap();
    let missing: Vec<&str> = ["providers", "leases"]
        .iter()
        .flat_map(|key| parity[key].as_array().unwrap())
        .map(|id| id.as_str().unwrap())
        .filter(|id| !names.contains(*id))
        .collect();
    assert!(
        missing.is_empty(),
        "not in spec/connectors/catalog.json: {missing:?}"
    );
}
