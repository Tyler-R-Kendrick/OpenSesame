//! Typed one-shot read admission; synthetic sessions never produce a real store root/key pair.
use crate::store::{prompt_password, require_reveal, resolve_root};
use opensesame_sealed_store::retired_credentials::{
    admit_store_read, has_retired_traps, ReadAdmission,
};
use opensesame_sealed_store::{unlock_store_key, StoreRoot};
use std::path::Path;
use zeroize::Zeroizing;

pub(crate) fn require_production_if_traps(root: &Path) -> anyhow::Result<()> {
    if has_retired_traps(root)? {
        let password = Zeroizing::new(prompt_password("Store passphrase")?);
        let _key = unlock_store_key(root, password.as_bytes())?;
    }
    Ok(())
}

pub fn cmd_show(
    name: &str,
    reveal: bool,
    path: Option<&Path>,
    tomb: Option<&str>,
) -> anyhow::Result<()> {
    require_reveal(reveal)?;
    let root_path = resolve_root(path, tomb)?;
    let password = Zeroizing::new(prompt_password("Store passphrase")?);
    match admit_store_read(&root_path, password.as_bytes())? {
        ReadAdmission::Synthetic(realm) => {
            let entry = opensesame_sealed_store::Entry::parse(&realm.show(name)?);
            crate::entry::print_shown(&entry);
        }
        ReadAdmission::Real(key) => {
            let root = StoreRoot::open(root_path)?;
            let age_id = std::env::var("OPENSESAME_AGE_IDENTITY").ok();
            let entry = root.show_with_age_identity(name, &key, age_id.as_deref())?;
            crate::entry::print_shown(&entry);
        }
    }
    Ok(())
}

fn admitted_names(
    path: Option<&Path>,
    tomb: Option<&str>,
    prefix: &str,
) -> anyhow::Result<Vec<String>> {
    let root_path = resolve_root(path, tomb)?;
    if has_retired_traps(&root_path)? {
        let password = Zeroizing::new(prompt_password("Store passphrase")?);
        if let ReadAdmission::Synthetic(realm) = admit_store_read(&root_path, password.as_bytes())?
        {
            return Ok(realm.names(prefix));
        }
    }
    Ok(StoreRoot::open(root_path)?.ls(prefix)?)
}

pub fn cmd_ls(prefix: Option<&str>, path: Option<&Path>, tomb: Option<&str>) -> anyhow::Result<()> {
    for name in admitted_names(path, tomb, prefix.unwrap_or(""))? {
        println!("{name}");
    }
    Ok(())
}

pub fn cmd_find(query: &str, path: Option<&Path>, tomb: Option<&str>) -> anyhow::Result<()> {
    for name in admitted_names(path, tomb, "")? {
        if name.contains(query) {
            println!("{name}");
        }
    }
    Ok(())
}
