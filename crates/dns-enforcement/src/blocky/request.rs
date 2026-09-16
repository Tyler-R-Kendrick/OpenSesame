//! What this crate asks a Blocky instance to do, as values.
//!
//! The safety-bearing part is [`DisableGroups`]: see the parent module for what
//! an empty one would have meant, and why it cannot be built.

use super::{ProtocolError, API_PREFIX};

/// The HTTP verb an operation uses.
///
/// Blocky's blocking endpoints are `GET` and its mutating list/query endpoints
/// are `POST`, which is not the split a reader would guess — hence the explicit
/// mapping rather than a rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    /// `GET`.
    Get,
    /// `POST`.
    Post,
}

impl Method {
    /// The verb as it goes on the wire.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }
}

/// A non-empty set of group names to disable.
///
/// The only way to name groups for a disable, and it cannot be empty.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisableGroups(Vec<String>);

impl DisableGroups {
    /// Build a disable scope from at least one group name.
    ///
    /// # Errors
    ///
    /// Returns [`ProtocolError::DisableWithoutGroups`] for an empty set, and
    /// [`ProtocolError::BadGroupName`] for a name that is blank or contains a
    /// comma — the parameter is comma-joined, so a comma inside a name would
    /// silently widen the request to a group nobody named.
    pub fn new<I, S>(groups: I) -> Result<Self, ProtocolError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let names: Vec<String> = groups.into_iter().map(Into::into).collect();
        if names.is_empty() {
            return Err(ProtocolError::DisableWithoutGroups);
        }
        for name in &names {
            if name.trim().is_empty() || name.contains(',') || name.contains(char::is_whitespace) {
                return Err(ProtocolError::BadGroupName {
                    group: name.clone(),
                });
            }
        }
        Ok(Self(names))
    }

    /// The comma-joined value for the `groups` query parameter.
    #[must_use]
    pub fn as_parameter(&self) -> String {
        self.0.join(",")
    }

    /// The group names.
    #[must_use]
    pub fn names(&self) -> &[String] {
        &self.0
    }
}

/// A positive window after which Blocky re-enables a disabled group itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DisableWindow(i64);

impl DisableWindow {
    /// Build a window from a positive number of seconds.
    ///
    /// # Errors
    ///
    /// Returns [`ProtocolError::BadWindow`] when the window is not positive.
    pub const fn seconds(seconds: i64) -> Result<Self, ProtocolError> {
        if seconds <= 0 {
            return Err(ProtocolError::BadWindow { seconds });
        }
        Ok(Self(seconds))
    }

    /// The value for the `duration` query parameter.
    #[must_use]
    pub fn as_parameter(&self) -> String {
        format!("{}s", self.0)
    }
}

/// Something this crate asks a Blocky instance to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Operation {
    /// Read whether blocking is on, and which groups are down.
    Status,
    /// Turn blocking back on for every group.
    Enable,
    /// Turn blocking off for the named groups — never for all of them.
    ///
    /// This is an operator-facing maintenance verb, not the road an allowance
    /// travels. Granting a domain uses a list entry and
    /// [`Operation::RefreshLists`]; nothing converts one into the other.
    Disable {
        /// The groups to disable. Non-empty by construction.
        groups: DisableGroups,
        /// An optional window after which Blocky re-enables them itself.
        window: Option<DisableWindow>,
    },
    /// Re-read every allowlist and denylist source from disk.
    RefreshLists,
    /// Resolve a name through Blocky and report how it decided.
    Query {
        /// The name to resolve.
        name: String,
        /// The record type, e.g. `A`.
        record_type: String,
    },
}

/// A request, ready for whatever client actually sends it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestSpec {
    /// The verb.
    pub method: Method,
    /// The path, including [`API_PREFIX`].
    pub path: String,
    /// Query parameters, in a stable order.
    pub query: Vec<(String, String)>,
    /// A JSON body, when the operation has one.
    pub body: Option<String>,
}

