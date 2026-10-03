//! Web logins for `opensesame dev run --agent` (ADR 0150 §6.3): an
//! `opensesameLogin(<sealed-store path>, origin=…, action=…, field=…)` entry
//! becomes an `osr_…` surrogate in the child and the person's password in the
//! declared form field — placed by the `surrogate-proxy` plugin, never by the
//! child.
//!
//! This process is the person's session, so it is the one that reads the
//! sealed store, through the same unlock as `opensesame pass show`. The
//! password leaves it only inside the plugin's run spec, over the plugin's
//! stdin pipe: never argv, never a file, never the child's environment, never
//! a log line. Nothing is read unless the plugin is on and will take it.
//!
//! **Where the password may go is the store's to say, not the schema's.**
//! `.env.schema` sits in a working tree an agent can edit; a login entry that
//! could name its own origin would let the agent point the person's password
//! at itself. So the sealed entry must carry `url: https://…` (pass's own
//! convention), and the declared `origin=` must be that URL's origin exactly,
//! or the run refuses to start.

use std::cell::RefCell;
use std::path::Path;

use opensesame_env_spec::{ResolvedEnvEntry, WebLogin};
use opensesame_sealed_store::{ItemDataKey, StoreRoot};
use serde::Serialize;
use zeroize::Zeroizing;

/// One login as it travels to the plugin. `Debug` never prints the secret.
#[derive(Serialize)]
pub(crate) struct LoginWire {
    pub(crate) env_var: String,
    pub(crate) origin: String,
    pub(crate) action: String,
    pub(crate) field: String,
    #[serde(serialize_with = "expose")]
    secret: Zeroizing<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ca_pem: Option<String>,
}

impl std::fmt::Debug for LoginWire {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginWire")
            .field("env_var", &self.env_var)
            .field("origin", &self.origin)
            .field("action", &self.action)
            .field("field", &self.field)
            .finish_non_exhaustive()
    }
}

fn expose<S: serde::Serializer>(secret: &Zeroizing<String>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(secret)
}

/// What the store holds for one login: its first line, and the `url:` its
/// trailer names.
pub(crate) struct StoredLogin {
    pub(crate) secret: Zeroizing<String>,
    pub(crate) url: Option<String>,
}

/// Where login passwords come from.
pub(crate) trait LoginSource {
    /// The entry at `store_path`.
    ///
    /// # Errors
    ///
    /// When the store cannot be opened or holds no such entry.
    fn read(&self, store_path: &str) -> anyhow::Result<StoredLogin>;
}

/// The person's sealed store, unlocked once, on first use, exactly as `pass
/// show` unlocks it (`OPENSESAME_STORE_PASSWORD`, else a hidden prompt).
#[derive(Default)]
pub(crate) struct SealedStoreLogins {
    unlocked: RefCell<Option<(StoreRoot, ItemDataKey)>>,
}

impl LoginSource for SealedStoreLogins {
    fn read(&self, store_path: &str) -> anyhow::Result<StoredLogin> {
        let mut unlocked = self.unlocked.borrow_mut();
        if unlocked.is_none() {
            *unlocked = Some(crate::store::open_unlocked(None, None)?);
        }
        let Some((root, key)) = unlocked.as_ref() else {
            anyhow::bail!("the sealed store did not open");
        };
        let age_id = std::env::var("OPENSESAME_AGE_IDENTITY").ok();
        let mut entry = root
            .show_with_age_identity(store_path, key, age_id.as_deref())
            .map_err(|_| anyhow::anyhow!("the sealed store has no readable entry {store_path}"))?;
        let url = trailer_url(&entry.trailer);
        let secret = Zeroizing::new(std::mem::take(&mut entry.secret));
        drop(Zeroizing::new(std::mem::take(&mut entry.trailer)));
        Ok(StoredLogin { secret, url })
    }
}

/// The login entries of a resolved schema.
pub(crate) fn declared(entries: &[ResolvedEnvEntry]) -> Vec<(&str, &WebLogin)> {
    entries
        .iter()
        .filter_map(|entry| Some((entry.key.as_str(), entry.login.as_ref()?)))
        .collect()
}

/// Read each declared login from `source` and bind it to its entry's origin.
///
/// # Errors
///
/// When an entry cannot be read, names no `url:`, or names another origin
/// than the schema declares; or a `ca=` file cannot be read.
pub(crate) fn resolve(
    declared: &[(&str, &WebLogin)],
    source: &dyn LoginSource,
) -> anyhow::Result<Vec<LoginWire>> {
    declared
        .iter()
        .map(|(env_var, login)| {
            let declared_origin = origin_of(&login.origin)
                .ok_or_else(|| anyhow::anyhow!("{env_var}: origin= is not an https origin"))?;
            let stored = source.read(&login.store_path)?;
            let Some(bound) = stored.url.as_deref().and_then(origin_of) else {
                anyhow::bail!(
                    "{env_var}: the sealed entry {} names no 'url: https://…' line; add one so the \
                     login's destination is the store's, not the schema's",
                    login.store_path
                );
            };
            if bound != declared_origin {
                anyhow::bail!(
                    "{env_var}: origin={} is not the origin of the sealed entry's url; refusing to \
                     send its password there",
                    login.origin
                );
            }
            let ca_pem = login.ca_file.as_deref().map(read_anchor).transpose()?;
            Ok(LoginWire {
                env_var: (*env_var).to_owned(),
                origin: login.origin.clone(),
                action: login.action.clone(),
                field: login.field.clone(),
                secret: stored.secret,
                ca_pem,
            })
        })
        .collect()
}

fn read_anchor(path: &str) -> anyhow::Result<String> {
    let pem = std::fs::read_to_string(Path::new(path))
        .map_err(|error| anyhow::anyhow!("ca={path} cannot be read: {error}"))?;
    if !pem.contains("-----BEGIN CERTIFICATE-----") || pem.contains("PRIVATE KEY") {
        anyhow::bail!("ca={path} is not a PEM certificate");
    }
    Ok(pem)
}

/// `url:` (any case) from an entry's trailer, pass's convention.
fn trailer_url(trailer: &str) -> Option<String> {
    trailer.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim()
            .eq_ignore_ascii_case("url")
            .then(|| value.trim().to_owned())
    })
}

/// `https://host[:port]` of an https URL, host lowercased, `:443` dropped.
pub(crate) fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let authority = authority.strip_suffix(":443").unwrap_or(&authority);
    Some(format!("https://{authority}"))
}

#[cfg(test)]
#[path = "dev_login_tests.rs"]
pub(crate) mod tests;
