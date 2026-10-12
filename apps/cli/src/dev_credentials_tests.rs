use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::{json, Value};
use zeroize::Zeroizing;

use super::*;
use crate::dev_run::login::StoredLogin;

/// Not a credential: a marker that must never leave the plugin's pipe.
const TOKEN: &str = "vtok_dummy_marker_0123456789abcdef";
const ENTRY: &str = "connections/acme/vercel";

#[derive(Default)]
struct Store {
    entries: HashMap<String, String>,
    unreadable: bool,
    reads: RefCell<Vec<String>>,
}

impl Store {
    fn holding(path: &str, secret: &str) -> Self {
        let mut store = Self::default();
        store.entries.insert(path.into(), secret.into());
        store
    }
}

impl LoginSource for Store {
    fn holds(&self, store_path: &str) -> bool {
        self.entries.contains_key(store_path)
    }

    fn read(&self, store_path: &str) -> anyhow::Result<StoredLogin> {
        self.reads.borrow_mut().push(store_path.to_owned());
        if self.unreadable {
            anyhow::bail!("the store is locked");
        }
        let secret = self
            .entries
            .get(store_path)
            .ok_or_else(|| anyhow::anyhow!("no entry"))?;
        Ok(StoredLogin {
            secret: Zeroizing::new(secret.clone()),
            url: None,
        })
    }
}

fn entry(env_var: &str, provider_id: &str, connection_ref: &str) -> Value {
    json!({
        "env_var": env_var,
        "provider_id": provider_id,
        "connection_ref": connection_ref,
    })
}

fn vercel() -> Value {
    entry("VERCEL_TOKEN", "vercel", "conn://acme/vercel")
}

#[test]
fn the_sealed_entry_is_derived_from_the_reference() {
    assert_eq!(store_path_of("conn://acme/vercel").as_deref(), Some(ENTRY));
    assert_eq!(
        store_path_of("conn://acme/vercel@v2").as_deref(),
        Some(ENTRY)
    );
    assert_eq!(
        store_path_of("conn://acme/web/vercel").as_deref(),
        Some("connections/acme/web/vercel")
    );
}

#[test]
fn a_reference_cannot_aim_the_read_at_another_entry() {
    for hostile in [
        "",
        "conn://",
        "conn://vercel",
        "conn://acme/../vercel",
        "conn://acme/.hidden",
        "conn://acme//vercel",
        "conn://acme/vercel/",
        "conn://acme/ver cel",
        "conn://acme/ver\\cel",
        "https://acme/vercel",
    ] {
        assert_eq!(store_path_of(hostile), None, "{hostile:?}");
    }
}

#[test]
fn a_stored_token_is_read_for_a_provider_with_no_local_tool() {
    let store = Store::holding(ENTRY, TOKEN);
    let wire = resolve(&[vercel()], &store).unwrap();
    assert_eq!(wire.len(), 1);
    assert_eq!(wire[0].connection_ref, "conn://acme/vercel");
    // The token travels in the plugin's run spec, so serialization carries it.
    let line = serde_json::to_value(&wire[0]).unwrap();
    assert_eq!(line["secret"], TOKEN);
    assert_eq!(*store.reads.borrow(), [ENTRY]);
}

#[test]
fn a_provider_with_a_local_tool_is_never_read_from_the_store() {
    let store = Store::holding("connections/acme/github", TOKEN);
    let github = entry("GITHUB_TOKEN", "github", "conn://acme/github");
    assert!(resolve(&[github], &store).unwrap().is_empty());
    assert!(store.reads.borrow().is_empty());
}

#[test]
fn a_connection_named_twice_is_read_once() {
    let store = Store::holding(ENTRY, TOKEN);
    let again = entry("VERCEL_API_TOKEN", "vercel", "conn://acme/vercel");
    let wire = resolve(&[vercel(), again], &store).unwrap();
    assert_eq!(wire.len(), 1);
    assert_eq!(store.reads.borrow().len(), 1);
}

#[test]
fn a_connection_with_no_entry_keeps_its_placeholder_and_reads_nothing() {
    let store = Store::default();
    assert!(resolve(&[vercel()], &store).unwrap().is_empty());
    assert!(store.reads.borrow().is_empty());
    let lines = missing(&[vercel()], &store);
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("VERCEL_TOKEN"), "{lines:?}");
    assert!(
        lines[0].contains(&format!("opensesame pass insert {ENTRY}")),
        "{lines:?}"
    );
}

#[test]
fn a_held_entry_is_not_reported_missing() {
    let store = Store::holding(ENTRY, TOKEN);
    assert!(missing(&[vercel()], &store).is_empty());
}

#[test]
fn an_empty_entry_is_refused_by_name() {
    let store = Store::holding(ENTRY, "  \n");
    let error = resolve(&[vercel()], &store).unwrap_err().to_string();
    assert!(error.contains(ENTRY), "{error}");
    assert!(error.contains("empty"), "{error}");
}

#[test]
fn an_unreadable_entry_names_the_entry_and_never_the_token() {
    let mut store = Store::holding(ENTRY, TOKEN);
    store.unreadable = true;
    let error = resolve(&[vercel()], &store).unwrap_err().to_string();
    assert!(error.contains(ENTRY), "{error}");
    assert!(!error.contains(TOKEN), "{error}");
}

#[test]
fn debug_output_names_the_connection_and_never_the_token() {
    let store = Store::holding(ENTRY, TOKEN);
    let wire = resolve(&[vercel()], &store).unwrap();
    let shown = format!("{:?}", wire[0]);
    assert!(shown.contains("conn://acme/vercel"), "{shown}");
    assert!(!shown.contains(TOKEN), "{shown}");
}

#[test]
fn an_entry_that_names_no_provider_or_variable_is_ignored() {
    let store = Store::holding(ENTRY, TOKEN);
    let no_provider = json!({"env_var": "VERCEL_TOKEN", "connection_ref": "conn://acme/vercel"});
    let no_variable = json!({"provider_id": "vercel", "connection_ref": "conn://acme/vercel"});
    assert!(resolve(&[no_provider, no_variable], &store)
        .unwrap()
        .is_empty());
    assert!(store.reads.borrow().is_empty());
}