impl Operation {
    /// Render this operation as a request.
    #[must_use]
    pub fn spec(&self) -> RequestSpec {
        match self {
            Self::Status => RequestSpec {
                method: Method::Get,
                path: format!("{API_PREFIX}/blocking/status"),
                query: Vec::new(),
                body: None,
            },
            Self::Enable => RequestSpec {
                method: Method::Get,
                path: format!("{API_PREFIX}/blocking/enable"),
                query: Vec::new(),
                body: None,
            },
            Self::Disable { groups, window } => {
                let mut query = vec![("groups".to_owned(), groups.as_parameter())];
                if let Some(window) = window {
                    query.push(("duration".to_owned(), window.as_parameter()));
                }
                RequestSpec {
                    method: Method::Get,
                    path: format!("{API_PREFIX}/blocking/disable"),
                    query,
                    body: None,
                }
            }
            Self::RefreshLists => RequestSpec {
                method: Method::Post,
                path: format!("{API_PREFIX}/lists/refresh"),
                query: Vec::new(),
                body: None,
            },
            Self::Query { name, record_type } => RequestSpec {
                method: Method::Post,
                path: format!("{API_PREFIX}/query"),
                query: Vec::new(),
                body: Some(serde_json::json!({ "query": name, "type": record_type }).to_string()),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{DisableGroups, DisableWindow, Method, Operation, ProtocolError};

    #[test]
    fn a_disable_cannot_be_built_without_groups() {
        // The one-parameter gap between "permit this domain" and "filter off for
        // everybody, indefinitely".
        let empty: Vec<String> = Vec::new();
        assert_eq!(
            DisableGroups::new(empty),
            Err(ProtocolError::DisableWithoutGroups)
        );
    }

    #[test]
    fn a_group_name_cannot_smuggle_a_second_group_through_the_comma_join() {
        assert_eq!(
            DisableGroups::new(["unit-alpha,unit-beta"]),
            Err(ProtocolError::BadGroupName {
                group: "unit-alpha,unit-beta".to_owned()
            })
        );
        assert!(matches!(
            DisableGroups::new([" "]),
            Err(ProtocolError::BadGroupName { .. })
        ));
    }

    #[test]
    fn no_operation_can_render_a_disable_without_a_groups_parameter() {
        // The invariant, checked over the shape of the rendered request rather
        // than over the constructor that produced it.
        let operations = [
            Operation::Status,
            Operation::Enable,
            Operation::RefreshLists,
            Operation::Query {
                name: "example.org".to_owned(),
                record_type: "A".to_owned(),
            },
            Operation::Disable {
                groups: DisableGroups::new(["unit-alpha"]).expect("groups"),
                window: None,
            },
        ];
        for operation in operations {
            let spec = operation.spec();
            if spec.path.ends_with("/blocking/disable") {
                let groups = spec
                    .query
                    .iter()
                    .find(|(key, _)| key == "groups")
                    .map(|(_, value)| value.clone())
                    .expect("a disable must carry groups");
                assert!(!groups.is_empty(), "groups must not be empty");
            }
        }
    }

    #[test]
    fn operations_render_the_paths_and_verbs_this_version_serves() {
        assert_eq!(Operation::Status.spec().path, "/api/blocking/status");
        assert_eq!(Operation::Status.spec().method, Method::Get);
        assert_eq!(Operation::Enable.spec().path, "/api/blocking/enable");
        // Measured: the blocking verbs are GET and the list/query verbs POST.
        assert_eq!(Operation::RefreshLists.spec().method, Method::Post);
        assert_eq!(Operation::RefreshLists.spec().path, "/api/lists/refresh");

        let query = Operation::Query {
            name: "docs.example.org".to_owned(),
            record_type: "A".to_owned(),
        }
        .spec();
        assert_eq!(query.method, Method::Post);
        assert_eq!(query.path, "/api/query");
        assert_eq!(
            query.body.as_deref(),
            Some(r#"{"query":"docs.example.org","type":"A"}"#)
        );
    }

    #[test]
    fn a_scoped_disable_renders_its_groups_and_window() {
        let spec = Operation::Disable {
            groups: DisableGroups::new(["unit-alpha", "unit-beta"]).expect("groups"),
            window: Some(DisableWindow::seconds(30).expect("window")),
        }
        .spec();
        assert_eq!(
            spec.query,
            vec![
                ("groups".to_owned(), "unit-alpha,unit-beta".to_owned()),
                ("duration".to_owned(), "30s".to_owned()),
            ]
        );
        assert_eq!(
            DisableWindow::seconds(0),
            Err(ProtocolError::BadWindow { seconds: 0 })
        );
    }
}
