// Test-only public numeric key material converted before unchanged strict wire parsing.
pub(super) fn provision_json(vector: &serde_json::Value) -> serde_json::Value {
    let bytes: [u8; 64] =
        serde_json::from_value::<Vec<u8>>(vector["publicIndependentKeyBytes"].clone())
            .unwrap()
            .try_into()
            .unwrap();
    assert_eq!(
        bytes,
        std::array::from_fn(|index| u8::try_from(index).unwrap())
    );
    let mut provision = vector["provision"].as_object().unwrap().clone();
    assert!(!provision.contains_key("independentKeyMaterialB64"));
    provision.insert(
        "independentKeyMaterialB64".into(),
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes).into(),
    );
    serde_json::Value::Object(provision)
}
