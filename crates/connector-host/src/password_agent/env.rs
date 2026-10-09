//! Portable environment template parsing and safe projection.
use serde_json::Value;
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Line {
    Literal(String),
    Reference { name: String, reference: String },
}
fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}
/// Startup hooks are reserved before credential-bearing helpers and wrappers.
#[must_use]
pub fn credential_startup_key(name: &str) -> bool {
    super::policy::policy()
        .credential_startup_env_keys
        .iter()
        .any(|key| key.eq_ignore_ascii_case(name))
}
/// # Errors
/// Rejects interpreter hooks before any credential or provider operation.
pub fn validate_run_assignments(assignments: &[String]) -> anyhow::Result<()> {
    for input in assignments {
        let (name, _) = assignment(input)?;
        anyhow::ensure!(
            !credential_startup_key(&name),
            "Credential startup environment variables are reserved during run"
        );
    }
    Ok(())
}
fn template_assignment(line: &str) -> Option<(&str, &str)> {
    let mut line = line.trim_start_matches('\u{feff}').trim_start();
    if line.starts_with('#') {
        return None;
    }
    if let Some(rest) = line.strip_prefix("export") {
        if rest.starts_with(char::is_whitespace) {
            line = rest.trim_start();
        }
    }
    let separator = line.find(['=', ':'])?;
    let name = line[..separator].trim().trim_matches(['\'', '"', '`']);
    valid_name(name).then_some((name, line[separator + 1..].trim_start()))
}
fn closing_quote(value: &str, quote: char) -> bool {
    value.contains(quote)
}
fn pending_quote(value: &str) -> Option<char> {
    let quote = value.chars().next()?;
    if matches!(quote, '\'' | '"') && !closing_quote(&value[1..], quote) {
        Some(quote)
    } else {
        None
    }
}

/// # Errors
/// Rejects startup assignments while preserving comments and quoted values.
pub fn validate_run_template(content: &str) -> anyhow::Result<()> {
    let mut multiline = None;
    for line in content.split(['\r', '\n']) {
        if let Some(quote) = multiline {
            if closing_quote(line, quote) {
                multiline = None;
            }
            continue;
        }
        if let Some((name, value)) = template_assignment(line) {
            anyhow::ensure!(
                !credential_startup_key(name),
                "Credential startup environment variables are reserved during run"
            );
            multiline = pending_quote(value);
        }
    }
    Ok(())
}
/// # Errors
/// Rejects invalid assignments without echoing their potentially secret contents.
pub fn assignment(input: &str) -> anyhow::Result<(String, String)> {
    let (name, reference) = input
        .split_once('=')
        .ok_or_else(|| anyhow::anyhow!("Expected NAME=op://reference"))?;
    anyhow::ensure!(
        valid_name(name) && reference.starts_with("op://"),
        "Invalid environment reference assignment"
    );
    Ok((name.into(), reference.into()))
}
fn unquote(value: &str) -> &str {
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}
fn parse_line(original: &str) -> Line {
    let trimmed = original.trim();
    if trimmed.starts_with('#') {
        return Line::Literal(original.into());
    }
    let candidate = trimmed.strip_prefix("export ").unwrap_or(trimmed).trim();
    let Some((name, value)) = candidate.split_once('=') else {
        return Line::Literal(original.into());
    };
    match assignment(&format!("{}={}", name.trim(), unquote(value.trim()))) {
        Ok((name, reference)) => Line::Reference { name, reference },
        Err(_) => Line::Literal(original.into()),
    }
}
#[must_use]
pub fn parse(content: &str) -> Vec<Line> {
    content.split('\n').map(parse_line).collect()
}
#[must_use]
pub fn references(lines: &[Line]) -> Vec<String> {
    let mut refs = Vec::new();
    for line in lines {
        if let Line::Reference { reference, .. } = line {
            if !refs.contains(reference) {
                refs.push(reference.clone());
            }
        }
    }
    refs
}
/// # Errors
/// Rejects missing values or an invalid provider batch.
pub fn resolved(lines: &[Line], refs: &[String], values: &Value) -> anyhow::Result<String> {
    let values = values
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Invalid secret batch"))?;
    anyhow::ensure!(
        values.len() == refs.len() && values.iter().all(Value::is_string),
        "Invalid secret batch"
    );
    lines
        .iter()
        .map(|line| match line {
            Line::Literal(value) => Ok(value.clone()),
            Line::Reference { name, reference } => {
                let index = refs
                    .iter()
                    .position(|r| r == reference)
                    .ok_or_else(|| anyhow::anyhow!("Missing secret reference"))?;
                let value = values[index].as_str().unwrap_or_default();
                let value = value
                    .strip_suffix('\n')
                    .unwrap_or(value)
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('\n', "\\n")
                    .replace('\r', "\\r");
                Ok(format!("{name}=\"{value}\""))
            }
        })
        .collect::<anyhow::Result<Vec<_>>>()
        .map(|lines| lines.join("\n"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn startup_assignments_and_templates_are_rejected_before_credentials() {
        let keys = &super::super::policy::policy().credential_startup_env_keys;
        assert!(keys.iter().any(|key| key == "LD_AUDIT"));
        for key in keys {
            assert!(super::validate_run_assignments(&[format!(
                "{}=op://Vault/Item/secret",
                key.to_ascii_lowercase()
            )])
            .is_err());
            for text in [
                format!("{key}=private-hook"),
                format!("export\t{key} = 'private-hook'"),
                format!("\u{feff}{key}: private-hook"),
                format!("\"{key}\"=private-hook"),
                format!("`{key}`=private-hook"),
            ] {
                assert!(super::validate_run_template(&text).is_err());
            }
        }
        assert!(super::validate_run_template(
            "# LD_PRELOAD=comment\nexport API = 'op://Vault/Item/token'\nTEXT=\"ordinary\nLD_PRELOAD=value text\n\""
        )
        .is_ok());
        assert!(super::validate_run_template("TEXT='first\\'\nLD_PRELOAD=private-hook").is_err());
        assert!(super::validate_run_template("TEXT=`first\nLD_PRELOAD=private-hook").is_err());
        assert!(super::validate_run_template("API=ordinary\rLD_PRELOAD=private-hook").is_err());
        assert!(super::validate_run_assignments(&["API=op://Vault/Item/token".into()]).is_ok());
    }
}
