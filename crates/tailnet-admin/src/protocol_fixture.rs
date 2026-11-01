//! Render `spec/conformance/tailnet-admin-protocol.json.hbs` with runtime key material.

use crate::synthetic;

const TEMPLATE: &str =
    include_str!("../../../spec/conformance/tailnet-admin-protocol.json.hbs");

pub struct ProtocolFixture {
    pub mint_auth_key_id: String,
    pub mint_auth_key: String,
    pub spec_json: String,
}

pub fn protocol_fixture() -> ProtocolFixture {
    let mint_auth_key_id = synthetic::auth_control_id();
    let mint_auth_key = synthetic::auth_key_for_control_id(&mint_auth_key_id);
    let spec_json = TEMPLATE
        .replace("{{mintAuthKeyId}}", &mint_auth_key_id)
        .replace("{{mintAuthKey}}", &mint_auth_key);
    ProtocolFixture {
        mint_auth_key_id,
        mint_auth_key,
        spec_json,
    }
}
