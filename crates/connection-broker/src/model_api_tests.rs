use crate::catalog::{load, AuthMethod, Catalog, Category, ModelProtocol, CATALOG_JSON};

#[test]
fn every_ai_model_provider_says_how_it_is_spoken_to() {
    let catalog = load().expect("embedded catalog");
    let rows: Vec<_> = catalog
        .providers()
        .iter()
        .filter(|provider| provider.category == Category::AiModelProvider)
        .collect();
    assert!(
        rows.len() >= 80,
        "the model catalog shrank to {}",
        rows.len()
    );
    for provider in rows {
        let api = provider
            .model_api
            .as_ref()
            .unwrap_or_else(|| panic!("{} has no model_api", provider.id));
        if matches!(provider.auth, AuthMethod::Configuration) {
            assert!(api.base_url.is_none(), "{}", provider.id);
            assert_eq!(provider.egress.scheme, "none", "{}", provider.id);
            continue;
        }
        let base = api.base_url.as_deref().expect("a fixed base_url");
        assert!(base.starts_with("https://"), "{}", provider.id);
        assert!(!base.ends_with('/'), "{}", provider.id);
        provider
            .egress
            .binding()
            .allows_url(&format!("{base}/"))
            .unwrap_or_else(|error| panic!("{}: {error}", provider.id));
    }
}

#[test]
fn a_model_row_cannot_name_a_host_its_egress_does_not() {
    let mut raw: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
    let index = raw["providers"]
        .as_array()
        .unwrap()
        .iter()
        .position(|row| row["id"] == "xai")
        .expect("xai row");
    raw["providers"][index]["model_api"]["base_url"] = serde_json::json!("https://evil.example/v1");
    let error = Catalog::parse(&raw.to_string()).unwrap_err().to_string();
    assert!(
        error.contains("must sit inside the provider egress"),
        "{error}"
    );

    raw["providers"][index]["model_api"]["base_url"] = serde_json::json!("https://api.x.ai/v1/");
    let error = Catalog::parse(&raw.to_string()).unwrap_err().to_string();
    assert!(error.contains("must not end with /"), "{error}");

    raw["providers"][index]["model_api"] = serde_json::json!({ "protocol": "openai_chat" });
    let error = Catalog::parse(&raw.to_string()).unwrap_err().to_string();
    assert!(error.contains("needs model_api.base_url"), "{error}");

    raw["providers"][index]["model_api"] = serde_json::json!({
        "protocol": "smtp",
        "base_url": "https://api.x.ai/v1"
    });
    assert!(Catalog::parse(&raw.to_string()).is_err());

    raw["providers"][index]["model_api"] = serde_json::json!({
        "protocol": "openai_chat",
        "base_url": "https://api.x.ai/v1",
        "header": "x-anything"
    });
    let error = Catalog::parse(&raw.to_string()).unwrap_err().to_string();
    assert!(error.contains("unknown field"), "{error}");

    raw["providers"][index]
        .as_object_mut()
        .unwrap()
        .remove("model_api");
    let error = Catalog::parse(&raw.to_string()).unwrap_err().to_string();
    assert!(error.contains("needs model_api"), "{error}");
}

#[test]
fn a_row_outside_the_model_category_cannot_carry_model_api() {
    let mut raw: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
    raw["providers"][0]["model_api"] = serde_json::json!({ "protocol": "openai_chat" });
    let error = Catalog::parse(&raw.to_string()).unwrap_err().to_string();
    assert!(
        error.contains("only valid on ai_model_provider rows"),
        "{error}"
    );
}

#[test]
fn a_configuration_model_row_cannot_pin_a_fixed_endpoint() {
    let mut raw: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
    let index = raw["providers"]
        .as_array()
        .unwrap()
        .iter()
        .position(|row| row["id"] == "litellm")
        .expect("litellm row");
    raw["providers"][index]["model_api"]["base_url"] =
        serde_json::json!("https://proxy.example/v1");
    let error = Catalog::parse(&raw.to_string()).unwrap_err().to_string();
    assert!(
        error.contains("names its endpoint at connect time"),
        "{error}"
    );
}

#[test]
fn model_credentials_travel_in_one_header_chosen_by_the_catalog() {
    let catalog = load().expect("embedded catalog");
    let anthropic = catalog.find("anthropic").unwrap();
    assert!(matches!(
        &anthropic.auth,
        AuthMethod::ApiKey { header, value_prefix } if header == "x-api-key" && value_prefix.is_empty()
    ));
    assert_eq!(
        anthropic.model_api.as_ref().unwrap().protocol,
        ModelProtocol::AnthropicMessages
    );
    let openai = catalog.find("openai").unwrap();
    assert_eq!(
        openai.model_api.as_ref().unwrap().protocol,
        ModelProtocol::OpenaiChat
    );
    assert_eq!(
        catalog
            .find("gemini")
            .unwrap()
            .model_api
            .as_ref()
            .unwrap()
            .protocol,
        ModelProtocol::GeminiGenerateContent
    );
}
