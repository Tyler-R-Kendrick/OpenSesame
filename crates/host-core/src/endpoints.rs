//! The services a target talks to, read from `spec/config/endpoints.json`
//! (ADR 0139). Every target resolves an address the same way: the flag, then
//! the endpoint's variable, then its aliases in order, then its default. No
//! code outside this module names an alias.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::Deserialize;

/// A variable, the older names it still answers to, and its default.
#[derive(Debug, Deserialize)]
pub struct Variable {
    pub env: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub default: String,
}

impl Variable {
    /// Every name this variable is read from, most specific first.
    pub fn names(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.env.as_str()).chain(self.aliases.iter().map(String::as_str))
    }

    /// The first set name's value, else the default.
    pub fn resolve(&self, lookup: impl Fn(&str) -> Option<String>) -> String {
        self.names()
            .find_map(|name| lookup(name).filter(|value| !value.trim().is_empty()))
            .unwrap_or_else(|| self.default.clone())
    }

    /// The value an alias carries when the variable itself is unset: the
    /// default a flag bound to [`Variable::env`] should fall back to.
    #[must_use]
    pub fn fallback(&self) -> String {
        self.resolve(|name| {
            if name == self.env {
                None
            } else {
                std::env::var(name).ok()
            }
        })
    }
}

/// One service.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub title: String,
    #[serde(flatten)]
    pub address: Variable,
    pub listen: Variable,
    pub pages_runtime_key: String,
    pub vite_key: String,
    pub setting: String,
    pub loopback_only: bool,
}

#[derive(Deserialize)]
struct Spec {
    endpoints: BTreeMap<String, Endpoint>,
}

static SPEC: LazyLock<Spec> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../spec/config/endpoints.json"))
        .expect("spec/config/endpoints.json is valid")
});

/// The Host API.
pub const HOST: &str = "host";
/// The Identity API.
pub const IDENTITY: &str = "identity";
/// The local host agent.
pub const DAEMON: &str = "daemon";

/// The endpoint named `id`.
///
/// # Panics
///
/// When `id` is not in the definition; the ids above always are.
#[must_use]
pub fn endpoint(id: &str) -> &'static Endpoint {
    SPEC.endpoints
        .get(id)
        .unwrap_or_else(|| panic!("no endpoint `{id}` in spec/config/endpoints.json"))
}

/// Every endpoint, by id.
pub fn all() -> impl Iterator<Item = (&'static str, &'static Endpoint)> {
    SPEC.endpoints.iter().map(|(id, e)| (id.as_str(), e))
}

/// The variable a flag for `id`'s address binds to.
#[must_use]
pub fn env(id: &str) -> &'static str {
    &endpoint(id).address.env
}

/// The default of a flag for `id`'s address: an alias's value, else the default.
#[must_use]
pub fn fallback(id: &str) -> String {
    endpoint(id).address.fallback()
}

/// The variable a server's listen flag binds to.
#[must_use]
pub fn listen_env(id: &str) -> &'static str {
    &endpoint(id).listen.env
}

/// The default of a server's listen flag.
#[must_use]
pub fn listen_fallback(id: &str) -> String {
    endpoint(id).listen.fallback()
}

/// The address of `id` from the process environment.
#[must_use]
pub fn address(id: &str) -> String {
    endpoint(id)
        .address
        .resolve(|name| std::env::var(name).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_endpoint_the_code_names_is_defined() {
        for id in [HOST, IDENTITY, DAEMON] {
            let e = endpoint(id);
            assert!(e.address.default.starts_with("http://127.0.0.1:"), "{id}");
            assert!(e.address.env.starts_with("OPENSESAME_"), "{id}");
        }
        assert_eq!(all().count(), 3);
    }

    #[test]
    fn a_variable_resolves_through_its_aliases_in_order() {
        let host = &endpoint(HOST).address;
        let alias = host.aliases[0].clone();
        let only_alias = |name: &str| (name == alias).then(|| "http://alias".to_owned());
        assert_eq!(host.resolve(only_alias), "http://alias");
        let both = |_: &str| Some("http://set".to_owned());
        assert_eq!(host.resolve(both), "http://set");
        assert_eq!(host.resolve(|_| None), host.default);
        let blank = |_: &str| Some("  ".to_owned());
        assert_eq!(host.resolve(blank), host.default);
    }

    #[test]
    fn the_daemon_is_loopback_only() {
        assert!(endpoint(DAEMON).loopback_only);
        assert!(!endpoint(HOST).loopback_only);
    }
}
