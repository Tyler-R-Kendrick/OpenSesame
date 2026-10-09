//! Every provider the daemon's CLI and keychain probes name is a row of the
//! one integration catalog, `spec/connectors/catalog.json`, by id or alias.
//! The probe tables are private, so this reads their sources.
use std::collections::BTreeSet;

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

/// The quoted strings inside every `provider_ids: &[…]` in `cli_probe.rs`.
fn cli_probe_ids() -> Vec<String> {
    let source = include_str!("../src/cli_probe.rs");
    source
        .split("provider_ids: &[")
        .skip(1)
        .flat_map(|rest| {
            rest[..rest.find(']').unwrap()]
                .split('"')
                .skip(1)
                .step_by(2)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect()
}

/// The provider half of every `("prefix", "provider")` row in `keychain.rs`.
fn keychain_ids() -> Vec<String> {
    let source = include_str!("../src/keychain.rs");
    let table = &source[source.find("KNOWN_LABEL_PREFIXES").unwrap()..];
    let table = &table[..table.find("];").unwrap()];
    table
        .lines()
        .filter_map(|line| line.trim().strip_prefix("(\""))
        .filter_map(|row| row.split('"').nth(2).map(str::to_owned))
        .collect()
}

#[test]
fn every_probed_provider_is_a_catalog_row() {
    let names = catalog_names();
    let ids: Vec<String> = cli_probe_ids().into_iter().chain(keychain_ids()).collect();
    assert!(ids.len() > 20, "the probe tables were not found: {ids:?}");
    let missing: BTreeSet<&String> = ids.iter().filter(|id| !names.contains(*id)).collect();
    assert!(
        missing.is_empty(),
        "not in spec/connectors/catalog.json: {missing:?}"
    );
}
