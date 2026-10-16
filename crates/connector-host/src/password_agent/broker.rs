//! The broker plan for `run --agent-proxy` (R8 PR3 of #786): which
//! `os://` references a surrogate may stand in for, and the bounded
//! scope each one is issued for. Re-exported from [`super::env`] so
//! the run lanes name one validation surface.

use super::env::{assignment, parse_os_reference, valid_name};

/// The connection one brokered reference names: its provider, the
/// `conn://…` reference brokered calls are receipted against, and the
/// sealed-store path its token lives at. All three derive from the item;
/// none is taken from a flag, so a person cannot aim a run at another
/// entry of the store by spelling flags differently.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrokerTarget {
    pub provider_id: String,
    pub connection_ref: String,
    pub store_path: String,
}

/// The broker target of an `os://vault/item/field` reference whose decoded
/// item is `connections/<org>/<provider>` or
/// `connections/<org>/<project>/<provider>` (the sealed folder connection
/// credentials live in). Every segment is plain (`[A-Za-z0-9._-]`, never
/// dot-led), the same rule the store path of a `conn://` reference obeys.
///
/// # Errors
/// Rejects every other shape — `op://` included — without echoing the
/// reference: under `--agent-proxy` a value the broker cannot stand in for
/// is never injected instead.
pub fn broker_target(reference: &str) -> anyhow::Result<BrokerTarget> {
    let (_, item, _) = parse_os_reference(reference)?;
    let segments: Vec<&str> = item.split('/').collect();
    let plain = |segment: &&str| {
        !segment.is_empty()
            && !segment.starts_with('.')
            && segment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    };
    anyhow::ensure!(
        matches!(segments.len(), 3 | 4)
            && segments[0] == "connections"
            && segments.iter().all(plain),
        "Only an os:// item under connections/<org>[/<project>]/<provider> can be brokered"
    );
    Ok(BrokerTarget {
        provider_id: segments[segments.len() - 1].to_string(),
        connection_ref: format!("conn://{}", segments[1..].join("/")),
        store_path: item,
    })
}

/// The HTTP methods a surrogate may be scoped to. Shared vectors:
/// `spec/conformance/surrogate-scope.json`, enforced again by the
/// surrogate-proxy plugin on the wire.
const BROKER_METHODS: [&str; 7] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/// Whether `method` is one a surrogate may be scoped to (exact, upper case;
/// declarations are upper-cased before they are asked).
#[must_use]
pub fn broker_http_method(method: &str) -> bool {
    BROKER_METHODS.contains(&method)
}

/// Whether `prefix` bounds a path: absolute, with at least one named
/// segment and no empty, `.` or `..` segment, query, fragment, backslash,
/// semicolon, whitespace or control character. The root bounds nothing.
/// Shared vectors: `spec/conformance/surrogate-scope.json`.
#[must_use]
pub fn broker_bounded_prefix(prefix: &str) -> bool {
    let Some(rest) = prefix.strip_prefix('/') else {
        return false;
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    !rest.is_empty()
        && rest
            .split('/')
            .all(|segment| !matches!(segment, "" | "." | ".."))
        && !prefix
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '?' | '#' | '\\' | ';'))
}

/// One brokered assignment with the bounded scope its surrogate is issued
/// for (ADR 0150 section 8: the narrowest operation the child needs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrokerEntry {
    pub name: String,
    pub reference: String,
    pub provider_id: String,
    pub connection_ref: String,
    pub store_path: String,
    pub methods: Vec<String>,
    pub path_prefixes: Vec<String>,
}

fn broker_scope_items(
    inputs: &[String],
    flag: &str,
) -> anyhow::Result<std::collections::BTreeMap<String, Vec<String>>> {
    let mut by_name: std::collections::BTreeMap<String, Vec<String>> =
        std::collections::BTreeMap::new();
    for input in inputs {
        let (name, list) = input
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("Expected {flag} NAME=value[,value...]"))?;
        anyhow::ensure!(valid_name(name), "Expected {flag} NAME=value[,value...]");
        let mut items: Vec<String> = Vec::new();
        for item in list.split(',').map(str::trim) {
            anyhow::ensure!(
                !item.is_empty(),
                "{name} cannot be brokered: {flag} names no value"
            );
            if !items.iter().any(|seen| seen == item) {
                items.push(item.to_string());
            }
        }
        anyhow::ensure!(
            by_name.insert(name.to_string(), items).is_none(),
            "{name} cannot be brokered: {flag} is declared twice for it"
        );
    }
    Ok(by_name)
}

