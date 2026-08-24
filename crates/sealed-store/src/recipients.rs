use std::fs;
use std::path::Path;

use crate::StoreError;

const RECIPIENTS_FILE: &str = ".opensesame-recipients";

#[derive(Debug, Clone, Default)]
pub struct Recipients {
    pub lines: Vec<String>,
}

impl Recipients {
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn load(root: &Path) -> Result<Self, StoreError> {
        let path = root.join(RECIPIENTS_FILE);
        if !path.exists() {
            return Ok(Self::default());
        }
        let text = fs::read_to_string(path)?;
        let lines = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(str::to_string)
            .collect();
        Ok(Self { lines })
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn write(root: &Path, recipients: &[String]) -> Result<(), StoreError> {
        let path = root.join(RECIPIENTS_FILE);
        let mut body = String::from("# OpenSesame sealed-store recipients\n");
        for r in recipients {
            body.push_str(r.trim());
            body.push('\n');
        }
        fs::write(path, body)?;
        Ok(())
    }
}
