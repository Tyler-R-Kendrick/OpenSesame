use std::path::{Component, Path, PathBuf};

use crate::StoreError;

/// Map a logical `pass`-style name to a relative path (no extension).
pub fn logical_to_relative(name: &str) -> Result<PathBuf, StoreError> {
    let name = name.trim().trim_matches('/');
    if name.is_empty() {
        return Err(StoreError::InvalidPath("empty name".into()));
    }
    if name.contains('\0') {
        return Err(StoreError::InvalidPath("NUL in name".into()));
    }
    let path = PathBuf::from(name);
    if path.is_absolute() {
        return Err(StoreError::InvalidPath("absolute path".into()));
    }
    for component in path.components() {
        match component {
            Component::Normal(seg) => {
                let s = seg.to_string_lossy();
                if s.is_empty() || s == "." || s == ".." {
                    return Err(StoreError::InvalidPath(format!("bad segment: {s}")));
                }
            }
            Component::CurDir | Component::ParentDir => {
                return Err(StoreError::InvalidPath("`.` or `..` not allowed".into()));
            }
            _ => return Err(StoreError::InvalidPath("invalid path component".into())),
        }
    }
    Ok(path)
}

/// Strip a known ciphertext extension and return the logical name.
pub fn relative_to_logical(rel: &Path) -> Result<String, StoreError> {
    if rel.is_absolute() {
        return Err(StoreError::InvalidPath("absolute relative path".into()));
    }
    let mut path = rel.to_path_buf();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if matches!(ext, "osseal" | "gpg" | "age") {
            path.set_extension("");
        }
    }
    let logical = path
        .to_str()
        .ok_or_else(|| StoreError::InvalidPath("non-utf8 path".into()))?
        .replace('\\', "/");
    if logical.is_empty() {
        return Err(StoreError::InvalidPath("empty logical name".into()));
    }
    Ok(logical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logical_name_maps_to_nested_relative() {
        assert_eq!(
            logical_to_relative("Email/github.com").unwrap(),
            PathBuf::from("Email/github.com")
        );
    }

    #[test]
    fn rejects_parent_segment() {
        assert!(logical_to_relative("../etc/passwd").is_err());
        assert!(logical_to_relative("foo/../bar").is_err());
    }

    #[test]
    fn relative_strips_extensions() {
        assert_eq!(
            relative_to_logical(Path::new("Email/github.com.osseal")).unwrap(),
            "Email/github.com"
        );
        assert_eq!(
            relative_to_logical(Path::new("a/b.gpg")).unwrap(),
            "a/b"
        );
    }
}
