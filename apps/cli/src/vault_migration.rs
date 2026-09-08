//! Offline password-wrapper inspection and explicit resource-budgeted rewrap.
use anyhow::{ensure, Context};
use base64::{engine::general_purpose::STANDARD, Engine};
use opensesame_human_vault::{
    kdf_policy::{inspect_legacy_kdf, KdfPolicy, OfflineMigrationBudget},
    migrate_password_wrapper_offline, PasswordWrapper,
};
use secrecy::{ExposeSecret, SecretString};
use std::{
    fs::File,
    io::{BufRead, IsTerminal, Read, Write},
    path::Path,
};

const MAX_WRAPPER_BYTES: u64 = 4096;

fn read_wrapper(path: &Path) -> anyhow::Result<PasswordWrapper> {
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(metadata.is_file(), "wrapper must be a regular local file");
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_WRAPPER_BYTES + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= usize::try_from(MAX_WRAPPER_BYTES)?,
        "wrapper too large"
    );
    let wrapper: PasswordWrapper = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("invalid password-wrapper JSON"))?;
    for (encoded, expected) in [
        (&wrapper.salt, 16),
        (&wrapper.nonce, 24),
        (&wrapper.wrapped_vrk, 48),
    ] {
        let decoded = STANDARD
            .decode(encoded)
            .map_err(|_| anyhow::anyhow!("invalid wrapper encoding"))?;
        ensure!(decoded.len() == expected, "invalid wrapper field length");
    }
    Ok(wrapper)
}

fn diagnostic(wrapper: &PasswordWrapper) -> anyhow::Result<serde_json::Value> {
    let m = wrapper.params_m_kib;
    let t = wrapper.params_t;
    let p = wrapper.params_p;
    let work = inspect_legacy_kdf(m, t, p)?;
    Ok(serde_json::json!({
        "format": "opensesame-password-wrapper-kdf-diagnostic",
        "memory_kib": m, "passes": t, "lanes": p,
        "memory_bytes": work.memory_bytes,
        "memory_pass_bytes": work.memory_pass_bytes,
        "native_accepted": KdfPolicy::Native.inspect(m, t, p).is_ok(),
        "browser_accepted": KdfPolicy::Browser.inspect(m, t, p).is_ok(),
        "offline_migratable": m <= 1024 * 1024 && t <= 16,
        "password_checked": false,
        "writer": { "memory_kib": 65536, "passes": 3, "lanes": 1 }
    }))
}

pub fn inspect(input: &Path) -> anyhow::Result<()> {
    println!("{}", diagnostic(&read_wrapper(input)?)?);
    Ok(())
}

/// No network, credential environment variables, password arguments, or overwrite mode.
pub fn migrate(input: &Path, output: &Path, memory_kib: u32, passes: u32) -> anyhow::Result<()> {
    let wrapper = read_wrapper(input)?;
    println!("{}", diagnostic(&wrapper)?);
    ensure!(
        wrapper.params_m_kib <= memory_kib && wrapper.params_t <= passes,
        "explicit budget does not admit this wrapper"
    );
    ensure!(
        (65536..=1024 * 1024).contains(&memory_kib) && (3..=16).contains(&passes),
        "budget must be 65536..1048576 KiB and 3..16 passes"
    );
    ensure!(
        std::io::stdin().is_terminal(),
        "migration requires an interactive terminal"
    );
    ensure!(
        !output.try_exists()?,
        "output already exists; input is never replaced"
    );
    check_private_output_support()?;
    eprint!("Offline KDF may allocate {memory_kib} KiB for up to {passes} passes. Type MIGRATE to authorize: ");
    std::io::stderr().flush()?;
    let mut confirmation = String::new();
    std::io::stdin()
        .lock()
        .take(32)
        .read_line(&mut confirmation)?;
    let budget = OfflineMigrationBudget::after_user_confirmation(
        memory_kib,
        passes,
        confirmation.trim_end_matches(['\r', '\n']) == "MIGRATE",
    )?;
    let password = SecretString::from(crate::store::prompt_secret_hidden("Wrapper password")?);
    let migrated =
        migrate_password_wrapper_offline(password.expose_secret().as_bytes(), &wrapper, &budget)
            .map_err(|_| anyhow::anyhow!("wrapper migration failed; input unchanged"))?;
    publish_new(output, &serde_json::to_vec(&migrated)?)?;
    println!("Password wrapper migrated; original retained. Verify the new wrapper before archiving the original.");
    Ok(())
}

fn check_private_output_support() -> anyhow::Result<()> {
    ensure!(
        cfg!(unix),
        "offline migration requires Unix owner-only file permissions"
    );
    Ok(())
}

fn publish_new(output: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    check_private_output_support()?;
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(output)
        .map_err(|_| anyhow::anyhow!("could not publish new wrapper; existing files unchanged"))?;
    File::open(parent)?
        .sync_all()
        .context("wrapper published but directory sync failed")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wrapper(m: u32) -> PasswordWrapper {
        PasswordWrapper {
            salt: STANDARD.encode([0; 16]),
            nonce: STANDARD.encode([0; 24]),
            wrapped_vrk: STANDARD.encode([0; 48]),
            params_m_kib: m,
            params_t: 3,
            params_p: 1,
        }
    }

    #[test]
    fn diagnostic_never_derives_or_authenticates_a_key() {
        let result = diagnostic(&wrapper(1024 * 1024)).unwrap();
        assert_eq!(result["native_accepted"], false);
        assert_eq!(result["password_checked"], false);
        assert_eq!(result["offline_migratable"], true);
        assert_eq!(
            diagnostic(&wrapper(u32::MAX)).unwrap()["offline_migratable"],
            false
        );
    }

    #[test]
    fn malformed_and_oversized_files_fail_before_work() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("wrapper.json");
        std::fs::write(&path, vec![b' '; 4097]).unwrap();
        assert!(read_wrapper(&path).is_err());
        let mut invalid = wrapper(65536);
        invalid.nonce = STANDARD.encode([0; 23]);
        std::fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(read_wrapper(&path).is_err());
    }

    #[test]
    fn rewrap_preserves_root_key_and_portable_writer_policy() {
        use opensesame_human_vault::{
            unwrap_vrk_with_password, wrap_vrk_with_password, VaultRootKey,
        };
        let original =
            wrap_vrk_with_password(b"offline-test-password", &VaultRootKey([42; 32])).unwrap();
        let budget = OfflineMigrationBudget::after_user_confirmation(65536, 3, true).unwrap();
        let migrated =
            migrate_password_wrapper_offline(b"offline-test-password", &original, &budget).unwrap();
        assert_eq!(migrated.params_m_kib, 65536);
        assert_eq!(migrated.params_t, 3);
        assert_eq!(migrated.params_p, 1);
        assert_eq!(
            unwrap_vrk_with_password(b"offline-test-password", &migrated)
                .unwrap()
                .0,
            [42; 32]
        );
        assert!(unwrap_vrk_with_password(b"wrong-password", &migrated).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn publication_never_replaces_existing_files_and_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("wrapper.json");
        publish_new(&path, b"first").unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(publish_new(&path, b"second").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"first");
    }
}
