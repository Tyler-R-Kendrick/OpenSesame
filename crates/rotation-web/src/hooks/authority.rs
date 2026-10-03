//! What an interceptor may not rewrite.
//!
//! An interceptor is trusted (agent-hooks/0.1 §1.4) to govern *content*: to
//! redact a free-text field, to move a selector within the page it is already
//! on. It is not trusted to decide *authority*. Which credential a run
//! touches, which capture slot a value is sealed into and where a browser may
//! be taken are the operator's and the executor's decisions (ADR 0005,
//! ADR 0076 §1, ADR 0082 §3); a `transform` that rewrote them would make the
//! interceptor a second author of the run.
//!
//! The rule is a type, not a convention. Every verb's argument type
//! implements [`Authority`], and `Verb::Args` requires it, so a verb cannot be
//! added without saying which of its members are authority — a verb with none
//! says so by returning [`Pinned::default`]. `HookSession::bracket` is the
//! only way a verb reaches the inner transport, and it compares the
//! [`Pinned`] view of the arguments it proposed with the view of the
//! effective ones the interceptors left. Any difference is
//! `host_error:transform_invalid` — the record is rewritten as for any other
//! transform the host cannot apply, and the verb is not called with the
//! altered value.
//!
//! The pinned view carries identifiers only: a credential reference, a slot
//! name, and the shape of a destination. It never holds a value.

use opensesame_ceremony::Slot;
use url::{Origin, Url};

use super::args::{
    CaptureDownloadArgs, CaptureFieldArgs, MaskArgs, NoArgs, PlacedRefArgs, RefArgs, SelectorArgs,
    UrlArgs,
};

/// The parts of a verb's arguments no interceptor may change.
///
/// The credential reference (which also names a candidate, whose handle is
/// the reference a fill writes), the capture slot, and the destination a
/// navigation reaches. `None` means the verb has no such member.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Pinned {
    reference: Option<String>,
    slot: Option<Slot>,
    destination: Option<Destination>,
}

/// A verb's arguments, split into what may be rewritten and what may not.
pub(crate) trait Authority {
    /// The authority in these arguments. Everything else is content.
    fn pinned(&self) -> Pinned;
}

/// Where a navigation goes, as far as an interceptor may not move it.
///
/// The path, query and fragment are content — an interceptor may point a
/// navigation at another page of the same site. The origin is authority, and
/// so is anything in the URL that stands in for one: userinfo (`https://good@evil`
/// is a host trick) and a destination the URL parser cannot reduce to an
/// origin. Because the comparison is against the origin the *executor*
/// proposed, it also keeps every navigation inside the run's declared origin
/// whenever the executor's own step is inside it.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Destination {
    /// Absolute, or protocol-relative: scheme, host, port and userinfo.
    Origin {
        scheme: String,
        host: String,
        port: u16,
        username: String,
        password: Option<String>,
    },
    /// Resolved against whatever page the browser is on; stays there.
    Relative,
    /// An opaque origin (`data:`, `javascript:`) or a string that does not
    /// parse. Nothing about it can be compared, so only the identical string
    /// is the same destination.
    Exact(String),
}

/// Two bases no real navigation names. A reference is relative only when it
/// resolves to *each* base's own host: `//relative.invalid/x` resolves to the
/// first base's host too, but against the second it lands on a host of its
/// own, so it is an origin, not a relative reference.
const SENTINEL_HOSTS: [&str; 2] = ["relative-a.invalid", "relative-b.invalid"];

impl Destination {
    fn of(raw: &str) -> Self {
        match Url::parse(raw) {
            Ok(url) => Self::of_absolute(&url).unwrap_or_else(|| Self::Exact(raw.to_owned())),
            Err(url::ParseError::RelativeUrlWithoutBase) => Self::of_relative(raw),
            Err(_) => Self::Exact(raw.to_owned()),
        }
    }

    fn of_relative(raw: &str) -> Self {
        let joined = SENTINEL_HOSTS.map(|host| {
            Url::parse(&format!("http://{host}/"))
                .ok()
                .and_then(|base| base.join(raw).ok())
        });
        let [Some(first), Some(second)] = &joined else {
            return Self::Exact(raw.to_owned());
        };
        let stays = |url: &Url, host: &str| url.scheme() == "http" && url.host_str() == Some(host);
        if stays(first, SENTINEL_HOSTS[0]) && stays(second, SENTINEL_HOSTS[1]) {
            return Self::Relative;
        }
        // `//evil.example/x`: an origin of its own, whichever base it met.
        Self::of_absolute(first).unwrap_or_else(|| Self::Exact(raw.to_owned()))
    }

