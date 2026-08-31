//! Conformance for the shared definition corpus (ADR 0087 §8).
//!
//! The rows here mirror `packages/vault-item-types/src/validate.test.ts` and
//! `native.test.ts`. A definition valid on one plane must be valid on the
//! other, and a rejection on one must be a rejection on the other — otherwise
//! `opensesame pass` and the PWA disagree about what a stored item is.

use std::collections::{BTreeMap, BTreeSet};

use opensesame_sealed_store::Entry;
use opensesame_vault_item_types::{
    from_entry, parse_definition, to_entry, ErrorCode, FieldValue, FieldValues, ItemTypeRegistry,
    Trust, BUILTIN_DEFINITIONS, LEGACY_TYPE_IDS, PLATFORM_PUBLISHER,
};

fn draft() -> serde_json::Value {
    serde_json::json!({
        "apiVersion": "opensesame.dev/v1alpha1",
        "kind": "VaultItemType",
        "metadata": {
            "id": "example-type",
            "version": "1.0.0",
            "publisher": "https://example.test"
        },
        "spec": {
            "title": "Example",
            "plural": "Examples",
            "extension": ".ex",
            "summary": "An example type used by the rejection table.",
            "categories": ["other"],
            "sections": [{
                "id": "main",
                "title": "Main",
                "fields": [
                    { "id": "label", "type": "string", "label": "Label" },
                    { "id": "token", "type": "concealed", "label": "Token" }
                ]
            }],
            "native": {
                "secret": "token",
                "trailer": [{ "key": "label", "field": "label" }]
            },
            "cxf": { "credential": "custom-fields" },
            "subtitle": ["label"],
            "search": ["label"]
        }
    })
}

fn refuse(mutate: impl FnOnce(&mut serde_json::Value)) -> Vec<ErrorCode> {
    let mut value = draft();
    mutate(&mut value);
    match parse_definition(&value.to_string(), Trust::Community) {
        Ok(_) => Vec::new(),
        Err(errors) => errors.codes(),
    }
}

#[test]
fn the_baseline_draft_parses() {
    let parsed = parse_definition(&draft().to_string(), Trust::Community)
        .expect("the baseline draft is valid");
    assert_eq!(parsed.metadata.id, "example-type");
    assert_eq!(parsed.spec.native.secret.as_deref(), Some("token"));
}

#[test]
fn refuses_an_unknown_field_anywhere() {
    assert!(refuse(|value| {
        value["componentUrl"] = serde_json::json!("https://example.test/x.wasm");
    })
    .contains(&ErrorCode::UnknownField));
    assert!(refuse(|value| {
        value["spec"]["sections"][0]["fields"][0]["pattern"] = serde_json::json!("^.*$");
    })
    .contains(&ErrorCode::UnknownField));
}

#[test]
fn refuses_a_foreign_api_version_or_kind() {
    assert!(refuse(|v| v["apiVersion"] = serde_json::json!("v2")).contains(&ErrorCode::ApiVersion));
    assert!(
        refuse(|v| v["kind"] = serde_json::json!("ConnectorDefinition")).contains(&ErrorCode::Kind)
    );
}

#[test]
fn refuses_bad_metadata() {
    assert!(
        refuse(|v| v["metadata"]["id"] = serde_json::json!("Bank Account"))
            .contains(&ErrorCode::Id)
    );
    assert!(
        refuse(|v| v["metadata"]["version"] = serde_json::json!("1.0"))
            .contains(&ErrorCode::Version)
    );
    assert!(
        refuse(|v| v["metadata"]["publisher"] = serde_json::json!("http://example.test"))
            .contains(&ErrorCode::Publisher)
    );
}

#[test]
fn refuses_a_field_type_outside_the_catalogue() {
    let codes =
        refuse(|v| v["spec"]["sections"][0]["fields"][0]["type"] = serde_json::json!("rich-text"));
    assert!(codes.contains(&ErrorCode::Syntax) || codes.contains(&ErrorCode::UnknownField));
}

