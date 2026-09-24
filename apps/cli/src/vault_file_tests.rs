//! `opensesame vault verify|ls` over the golden Pages vault vectors: the
//! output shape `opensesame-id vault` prints, extensions from the built-in
//! item types, and nothing printed that is not a name, kind, path, id or the
//! file's own metadata.

use super::*;

const VECTORS: &str = include_str!("../../../spec/conformance/vault-vectors.json");

fn fixture() -> Value {
    serde_json::from_str(VECTORS).expect("the vectors parse")
}

fn vector(name: &str) -> Value {
    serde_json::from_str(fixture()["vectors"][name]["file"].as_str().unwrap()).unwrap()
}

fn password() -> SecretString {
    SecretString::from(fixture()["password"].as_str().unwrap().to_owned())
}

fn opened(envelope: &Value) -> OpenedVaultFile {
    let file = read_vault_file(&envelope.to_string()).unwrap();
    open(&file, &password()).unwrap()
}

fn string_leaves(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(leaf) => out.push(leaf.clone()),
        Value::Array(rows) => rows.iter().for_each(|row| string_leaves(row, out)),
        Value::Object(map) => map.values().for_each(|row| string_leaves(row, out)),
        _ => {}
    }
}

#[test]
fn verify_and_ls_print_the_ts_cli_shape() {
    let opened = opened(&vector("export-personal"));
    assert_eq!(
        render_verify(&opened, "text"),
        "OK — opensesame-vault-export: bound to personal, revision 2, 2 items"
    );
    assert_eq!(
        render_ls(&opened, "text"),
        "opensesame-vault-export: bound to personal, revision 2, 2 items\n\
         Personal login.login\tlogin\n\
         Personal note.note\tnote"
    );
    let verify: Value = serde_json::from_str(&render_verify(&opened, "json")).unwrap();
    assert_eq!(verify["items"], 2);
    assert_eq!(verify["rolled_back"], false);
}

#[test]
fn ls_json_carries_only_what_may_be_shown() {
    let opened = opened(&vector("backup-project"));
    let listed: Value = serde_json::from_str(&render_ls(&opened, "json")).unwrap();
    let mut allowed = vec![
        "opensesame-offline-backup".to_owned(),
        "proj_vectors01".to_owned(),
    ];
    for item in &opened.items {
        allowed.extend([
            item.id.clone(),
            item.name.clone(),
            item.kind.clone(),
            item.path.clone(),
        ]);
    }
    let mut printed = Vec::new();
    string_leaves(&listed, &mut printed);
    assert_eq!(printed.len(), 2 + 4 * opened.items.len());
    for leaf in printed {
        assert!(allowed.contains(&leaf), "printed {leaf:?}");
    }
}

#[test]
fn a_legacy_body_and_a_rollback_are_said_out_loud() {
    let legacy = opened(&vector("export-legacy-unbound"));
    assert_eq!(
        render_verify(&legacy, "text"),
        "OK — opensesame-vault-export: legacy body, unbound from personal, 2 items"
    );
    let mut rolled = vector("export-personal");
    rolled["header"]["bodyRev"] = json!(3);
    let rolled = opened(&rolled);
    assert!(render_verify(&rolled, "text")
        .ends_with("revision 2, 2 items — ROLLED BACK: the header records revision 3"));
}

#[test]
fn refusals_name_no_value() {
    let file = read_vault_file(&vector("backup-personal").to_string()).unwrap();
    let wrong = open(&file, &SecretString::from("not the password".to_owned())).unwrap_err();
    assert_eq!(refusal(wrong).to_string(), "Wrong master password.");
    let rejected = read_vault_file("{}").map(|_| ()).unwrap_err();
    assert_eq!(refusal(rejected).to_string(), "Refused: not a vault file");
}
