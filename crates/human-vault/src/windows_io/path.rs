use std::{
    io,
    path::{Component, Path, PathBuf, Prefix},
};

fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "unsafe Windows storage path")
}
fn component(value: &str) -> io::Result<()> {
    if value.encode_utf16().count() > 255 {
        return Err(denied());
    }
    if value.is_empty()
        || value.ends_with(['.', ' '])
        || value
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err(denied());
    }
    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    let reserved =
        ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"].contains(&stem.as_str());
    let numbered = ["COM", "LPT"].iter().any(|p| {
        stem.strip_prefix(p).is_some_and(|s| {
            s.chars().count() == 1 && s.chars().all(|c| c.is_ascii_digit() || "¹²³".contains(c))
        })
    });
    if reserved || numbered {
        return Err(denied());
    }
    Ok(())
}
fn raw_components(path: &Path, skip_drive: bool) -> io::Result<()> {
    let value = path.to_str().ok_or_else(denied)?;
    if value.encode_utf16().count() > 32760 {
        return Err(denied());
    }
    let tail = if skip_drive {
        value.get(3..).ok_or_else(denied)?
    } else {
        value
    };
    for (index, part) in tail.split(['/', '\\']).enumerate() {
        if index >= 128 {
            return Err(denied());
        }
        component(part)?;
    }
    Ok(())
}
pub(super) fn root(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut components = root.components();
    if !matches!(components.next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_)))
        || !matches!(components.next(), Some(Component::RootDir))
    {
        return Err(denied());
    }
    // The volume root has no tail; every other spelling is checked verbatim.
    if root.as_os_str().len() > 3 {
        raw_components(root, true)?;
    }
    let mut current = PathBuf::new();
    let mut paths = Vec::new();
    for part in root.components() {
        match part {
            Component::Prefix(_) => current.push(part.as_os_str()),
            Component::RootDir => {
                current.push(part.as_os_str());
                paths.push(current.clone());
            }
            Component::Normal(_) => {
                current.push(part.as_os_str());
                paths.push(current.clone());
            }
            _ => return Err(denied()),
        }
    }
    if paths.is_empty() {
        return Err(denied());
    }
    Ok(paths)
}
pub(super) fn relative(path: &Path) -> io::Result<Vec<PathBuf>> {
    raw_components(path, false)?;
    let mut current = PathBuf::new();
    let mut paths = Vec::new();
    for part in path.components() {
        if !matches!(part, Component::Normal(_)) {
            return Err(denied());
        }
        current.push(part.as_os_str());
        paths.push(current.clone());
    }
    if paths.is_empty() {
        return Err(denied());
    }
    Ok(paths)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_windows_aliases_without_filesystem_access() {
        for input in [
            "../secret",
            "a/./b",
            "a//b",
            "file:stream",
            "file.",
            "file ",
            "CON",
            "aux.txt",
            "CON .txt",
            "CONIN$",
            "CONOUT$",
            "COM1.key",
            "LPT²",
            "\\\\server\\share",
            "C:\\x",
            "x\0y",
        ] {
            assert!(relative(Path::new(input)).is_err(), "{input:?}");
        }
        assert!(relative(Path::new("config/retired-credentials.v1")).is_ok());
        assert!(relative(Path::new(&"x".repeat(256))).is_err());
        assert!(relative(Path::new(&vec!["x"; 129].join("/"))).is_err());
        assert!(root(Path::new("C:\\Users\\owner\\vault")).is_ok());
        assert!(root(Path::new("\\\\?\\C:\\vault")).is_err());
    }
}