#[test]
fn refuses_duplicate_field_ids_across_sections() {
    let codes = refuse(|value| {
        value["spec"]["sections"] = serde_json::json!([
            { "id": "one", "title": "One",
              "fields": [{ "id": "label", "type": "string", "label": "A" }] },
            { "id": "two", "title": "Two",
              "fields": [{ "id": "label", "type": "string", "label": "B" }] }
        ]);
        value["spec"]["native"] = serde_json::json!({ "secret": null, "trailer": [] });
    });
    assert!(codes.contains(&ErrorCode::DuplicateField));
}

#[test]
fn refuses_a_default_on_a_concealed_field_and_allows_one_elsewhere() {
    assert!(refuse(|value| {
        value["spec"]["sections"][0]["fields"][1]["default"] = serde_json::json!("hunter2");
    })
    .contains(&ErrorCode::ConcealedDefault));
    assert!(refuse(|value| {
        value["spec"]["sections"][0]["fields"][0]["default"] = serde_json::json!("Untitled");
    })
    .is_empty());
}

#[test]
fn refuses_a_concealed_field_in_any_preview_surface() {
    assert!(
        refuse(|v| v["spec"]["subtitle"] = serde_json::json!(["token"]))
            .contains(&ErrorCode::ConcealedPreview)
    );
    assert!(
        refuse(|v| v["spec"]["search"] = serde_json::json!(["token"]))
            .contains(&ErrorCode::ConcealedPreview)
    );
    assert!(
        refuse(|v| v["spec"]["subtitle"] = serde_json::json!(["nope"]))
            .contains(&ErrorCode::ConcealedPreview)
    );
}

#[test]
fn refuses_a_native_secret_that_cannot_hold_line_one() {
    assert!(refuse(
        |v| v["spec"]["native"] = serde_json::json!({"secret": "missing", "trailer": []})
    )
    .contains(&ErrorCode::NativeSecret));
    assert!(refuse(|value| {
        value["spec"]["sections"] = serde_json::json!([{
            "id": "main", "title": "Main",
            "fields": [{ "id": "who", "type": "person-name", "label": "Name" }]
        }]);
        value["spec"]["native"] = serde_json::json!({ "secret": "who", "trailer": [] });
        value["spec"]["subtitle"] = serde_json::json!([]);
        value["spec"]["search"] = serde_json::json!([]);
    })
    .contains(&ErrorCode::NativeSecret));
    assert!(refuse(|value| {
        value["spec"]["sections"] = serde_json::json!([{
            "id": "main", "title": "Main",
            "fields": [{ "id": "keys", "type": "concealed", "label": "Key", "multiple": true }]
        }]);
        value["spec"]["native"] = serde_json::json!({ "secret": "keys", "trailer": [] });
        value["spec"]["subtitle"] = serde_json::json!([]);
        value["spec"]["search"] = serde_json::json!([]);
    })
    .contains(&ErrorCode::NativeSecret));
}

#[test]
fn refuses_a_broken_trailer() {
    assert!(refuse(|value| {
        value["spec"]["native"] = serde_json::json!({
            "secret": "token",
            "trailer": [{ "key": "token", "field": "token" }]
        });
    })
    .contains(&ErrorCode::Trailer));
    assert!(refuse(|value| {
        value["spec"]["native"] = serde_json::json!({
            "secret": "token",
            "trailer": [
                { "key": "label", "field": "label" },
                { "key": "label", "field": "label" }
            ]
        });
    })
    .contains(&ErrorCode::Trailer));
}

#[test]
fn refuses_bad_select_options_and_repeating_records() {
    assert!(refuse(|value| {
        value["spec"]["sections"][0]["fields"][0]["type"] = serde_json::json!("select");
    })
    .contains(&ErrorCode::Options));
    assert!(refuse(|value| {
        value["spec"]["sections"][0]["fields"][0]["options"] = serde_json::json!(["a", "b"]);
    })
    .contains(&ErrorCode::Options));
    assert!(refuse(|value| {
        value["spec"]["sections"][0]["fields"][0] = serde_json::json!({
            "id": "who", "type": "person-name", "label": "Name", "multiple": true
        });
        value["spec"]["subtitle"] = serde_json::json!([]);
        value["spec"]["search"] = serde_json::json!([]);
        value["spec"]["native"] = serde_json::json!({ "secret": "token", "trailer": [] });
    })
    .contains(&ErrorCode::Multiple));
}

