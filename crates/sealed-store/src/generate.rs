//! Character passwords under the policy every target shares
//! (`spec/conformance/password-policy.json`, ADR 0139): the same alphabets,
//! defaults and rules as `generateCharacters` in `packages/app-core`.

use std::sync::LazyLock;

use rand::seq::SliceRandom;
use rand::Rng;
use serde::Deserialize;

#[derive(Deserialize)]
struct Classes {
    lower: String,
    upper: String,
    digits: String,
    symbols: String,
}

#[derive(Deserialize)]
struct Policy {
    classes: Classes,
    ambiguous: String,
    defaults: CharOptions,
}

static POLICY: LazyLock<Policy> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../spec/conformance/password-policy.json"
    ))
    .expect("spec/conformance/password-policy.json is valid")
});

/// Which classes a generated password draws from, and how long it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)]
pub struct CharOptions {
    pub length: usize,
    pub lower: bool,
    pub upper: bool,
    pub digits: bool,
    pub symbols: bool,
    pub avoid_ambiguous: bool,
}

impl Default for CharOptions {
    fn default() -> Self {
        POLICY.defaults
    }
}

/// No character class was selected.
#[derive(Debug, thiserror::Error)]
#[error("choose at least one character set")]
pub struct NoCharacterClass;

/// The shared default length.
#[must_use]
pub fn default_password_length() -> usize {
    POLICY.defaults.length
}

fn pools(options: &CharOptions) -> Vec<Vec<char>> {
    let classes = &POLICY.classes;
    [
        (options.lower, &classes.lower),
        (options.upper, &classes.upper),
        (options.digits, &classes.digits),
        (options.symbols, &classes.symbols),
    ]
    .into_iter()
    .filter(|(selected, _)| *selected)
    .map(|(_, pool)| {
        pool.chars()
            .filter(|c| !options.avoid_ambiguous || !POLICY.ambiguous.contains(*c))
            .collect::<Vec<_>>()
    })
    .filter(|pool| !pool.is_empty())
    .collect()
}

/// One character from each selected class, the rest drawn uniformly from
/// their union, shuffled; never shorter than the number of classes.
///
/// # Errors
///
/// Returns [`NoCharacterClass`] when no class is selected.
pub fn generate_characters(options: &CharOptions) -> Result<String, NoCharacterClass> {
    let pools = pools(options);
    if pools.is_empty() {
        return Err(NoCharacterClass);
    }
    let union: Vec<char> = pools.concat();
    let length = options.length.max(pools.len());
    let mut rng = rand::thread_rng();
    let mut out: Vec<char> = pools
        .iter()
        .map(|pool| pool[rng.gen_range(0..pool.len())])
        .collect();
    out.extend((out.len()..length).map(|_| union[rng.gen_range(0..union.len())]));
    out.shuffle(&mut rng);
    Ok(out.into_iter().collect())
}

/// A password with the shared defaults, at `length`, with or without symbols.
///
/// # Panics
///
/// Only if the shared defaults select no class but symbols, which the policy
/// file's own test rules out.
#[must_use]
pub fn generate_password(length: usize, symbols: bool) -> String {
    generate_characters(&CharOptions {
        length,
        symbols,
        ..CharOptions::default()
    })
    .expect("the shared defaults select a class besides symbols")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_length_and_no_symbols() {
        let p = generate_password(32, false);
        assert_eq!(p.chars().count(), 32);
        assert!(p.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn generate_with_symbols_includes_one() {
        let p = generate_password(16, true);
        assert!(p.chars().any(|c| !c.is_ascii_alphanumeric()));
    }
}
