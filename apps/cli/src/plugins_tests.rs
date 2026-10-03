use super::*;
use crate::plugins_install::{install, normalize_pin, redirect_allowed, remove, InstallRequest};
use opensesame_plugin_settings::sha256_file;

struct Home {
    dir: tempfile::TempDir,
}

impl Home {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
        }
    }
    fn settings(&self) -> PathBuf {
        self.dir.path().join("config").join("plugins.json")
    }
    fn root(&self) -> PathBuf {
        self.dir.path().join("data").join("plugins")
    }
    fn artifact(&self, bytes: &[u8]) -> (PathBuf, String) {
        let path = self.dir.path().join("download.bin");
        std::fs::write(&path, bytes).unwrap();
        let pin = sha256_file(&path).unwrap();
        (path, pin)
    }
    fn load(&self) -> PluginSettings {
        PluginSettings::load(&self.settings()).unwrap()
    }
}

fn native(from: &std::path::Path, sha256: &str, version: Option<&str>) -> InstallRequest {
    InstallRequest {
        id: "surrogate-proxy".into(),
        from: from.display().to_string(),
        sha256: sha256.into(),
        version: version.map(str::to_owned),
        extension_id: None,
    }
}

#[tokio::test]
async fn an_install_is_pinned_placed_executable_and_recorded_off() {
    let home = Home::new();
    let (artifact, pin) = home.artifact(b"plugin bytes");
    let out = install(
        &home.settings(),
        &home.root(),
        native(&artifact, &pin, Some("1.2.0")),
    )
    .await
    .unwrap();
    let dest = home
        .root()
        .join("surrogate-proxy/1.2.0/opensesame-surrogate-proxy");
    assert_eq!(out["location"], dest.display().to_string());
    assert_eq!(out["enabled"], false);
    assert_eq!(std::fs::read(&dest).unwrap(), b"plugin bytes");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
    }
    let state = home.load().state("surrogate-proxy", |_| None).unwrap();
    assert!(state.installed && !state.enabled && !state.active);
}

#[tokio::test]
async fn bytes_that_are_not_the_pin_are_never_installed_or_recorded() {
    let home = Home::new();
    let (artifact, _) = home.artifact(b"tampered bytes");
    let error = install(
        &home.settings(),
        &home.root(),
        native(&artifact, &"a".repeat(64), None),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("sha256 mismatch"), "{error}");
    assert!(home.load().plugins.is_empty());
    let dir = home.root().join("surrogate-proxy/local");
    let leftovers: Vec<_> = std::fs::read_dir(&dir).map_or_else(|_| Vec::new(), Iterator::collect);
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[tokio::test]
async fn a_cleartext_or_other_scheme_url_is_refused_before_any_fetch() {
    let home = Home::new();
    for from in [
        "http://example.test/p",
        "ftp://example.test/p",
        "file:///etc/passwd",
    ] {
        let mut request = native(std::path::Path::new(from), &"a".repeat(64), None);
        request.from = from.into();
        let error = install(&home.settings(), &home.root(), request)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("only https"), "{from}: {error}");
    }
    assert!(home.load().plugins.is_empty());
}

#[test]
fn a_redirect_may_not_leave_the_named_host_or_https() {
    let url = |s: &str| reqwest::Url::parse(s).unwrap();
    assert!(redirect_allowed(
        "dl.example.test",
        &url("https://dl.example.test/x"),
        0
    ));
    assert!(!redirect_allowed(
        "dl.example.test",
        &url("https://evil.test/x"),
        0
    ));
    assert!(!redirect_allowed(
        "dl.example.test",
        &url("http://dl.example.test/x"),
        0
    ));
    assert!(!redirect_allowed(
        "dl.example.test",
        &url("https://dl.example.test.evil.test/x"),
        0
    ));
    assert!(!redirect_allowed(
        "dl.example.test",
        &url("https://dl.example.test/x"),
        5
    ));
}

#[tokio::test]
async fn a_version_that_traverses_is_refused() {
    let home = Home::new();
    let (artifact, pin) = home.artifact(b"x");
    for version in ["../../bin", "a/b", ".hidden", ""] {
        let error = install(
            &home.settings(),
            &home.root(),
            native(&artifact, &pin, Some(version)),
        )
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains("plain name"),
            "{version}: {error}"
        );
    }
}

#[test]
fn a_pin_is_64_hex_and_stored_lowercase() {
    assert_eq!(normalize_pin(&"AB".repeat(32)).unwrap(), "ab".repeat(32));
    assert!(normalize_pin("abc").is_err());
    assert!(normalize_pin(&"zz".repeat(32)).is_err());
}

#[test]
fn enabling_a_plugin_nobody_installed_says_how_to_install_it() {
    let home = Home::new();
    let error = set_enabled(&home.settings(), "surrogate-proxy", true).unwrap_err();
    let text = error.to_string();
    assert!(text.contains("not installed"), "{text}");
    assert!(
        text.contains("opensesame plugins install surrogate-proxy"),
        "{text}"
    );
}

#[test]
fn an_unknown_plugin_names_the_catalog() {
    let home = Home::new();
    let error = set_enabled(&home.settings(), "keylogger", true).unwrap_err();
    assert!(error.to_string().contains("surrogate-proxy"), "{error}");
}

