//! Native-messaging **host manifests** — the approval gate for stdio bridges.
//!
//! A browser will not launch a native-messaging host until a manifest naming
//! that host, its absolute path, and the extension ids allowed to talk to it
//! exists in a per-user directory. Writing that file is a deliberate, named
//! act by the human (`opensesame bridge install …`), and it is what makes the
//! stdio bridges satisfy constitution C2(b): the browser is a caller identity
//! that a person explicitly admitted, once.
//!
//! Nothing here reads or writes secrets; it is path + JSON logic only.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::BridgeError;

/// Which foreign protocol a manifest advertises.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeKind {
    /// browserpass-native compatible host.
    Browserpass,
    /// gopass-jsonapi compatible host.
    Gopass,
    /// keepassxc-proxy compatible host (stdio mode).
    KeepassXc,
}

impl BridgeKind {
    /// The manifest `name`, which is also the file's basename. These are the
    /// names the *stock* extensions look for — that is the whole point.
    #[must_use]
    pub fn host_name(self) -> &'static str {
        match self {
            BridgeKind::Browserpass => "com.github.browserpass.native",
            BridgeKind::Gopass => "com.justwatch.gopass",
            BridgeKind::KeepassXc => "org.keepassxc.keepassxc_browser",
        }
    }

    #[must_use]
    pub fn description(self) -> &'static str {
        match self {
            BridgeKind::Browserpass => {
                "OpenSesame sealed-store bridge speaking the browserpass-native protocol"
            }
            BridgeKind::Gopass => {
                "OpenSesame sealed-store bridge speaking the gopass-jsonapi protocol"
            }
            BridgeKind::KeepassXc => {
                "OpenSesame sealed-store bridge speaking the keepassxc-protocol"
            }
        }
    }

    /// Default binary name shipped by this crate.
    #[must_use]
    pub fn default_binary(self) -> &'static str {
        match self {
            BridgeKind::Browserpass => "opensesame-browserpass-host",
            BridgeKind::Gopass => "opensesame-gopass-jsonapi",
            BridgeKind::KeepassXc => "opensesame-keepassxc-bridge",
        }
    }

    /// Chrome/Chromium extension ids permitted to launch the host.
    #[must_use]
    pub fn chrome_extension_ids(self) -> &'static [&'static str] {
        match self {
            BridgeKind::Browserpass => &[
                "naepdomgkenhinolocfifgehidddafch",
                "pjmbgaakjkbhpopmakjoedenlfdmcdgm",
                "klfoddkbhleoaabpmiigbmpbjfljimgb",
            ],
            BridgeKind::Gopass => &["kkhfnlkhiapbiehimabddjbimfaijdhk"],
            BridgeKind::KeepassXc => &[
                "oboonakemofpalcgghocfoadofidjkkk",
                "pdffhmdngciaglkoonimfcmckehcpafo",
            ],
        }
    }

    /// Firefox extension ids permitted to launch the host.
    #[must_use]
    pub fn firefox_extension_ids(self) -> &'static [&'static str] {
        match self {
            BridgeKind::Browserpass => &["browserpass@maximbaz.com"],
            BridgeKind::Gopass => &["{eec37db0-22ad-4bf1-9068-5ae08df8c7e9}"],
            BridgeKind::KeepassXc => &["keepassxc-browser@keepassxc.org"],
        }
    }
}

impl std::str::FromStr for BridgeKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "browserpass" => Ok(BridgeKind::Browserpass),
            "gopass" => Ok(BridgeKind::Gopass),
            "keepassxc" => Ok(BridgeKind::KeepassXc),
            other => Err(format!("unknown bridge '{other}'")),
        }
    }
}

/// Browser families with distinct manifest locations and key names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Browser {
    Chrome,
    Chromium,
    Firefox,
}

impl Browser {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Browser::Chrome => "chrome",
            Browser::Chromium => "chromium",
            Browser::Firefox => "firefox",
        }
    }
}

impl std::str::FromStr for Browser {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "chrome" | "google-chrome" => Ok(Browser::Chrome),
            "chromium" => Ok(Browser::Chromium),
            "firefox" => Ok(Browser::Firefox),
            other => Err(format!("unknown browser '{other}'")),
        }
    }
}

/// A Chrome-family manifest (`allowed_origins`).
#[derive(Debug, Serialize)]
struct ChromeManifest<'a> {
    name: &'a str,
    description: &'a str,
    path: String,
    #[serde(rename = "type")]
    kind: &'a str,
    allowed_origins: Vec<String>,
}