#[test]
fn refuses_an_extension_that_is_not_a_short_leading_dot_slug() {
    assert!(
        refuse(|v| v["spec"]["extension"] = serde_json::json!("bank"))
            .contains(&ErrorCode::Extension)
    );
    assert!(
        refuse(|v| v["spec"]["extension"] = serde_json::json!("./etc/passwd"))
            .contains(&ErrorCode::Extension)
    );
}

#[test]
fn only_a_platform_definition_may_name_a_handler() {
    assert!(
        refuse(|v| v["spec"]["handler"] = serde_json::json!("certificate"))
            .contains(&ErrorCode::Handler)
    );

    let mut community_publisher = draft();
    community_publisher["spec"]["handler"] = serde_json::json!("certificate");
    let errors = parse_definition(&community_publisher.to_string(), Trust::Platform)
        .expect_err("a community publisher cannot claim a handler even at platform trust");
    assert!(errors.has(ErrorCode::Handler));

    let mut platform = draft();
    platform["metadata"]["publisher"] = serde_json::json!(PLATFORM_PUBLISHER);
    platform["spec"]["handler"] = serde_json::json!("certificate");
    let parsed = parse_definition(&platform.to_string(), Trust::Platform)
        .expect("the platform may name a handler it implements");
    assert!(parsed.spec.handler.is_some());
}