#[tokio::test]
async fn enable_and_disable_round_trip_and_status_reports_the_pin() {
    let home = Home::new();
    let (artifact, pin) = home.artifact(b"plugin bytes");
    install(
        &home.settings(),
        &home.root(),
        native(&artifact, &pin, None),
    )
    .await
    .unwrap();
    let on = set_enabled(&home.settings(), "surrogate-proxy", true).unwrap();
    assert_eq!(on["enabled"], true);
    assert_eq!(
        status(&home.settings(), "surrogate-proxy").unwrap()["pin"],
        "ok"
    );
    let off = set_enabled(&home.settings(), "surrogate-proxy", false).unwrap();
    assert_eq!(off["enabled"], false);
    assert!(!home.load().plugins["surrogate-proxy"].enabled);
}

#[tokio::test]
async fn a_binary_changed_after_install_cannot_be_switched_on() {
    let home = Home::new();
    let (artifact, pin) = home.artifact(b"plugin bytes");
    let out = install(
        &home.settings(),
        &home.root(),
        native(&artifact, &pin, None),
    )
    .await
    .unwrap();
    std::fs::write(out["location"].as_str().unwrap(), b"swapped").unwrap();
    let error = set_enabled(&home.settings(), "surrogate-proxy", true).unwrap_err();
    assert!(error.to_string().contains("left off"), "{error}");
    assert!(!home.load().plugins["surrogate-proxy"].enabled);
    assert_eq!(
        status(&home.settings(), "surrogate-proxy").unwrap()["pin"],
        "mismatch"
    );
}

#[tokio::test]
async fn remove_deletes_the_files_and_the_record() {
    let home = Home::new();
    let (artifact, pin) = home.artifact(b"plugin bytes");
    install(
        &home.settings(),
        &home.root(),
        native(&artifact, &pin, None),
    )
    .await
    .unwrap();
    let out = remove(&home.settings(), &home.root(), "surrogate-proxy").unwrap();
    assert_eq!(out["record"], true);
    assert_eq!(out["files"], true);
    assert!(!home.root().join("surrogate-proxy").exists());
    assert!(home.load().plugins.is_empty());
}

#[test]
fn remove_never_deletes_a_recorded_location_outside_the_install_root() {
    let home = Home::new();
    let outside = home.dir.path().join("elsewhere.bin");
    std::fs::write(&outside, b"not ours").unwrap();
    let mut settings = PluginSettings::default();
    let pin = sha256_file(&outside).unwrap();
    settings
        .record_install("surrogate-proxy", "1", &pin, outside.to_str().unwrap())
        .unwrap();
    settings.save(&home.settings()).unwrap();
    let out = remove(&home.settings(), &home.root(), "surrogate-proxy").unwrap();
    assert!(outside.exists());
    assert_eq!(out["left_in_place"], outside.display().to_string());
}

#[tokio::test]
async fn a_browser_extension_records_its_extension_id_after_its_zip_verifies() {
    let home = Home::new();
    let (zip, pin) = home.artifact(b"PK zip bytes");
    let request = InstallRequest {
        id: "browser-autofill".into(),
        from: zip.display().to_string(),
        sha256: pin,
        version: Some("0.1.0".into()),
        extension_id: Some("abcdefghijklmnopabcdefghijklmnop".into()),
    };
    let out = install(&home.settings(), &home.root(), request.clone())
        .await
        .unwrap();
    assert_eq!(out["location"], "abcdefghijklmnopabcdefghijklmnop");
    assert!(home
        .root()
        .join("browser-autofill/0.1.0/browser-autofill.zip")
        .exists());
    let mut missing = request;
    missing.extension_id = None;
    assert!(install(&home.settings(), &home.root(), missing)
        .await
        .is_err());
}

/// The install command Settings shows a person to copy
/// (`packages/app-core/src/lib/plugins/catalog.ts`), with its placeholders
/// filled, parsed by this CLI's own parser: a command that drifts from the
/// verb's required arguments fails here, not at the person's terminal.
#[test]
fn the_install_command_settings_shows_parses_as_this_cli_install() {
    use clap::Parser as _;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let pages =
        std::fs::read_to_string(root.join("packages/app-core/src/lib/plugins/catalog.ts")).unwrap();
    let shown = regex::Regex::new(r#"installCommand:\s*"([^"]+)""#).unwrap();
    let commands: Vec<&str> = shown
        .captures_iter(&pages)
        .map(|c| c.get(1).unwrap().as_str())
        .collect();
    assert_eq!(commands.len(), catalog().len(), "{commands:?}");
    for plugin in catalog() {
        let command = commands
            .iter()
            .find(|c| c.split_whitespace().nth(3) == Some(plugin.id.as_str()))
            .unwrap_or_else(|| panic!("no install command for {}", plugin.id));
        let filled = command
            .replace("<file-or-url>", "/tmp/artifact")
            .replace("<sha256>", &"a".repeat(64))
            .replace("<extension-id>", "abcdefghijklmnopabcdefghijklmnop");
        assert!(!filled.contains('<'), "unknown placeholder in {command}");
        let cli = crate::Cli::try_parse_from(filled.split_whitespace())
            .unwrap_or_else(|e| panic!("{command}: {e}"));
        let crate::Commands::Plugins {
            cmd: PluginsCmd::Install {
                id, extension_id, ..
            },
        } = cli.command
        else {
            panic!("{command} is not `plugins install`");
        };
        assert_eq!(id, plugin.id);
        let is_extension = matches!(
            plugin.kind,
            opensesame_plugin_settings::PluginKind::BrowserExtension
        );
        assert_eq!(extension_id.is_some(), is_extension, "{command}");
    }
}