/// A Firefox manifest (`allowed_extensions`).
#[derive(Debug, Serialize)]
struct FirefoxManifest<'a> {
    name: &'a str,
    description: &'a str,
    path: String,
    #[serde(rename = "type")]
    kind: &'a str,
    allowed_extensions: Vec<String>,
}

/// Render the manifest JSON for `bridge` in `browser`, pointing at `binary`.
///
/// # Errors
///
/// Returns an error when the manifest cannot be serialized.
pub fn render_manifest(
    bridge: BridgeKind,
    browser: Browser,
    binary: &Path,
) -> Result<String, BridgeError> {
    let path = binary.to_string_lossy().to_string();
    let json = match browser {
        Browser::Firefox => serde_json::to_string_pretty(&FirefoxManifest {
            name: bridge.host_name(),
            description: bridge.description(),
            path,
            kind: "stdio",
            allowed_extensions: bridge
                .firefox_extension_ids()
                .iter()
                .map(|id| (*id).to_string())
                .collect(),
        }),
        Browser::Chrome | Browser::Chromium => serde_json::to_string_pretty(&ChromeManifest {
            name: bridge.host_name(),
            description: bridge.description(),
            path,
            kind: "stdio",
            allowed_origins: bridge
                .chrome_extension_ids()
                .iter()
                .map(|id| format!("chrome-extension://{id}/"))
                .collect(),
        }),
    };
    json.map(|mut s| {
        s.push('\n');
        s
    })
    .map_err(|e| BridgeError::Store(format!("unserializable manifest: {e}")))
}

/// Per-user directory a browser scans for native-messaging manifests.
///
/// `home` is passed in rather than read from the environment so this is a
/// pure function the tests can drive against a tempdir.
#[must_use]
pub fn manifest_dir(browser: Browser, home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        let support = home.join("Library").join("Application Support");
        return match browser {
            Browser::Chrome => support
                .join("Google")
                .join("Chrome")
                .join("NativeMessagingHosts"),
            Browser::Chromium => support.join("Chromium").join("NativeMessagingHosts"),
            Browser::Firefox => support.join("Mozilla").join("NativeMessagingHosts"),
        };
    }
    match browser {
        Browser::Chrome => home
            .join(".config")
            .join("google-chrome")
            .join("NativeMessagingHosts"),
        Browser::Chromium => home
            .join(".config")
            .join("chromium")
            .join("NativeMessagingHosts"),
        Browser::Firefox => home.join(".mozilla").join("native-messaging-hosts"),
    }
}

/// Full manifest path for a bridge/browser pair.
#[must_use]
pub fn manifest_path(bridge: BridgeKind, browser: Browser, home: &Path) -> PathBuf {
    manifest_dir(browser, home).join(format!("{}.json", bridge.host_name()))
}

/// The result of an install, for the CLI to report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub path: PathBuf,
    pub host_name: &'static str,
    pub binary: PathBuf,
}

/// Write the manifest. Creates the browser's directory if it does not exist.
///
/// This is the C2 approval act: after it, the named browser extensions — and
/// only those — may launch the bridge.
///
/// # Errors
///
/// Returns an error when the manifest cannot be rendered or written.
pub fn install(
    bridge: BridgeKind,
    browser: Browser,
    home: &Path,
    binary: &Path,
) -> Result<Installed, BridgeError> {
    let json = render_manifest(bridge, browser, binary)?;
    let path = manifest_path(bridge, browser, home);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, json)?;
    Ok(Installed {
        path,
        host_name: bridge.host_name(),
        binary: binary.to_path_buf(),
    })
}

/// Remove a previously installed manifest; absent is success.
///
/// # Errors
///
/// Returns an I/O error when an existing manifest cannot be removed.
pub fn uninstall(
    bridge: BridgeKind,
    browser: Browser,
    home: &Path,
) -> Result<PathBuf, BridgeError> {
    let path = manifest_path(bridge, browser, home);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(path),
        Err(e) => Err(BridgeError::Io(e)),
    }
}

