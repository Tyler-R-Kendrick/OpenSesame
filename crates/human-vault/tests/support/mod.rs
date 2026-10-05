//! Checks the vector tests share.

use serde_json::Value;

/// The account vectors hold every way to keep a login (ADR 0172 section 2): a
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

/// The derived vector (ADR 0173): a root kept in the clear, with the counter
/// and rules its password is computed from, and one sealed under the pepper
/// through OPAQUE (`v` 2, the record and server setup beside the ciphertext).
pub fn assert_derived_methods(name: &str, body: &Value) {
    let methods: Vec<&Value> = body["items"]
        .as_array()
        .expect("items")
        .iter()
        .flat_map(|item| item["methods"].as_array().expect("methods"))
        .filter(|method| method["type"] == "password" && method["generator"]["id"] == "derived")
        .collect();
    assert_eq!(methods.len(), 2, "{name}: two derived passwords");
    assert!(
        methods.iter().any(|m| m["pepper"] == false
            && m["secret"].as_str().is_some_and(|root| !root.is_empty())
            && m["generator"]["counter"].is_number()
            && m["generator"]["rules"].is_object()),
        "{name}: a root in the clear"
    );
    assert!(
        methods.iter().any(|m| m["pepper"] == true
            && m["secret"] == ""
            && m["sealed"]["v"] == 2
            && m["sealed"]["registrationRecord"].is_string()
            && m["sealed"]["serverSetup"].is_string()),
        "{name}: a root sealed under the pepper"
    );
}
