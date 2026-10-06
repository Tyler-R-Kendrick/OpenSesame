//! Fail-closed templates and verification for private writes.
use serde_json::{json, Value};
/// # Errors
/// Rejects blank or duplicate titles.
pub fn create_template(
    listed: &[Value],
    title: &str,
    credential: &str,
    url: Option<&str>,
    notes: Option<&str>,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        listed.iter().all(|item| item["title"].is_string()),
        "Invalid existing-item metadata; nothing was created"
    );
    anyhow::ensure!(
        !title.trim().is_empty() && !credential.trim().is_empty(),
        "Non-empty title and credential required; nothing was created"
    );
    anyhow::ensure!(
        !listed.iter().any(|i| i["title"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .eq_ignore_ascii_case(title.trim())),
        "An item with this title already exists; nothing was created"
    );
    let mut fields =
        vec![json!({"id":"credential","type":"CONCEALED","label":"credential","value":credential})];
    if let Some(notes) = notes {
        fields.push(json!({"id":"notesPlain","type":"STRING","purpose":"NOTES","label":"notesPlain","value":notes}));
    }
    let mut template = json!({"title":title.trim(),"category":"API_CREDENTIAL","fields":fields});
    if let Some(url) = url {
        template["urls"] = json!([{"href":url,"primary":true}]);
    }
    Ok(template)
}
/// # Errors
/// Rejects inconsistent provider receipts or read-back values.
pub fn verify_create(
    receipt: &Value,
    stored: &Value,
    template: &Value,
    vault: &str,
) -> anyhow::Result<Value> {
    super::validate_summary(receipt)?;
    super::validate_item(stored)?;
    let reference = super::reference(receipt, "credential")?;
    anyhow::ensure!(
        receipt["title"] == template["title"]
            && receipt["category"] == "API_CREDENTIAL"
            && (receipt["vault"]["id"] == vault || receipt["vault"]["name"] == vault),
        "Creation is unverified; inspect before retrying"
    );
    for key in ["id", "title", "category", "vault"] {
        anyhow::ensure!(
            receipt[key] == stored[key],
            "Creation is unverified; inspect before retrying"
        );
    }
    for expected in template["fields"].as_array().into_iter().flatten() {
        let fields: Vec<_> = stored["fields"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|field| field["id"] == expected["id"] && field.get("section").is_none())
            .collect();
        anyhow::ensure!(
            fields.len() == 1
                && expected.as_object().is_some_and(|properties| properties
                    .iter()
                    .all(|(key, value)| fields[0].get(key) == Some(value))),
            "Creation is unverified; inspect before retrying"
        );
    }
    if let Some(url) = template["urls"][0]["href"].as_str() {
        anyhow::ensure!(
            stored["urls"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|u| u["href"] == url),
            "Creation is unverified; inspect before retrying"
        );
    }
    Ok(
        json!({"id":receipt["id"],"title":receipt["title"],"vault":vault,"kind":"api-credential","field":"credential","ref":reference,"verified":true}),
    )
}
fn passwords(item: &Value) -> Vec<&Value> {
    item["fields"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| {
            f["id"] == "password"
                && f["purpose"] == "PASSWORD"
                && f["type"] == "CONCEALED"
                && f.get("section").is_none()
        })
        .collect()
}
/// # Errors
/// Requires exactly one unsectioned built-in Login password and safe identifiers.
pub fn password_receipt(item: &Value, input: &str) -> anyhow::Result<Value> {
    super::validate_summary(item)?;
    anyhow::ensure!(item["fields"].is_array(), "Invalid Login fields");
    let fields = passwords(item);
    anyhow::ensure!(
        item["category"] == "LOGIN" && fields.len() == 1,
        "Expected a Login with exactly one built-in password; nothing was changed"
    );
    Ok(
        json!({"id":item["id"],"title":item["title"],"vault":item["vault"]["name"],"ref":super::reference(item,"password")?,"matches":fields[0]["value"]==input}),
    )
}
/// # Errors
/// Refuses passkeys and unnamed imported fields unless repair was explicitly selected.
pub fn password_template(item: &Value, input: &str, repair: bool) -> anyhow::Result<Value> {
    password_receipt(item, input)?;
    let mut template = item.clone();
    anyhow::ensure!(
        item["passkeys"].as_array().is_none_or(Vec::is_empty),
        "Cannot safely edit a template containing passkeys; nothing was changed"
    );
    let fields = template["fields"]
        .as_array_mut()
        .ok_or_else(|| anyhow::anyhow!("Invalid login fields"))?;
    for (index, field) in fields.iter_mut().enumerate() {
        anyhow::ensure!(
            field["type"] != "PASSKEY",
            "Cannot safely edit a template containing passkeys; nothing was changed"
        );
        if field["id"].as_str().unwrap_or_default().is_empty()
            && field["label"].as_str().unwrap_or_default().is_empty()
        {
            anyhow::ensure!(
                repair,
                "Unnamed imported fields require explicit repair; nothing was changed"
            );
            field["id"] = json!(format!("imported_field_{}", index + 1));
            field["label"] = json!(format!("Imported field {}", index + 1));
            field["type"] = json!("CONCEALED");
        }
        if field["id"] == "password"
            && field["purpose"] == "PASSWORD"
            && field.get("section").is_none()
        {
            field["value"] = json!(input);
        }
    }
    Ok(template)
}
/// # Errors
/// Rejects a write whose identity or built-in password did not survive read-back.
pub fn verify_password(before: &Value, after: &Value, input: &str) -> anyhow::Result<Value> {
    for key in ["id", "title", "category"] {
        anyhow::ensure!(
            before[key] == after[key],
            "Password update is unverified; inspect before retrying"
        );
    }
    anyhow::ensure!(
        before["vault"]["id"] == after["vault"]["id"],
        "Password update is unverified; inspect before retrying"
    );
    let expected = password_template(before, input, true)?;
    for key in ["fields", "tags", "urls", "sections"] {
        anyhow::ensure!(
            expected.get(key) == after.get(key),
            "Password update is unverified; unrelated item data changed; inspect before retrying"
        );
    }
    let mut receipt = password_receipt(after, input)?;
    anyhow::ensure!(
        receipt["matches"] == true,
        "Password update is unverified; inspect before retrying"
    );
    receipt.as_object_mut().map(|o| o.remove("matches"));
    receipt["changed"] = json!(true);
    receipt["verified"] = json!(true);
    Ok(receipt)
}
