#[test]
fn pact_auth_precedes_storage_and_the_receipt_precedes_the_body() {
    let source = include_str!("../../kv_facade.rs");
    // A read authenticates, resolves inside the caller's organization, and only
    // then touches storage.
    opensesame_host_core::pact::assert_source_order(
        source,
        &[
            "async fn read_data",
            "parse_kv_path(&mount, &raw_path)",
            "vault_caller(&st, &headers)",
            "caller.organization(st.connection_organization)",
            "resolve_connection(&st, &caller, &organization_id",
        ],
    );
    // The body is built, the receipt is emitted, and only a recorded receipt
    // produces a 200.
    opensesame_host_core::pact::assert_source_order(
        source,
        &[
            "async fn respond_read",
            "let body = data_envelope(",
            "emit_receipt(",
            "Ok(receipt_id) => with_receipt(receipt_id, body)",
            "Err(response) => response",
        ],
    );
    // Signing happens before persistence, and the leak check before both.
    opensesame_host_core::pact::assert_source_order(
        source,
        &[
            "async fn emit_receipt",
            ".sign_receipt(receipt)",
            "assert_no_secret_leak()",
            "insert_intent(&intent)",
            "insert_receipt(&receipt)",
        ],
    );
    // Nothing on this surface materialises a secret outside the ADR 0049 gate.
    assert!(!source.contains("get_secret"));
    assert!(!source.contains("getSecret"));
    let materialize = source
        .find("async fn materialized_data")
        .expect("materialized_data");
    let gate = source[materialize..]
        .find("MaterializationPolicy::DerivedShortLived")
        .expect("policy gate");
    let mint = source[materialize..]
        .find("mint_derived_token")
        .expect("mint call");
    assert!(gate < mint, "the mint path must be policy-gated first");
}
