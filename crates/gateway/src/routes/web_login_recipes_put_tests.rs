//! The recipe routes proper (ADR 0076 §4, ADR 0159): trust comes only from a
//! verification the Host performed, a body can name none, and every write and
//! delete is compare-and-set and audited without the document.

use opensesame_domain::{OrganizationId, OrganizationRole};
use opensesame_rotation_web::recipe_doc::{RecipeDocument, MAX_RECIPE_BYTES};
use serde_json::json;

use super::tests::*;
use super::*;
use crate::app_state::{test_demo_state, test_session_headers};
use crate::test_principals::{P26, P28};
use crate::web_login::recipe_fixture;

#[tokio::test]
async fn an_unsigned_recipe_is_stored_a_candidate_that_no_run_may_replay() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let who = owner(&st);
    let mut document = recipe_fixture::document(SITE, false);
    document.signature = None;

    let created = send(
        &app,
        &put_headers(&who, "\"0\""),
        "PUT",
        &recipe_uri(),
        document_bytes(&document),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    assert_eq!(created.headers["etag"], "\"1\"");
    let recipe = &created.body["recipe"];
    assert_eq!(recipe["trust"], "candidate");
    assert_eq!(recipe["verified_at"], Value::Null);
    assert_eq!(recipe["signer_key_id"], Value::Null);
    assert_eq!(
        recipe["runnable"],
        json!({"attended": false, "unattended": false})
    );
    assert_eq!(recipe["updated_by"], P26);

    let read = send(&app, &who, "GET", &recipe_uri(), Vec::new()).await;
    assert_eq!(read.status, StatusCode::OK);
    assert_eq!(read.headers["etag"], "\"1\"");
    assert_eq!(read.body["document"]["origin"], SITE);
    assert_eq!(
        read.body["document"]["change_password"]["submit_selector"],
        "#save"
    );
    let listed = send(&app, &who, "GET", RECIPES, Vec::new()).await;
    assert_eq!(listed.body["recipes"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn trust_comes_from_the_signature_and_never_from_the_request() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let who = owner(&st);
    let put = |version: &str, document: &RecipeDocument| {
        let headers = put_headers(&who, version);
        let app = app.clone();
        let body = document_bytes(document);
        async move { send(&app, &headers, "PUT", &recipe_uri(), body).await }
    };

    // No pinned key yet: a signature nobody trusts is refused, not stored.
    let signed = recipe_fixture::document(SITE, false);
    let reply = put("\"0\"", &signed).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.body["error"], "unknown_signer");
    assert_eq!(
        send(&app, &who, "GET", &recipe_uri(), Vec::new())
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    assert_eq!(pin_signer(&app, &st).await.status, StatusCode::CREATED);

    // Signed, no canary: verified, but nothing has proven it yet.
    let reply = put("\"0\"", &signed).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let recipe = &reply.body["recipe"];
    assert_eq!(recipe["trust"], "candidate");
    assert_eq!(recipe["signer_key_id"], key_id());
    assert!(recipe["verified_at"].is_string());
    assert_eq!(
        recipe["runnable"],
        json!({"attended": true, "unattended": false})
    );

    // Signed with a canary attestation: proven.
    let attested = recipe_fixture::document(SITE, true);
    let reply = put("\"1\"", &attested).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.headers["etag"], "\"2\"");
    let recipe = &reply.body["recipe"];
    assert_eq!(recipe["trust"], "canary_verified");
    assert_eq!(recipe["canary"]["source"], "signed");
    assert_eq!(recipe["canary"]["result"], "passed");
    assert_eq!(
        recipe["runnable"],
        json!({"attended": true, "unattended": true})
    );

    // A tampered document, a forged key id, and a canary with nobody behind it.
    let mut tampered = attested.clone();
    tampered.change_password.submit_selector = "#steal".into();
    let reply = put("\"2\"", &tampered).await;
    assert_eq!(
        (reply.status, reply.body["error"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_signature"))
    );
    let mut forged = attested.clone();
    forged.signature.as_mut().unwrap().key_id = "rsk_00000000000000000000000000000000".into();
    assert_eq!(put("\"2\"", &forged).await.body["error"], "unknown_signer");
    let mut unsigned_claim = attested.clone();
    unsigned_claim.signature = None;
    assert_eq!(
        put("\"2\"", &unsigned_claim).await.body["error"],
        "canary_unsigned"
    );

    // The stored recipe is untouched by every refusal.
    let read = send(&app, &who, "GET", &recipe_uri(), Vec::new()).await;
    assert_eq!(read.body["recipe"]["version"], 2);
    assert_eq!(read.body["recipe"]["trust"], "canary_verified");
}

#[tokio::test]
async fn a_body_can_name_no_trust_and_no_other_origin() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let who = put_headers(&owner(&st), "\"0\"");
    let base = serde_json::to_value(recipe_fixture::document(SITE, false)).unwrap();
    let edit = |change: &dyn Fn(&mut Value)| {
        let mut document = base.clone();
        change(&mut document);
        document.to_string().into_bytes()
    };
    for (name, body, status, code) in [
        (
            "trust",
            edit(&|d| d["trust"] = json!("corpus")),
            400,
            "invalid_recipe",
        ),
        (
            "a canary result",
            edit(&|d| {
                d["canary"] = json!({"verified_at": "2026-01-01T00:00:00Z", "result": "passed"});
            }),
            400,
            "invalid_recipe",
        ),
        (
            "an origin that is not the path's",
            edit(&|d| {
                d["origin"] = json!("https://other.example");
                d["change_password"]["change_url"] = json!("https://other.example/x");
            }),
            400,
            "origin_mismatch",
        ),
        (
            "an off-origin change url",
            edit(&|d| d["change_password"]["change_url"] = json!("https://evil.example/x")),
            400,
            "invalid_recipe",
        ),
        (
            "an expired recipe",
            edit(&|d| d["expires_at"] = json!("2020-01-01T00:00:00Z")),
            400,
            "invalid_recipe",
        ),
        (
            "a recipe valid for years",
            edit(&|d| d["expires_at"] = json!("2099-01-01T00:00:00Z")),
            400,
            "invalid_recipe",
        ),
        (
            "an unknown version",
            edit(&|d| d["schema_version"] = json!(2)),
            400,
            "invalid_recipe",
        ),
        ("not a document", b"[]".to_vec(), 400, "invalid_recipe"),
    ] {
        let reply = send(&app, &who, "PUT", &recipe_uri(), body).await;
        assert_eq!(reply.status.as_u16(), status, "{name}: {}", reply.body);
        assert_eq!(reply.body["error"], code, "{name}");
    }
    let big = vec![b' '; MAX_RECIPE_BYTES + 1];
    assert_eq!(
        send(&app, &who, "PUT", &recipe_uri(), big).await.status,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        send(&app, &who, "GET", &recipe_uri(), Vec::new())
            .await
            .status,
        StatusCode::NOT_FOUND,
        "nothing was stored"
    );
}

#[tokio::test]
async fn origins_in_the_path_are_canonical_or_refused() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let who = owner(&st);
    for bad in [
        "login.example",
        "http%3A%2F%2Flogin.example",
        "https%3A%2F%2Flogin.example%2Fpath",
    ] {
        let reply = send(&app, &who, "GET", &format!("{RECIPES}/{bad}"), Vec::new()).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{bad}");
        assert_eq!(reply.body["error"], "invalid_origin");
    }
    // The default port and the host's case are the same origin.
    let reply = send(
        &app,
        &who,
        "GET",
        &format!("{RECIPES}/https%3A%2F%2FLOGIN.example%3A443"),
        Vec::new(),
    )
    .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

async fn put_at(app: &Router, who: &HeaderMap, version: &str, body: &[u8]) -> Reply {
    let headers = put_headers(who, version);
    send(app, &headers, "PUT", &recipe_uri(), body.to_vec()).await
}

async fn delete_at(app: &Router, who: &HeaderMap, version: &str) -> Reply {
    let headers = put_headers(who, version);
    send(app, &headers, "DELETE", &recipe_uri(), Vec::new()).await
}

#[tokio::test]
async fn writes_are_compare_and_set() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let who = owner(&st);
    pin_signer(&app, &st).await;
    let body = document_bytes(&recipe_fixture::document(SITE, false));

    let missing = send(&app, &who, "PUT", &recipe_uri(), body.clone()).await;
    assert_eq!(missing.status, StatusCode::PRECONDITION_REQUIRED);
    let malformed = put_at(&app, &who, "W/\"1\"", &body).await;
    assert_eq!(malformed.status, StatusCode::BAD_REQUEST);

    assert_eq!(
        put_at(&app, &who, "\"0\"", &body).await.status,
        StatusCode::CREATED
    );
    for stale in ["\"0\"", "\"2\""] {
        let reply = put_at(&app, &who, stale, &body).await;
        assert_eq!(reply.status, StatusCode::PRECONDITION_FAILED, "{stale}");
        assert_eq!(reply.body["current_version"], 1);
    }
    assert_eq!(
        put_at(&app, &who, "\"1\"", &body).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn deletes_are_compare_and_set_and_every_change_is_audited_without_the_document() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let who = owner(&st);
    pin_signer(&app, &st).await;
    let body = document_bytes(&recipe_fixture::document(SITE, false));
    put_at(&app, &who, "\"0\"", &body).await;
    put_at(&app, &who, "\"1\"", &body).await;

    let missing = send(&app, &who, "DELETE", &recipe_uri(), Vec::new()).await;
    assert_eq!(missing.status, StatusCode::PRECONDITION_REQUIRED);
    let stale = delete_at(&app, &who, "\"1\"").await;
    assert_eq!(
        (stale.status, &stale.body["current_version"]),
        (StatusCode::PRECONDITION_FAILED, &json!(2))
    );
    let deleted = delete_at(&app, &who, "\"2\"").await;
    assert_eq!(
        (deleted.status, &deleted.body["deleted"]),
        (StatusCode::OK, &json!(true))
    );
    assert_eq!(
        delete_at(&app, &who, "\"2\"").await.status,
        StatusCode::NOT_FOUND
    );

    // Two writes and one delete, each with an audit that names no selector.
    let puts = audit_payloads(&st, EVENT_RECIPE_PUT).await;
    assert_eq!(puts.len(), 2);
    let removals = audit_payloads(&st, EVENT_RECIPE_DELETED).await;
    assert_eq!(removals.len(), 1);
    for payload in puts.iter().chain(&removals) {
        assert!(
            !payload.contains("#save") && !payload.contains("change-password"),
            "{payload}"
        );
    }
    assert!(puts[0].contains("signature_verified") && puts[0].contains("sha256:"));
}

#[tokio::test]
async fn revoking_the_signer_takes_the_recipe_out_of_service_at_once() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let who = owner(&st);
    pin_signer(&app, &st).await;
    let attested = recipe_fixture::document(SITE, true);
    let created = send(
        &app,
        &put_headers(&who, "\"0\""),
        "PUT",
        &recipe_uri(),
        document_bytes(&attested),
    )
    .await;
    assert_eq!(
        created.body["recipe"]["runnable"],
        json!({"attended": true, "unattended": true})
    );

    let revoked = send(
        &app,
        &who,
        "DELETE",
        &format!("{SIGNERS}/{}", key_id()),
        Vec::new(),
    )
    .await;
    assert_eq!(revoked.status, StatusCode::OK);
    let read = send(&app, &who, "GET", &recipe_uri(), Vec::new()).await;
    assert_eq!(
        read.body["recipe"]["runnable"],
        json!({"attended": false, "unattended": false})
    );
    let again = send(
        &app,
        &put_headers(&who, "\"1\""),
        "PUT",
        &recipe_uri(),
        document_bytes(&attested),
    )
    .await;
    assert_eq!(
        (again.status, again.body["error"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("signer_revoked"))
    );
}

#[tokio::test]
async fn another_organizations_recipes_and_signers_are_invisible() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    pin_signer(&app, &st).await;
    let who = owner(&st);
    send(
        &app,
        &put_headers(&who, "\"0\""),
        "PUT",
        &recipe_uri(),
        document_bytes(&recipe_fixture::document(SITE, true)),
    )
    .await;
    let stranger = test_session_headers(&st, P28, OrganizationId::new(), OrganizationRole::Owner);
    assert!(
        send(&app, &stranger, "GET", RECIPES, Vec::new()).await.body["recipes"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        send(&app, &stranger, "GET", SIGNERS, Vec::new()).await.body["signers"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        send(&app, &stranger, "GET", &recipe_uri(), Vec::new())
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}
