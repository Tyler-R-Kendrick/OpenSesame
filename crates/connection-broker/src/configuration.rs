use std::collections::{BTreeMap, BTreeSet};

use crate::catalog::ConfigurationFieldDef;
use crate::model::ConfiguredFieldView;
use crate::{BrokerError, Result, MAX_CREDENTIAL_BYTES};

pub type Configuration = BTreeMap<String, String>;

const MAX_FIELDS: usize = 64;
const MAX_FIELD_NAME_BYTES: usize = 64;
const MAX_TOTAL_BYTES: usize = 24 * 1024;

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_FIELD_NAME_BYTES
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

pub fn validate_mutation(
    definitions: &[ConfigurationFieldDef],
    set: &Configuration,
    clear: &[String],
) -> Result<()> {
    if set.len() > MAX_FIELDS || clear.len() > MAX_FIELDS {
        return Err(BrokerError::Invalid(
            "configuration exceeds 64 fields".into(),
        ));
    }
    let allowed: BTreeSet<_> = definitions.iter().map(|field| field.name).collect();
    let mut total = 0usize;
    for (name, value) in set {
        if !valid_name(name) || !allowed.contains(name.as_str()) {
            return Err(BrokerError::Invalid(format!(
                "configuration field `{name}` is not supported"
            )));
        }
        if value.is_empty() {
            return Err(BrokerError::Invalid(format!(
                "configuration field `{name}` is empty"
            )));
        }
        if value.len() > MAX_CREDENTIAL_BYTES {
            return Err(BrokerError::Invalid(format!(
                "configuration field `{name}` exceeds {MAX_CREDENTIAL_BYTES} bytes"
            )));
        }
        total = total.saturating_add(name.len()).saturating_add(value.len());
    }
    if total > MAX_TOTAL_BYTES {
        return Err(BrokerError::Invalid(
            "configuration exceeds 24576 bytes".into(),
        ));
    }
    let mut seen = BTreeSet::new();
    for name in clear {
        if !valid_name(name) || !allowed.contains(name.as_str()) {
            return Err(BrokerError::Invalid(format!(
                "configuration field `{name}` is not supported"
            )));
        }
        if set.contains_key(name) || !seen.insert(name) {
            return Err(BrokerError::Invalid(format!(
                "configuration field `{name}` is set and cleared more than once"
            )));
        }
    }
    Ok(())
}

pub fn apply(configuration: &mut Configuration, set: Configuration, clear: &[String]) {
    for name in clear {
        configuration.remove(name);
    }
    configuration.extend(set);
}

pub fn complete(definitions: &[ConfigurationFieldDef], configuration: &Configuration) -> bool {
    definitions
        .iter()
        .filter(|field| field.required)
        .all(|field| configuration.contains_key(field.name))
}

pub fn views(
    definitions: &[ConfigurationFieldDef],
    configuration: &Configuration,
) -> Vec<ConfiguredFieldView> {
    definitions
        .iter()
        .filter_map(|field| {
            let value = configuration.get(field.name)?;
            let hint = if field.secret {
                Some("configured".into())
            } else {
                let suffix: String = value
                    .chars()
                    .rev()
                    .take(4)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                Some(format!("***{suffix}"))
            };
            Some(ConfiguredFieldView {
                name: field.name.into(),
                hint,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIELDS: &[ConfigurationFieldDef] = &[
        ConfigurationFieldDef {
            name: "client_id",
            secret: false,
            required: true,
        },
        ConfigurationFieldDef {
            name: "client_secret",
            secret: true,
            required: true,
        },
    ];

    #[test]
    fn validates_applies_and_redacts_provider_fields() {
        let set = Configuration::from([
            ("client_id".into(), "client-1234".into()),
            ("client_secret".into(), "do-not-return".into()),
        ]);
        validate_mutation(FIELDS, &set, &[]).unwrap();
        let mut configuration = Configuration::new();
        apply(&mut configuration, set, &[]);
        assert!(complete(FIELDS, &configuration));
        assert_eq!(
            views(FIELDS, &configuration),
            vec![
                ConfiguredFieldView {
                    name: "client_id".into(),
                    hint: Some("***1234".into()),
                },
                ConfiguredFieldView {
                    name: "client_secret".into(),
                    hint: Some("configured".into()),
                },
            ]
        );
        assert!(!format!("{:?}", views(FIELDS, &configuration)).contains("do-not-return"));
    }
}
