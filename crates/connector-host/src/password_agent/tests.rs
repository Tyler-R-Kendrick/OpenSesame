use super::{discover, documents, env, writes};
use serde_json::json;
fn item() -> serde_json::Value {
    json!({"id":"abcdefghijklmnopqrstuvwxyz","title":"Database Token","category":"API_CREDENTIAL","vault":{"id":"12345678901234567890123456","name":"Automation"},"tags":[],"urls":[{"href":"https://user:password@example.com/oauth?token=secret#secret"}],"fields":[{"id":"credential","label":"credential","type":"CONCEALED","value":"DO-NOT-PRINT","reference":"op://Automation/Database Token/credential"}]})
}
#[test]
fn discovery_never_returns_field_values_or_url_credentials() {
    let item = item();
    let output = discover::inventory(&[item.clone()]);
    let serialized = serde_json::to_string(&output).unwrap();
    assert!(!serialized.contains("DO-NOT-PRINT"));
    assert!(!serialized.contains("password"));
    assert!(!serialized.contains("token="));
    let result = discover::find(&[item.clone()], &[item], &["databse".into()]);
    assert_eq!(result["suggestions"][0]["query"], "databse");
    assert!(!result.to_string().contains("DO-NOT-PRINT"));
}
#[test]
fn multiquery_deduplicates_refs_and_annotates_queries() {
    let item = item();
    let output = discover::find(
        &[item.clone()],
        &[item],
        &["database".into(), "token".into(), "token".into()],
    );
    assert_eq!(output["matches"].as_array().unwrap().len(), 1);
    assert_eq!(
        output["matches"][0]["queries"],
        json!(["database", "token"])
    );
}
#[test]
fn parses_concatenated_json_and_fails_on_partial_output() {
    assert_eq!(documents(b"{}\n{}\n").unwrap().len(), 2);
    assert!(documents(b"{}\n{\"").is_err());
}
#[test]
fn resolver_deduplicates_preserves_literals_and_quotes_values() {
    let lines = env::parse("# hello\nexport A='op://v/i/f'\nB=op://v/i/f\nLITERAL=hello\n");
    let refs = env::references(&lines);
    assert_eq!(refs.len(), 1);
    assert_eq!(
        env::resolved(&lines, &refs, &json!(["a\"\\\n\r\n"])).unwrap(),
        "# hello\nA=\"a\\\"\\\\\\n\\r\"\nB=\"a\\\"\\\\\\n\\r\"\nLITERAL=hello\n"
    );
    assert!(env::resolved(&lines, &refs, &json!([])).is_err());
}
#[test]
fn duplicate_create_is_rejected_without_mutation() {
    assert!(writes::create_template(&[item()], " database token ", "secret", None, None).is_err());
}
#[test]
fn create_verifies_private_values_but_returns_safe_receipt() {
    let template =
        writes::create_template(&[], "Database Token", "DO-NOT-PRINT", None, None).unwrap();
    let stored = item();
    let receipt = writes::verify_create(&stored, &stored, &template, "Automation").unwrap();
    assert_eq!(receipt["verified"], true);
    assert!(!receipt.to_string().contains("DO-NOT-PRINT"));
    let mut changed = stored.clone();
    changed["fields"][0]["value"] = json!("mismatch");
    assert!(writes::verify_create(&stored, &changed, &template, "Automation").is_err());
}
#[test]
fn login_edits_preserve_fields_refuse_passkeys_and_require_repair() {
    let mut item = item();
    item["category"] = json!("LOGIN");
    item["fields"] = json!([{"id":"password","purpose":"PASSWORD","type":"CONCEALED","value":"old"},{"value":"imported"}]);
    assert!(writes::password_template(&item, "new\n", false).is_err());
    let edited = writes::password_template(&item, "new\n", true).unwrap();
    assert_eq!(edited["fields"][1]["value"], "imported");
    assert_eq!(edited["fields"][0]["value"], "new\n");
    assert_eq!(
        writes::verify_password(&item, &edited, "new\n").unwrap()["verified"],
        true
    );
    item["passkeys"] = json!([{}]);
    assert!(writes::password_template(&item, "new", true).is_err());
}
#[test]
fn readback_refuses_loss_of_unrelated_login_data() {
    let mut before = item();
    before["category"] = json!("LOGIN");
    before["tags"] = json!(["keep"]);
    before["fields"] = json!([{"id":"password","purpose":"PASSWORD","type":"CONCEALED","value":"old"},{"id":"extra","type":"STRING","value":"preserve"}]);
    let mut after = writes::password_template(&before, "new", false).unwrap();
    after["tags"] = json!([]);
    assert!(writes::verify_password(&before, &after, "new").is_err());
    after = writes::password_template(&before, "new", false).unwrap();
    after["fields"][1]["value"] = json!("lost");
    assert!(writes::verify_password(&before, &after, "new").is_err());
}
#[test]
fn corrupted_metadata_cannot_enter_safe_write_receipts() {
    let mut item = item();
    item["category"] = json!("LOGIN");
    item["fields"] =
        json!([{"id":"password","purpose":"PASSWORD","type":"CONCEALED","value":"old"}]);
    item["title"] = json!({"value":"private-corruption-canary"});
    assert!(writes::password_receipt(&item, "new").is_err());
    item["title"] = json!("Login");
    item["vault"]["name"] = json!({"value":"private-corruption-canary"});
    assert!(writes::password_receipt(&item, "new").is_err());
}
#[test]
fn create_readback_rejects_changed_labels_and_purpose() {
    let template =
        writes::create_template(&[], "Database Token", "DO-NOT-PRINT", None, Some("notes"))
            .unwrap();
    let mut stored = item();
    stored["fields"] = template["fields"].clone();
    let receipt = stored.clone();
    stored["fields"][0]["label"] = json!("corrupt");
    assert!(writes::verify_create(&receipt, &stored, &template, "Automation").is_err());
    stored["fields"] = template["fields"].clone();
    stored["fields"][1]["purpose"] = json!("PASSWORD");
    assert!(writes::verify_create(&receipt, &stored, &template, "Automation").is_err());
}
#[test]
fn service_account_policy_requires_dedicated_scoped_vault_and_exact_private_token() {
    use super::service;
    assert!(service::validate_setup("Automation", "Personal", "Backup", Some("90d")).is_err());
    assert!(service::validate_setup("Automation", "Automation", "Backup", Some("09d")).is_err());
    assert!(service::validate_setup("Automation", "Automation", "Backup", Some("1💥")).is_err());
    assert_eq!(service::token("ops_token\n").unwrap(), "ops_token");
    assert!(service::token("ops_token\n\n").is_err());
    assert_eq!(
        service::grant(&"a".repeat(26), true).unwrap(),
        format!("{}:read_items,write_items", "a".repeat(26))
    );
    assert!(service::grant("unsafe:write_items", true).is_err());
    let vault = json!({"id":"a".repeat(26),"name":"Automation"});
    assert!(service::validate_destination(&vault, &"a".repeat(26)).is_err());
    assert!(service::select(&[vault.clone(), vault.clone()], "Automation").is_err());
    assert!(service::verify_visible(&[vault.clone(), vault], &"a".repeat(26)).is_err());
}
