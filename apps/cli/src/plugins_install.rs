//! Installing and removing a plugin's files (ADR 0150 §7).
//!
//! An install is: fetch into a partial file beside its destination, hash it,
//! refuse unless the hash is the pin the person gave, then move it into place
//! and record it **off**. Nothing is recorded, and nothing is left behind,
//! when the bytes are not the pinned ones. A URL must be https, and a
//! redirect may not leave the host the person named.
//!
//! ```text
//! <data dir>/plugins/<id>/<version>/<binary>     a native plugin, 0755
//! <data dir>/plugins/<id>/<version>/<id>.zip     an extension's package
//! ```
//!
//! `OPENSESAME_PLUGINS_DIR` replaces `<data dir>/plugins`.

use std::path::{Path, PathBuf};

use opensesame_plugin_settings::{catalog, sha256_file, CatalogPlugin, PluginKind, PluginSettings};
use serde_json::{json, Value};

/// Overrides where plugin files are installed.
pub(crate) const INSTALL_DIR_ENV: &str = "OPENSESAME_PLUGINS_DIR";
/// Largest artifact an install fetches.
const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;
/// Most redirects a download follows, all on the named host.
const MAX_REDIRECTS: usize = 5;

/// What `opensesame plugins install` was asked.
#[derive(Debug, Clone)]
pub(crate) struct InstallRequest {
    pub id: String,
    pub from: String,
    pub sha256: String,
    pub version: Option<String>,
    pub extension_id: Option<String>,
}

/// `<data dir>/plugins`, or [`INSTALL_DIR_ENV`].
pub(crate) fn install_root() -> anyhow::Result<PathBuf> {
    if let Some(dir) = std::env::var_os(INSTALL_DIR_ENV).filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    let dirs = directories::ProjectDirs::from("dev", "OpenSesame", "opensesame")
        .ok_or_else(|| anyhow::anyhow!("no data directory for plugins"))?;
    Ok(dirs.data_dir().join("plugins"))
}

fn row(id: &str) -> anyhow::Result<CatalogPlugin> {
    catalog()
        .into_iter()
        .find(|plugin| plugin.id == id)
        .ok_or_else(|| anyhow::anyhow!("unknown plugin {id}"))
}

/// A pin is 64 hex characters; stored lowercase.
pub(crate) fn normalize_pin(raw: &str) -> anyhow::Result<String> {
    let pin = raw.trim().to_ascii_lowercase();
    if pin.len() != 64 || !pin.bytes().all(|b| b.is_ascii_hexdigit()) {
        anyhow::bail!("--sha256 must be 64 hex characters");
    }
    Ok(pin)
}

/// A version names a directory, so it is one plain path segment.
pub(crate) fn check_segment(what: &str, value: &str) -> anyhow::Result<()> {
    let plain = !value.is_empty()
        && value.len() <= 64
        && !value.starts_with('.')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'+'));
    if !plain {
        anyhow::bail!("{what} must be a plain name ([A-Za-z0-9._+-], not starting with '.')");
    }
    Ok(())
}

/// Install `request` under `root` and record it off in `settings_path`.
pub(crate) async fn install(
    settings_path: &Path,
    root: &Path,
    request: InstallRequest,
) -> anyhow::Result<Value> {
    let plugin = row(&request.id)?;
    let pin = normalize_pin(&request.sha256)?;
    let version = request
        .version
        .clone()
        .unwrap_or_else(|| "local".to_owned());
    check_segment("--version", &version)?;
    let dir = root.join(&plugin.id).join(&version);
    let (location, verified_by) = match plugin.kind {
        PluginKind::NativeBinary => {
            let binary = plugin
                .binary
                .clone()
                .ok_or_else(|| anyhow::anyhow!("catalog row {} names no binary", plugin.id))?;
            let dest = dir.join(&binary);
            place(&request.from, &dest, &pin, true).await?;
            (dest.display().to_string(), "sha256")
        }
        PluginKind::BrowserExtension => {
            let extension_id = request.extension_id.clone().ok_or_else(|| {
                anyhow::anyhow!("--extension-id is required for a browser extension")
            })?;
            check_segment("--extension-id", &extension_id)?;
            if request.from == extension_id {
                // A store id: the browser's store verifies the package.
                (extension_id, "store")
            } else {
                let dest = dir.join(format!("{}.zip", plugin.id));
                place(&request.from, &dest, &pin, false).await?;
                (extension_id, "sha256")
            }
        }
    };
    let mut settings = PluginSettings::load(settings_path)?;
    settings.record_install(&plugin.id, &version, &pin, &location)?;
    settings.save(settings_path)?;
    Ok(json!({
        "installed": plugin.id,
        "version": version,
        "location": location,
        "sha256": pin,
        "verified_by": verified_by,
        "enabled": false,
        "next": format!("opensesame plugins enable {}", plugin.id),
    }))
}