/// Guess where a bridge binary lives: next to the running executable, else
/// the bare name for `PATH` resolution by the browser.
#[must_use]
pub fn default_binary_path(bridge: BridgeKind) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(bridge.default_binary());
            if candidate.exists() {
                return candidate;
            }
        }
    }
    PathBuf::from(bridge.default_binary())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrome_manifest_uses_allowed_origins() {
        let json = render_manifest(
            BridgeKind::Browserpass,
            Browser::Chrome,
            Path::new("/usr/local/bin/opensesame-browserpass-host"),
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["name"], "com.github.browserpass.native");
        assert_eq!(value["type"], "stdio");
        assert_eq!(value["path"], "/usr/local/bin/opensesame-browserpass-host");
        assert_eq!(
            value["allowed_origins"][0],
            "chrome-extension://naepdomgkenhinolocfifgehidddafch/"
        );
        assert!(value.get("allowed_extensions").is_none());
        assert!(json.ends_with('\n'));
    }

    #[test]
    fn firefox_manifest_uses_allowed_extensions() {
        let json = render_manifest(
            BridgeKind::Gopass,
            Browser::Firefox,
            Path::new("/opt/os/opensesame-gopass-jsonapi"),
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["name"], "com.justwatch.gopass");
        assert_eq!(
            value["allowed_extensions"][0],
            "{eec37db0-22ad-4bf1-9068-5ae08df8c7e9}"
        );
        assert!(value.get("allowed_origins").is_none());
    }

    #[test]
    fn keepassxc_manifest_names_the_stock_host() {
        let json = render_manifest(
            BridgeKind::KeepassXc,
            Browser::Firefox,
            Path::new("/bin/opensesame-keepassxc-bridge"),
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["name"], "org.keepassxc.keepassxc_browser");
        assert_eq!(
            value["allowed_extensions"][0],
            "keepassxc-browser@keepassxc.org"
        );
    }

    #[test]
    fn manifest_paths_are_per_browser() {
        let home = Path::new("/home/tester");
        let chrome = manifest_path(BridgeKind::Browserpass, Browser::Chrome, home);
        let chromium = manifest_path(BridgeKind::Browserpass, Browser::Chromium, home);
        let firefox = manifest_path(BridgeKind::Browserpass, Browser::Firefox, home);
        assert_ne!(chrome, chromium);
        assert_ne!(chrome, firefox);
        for path in [&chrome, &chromium, &firefox] {
            assert!(path.ends_with("com.github.browserpass.native.json"));
            assert!(path.starts_with(home));
        }
        if cfg!(target_os = "macos") {
            assert!(chrome.to_string_lossy().contains("Application Support"));
        } else {
            assert!(chrome.to_string_lossy().contains(".config/google-chrome"));
            assert!(firefox.to_string_lossy().contains(".mozilla"));
        }
    }

    #[test]
    fn install_then_uninstall_round_trips() {
        let home = tempfile::tempdir().unwrap();
        let binary = Path::new("/usr/bin/opensesame-browserpass-host");
        let installed = install(
            BridgeKind::Browserpass,
            Browser::Firefox,
            home.path(),
            binary,
        )
        .unwrap();
        assert!(installed.path.exists());
        assert_eq!(installed.host_name, "com.github.browserpass.native");

        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&installed.path).unwrap()).unwrap();
        assert_eq!(json["path"], binary.to_string_lossy().as_ref());

        let removed = uninstall(BridgeKind::Browserpass, Browser::Firefox, home.path()).unwrap();
        assert!(!removed.exists());
        // Idempotent.
        uninstall(BridgeKind::Browserpass, Browser::Firefox, home.path()).unwrap();
    }

    #[test]
    fn install_overwrites_a_previous_manifest() {
        let home = tempfile::tempdir().unwrap();
        install(
            BridgeKind::Gopass,
            Browser::Chrome,
            home.path(),
            Path::new("/old/path"),
        )
        .unwrap();
        let installed = install(
            BridgeKind::Gopass,
            Browser::Chrome,
            home.path(),
            Path::new("/new/path"),
        )
        .unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&installed.path).unwrap()).unwrap();
        assert_eq!(json["path"], "/new/path");
    }

    #[test]
    fn parsers_accept_the_documented_spellings() {
        use std::str::FromStr;
        assert_eq!(
            BridgeKind::from_str("Browserpass").unwrap(),
            BridgeKind::Browserpass
        );
        assert_eq!(BridgeKind::from_str("gopass").unwrap(), BridgeKind::Gopass);
        assert_eq!(
            BridgeKind::from_str("keepassxc").unwrap(),
            BridgeKind::KeepassXc
        );
        assert!(BridgeKind::from_str("1password").is_err());

        assert_eq!(Browser::from_str("google-chrome").unwrap(), Browser::Chrome);
        assert_eq!(Browser::from_str("FIREFOX").unwrap(), Browser::Firefox);
        assert_eq!(Browser::from_str("chromium").unwrap(), Browser::Chromium);
        assert!(Browser::from_str("safari").is_err());
        assert_eq!(Browser::Chrome.as_str(), "chrome");
    }

    #[test]
    fn default_binary_path_falls_back_to_the_bare_name() {
        let path = default_binary_path(BridgeKind::KeepassXc);
        assert!(path
            .to_string_lossy()
            .ends_with("opensesame-keepassxc-bridge"));
    }
}
