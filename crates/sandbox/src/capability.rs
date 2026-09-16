//! The brokered surface: the complete list of things a guest can ask for.
//!
//! This is a closed enum on purpose. A guest's whole world is one wasm
//! module namespace, [`BROKERED_MODULE`], holding at most these four
//! functions — every one of which is a host call that re-decides the
//! request. There is no import for a file, a socket, an environment
//! variable, a clock, or an RNG, so denying ambient authority is not a
//! runtime check that could be forgotten: there is nothing to link.
//!
//! Each capability is named by a grant action. A grant that does not name
//! the action does not get the import defined, and a guest importing it
//! fails to instantiate — the fence is at link time, not at call time.

use std::fmt;

/// The only wasm import module a guest may name.
pub const BROKERED_MODULE: &str = "opensesame:sandbox";

/// The entry point every guest must export.
pub const ENTRY_POINT: &str = "run";

/// The linear memory every guest must export for a brokered call to pass
/// bytes. The host never supplies one.
pub const GUEST_MEMORY: &str = "memory";

/// One brokered host function.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BrokeredCapability {
    /// Hand bytes back to the host as the run's result. Capped by the
    /// profile; a guest cannot return more than its budget allows.
    Emit,
    /// Fetch a host-chosen, host-authorized destination. The guest supplies
    /// a reference, never a credential, and the host injects authorization
    /// on its own side of the boundary.
    HttpFetch,
    /// Sign a digest for a named purpose. The key never enters the guest.
    Sign,
    /// Acquire an access token and receive an **opaque handle** — an integer
    /// the host can resolve and the guest cannot read bytes out of.
    TokenAcquire,
}

impl BrokeredCapability {
    /// Every capability, in a stable order.
    pub const ALL: [Self; 4] = [Self::Emit, Self::HttpFetch, Self::Sign, Self::TokenAcquire];

    /// The grant action that confers this capability.
    #[must_use]
    pub const fn action(self) -> &'static str {
        match self {
            Self::Emit => "sandbox.emit",
            Self::HttpFetch => "sandbox.http",
            Self::Sign => "sandbox.sign",
            Self::TokenAcquire => "sandbox.token",
        }
    }

    /// The wasm import field name inside [`BROKERED_MODULE`].
    #[must_use]
    pub const fn import_name(self) -> &'static str {
        match self {
            Self::Emit => "emit",
            Self::HttpFetch => "http-fetch",
            Self::Sign => "sign",
            Self::TokenAcquire => "token-acquire",
        }
    }

    /// The capability a grant action confers, if any.
    ///
    /// Unknown actions confer nothing. A grant chain carries actions for the
    /// whole product — `repository.read` and friends — and none of them is a
    /// sandbox capability by accident.
    #[must_use]
    pub fn from_action(action: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|capability| capability.action() == action)
    }

    /// The capability behind an import field name, if any.
    #[must_use]
    pub fn from_import_name(name: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|capability| capability.import_name() == name)
    }
}

impl fmt::Display for BrokeredCapability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.import_name())
    }
}

/// The ambient surface an import would have reached, for refusal messages.
///
/// Classification is for the message only — every non-brokered import is
/// refused whatever it is called. Naming the surface makes an incident
/// legible: "the guest wanted `fd_write`" is a different story from "the
/// guest wanted `sock_connect`".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AmbientKind {
    /// Files, directories, descriptors, paths.
    Filesystem,
    /// Environment variables, arguments, the working directory.
    Environment,
    /// Sockets, DNS, anything that reaches the network unbrokered.
    Network,
    /// Wall-clock or monotonic time.
    Clock,
    /// Entropy.
    Randomness,
    /// Process control: exit, spawn, threads.
    Process,
    /// Not recognizable, and refused all the same.
    Unclassified,
}

