//! Checks the vector tests share.

use serde_json::Value;

/// The account vectors hold every way to keep a login (ADR 0168 section 2): a
/// plain manual password, a peppered one with its sealed envelope, a sphinx
/// one with its OPRF key, an authenticator, and api-key, token and oauth.
pub fn assert_account_methods(name: &str, body: &Value) {
    let methods: Vec<&Value> = body["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter(|item| item["kind"] == "account")
        .flat_map(|item| item["methods"].as_array().expect("methods"))
        .collect();
    let has = |ty: &str| methods.iter().any(|method| method["type"] == ty);
    assert!(has("password") && has("authenticator"), "{name}");
    assert!(has("api-key") && has("token") && has("oauth"), "{name}");
    let password = |pred: &dyn Fn(&Value) -> bool| {
        methods
            .iter()
            .any(|method| method["type"] == "password" && pred(method))
    };
    assert!(
        password(&|m| m["generator"]["id"] == "manual" && m["pepper"] == false),
        "{name}: a plain manual password"
    );
    assert!(
        password(&|m| m["pepper"] == true && m["sealed"].is_object() && m["secret"] == ""),
        "{name}: a peppered password with its sealed envelope"
    );
    assert!(
        password(&|m| m["generator"]["id"] == "sphinx" && m["generator"]["oprfKeyB64"].is_string()),
        "{name}: a sphinx password"
    );
}
