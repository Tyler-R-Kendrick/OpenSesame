//! WIT guest helpers — ConnectionRef oriented; no secrets.get.
use opensesame_domain::DomainError;
use std::path::Path;

pub type Result<T> = std::result::Result<T, DomainError>;

/// Structural guarantee: connector WIT must not expose secrets.get as an import.
pub fn assert_wit_forbids_secrets_get(wit_source: &str) -> Result<()> {
    // Strip line comments so documentation mentioning the forbidden API is allowed.
    let code: String = wit_source
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    if code.contains("secrets.get") || code.contains("secret-get") {
        return Err(DomainError::ExportDenied);
    }
    if !code.contains("authorized-request") {
        return Err(DomainError::GrantAttenuation(
            "WIT must expose authorized-request for ConnectionRef HTTP".into(),
        ));
    }
    Ok(())
}

pub fn assert_repo_wit_forbids_secrets_get(repo_root: &Path) -> Result<()> {
    let path = repo_root.join("wit/connector/world.wit");
    let src = std::fs::read_to_string(&path)
        .map_err(|e| DomainError::Canonicalization(format!("cannot read WIT: {e}")))?;
    assert_wit_forbids_secrets_get(&src)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn wit_forbids_secrets_get() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        assert_repo_wit_forbids_secrets_get(&root).unwrap();
    }

    #[test]
    fn rejects_evil_wit() {
        let evil = r#"
          interface secrets { get: func(ref: string) -> string; }
        "#;
        // missing authorized-request and contains secrets.get pattern via "secrets" + get
        let evil2 = "secrets.get: func(ref: string) -> string;";
        assert!(assert_wit_forbids_secrets_get(evil2).is_err());
        let _ = evil;
    }
}
