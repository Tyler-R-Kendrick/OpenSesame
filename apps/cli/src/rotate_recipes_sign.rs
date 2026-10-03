//! Signing a recipe is a local ops act (ADR 0076 §4): the private key is a
//! file this process reads and nothing else, never an argument, never
//! printed, never sent. The Host holds only the public half.
//!
//! A key file is the 32-byte seed as 64 hex characters, mode `0600` on a
//! platform that has modes — a seed another user can read is a seed that is
//! not a secret, and the Host would trust whatever it signed. `keygen` makes
//! one (refusing to overwrite) and prints only the public half and its id.

use std::io::Write as _;
use std::path::Path;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use opensesame_rotation_web::recipe_doc::{
    key_id_of, signing_key_from_seed_hex, CanaryAttestation, RecipeDocument, SigningKey,
    MAX_RECIPE_BYTES,
};
use rand::RngCore as _;
use serde_json::{json, Value};
use zeroize::Zeroizing;

/// The signing key in `path`, after checking nobody else can read it.
///
/// # Errors
///
/// When the file is unreadable, readable by group or other (Unix), or not a
/// 64-hex seed. No message repeats the file's contents.
pub(super) fn read_signing_key(path: &Path) -> Result<SigningKey> {
    // A seed typed where a path belongs is already in a shell history, and the
    // refusal must not repeat it into a terminal log as well.
    let typed_the_key = path
        .to_str()
        .is_some_and(|text| text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit()));
    if typed_the_key {
        bail!(
            "--key names a file holding the signing key, not the key itself; a key given as an \
             argument is in your shell history now, so discard it and make another with \
             `signer keygen`"
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(path)
            .with_context(|| format!("reading signing key {}", path.display()))?
            .permissions()
            .mode();
        if mode & 0o077 != 0 {
            bail!(
                "signing key {} is readable by other users (mode {:03o}); run `chmod 600` on it",
                path.display(),
                mode & 0o777
            );
        }
    }
    let text = Zeroizing::new(
        std::fs::read_to_string(path)
            .with_context(|| format!("reading signing key {}", path.display()))?,
    );
    signing_key_from_seed_hex(&text)
        .map_err(|refused| anyhow::anyhow!("signing key {}: {refused}", path.display()))
}

/// A recipe file, read bounded and checked.
///
/// # Errors
///
/// When it is unreadable or not a valid recipe document.
pub(super) fn read_recipe(path: &Path) -> Result<(String, RecipeDocument)> {
    let size = std::fs::metadata(path)
        .with_context(|| format!("reading recipe {}", path.display()))?
        .len();
    if size > MAX_RECIPE_BYTES as u64 {
        bail!(
            "recipe {} is larger than {MAX_RECIPE_BYTES} bytes",
            path.display()
        );
    }
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading recipe {}", path.display()))?;
    let document = RecipeDocument::parse(text.as_bytes())
        .map_err(|refused| anyhow::anyhow!("recipe {}: {refused}", path.display()))?;
    Ok((text, document))
}

/// `now`, or an RFC 3339 timestamp, as one.
fn attested_at(text: &str) -> Result<DateTime<Utc>> {
    if text == "now" {
        return Ok(Utc::now());
    }
    DateTime::parse_from_rfc3339(text)
        .map(|at| at.with_timezone(&Utc))
        .with_context(|| "--canary-at is `now` or an RFC 3339 timestamp".to_owned())
}

/// What a signature may be asked to say besides "this document".
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct SignOptions<'a> {
    /// Attest that the recipe completed a real change, verified by a fresh
    /// login, at this time (`now` or RFC 3339) — an assertion the signer
    /// answers for, which the Host counts only inside a verified signature.
    pub canary_at: Option<&'a str>,
    /// Set the recipe to expire this many days from now, so a renewal re-signs
    /// the same steps with a fresh window.
    pub expires_in_days: Option<i64>,
}

/// Sign `recipe` with the key in `key`, replacing any signature it carries.
///
/// # Errors
///
/// When the key or the recipe cannot be read, the recipe is outside its
/// window (expired, or expiring further out than a quarter), or the
/// attestation is from the future or stale.
pub(super) fn sign(key: &Path, recipe: &Path, options: SignOptions<'_>) -> Result<RecipeDocument> {
    let signing = read_signing_key(key)?;
    let (_, mut document) = read_recipe(recipe)?;
    if let Some(days) = options.expires_in_days {
        document.expires_at = (Utc::now() + chrono::Duration::days(days)).to_rfc3339();
    }
    if let Some(text) = options.canary_at {
        document.canary = Some(CanaryAttestation {
            verified_at: attested_at(text)?.to_rfc3339(),
        });
    }
    document
        .check_window(Utc::now())
        .map_err(|refused| anyhow::anyhow!("recipe {}: {refused}", recipe.display()))?;
    document
        .sign(&signing)
        .map_err(|refused| anyhow::anyhow!("{refused}"))?;
    Ok(document)
}

/// Write `document` as the recipe file `out`, or print it when there is none.
///
/// # Errors
///
/// When the file cannot be written.
pub(super) fn emit(document: &RecipeDocument, out: Option<&Path>) -> Result<()> {
    let text = serde_json::to_string_pretty(document)? + "\n";
    if let Some(path) = out {
        return std::fs::write(path, text)
            .with_context(|| format!("writing recipe {}", path.display()));
    }
    print!("{text}");
    Ok(())
}

/// A new signing key in `out` (created with mode `0600`, never overwritten):
/// its public half and id, for `rotate signer add`.
///
/// # Errors
///
/// When `out` exists or cannot be written.
pub(super) fn keygen(out: &Path) -> Result<Value> {
    let mut seed = Zeroizing::new([0u8; 32]);
    rand::rngs::OsRng.fill_bytes(&mut seed[..]);
    let key = SigningKey::from_bytes(&seed);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(out).with_context(|| {
        format!(
            "creating signing key {} (it must not already exist)",
            out.display()
        )
    })?;
    let text = Zeroizing::new(format!("{}\n", hex::encode(&seed[..])));
    file.write_all(text.as_bytes())
        .with_context(|| format!("writing signing key {}", out.display()))?;
    Ok(json!({
        "key_id": key_id_of(&key.verifying_key()),
        "public_key": hex::encode(key.verifying_key().as_bytes()),
        "key_file": out.display().to_string(),
    }))
}

/// The public key and id of the signing key in `key`.
///
/// # Errors
///
/// As [`read_signing_key`].
pub(super) fn public_half(key: &Path) -> Result<(String, String)> {
    let signing = read_signing_key(key)?;
    let public = signing.verifying_key();
    Ok((key_id_of(&public), hex::encode(public.as_bytes())))
}
