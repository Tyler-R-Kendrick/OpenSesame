//! Conformance for the shared definition corpus (ADR 0087 §8, ADR 0139).
//!
//! The rejection table and the native-projection cases are data, in
//! `spec/conformance/item-type-cases.json`, and
//! `packages/vault-item-types/src/conformance.test.ts` runs the same rows. A
//! definition valid on one plane must be valid on the other, and a rejection
//! on one must be a rejection on the other — otherwise `opensesame pass` and
//! the PWA disagree about what a stored item is. What stays here as code is
//! what cannot be a row: the size cap, malformed text, and the loops over the
//! whole built-in corpus.

use std::collections::{BTreeMap, BTreeSet};

use opensesame_sealed_store::Entry;
use opensesame_vault_item_types::{
    from_entry, parse_definition, to_entry, ErrorCode, FieldValue, FieldValues, ItemTypeDefinition,
    ItemTypeRegistry, Trust, BUILTIN_DEFINITIONS, LEGACY_TYPE_IDS, PLATFORM_PUBLISHER,
};
use serde_json::Value;

fn cases() -> Value {
    serde_json::from_str(include_str!(
        "../../../spec/conformance/item-type-cases.json"
    ))
    .expect("item-type-cases.json parses")
}

fn list<'a>(value: &'a Value, what: &str) -> &'a Vec<Value> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("{what} is a list"))
}

fn text<'a>(value: &'a Value, what: &str) -> &'a str {
    value
        .as_str()
        .unwrap_or_else(|| panic!("{what} is a string"))
}

/// Write `value` at a JSON Pointer (RFC 6901), creating a missing object key;
/// a final `-` appends to an array.
fn set_pointer(target: &mut Value, pointer: &str, value: Value) {
    let mut tokens: Vec<String> = pointer
        .split('/')
        .skip(1)
        .map(|token| token.replace("~1", "/").replace("~0", "~"))
        .collect();
    let last = tokens.pop().expect("a pointer names a location");
    let mut node = target;
    for token in &tokens {
        node = match node {
            Value::Array(items) => &mut items[token.parse::<usize>().expect("an array index")],
            Value::Object(map) => map
                .get_mut(token.as_str())
                .unwrap_or_else(|| panic!("`{pointer}` walks through a missing `{token}`")),
            _ => panic!("`{pointer}` walks through a scalar at `{token}`"),
        };
    }
    match node {
        Value::Array(items) if last == "-" => items.push(value),
        Value::Array(items) => items[last.parse::<usize>().expect("an array index")] = value,
        Value::Object(map) => {
            map.insert(last, value);
        }
        _ => panic!("`{pointer}` ends inside a scalar"),
    }
}

/// The case's draft, with every `[pointer, value]` pair applied in order.
fn draft_for(draft: &Value, case: &Value, name: &str) -> Value {
    let mut value = draft.clone();
    for pair in list(&case["set"], name) {
        let pair = list(pair, name);
        set_pointer(&mut value, text(&pair[0], name), pair[1].clone());
    }
    value
}

fn refused_codes(draft: &Value, trust: Trust) -> Vec<&'static str> {
    match parse_definition(&draft.to_string(), trust) {
        Ok(_) => Vec::new(),
        Err(errors) => errors.codes().into_iter().map(ErrorCode::as_str).collect(),
    }
}

/// Whether the refusal matches the case; the reason it does not, if not.
fn check_definition(case: &Value, name: &str, refused: &[&str]) -> Result<(), String> {
    let expectations = ["codes", "codesAnyOf", "valid"]
        .iter()
        .filter(|key| case.get(**key).is_some())
        .count();
    assert_eq!(expectations, 1, "`{name}` states exactly one expectation");
    let matched = if case["valid"] == true {
        refused.is_empty()
    } else if let Some(codes) = case.get("codes") {
        list(codes, name)
            .iter()
            .all(|code| refused.contains(&text(code, name)))
    } else {
        list(&case["codesAnyOf"], name)
            .iter()
            .any(|code| refused.contains(&text(code, name)))
    };
    if matched {
        Ok(())
    } else {
        Err(format!("`{name}`: refused with {refused:?}"))
    }
}