/// Fetch `from` to a partial file beside `dest`, verify it, move it in place.
async fn place(from: &str, dest: &Path, pin: &str, executable: bool) -> anyhow::Result<()> {
    let dir = dest
        .parent()
        .ok_or_else(|| anyhow::anyhow!("install destination has no directory"))?;
    std::fs::create_dir_all(dir)?;
    let name = dest
        .file_name()
        .map_or_else(Default::default, |n| n.to_string_lossy().into_owned());
    let partial = dir.join(format!(".{name}.partial"));
    let _ = std::fs::remove_file(&partial);
    let fetched = fetch(from, &partial).await;
    let verified = fetched.and_then(|()| {
        let digest = sha256_file(&partial)?;
        if digest != pin {
            anyhow::bail!(
                "sha256 mismatch: --from is {digest}, --sha256 was {pin}; nothing installed"
            );
        }
        Ok(())
    });
    if let Err(error) = verified {
        let _ = std::fs::remove_file(&partial);
        return Err(error);
    }
    set_mode(&partial, if executable { 0o755 } else { 0o644 })?;
    std::fs::rename(&partial, dest)?;
    Ok(())
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_: &Path, _: u32) -> std::io::Result<()> {
    Ok(())
}

async fn fetch(from: &str, partial: &Path) -> anyhow::Result<()> {
    if let Some((scheme, _)) = from.split_once("://") {
        if !scheme.eq_ignore_ascii_case("https") {
            anyhow::bail!("only https URLs are installed from, not {scheme}://");
        }
        return download(from, partial).await;
    }
    let source = Path::new(from);
    let len = std::fs::metadata(source)
        .map_err(|error| anyhow::anyhow!("--from {from}: {error}"))?
        .len();
    if len > MAX_ARTIFACT_BYTES {
        anyhow::bail!("--from is larger than {MAX_ARTIFACT_BYTES} bytes");
    }
    std::fs::copy(source, partial)?;
    Ok(())
}

/// Whether a redirect to `next`, after `hops` redirects, stays on `host` over
/// https.
pub(crate) fn redirect_allowed(host: &str, next: &reqwest::Url, hops: usize) -> bool {
    hops < MAX_REDIRECTS
        && next.scheme() == "https"
        && next
            .host_str()
            .is_some_and(|h| h.eq_ignore_ascii_case(host))
}

async fn download(url: &str, partial: &Path) -> anyhow::Result<()> {
    use std::io::Write;
    let parsed = reqwest::Url::parse(url)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("the URL names no host"))?
        .to_owned();
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if redirect_allowed(&host, attempt.url(), attempt.previous().len()) {
            attempt.follow()
        } else {
            attempt.error("a redirect left the named host or https")
        }
    });
    let client = reqwest::Client::builder()
        .redirect(policy)
        .https_only(true)
        .build()?;
    let mut response = client.get(parsed).send().await?.error_for_status()?;
    let mut file = std::fs::File::create(partial)?;
    let mut total: u64 = 0;
    while let Some(chunk) = response.chunk().await? {
        total = total.saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
        if total > MAX_ARTIFACT_BYTES {
            anyhow::bail!("the download is larger than {MAX_ARTIFACT_BYTES} bytes");
        }
        file.write_all(&chunk)?;
    }
    file.flush()?;
    Ok(())
}

/// Delete `id`'s files under `root` and its record.
///
/// Only `<root>/<id>` is deleted: a recorded location outside it (an install
/// made with another `OPENSESAME_PLUGINS_DIR`) is reported, never removed, so
/// a tampered settings file cannot aim this at an arbitrary path.
pub(crate) fn remove(settings_path: &Path, root: &Path, id: &str) -> anyhow::Result<Value> {
    let plugin = row(id)?;
    let mut settings = PluginSettings::load(settings_path)?;
    let own = root.join(&plugin.id);
    let outside = settings
        .plugins
        .get(id)
        .filter(|p| {
            plugin.kind == PluginKind::NativeBinary && !Path::new(&p.location).starts_with(&own)
        })
        .map(|p| p.location.clone());
    let files = own.exists();
    if files {
        std::fs::remove_dir_all(&own)?;
    }
    let record = settings.remove(id);
    settings.save(settings_path)?;
    Ok(json!({
        "removed": plugin.id,
        "record": record,
        "files": files,
        "left_in_place": outside,
    }))
}
