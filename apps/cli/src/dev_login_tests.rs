use std::collections::HashMap;

use super::*;

pub(crate) const SECRET: &str = "hunter2 & correct=horse";

/// An in-memory store: path → (password, trailer).
#[derive(Default)]
pub(crate) struct FakeStore {
    pub(crate) entries: HashMap<String, (String, String)>,
    pub(crate) reads: RefCell<Vec<String>>,
}

impl FakeStore {
    pub(crate) fn with(path: &str, trailer: &str) -> Self {
        let mut store = Self::default();
        store
            .entries
            .insert(path.into(), (SECRET.into(), trailer.into()));
        store
    }
}

impl LoginSource for FakeStore {
    fn read(&self, store_path: &str) -> anyhow::Result<StoredLogin> {
        self.reads.borrow_mut().push(store_path.to_owned());
        let (secret, trailer) = self
            .entries
            .get(store_path)
            .ok_or_else(|| anyhow::anyhow!("no entry"))?;
        Ok(StoredLogin {
            secret: Zeroizing::new(secret.clone()),
            url: trailer_url(trailer),
        })
    }
}

pub(crate) fn web_login(origin: &str) -> WebLogin {
    WebLogin {
        store_path: "Web/app".into(),
        origin: origin.into(),
        action: "/session".into(),
        field: "password".into(),
        ca_file: None,
    }
}

#[test]
fn origins_normalize_case_and_the_default_port() {
    assert_eq!(
        origin_of("https://App.Example:443/login?x#y").as_deref(),
        Some("https://app.example")
    );
    assert_eq!(
        origin_of("https://app.example:8443").as_deref(),
        Some("https://app.example:8443")
    );
    for bad in [
        "http://app.example",
        "app.example",
        "https://",
        "https://u@app.example",
    ] {
        assert!(origin_of(bad).is_none(), "{bad}");
    }
}

#[test]
fn the_url_line_is_read_from_the_trailer_in_any_case() {
    assert_eq!(
        trailer_url("login: alice\nURL: https://app.example/login\n").as_deref(),
        Some("https://app.example/login")
    );
    assert!(trailer_url("login: alice\n").is_none());
}

#[test]
fn a_login_bound_to_its_entry_resolves_with_the_password() {
    let store = FakeStore::with("Web/app", "url: https://app.example/login\n");
    let login = web_login("https://APP.example");
    let wire = resolve(&[("APP_PASSWORD", &login)], &store).unwrap();
    assert_eq!(wire.len(), 1);
    assert_eq!(wire[0].env_var, "APP_PASSWORD");
    let line = serde_json::to_value(&wire[0]).unwrap();
    assert_eq!(line["secret"], SECRET);
    assert!(line.get("ca_pem").is_none());
}

#[test]
fn a_schema_cannot_send_the_password_to_an_origin_the_entry_does_not_name() {
    let store = FakeStore::with("Web/app", "url: https://app.example/login\n");
    let rerouted = web_login("https://attacker.example");
    let error = resolve(&[("APP_PASSWORD", &rerouted)], &store)
        .unwrap_err()
        .to_string();
    assert!(error.contains("refusing"), "{error}");
    assert!(!error.contains(SECRET), "{error}");
}

#[test]
fn an_entry_that_names_no_url_is_refused() {
    let store = FakeStore::with("Web/app", "login: alice\n");
    let error = resolve(
        &[("APP_PASSWORD", &web_login("https://app.example"))],
        &store,
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("url:"), "{error}");
}

#[test]
fn a_cleartext_origin_is_refused_before_the_store_is_read() {
    let store = FakeStore::with("Web/app", "url: http://app.example\n");
    assert!(resolve(
        &[("APP_PASSWORD", &web_login("http://app.example"))],
        &store
    )
    .is_err());
    assert!(store.reads.borrow().is_empty());
}

#[test]
fn a_ca_file_must_be_a_certificate_and_never_a_key() {
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("key.pem");
    std::fs::write(&key, "-----BEGIN PRIVATE KEY-----\nx\n").unwrap();
    let store = FakeStore::with("Web/app", "url: https://app.example\n");
    let mut login = web_login("https://app.example");
    login.ca_file = Some(key.display().to_string());
    assert!(resolve(&[("APP_PASSWORD", &login)], &store).is_err());
}

#[test]
fn debug_names_the_form_and_never_the_password() {
    let store = FakeStore::with("Web/app", "url: https://app.example\n");
    let wire = resolve(
        &[("APP_PASSWORD", &web_login("https://app.example"))],
        &store,
    )
    .unwrap();
    let shown = format!("{wire:?}");
    assert!(shown.contains("APP_PASSWORD"), "{shown}");
    assert!(!shown.contains("hunter2"), "{shown}");
}
