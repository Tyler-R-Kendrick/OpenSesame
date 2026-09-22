//! What to put in a disposable leaf, and when it is valid.
//!
//! Split out of the issuer so both files stay inside the 400-line module
//! budget (ADR 0093). Every knob here exists to build a *negative* fixture a
//! real verifier must reject.

/// How long a leaf is valid for. `Expired`/`NotYetValid` use absolute
/// timestamps so the fixture does not depend on when the suite runs.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Window {
    Valid,
    Expired,
    NotYetValid,
}

impl Window {
    pub(super) fn absolute(self) -> (String, String) {
        let now = chrono::Utc::now();
        let fmt = |t: chrono::DateTime<chrono::Utc>| t.format("%Y%m%d%H%M%SZ").to_string();
        match self {
            Self::Expired => (
                fmt(now - chrono::Duration::hours(6)),
                fmt(now - chrono::Duration::hours(1)),
            ),
            _ => (
                fmt(now + chrono::Duration::hours(1)),
                fmt(now + chrono::Duration::hours(6)),
            ),
        }
    }
}

/// What to put in a leaf. Only the knobs an interop assertion needs.
pub struct LeafSpec {
    pub(super) name: String,
    sans: Vec<String>,
    eku: &'static str,
    pub(super) window: Window,
    is_ca: bool,
}

impl LeafSpec {
    /// A `serverAuth` leaf with one DNS SAN.
    #[must_use]
    pub fn server(name: &str, dns: &str) -> Self {
        Self {
            name: name.to_string(),
            sans: vec![format!("DNS:{dns}")],
            eku: "serverAuth",
            window: Window::Valid,
            is_ca: false,
        }
    }

    /// A `clientAuth` leaf with one URI SAN (SPIFFE ID or plain URI).
    #[must_use]
    pub fn client_uri(name: &str, uri: &str) -> Self {
        Self {
            name: name.to_string(),
            sans: vec![format!("URI:{uri}")],
            eku: "clientAuth",
            window: Window::Valid,
            is_ca: false,
        }
    }

    /// A `clientAuth` leaf with one DNS SAN.
    #[must_use]
    pub fn client_dns(name: &str, dns: &str) -> Self {
        Self {
            name: name.to_string(),
            sans: vec![format!("DNS:{dns}")],
            eku: "clientAuth",
            window: Window::Valid,
            is_ca: false,
        }
    }

    /// Both EKUs, as a SPIFFE X509-SVID usually carries.
    #[must_use]
    pub fn dual_uri(name: &str, uri: &str) -> Self {
        let mut spec = Self::client_uri(name, uri);
        spec.eku = "serverAuth,clientAuth";
        spec
    }

    /// Move the validity window.
    #[must_use]
    pub fn window(mut self, window: Window) -> Self {
        self.window = window;
        self
    }

    /// Set `CA:TRUE` on an end-entity certificate (an adversarial fixture).
    #[must_use]
    pub fn as_ca(mut self) -> Self {
        self.is_ca = true;
        self
    }

    pub(super) fn extensions(&self) -> String {
        let bc = if self.is_ca {
            "basicConstraints=critical,CA:TRUE"
        } else {
            "basicConstraints=critical,CA:FALSE"
        };
        format!(
            "{bc}\nkeyUsage=critical,digitalSignature,keyEncipherment\n\
             extendedKeyUsage={}\nsubjectAltName={}\nsubjectKeyIdentifier=hash\n",
            self.eku,
            self.sans.join(",")
        )
    }
}