#[test]
fn definitions_match_the_shared_cases() {
    let all = cases();
    let failures: Vec<String> = list(&all["definitionCases"], "definitionCases")
        .iter()
        .filter_map(|case| {
            let name = text(&case["name"], "name");
            let trust = if case["trust"] == "platform" {
                Trust::Platform
            } else {
                Trust::Community
            };
            let refused = refused_codes(&draft_for(&all["draft"], case, name), trust);
            check_definition(case, name, &refused).err()
        })
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn field_values(value: &Value, name: &str) -> FieldValues {
    serde_json::from_value(value.clone()).unwrap_or_else(|e| panic!("`{name}` values: {e}"))
}

/// Project `values`, check the entry against the case, and hand it back.
fn projected(definition: &ItemTypeDefinition, case: &Value, name: &str) -> Entry {
    let expected = &case["entry"];
    let entry = to_entry(definition, &field_values(&case["values"], name));
    assert_eq!(entry.secret, expected["secret"], "`{name}` line one");
    assert_eq!(entry.trailer, expected["trailer"], "`{name}` trailer");
    if let Some(rendered) = case.get("rendered") {
        assert_eq!(entry.render(), *rendered, "`{name}` rendered");
    }
    if entry
        .trailer
        .lines()
        .any(|line| line.starts_with("otpauth://"))
    {
        assert!(
            Entry::parse(&entry.render()).otp.is_some(),
            "`{name}`: a projected TOTP seed must be visible to pass-otp"
        );
    }
    entry
}

fn check_readback(definition: &ItemTypeDefinition, entry: &Entry, case: &Value, name: &str) {
    let Some(expected) = case.get("readback") else {
        return;
    };
    let back = from_entry(definition, entry);
    assert_eq!(
        back.values,
        field_values(&expected["values"], name),
        "`{name}` reads back"
    );
    if let Some(extra) = expected.get("extra") {
        let extra: BTreeMap<String, String> =
            serde_json::from_value(extra.clone()).unwrap_or_else(|e| panic!("`{name}`: {e}"));
        assert_eq!(back.extra, extra, "`{name}` keeps unclaimed keys");
    }
}

#[test]
fn projections_match_the_shared_cases() {
    let registry = ItemTypeRegistry::with_builtins();
    for case in list(&cases()["projectionCases"], "projectionCases") {
        let name = text(&case["name"], "name");
        let id = text(&case["type"], name);
        let definition = registry
            .get(id)
            .unwrap_or_else(|| panic!("`{name}`: `{id}` is built in"));
        let entry = if case.get("values").is_some() {
            projected(definition, case, name)
        } else {
            Entry {
                secret: text(&case["entry"]["secret"], name).to_owned(),
                trailer: text(&case["entry"]["trailer"], name).to_owned(),
                otp: None,
            }
        };
        check_readback(definition, &entry, case, name);
    }
}

#[test]
fn refuses_a_definition_larger_than_the_cap() {
    let mut value = cases()["draft"].clone();
    value["spec"]["summary"] = serde_json::json!("x".repeat(80 * 1024));
    let errors = parse_definition(&value.to_string(), Trust::Community).expect_err("too large");
    assert_eq!(errors.codes(), vec![ErrorCode::TooLarge]);
}

#[test]
fn refuses_malformed_json() {
    let errors = parse_definition("{", Trust::Community).expect_err("malformed");
    assert_eq!(errors.codes(), vec![ErrorCode::Syntax]);
}

#[test]
fn every_built_in_definition_parses() {
    for (id, text) in BUILTIN_DEFINITIONS {
        let definition = parse_definition(text, Trust::Platform)
            .unwrap_or_else(|errors| panic!("`{id}` is invalid:\n{errors}"));
        assert_eq!(&definition.metadata.id, id);
        assert_eq!(definition.metadata.publisher, PLATFORM_PUBLISHER);
    }
}

#[test]
fn the_corpus_still_carries_every_legacy_kind() {
    let ids: BTreeSet<&str> = BUILTIN_DEFINITIONS.iter().map(|(id, _)| *id).collect();
    for legacy in LEGACY_TYPE_IDS {
        assert!(ids.contains(legacy), "the corpus lost `{legacy}`");
    }
}

#[test]
fn every_built_in_type_has_a_distinct_vfs_extension() {
    let registry = ItemTypeRegistry::with_builtins();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for entry in registry.list() {
        assert!(
            seen.insert(entry.definition.spec.extension.clone()),
            "extension `{}` is claimed twice",
            entry.definition.spec.extension
        );
    }
}

#[test]
fn no_built_in_leaks_a_concealed_field_into_a_preview() {
    let registry = ItemTypeRegistry::with_builtins();
    for entry in registry.list() {
        let definition = &entry.definition;
        for id in definition
            .spec
            .subtitle
            .iter()
            .chain(definition.spec.search.iter())
        {
            let field = definition.field(id).expect("preview names a real field");
            assert!(
                !field.field_type.concealed(),
                "`{}` puts a concealed field in a preview",
                definition.metadata.id
            );
        }
    }
}

fn text_values(definition: &ItemTypeDefinition) -> FieldValues {
    let mut values: FieldValues = BTreeMap::new();
    for field in definition.fields() {
        if field.repeats() {
            continue;
        }
        values.insert(
            field.id.clone(),
            FieldValue::Text(format!("v-{}", field.id)),
        );
    }
    values
}

#[test]
fn the_native_projection_round_trips_for_every_built_in_type() {
    let registry = ItemTypeRegistry::with_builtins();
    for entry in registry.list() {
        let definition = &entry.definition;
        let once = to_entry(definition, &text_values(definition));
        let back = from_entry(definition, &once);
        let twice = to_entry(definition, &back.values);
        assert_eq!(
            twice.secret, once.secret,
            "`{}` lost its secret line",
            definition.metadata.id
        );
        assert_eq!(
            twice.trailer, once.trailer,
            "`{}` lost trailer content",
            definition.metadata.id
        );
        assert!(
            !once.secret.contains('\n'),
            "`{}` wrote a newline onto line one",
            definition.metadata.id
        );
    }
}
