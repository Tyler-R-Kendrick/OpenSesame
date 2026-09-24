//! `spec/connectors/catalog.view.json` is what `GET /api/v1/providers` serves
//! for every catalog row — the projection, computed here and nowhere else.
//! Every other target (the Pages PWA through
//! `packages/app-core/src/lib/connector-catalog.generated.ts`) reads this file
//! instead of re-deriving auth kinds, refresh support, egress or default
//! fields from the catalog. Regenerate with:
//!
//! ```bash
//! UPDATE_CATALOG_VIEW=1 cargo +1.88.0 test -p opensesame-connection-broker --test catalog_view
//! ```
use std::path::PathBuf;

use opensesame_connection_broker::catalog;
use opensesame_connection_broker::model::ProviderView;

fn render() -> String {
    let revision = catalog::revision().unwrap();
    let providers: Vec<serde_json::Value> = catalog::all()
        .unwrap()
        .iter()
        .map(|provider| {
            let view = ProviderView::new(provider, false, false, Vec::new(), None, revision);
            let mut value = serde_json::to_value(view).unwrap();
            value["aliases"] = serde_json::json!(provider.aliases);
            value
        })
        .collect();
    let document = serde_json::json!({ "revision": revision, "providers": providers });
    format!("{}\n", serde_json::to_string_pretty(&document).unwrap())
}

#[test]
fn the_checked_in_view_is_the_catalog_projection() {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/connectors/catalog.view.json");
    let rendered = render();
    if std::env::var_os("UPDATE_CATALOG_VIEW").is_some() {
        std::fs::write(&path, &rendered).unwrap();
        return;
    }
    let current: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_default())
            .unwrap_or_default();
    let expected: serde_json::Value = serde_json::from_str(&rendered).unwrap();
    assert!(
        current == expected,
        "spec/connectors/catalog.view.json is stale; regenerate it with \
         UPDATE_CATALOG_VIEW=1 cargo +1.88.0 test -p opensesame-connection-broker --test catalog_view"
    );
}