    fn of_absolute(url: &Url) -> Option<Self> {
        let Origin::Tuple(scheme, _, port) = url.origin() else {
            return None;
        };
        Some(Self::Origin {
            scheme,
            host: url.host_str()?.to_owned(),
            port,
            username: url.username().to_owned(),
            password: url.password().map(str::to_owned),
        })
    }
}

impl Authority for UrlArgs {
    fn pinned(&self) -> Pinned {
        Pinned {
            destination: Some(Destination::of(&self.url)),
            ..Pinned::default()
        }
    }
}

impl Authority for PlacedRefArgs {
    fn pinned(&self) -> Pinned {
        Pinned {
            reference: Some(self.reference.as_str().to_owned()),
            ..Pinned::default()
        }
    }
}

impl Authority for RefArgs {
    fn pinned(&self) -> Pinned {
        Pinned {
            reference: Some(self.reference.as_str().to_owned()),
            ..Pinned::default()
        }
    }
}

impl Authority for CaptureFieldArgs {
    fn pinned(&self) -> Pinned {
        Pinned {
            slot: Some(self.slot),
            ..Pinned::default()
        }
    }
}

impl Authority for CaptureDownloadArgs {
    fn pinned(&self) -> Pinned {
        Pinned {
            slot: Some(self.slot),
            ..Pinned::default()
        }
    }
}

/// A selector picks an element of the page the run is already on; rewriting
/// it is a content decision (a guard narrowing what a step touches).
impl Authority for SelectorArgs {
    fn pinned(&self) -> Pinned {
        Pinned::default()
    }
}

/// A mask manifest is the layout a frame is redacted with; a frame is
/// admitted or dropped by the session-observe gate, not by what asked for it.
impl Authority for MaskArgs {
    fn pinned(&self) -> Pinned {
        Pinned::default()
    }
}

impl Authority for NoArgs {
    fn pinned(&self) -> Pinned {
        Pinned::default()
    }
}

#[cfg(test)]
mod tests {
    use super::Destination;

    fn same(a: &str, b: &str) -> bool {
        Destination::of(a) == Destination::of(b)
    }

    #[test]
    fn a_path_query_or_fragment_is_content() {
        assert!(same("https://example.com/a", "https://example.com/b?x=1#y"));
        assert!(same("https://example.com", "https://example.com:443/"));
        assert!(same("https://EXAMPLE.com/a", "https://example.com/b"));
        assert!(same("/login", "settings/password"));
    }

    #[test]
    fn anything_that_moves_the_origin_is_authority() {
        assert!(!same("https://example.com/a", "https://evil.example/a"));
        assert!(!same("https://example.com/a", "http://example.com/a"));
        assert!(!same("https://example.com/a", "https://example.com:8443/a"));
        assert!(!same(
            "https://example.com/a",
            "https://example.com.evil.example/"
        ));
        assert!(!same(
            "https://example.com/a",
            "https://example.com@evil.example/"
        ));
        assert!(!same(
            "https://example.com/a",
            "https://user:pw@example.com/a"
        ));
    }

    #[test]
    fn a_relative_reference_cannot_become_another_origin() {
        assert!(!same("/login", "https://evil.example/login"));
        assert!(!same("/login", "//evil.example/login"));
        assert!(!same("/login", "\\\\evil.example/login"));
        // The sentinel host is not a way to stay "relative".
        assert!(!same("/login", "//relative-a.invalid/login"));
        assert!(!same("/login", "//relative-b.invalid/login"));
        assert!(!same("https://example.com/", "/login"));
    }

    #[test]
    fn an_opaque_or_unparseable_destination_is_only_ever_itself() {
        assert!(same("javascript:void(0)", "javascript:void(0)"));
        assert!(!same("javascript:void(0)", "javascript:void(1)"));
        assert!(!same("data:text/html,a", "data:text/html,b"));
        assert!(same("http://[::1", "http://[::1"));
        assert!(!same("http://[::1", "http://[::2"));
    }
}