#[test]
fn refuses_a_definition_larger_than_the_cap() {
    let mut value = draft();
    value["spec"]["summary"] = serde_json::json!("x".repeat(80 * 1024));
    let errors = parse_definition(&value.to_string(), Trust::Community).expect_err("too large");
    assert_eq!(errors.codes(), vec![ErrorCode::TooLarge]);
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

fn text_values(definition: &opensesame_vault_item_types::ItemTypeDefinition) -> FieldValues {
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

#[test]
fn a_login_projects_onto_a_pass_entry() {
    let registry = ItemTypeRegistry::with_builtins();
    let login = registry.get("login").expect("login is built in");
    let mut values: FieldValues = BTreeMap::new();
    values.insert("username".into(), FieldValue::Text("ada".into()));
    values.insert("password".into(), FieldValue::Text("correct horse".into()));
    values.insert(
        "uris".into(),
        FieldValue::List(vec!["https://example.test".into()]),
    );
    let entry = to_entry(login, &values);
    assert_eq!(entry.secret, "correct horse");
    assert_eq!(entry.trailer, "login: ada\nurl: https://example.test\n");
    assert_eq!(
        entry.render(),
        "correct horse\nlogin: ada\nurl: https://example.test\n"
    );
}

#[test]
fn a_totp_seed_is_written_where_pass_otp_looks_for_it() {
    let registry = ItemTypeRegistry::with_builtins();
    let login = registry.get("login").expect("login is built in");
    let uri = "otpauth://totp/Demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // gitleaks:allow -- RFC fixture
    let mut values: FieldValues = BTreeMap::new();
    values.insert("password".into(), FieldValue::Text("pw".into()));
    values.insert("totp".into(), FieldValue::Text(uri.into()));
    let entry = to_entry(login, &values);
    let reparsed = Entry::parse(&entry.render());
    assert!(
        reparsed.otp.is_some(),
        "a projected TOTP seed must be visible to pass-otp"
    );
    let back = from_entry(login, &entry);
    assert_eq!(back.values.get("totp"), Some(&FieldValue::Text(uri.into())));
}

#[test]
fn a_readback_keeps_trailer_keys_the_definition_does_not_claim() {
    let registry = ItemTypeRegistry::with_builtins();
    let note = registry.get("note").expect("note is built in");
    let back = from_entry(
        note,
        &Entry {
            secret: String::new(),
            trailer: "notes: hello\nlegacy_key: kept\n".into(),
            otp: None,
        },
    );
    assert_eq!(
        back.values.get("notes"),
        Some(&FieldValue::Text("hello".into()))
    );
    assert_eq!(
        back.extra.get("legacy_key").map(String::as_str),
        Some("kept")
    );
}

#[test]
fn a_multi_line_value_stays_on_one_trailer_line() {
    let registry = ItemTypeRegistry::with_builtins();
    let note = registry.get("note").expect("note is built in");
    let mut values: FieldValues = BTreeMap::new();
    values.insert(
        "notes".into(),
        FieldValue::Text("first\nsecond\\third".into()),
    );
    let entry = to_entry(note, &values);
    assert_eq!(entry.trailer.lines().count(), 1);
    assert_eq!(
        from_entry(note, &entry).values.get("notes"),
        Some(&FieldValue::Text("first\nsecond\\third".into()))
    );
}

#[test]
fn a_record_field_round_trips_part_by_part() {
    let registry = ItemTypeRegistry::with_builtins();
    let bank = registry
        .get("bank-account")
        .expect("bank-account is built in");
    let mut parts = BTreeMap::new();
    parts.insert("first".to_owned(), "Ada".to_owned());
    parts.insert("last".to_owned(), "Lovelace".to_owned());
    let mut values: FieldValues = BTreeMap::new();
    values.insert("accountHolder".into(), FieldValue::Parts(parts.clone()));
    values.insert(
        "accountNumber".into(),
        FieldValue::Text("0001234567".into()),
    );
    let readback = from_entry(bank, &to_entry(bank, &values));
    assert_eq!(
        readback.values.get("accountHolder"),
        Some(&FieldValue::Parts(parts))
    );
    assert_eq!(
        readback.values.get("accountNumber"),
        Some(&FieldValue::Text("0001234567".into()))
    );
}

#[test]
fn an_unclaimed_trailer_key_carrying_a_dot_survives() {
    // The same three rows as `native.test.ts`'s parity block. The client and
    // the host read the same file; they have to keep the same things.
    let registry = ItemTypeRegistry::with_builtins();
    let note = registry.get("note").expect("note is built in");
    let back = from_entry(
        note,
        &Entry {
            secret: String::new(),
            trailer: "notes: hello\nlegacy.sub.key: kept\n".into(),
            otp: None,
        },
    );
    assert_eq!(
        back.values.get("notes"),
        Some(&FieldValue::Text("hello".into()))
    );
    assert_eq!(
        back.extra.get("legacy.sub.key").map(String::as_str),
        Some("kept")
    );
}

#[test]
fn a_key_with_an_empty_part_survives_and_a_shouted_key_does_not() {
    let registry = ItemTypeRegistry::with_builtins();
    let note = registry.get("note").expect("note is built in");
    let kept = from_entry(
        note,
        &Entry {
            secret: String::new(),
            trailer: "odd.: kept\n".into(),
            otp: None,
        },
    );
    assert_eq!(kept.extra.get("odd.").map(String::as_str), Some("kept"));

    let dropped = from_entry(
        note,
        &Entry {
            secret: String::new(),
            trailer: "Notes: shouted\n".into(),
            otp: None,
        },
    );
    assert!(dropped.extra.is_empty());
}

#[test]
fn a_drops_bearer_token_never_reaches_an_entry() {
    let registry = ItemTypeRegistry::with_builtins();
    let drop = registry.get("drop").expect("drop is built in");
    let mut values: FieldValues = BTreeMap::new();
    values.insert("state".into(), FieldValue::Text("pending".into()));
    values.insert("claimId".into(), FieldValue::Text("clm_1".into()));
    values.insert(
        "bearerToken".into(),
        FieldValue::Text("bearer-secret-value".into()),
    );
    let entry = to_entry(drop, &values);
    // A drop's payload lives in its claim, not the vault.
    assert!(!entry.render().contains("bearer-secret-value"));
    assert!(entry.secret.is_empty());
}

#[test]
fn refuses_a_section_id_longer_than_the_cap() {
    // The TypeScript regex caps this at 48; the host must agree, or a
    // definition is valid on one plane and refused on the other.
    let codes = refuse(|value| {
        value["spec"]["sections"][0]["id"] = serde_json::json!("s".repeat(64));
    });
    assert!(codes.contains(&ErrorCode::Sections));
}