/// The broker plan for `run --agent-proxy`: every `--env` assignment must
/// name a brokerable `os://` connections item, and the `--paths` /
/// `--methods` companions (`NAME=/prefix[,…]`, `NAME=GET[,…]`) must bound
/// every brokered name exactly — nothing wider, nothing missing, nothing
/// for a name nobody brokered. Methods are upper-cased as declared, then
/// checked exactly, and a path's trailing slash is dropped once it bounds.
///
/// # Errors
/// Rejects an `op://` or non-connections assignment, a repeated name, a
/// missing or unbounded scope, and scope for an unbrokered name. Broker
/// mode fails closed: a rejected plan injects nothing.
pub fn broker_plan(
    assignments: &[String],
    paths: &[String],
    methods: &[String],
) -> anyhow::Result<Vec<BrokerEntry>> {
    let paths = broker_scope_items(paths, "--paths")?;
    let methods = broker_scope_items(methods, "--methods")?;
    let mut plan: Vec<BrokerEntry> = Vec::new();
    for input in assignments {
        let (name, reference) = assignment(input)?;
        anyhow::ensure!(
            !plan.iter().any(|entry: &BrokerEntry| entry.name == name),
            "{name} cannot be brokered: it is assigned twice"
        );
        let target = broker_target(&reference).map_err(|_| {
            anyhow::anyhow!(
                "{name} cannot be brokered: --agent-proxy brokers only an os:// item under \
                 connections/<org>[/<project>]/<provider>; the value was not injected"
            )
        })?;
        let Some(prefixes) = paths.get(&name) else {
            anyhow::bail!(
                "{name} cannot be brokered: declare what the child may reach, for example \
                 --paths {name}=/repos/acme --methods {name}=GET; the root is not a scope"
            );
        };
        let mut path_prefixes: Vec<String> = Vec::new();
        for prefix in prefixes {
            anyhow::ensure!(
                broker_bounded_prefix(prefix),
                "{name} cannot be brokered: --paths entry `{prefix}` does not bound the \
                 surrogate: name an absolute prefix such as /repos/acme (the root, dot \
                 segments, queries and fragments are refused)"
            );
            let prefix = prefix.trim_end_matches('/').to_string();
            if !path_prefixes.contains(&prefix) {
                path_prefixes.push(prefix);
            }
        }
        let Some(declared) = methods.get(&name) else {
            anyhow::bail!(
                "{name} cannot be brokered: --methods {name}=GET is required beside --paths: \
                 name the verbs the surrogate may use"
            );
        };
        let mut entry_methods: Vec<String> = Vec::new();
        for method in declared {
            let method = method.to_ascii_uppercase();
            anyhow::ensure!(
                broker_http_method(&method),
                "{name} cannot be brokered: --methods entry `{method}` is not one of {}",
                BROKER_METHODS.join(", ")
            );
            if !entry_methods.contains(&method) {
                entry_methods.push(method);
            }
        }
        plan.push(BrokerEntry {
            name,
            reference,
            provider_id: target.provider_id,
            connection_ref: target.connection_ref,
            store_path: target.store_path,
            methods: entry_methods,
            path_prefixes,
        });
    }
    for (flag, scoped) in [("--paths", &paths), ("--methods", &methods)] {
        for name in scoped.keys() {
            anyhow::ensure!(
                plan.iter().any(|entry| &entry.name == name),
                "{name} cannot be brokered: {flag} names it, but no --env assignment brokers it"
            );
        }
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    #[test]
    fn broker_targets_are_connections_items_only() {
        let target =
            super::broker_target("os://vault/connections%2Facme%2Fvercel/password").unwrap();
        assert_eq!(target.provider_id, "vercel");
        assert_eq!(target.connection_ref, "conn://acme/vercel");
        assert_eq!(target.store_path, "connections/acme/vercel");
        let nested =
            super::broker_target("os://vault/connections%2Facme%2Fapp%2Fgithub/credential")
                .unwrap();
        assert_eq!(nested.provider_id, "github");
        assert_eq!(nested.connection_ref, "conn://acme/app/github");
        for reference in [
            "op://vault/connections%2Facme%2Fvercel/password",
            "os://vault/Dev%2Ftoken/password",
            "os://vault/connections%2Fvercel/password",
            "os://vault/connections%2Fa%2Fb%2Fc%2Fd/password",
            "os://vault/connections%2F..%2Fvercel/password",
            "os://vault/connections%2Facme%2F/password",
        ] {
            assert!(super::broker_target(reference).is_err(), "{reference}");
        }
    }

    #[test]
    fn broker_plans_require_a_bounded_scope_for_every_name() {
        let assignments = vec!["TOKEN=os://vault/connections%2Facme%2Fvercel/password".to_string()];
        let plan = super::broker_plan(
            &assignments,
            &["TOKEN=/v2/user,/v9/projects".to_string()],
            &["TOKEN=GET,post".to_string()],
        )
        .unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].name, "TOKEN");
        assert_eq!(plan[0].provider_id, "vercel");
        assert_eq!(plan[0].path_prefixes, ["/v2/user", "/v9/projects"]);
        assert_eq!(plan[0].methods, ["GET", "POST"]);
        // Missing either half of the scope, an unbounded path, an unknown
        // method, or scope for a name nobody brokered all fail closed.
        for (paths, methods) in [
            (vec![], vec!["TOKEN=GET".to_string()]),
            (vec!["TOKEN=/v2/user".to_string()], vec![]),
            (vec!["TOKEN=/".to_string()], vec!["TOKEN=GET".to_string()]),
            (
                vec!["TOKEN=relative".to_string()],
                vec!["TOKEN=GET".to_string()],
            ),
            (
                vec!["TOKEN=/v2/user".to_string()],
                vec!["TOKEN=FETCH".to_string()],
            ),
            (
                vec!["OTHER=/v2/user".to_string()],
                vec!["TOKEN=GET".to_string()],
            ),
            (
                vec!["TOKEN=/v2/user".to_string(), "TOKEN=/user".to_string()],
                vec!["TOKEN=GET".to_string()],
            ),
        ] {
            assert!(
                super::broker_plan(&assignments, &paths, &methods).is_err(),
                "{paths:?} {methods:?}"
            );
        }
        // An op:// assignment is never brokered, and neither is an os://
        // item outside connections/.
        for assignment in [
            "TOKEN=op://vault/connections%2Facme%2Fvercel/password",
            "TOKEN=os://vault/Dev%2Ftoken/password",
        ] {
            assert!(super::broker_plan(
                &[assignment.to_string()],
                &["TOKEN=/v2/user".to_string()],
                &["TOKEN=GET".to_string()],
            )
            .is_err());
        }
        // One name, one delivery.
        let repeated = vec![
            assignments[0].clone(),
            "TOKEN=os://vault/connections%2Facme%2Fgithub/password".to_string(),
        ];
        assert!(super::broker_plan(
            &repeated,
            &["TOKEN=/v2/user".to_string()],
            &["TOKEN=GET".to_string()],
        )
        .is_err());
    }

    #[test]
    fn broker_scope_bounds_match_the_shared_vectors() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../spec/conformance/surrogate-scope.json"
        ))
        .unwrap();
        for prefix in vectors["bounded"].as_array().unwrap() {
            let prefix = prefix.as_str().unwrap();
            assert!(super::broker_bounded_prefix(prefix), "bounded {prefix:?}");
        }
        for prefix in vectors["unbounded"].as_array().unwrap() {
            let prefix = prefix.as_str().unwrap();
            assert!(
                !super::broker_bounded_prefix(prefix),
                "unbounded {prefix:?}"
            );
        }
        for method in vectors["methods"]["valid"].as_array().unwrap() {
            assert!(super::broker_http_method(method.as_str().unwrap()));
        }
        for method in vectors["methods"]["invalid"].as_array().unwrap() {
            assert!(!super::broker_http_method(method.as_str().unwrap()));
        }
    }
}
