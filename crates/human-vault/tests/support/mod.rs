//! Checks the vector tests share.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use opensesame_human_vault::pages_vault::vault_seal_binding;
use serde_json::Value;
use sha2::Sha256;

/// The vector added by ADR 0179: credentials that are entries of their own, bound and not.
pub const CREDENTIAL_VECTORS: [&str; 1] = ["backup-personal-credentials"];

/// Words the format itself stores as strings: a method's type, and so the
/// extension a credential is listed under.
pub const VOCABULARY: [&str; 6] = [
    "password",
    "api-key",
    "token",
    "oauth",
    "oauth-client",
    "authenticator",
];

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

/// The derived vector (ADR 0173, ADR 0174): a root, with the counter and rules a
/// password is computed from, and the same with a pepper slot, which keeps only
/// where the pepper goes. Neither holds a password or a pepper.
pub fn assert_derived_methods(name: &str, body: &Value) {
    let methods: Vec<&Value> = body["items"]
        .as_array()
        .expect("items")
        .iter()
        .flat_map(|item| item["methods"].as_array().expect("methods"))
        .filter(|method| method["type"] == "password" && method["generator"]["id"] == "derived")
        .collect();
    assert_eq!(methods.len(), 2, "{name}: two derived passwords");
    let has_params = |m: &&Value| {
        m["secret"].as_str().is_some_and(|root| !root.is_empty())
            && m["generator"]["counter"].is_number()
            && m["generator"]["rules"].is_object()
            && m["sealed"].is_null()
    };
    assert!(
        methods
            .iter()
            .any(|m| m["pepper"] == false && has_params(m)),
        "{name}: a root and its parameters"
    );
    assert!(
        methods
            .iter()
            .any(|m| m["pepper"] == true && m["pepperAt"] == "-4" && has_params(m)),
        "{name}: a pepper slot, and no pepper"
    );
}

/// Every string leaf of a JSON value.
pub fn string_leaves(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(leaf) => out.push(leaf.clone()),
        Value::Array(rows) => rows.iter().for_each(|row| string_leaves(row, out)),
        Value::Object(map) => map.values().for_each(|row| string_leaves(row, out)),
        _ => {}
    }
}

/// What the derived vector lists: two accounts, by name, kind and path (ADR 0173).
/// Neither name holds the word `derived`, which the vector stores as a value.
pub fn assert_derived_listing(name: &str, listed: &[(&str, &str, &str)]) {
    let want = [
        (
            "Personal computed account",
            "account",
            "Personal computed account.account",
        ),
        (
            "Personal computed slotted account",
            "account",
            "Personal computed slotted account.account",
        ),
    ];
    assert_eq!(listed, want, "{name}");
}

/// What the credentials vector lists (ADR 0179): the account, a password kept on
/// its own and an API key whose account is not in the body. The two credentials
/// bound to the account are part of its file and are not listed.
pub fn assert_credentials_listing(name: &str, listed: &[(&str, &str, &str)]) {
    let want = [
        (
            "Personal bound account",
            "account",
            "Personal bound account.account",
        ),
        (
            "Personal spare password",
            "credential",
            "Personal spare password.password",
        ),
        (
            "Personal orphaned key",
            "credential",
            "Personal orphaned key.apikey",
        ),
    ];
    assert_eq!(listed, want, "{name}");
}

pub fn b64(value: &Value) -> Vec<u8> {
    STANDARD
        .decode(value.as_str().expect("base64 field"))
        .expect("base64")
}

pub fn aes_open(key: &[u8], blob: &Value, aad: &[u8]) -> Option<Vec<u8>> {
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key))
        .decrypt(
            Nonce::from_slice(&b64(&blob["ivB64"])),
            Payload {
                msg: &b64(&blob["ctB64"]),
                aad,
            },
        )
        .ok()
}

/// The body decrypted independently of the reader (PBKDF2 → wrap → body),
/// so the test can name the values the reader must never list.
pub fn independent_body(file: &str, tomb: &str, nfkc: &str) -> Value {
    let envelope: Value = serde_json::from_str(file).unwrap();
    let vault = if envelope["vault"].is_object() {
        &envelope["vault"]
    } else {
        &envelope
    };
    let kdf = &vault["header"]["kdf"];
    let mut kek = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(
        nfkc.as_bytes(),
        &b64(&kdf["saltB64"]),
        u32::try_from(kdf["iterations"].as_u64().unwrap()).unwrap(),
        &mut kek,
    );
    let vk = aes_open(&kek, &vault["header"]["wrap"], &[]).expect("wrap opens");
    let body = aes_open(&vk, &vault["body"], &vault_seal_binding(tomb, "body"))
        .or_else(|| aes_open(&vk, &vault["body"], &[]))
        .expect("body opens");
    serde_json::from_slice(&body).unwrap()
}