/// Import-name vocabulary per ambient surface, in match order.
const AMBIENT_TABLE: [(AmbientKind, &[&str]); 6] = [
    (
        AmbientKind::Filesystem,
        &[
            "fd_", "path_", "file", "dir", "open", "read", "write", "stat",
        ],
    ),
    (
        AmbientKind::Network,
        &[
            "sock", "net", "connect", "bind", "listen", "dns", "resolve", "http",
        ],
    ),
    (
        AmbientKind::Environment,
        &["environ", "getenv", "env_", "args_", "cwd"],
    ),
    (AmbientKind::Clock, &["clock", "time", "now", "sleep"]),
    (
        AmbientKind::Randomness,
        &["random", "entropy", "getrandom", "urandom"],
    ),
    (
        AmbientKind::Process,
        &[
            "proc_exit",
            "spawn",
            "fork",
            "exec",
            "thread",
            "signal",
            "kill",
        ],
    ),
];

impl AmbientKind {
    /// Every surface, so a sweep cannot miss one added later.
    pub const ALL: [Self; 7] = [
        Self::Filesystem,
        Self::Environment,
        Self::Network,
        Self::Clock,
        Self::Randomness,
        Self::Process,
        Self::Unclassified,
    ];

    /// A stable name for receipts.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Filesystem => "filesystem",
            Self::Environment => "environment",
            Self::Network => "network",
            Self::Clock => "clock",
            Self::Randomness => "randomness",
            Self::Process => "process",
            Self::Unclassified => "unclassified",
        }
    }

    /// Name the surface behind an import, from its module and field names.
    #[must_use]
    pub fn classify(module: &str, name: &str) -> Self {
        let haystack = format!("{module}::{name}").to_ascii_lowercase();
        for (kind, needles) in AMBIENT_TABLE {
            if needles.iter().any(|needle| haystack.contains(needle)) {
                return kind;
            }
        }
        Self::Unclassified
    }
}

#[cfg(test)]
mod tests {
    use super::{AmbientKind, BrokeredCapability, BROKERED_MODULE};

    #[test]
    fn actions_and_import_names_round_trip_and_do_not_collide() {
        for capability in BrokeredCapability::ALL {
            assert_eq!(
                BrokeredCapability::from_action(capability.action()),
                Some(capability)
            );
            assert_eq!(
                BrokeredCapability::from_import_name(capability.import_name()),
                Some(capability)
            );
        }
        let actions: std::collections::BTreeSet<_> =
            BrokeredCapability::ALL.iter().map(|c| c.action()).collect();
        assert_eq!(actions.len(), BrokeredCapability::ALL.len());
    }

    #[test]
    fn product_actions_are_not_sandbox_capabilities_by_accident() {
        for action in [
            "repository.read",
            "sandbox",
            "sandbox.",
            "sandbox.http.extra",
            "SANDBOX.HTTP",
            "connection.invoke",
        ] {
            assert_eq!(BrokeredCapability::from_action(action), None, "{action}");
        }
    }

    #[test]
    fn there_is_exactly_one_import_module_and_no_secret_shaped_capability() {
        assert_eq!(BROKERED_MODULE, "opensesame:sandbox");
        for capability in BrokeredCapability::ALL {
            let name = capability.import_name();
            assert!(!name.contains("secret"), "{name}");
            assert!(!name.contains("materialize"), "{name}");
            assert!(!name.contains("reveal"), "{name}");
        }
    }

    #[test]
    fn wasi_imports_classify_into_the_surface_they_would_have_reached() {
        let cases = [
            (
                "wasi_snapshot_preview1",
                "fd_write",
                AmbientKind::Filesystem,
            ),
            (
                "wasi_snapshot_preview1",
                "path_open",
                AmbientKind::Filesystem,
            ),
            (
                "wasi_snapshot_preview1",
                "sock_connect",
                AmbientKind::Network,
            ),
            (
                "wasi_snapshot_preview1",
                "environ_get",
                AmbientKind::Environment,
            ),
            (
                "wasi_snapshot_preview1",
                "clock_time_get",
                AmbientKind::Clock,
            ),
            (
                "wasi_snapshot_preview1",
                "random_get",
                AmbientKind::Randomness,
            ),
            ("wasi_snapshot_preview1", "proc_exit", AmbientKind::Process),
            ("env", "totally_benign", AmbientKind::Unclassified),
        ];
        for (module, name, expected) in cases {
            assert_eq!(AmbientKind::classify(module, name), expected, "{name}");
        }
    }
}
