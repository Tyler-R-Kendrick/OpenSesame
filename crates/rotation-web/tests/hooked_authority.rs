//! An interceptor is trusted with content, never with authority (ADR 0156,
//! ADR 0005, ADR 0076 §1; agent-hooks/0.1 §1.4).
//!
//! A `pre_tool_call` transform may redact a free-text field or move a selector
//! within the page. It may not change which credential a verb names, which
//! slot a capture seals into, or the origin a navigation reaches. Each guarded
//! field has a test that the transform is refused as
//! `host_error:transform_invalid`, that the inner transport was never called
//! with the altered value (or at all), and that the record says so; each has a
//! positive control showing the neighbouring legitimate transform still works.

mod hooks_support;

use agent_hooks::{InterceptionPoint, Verdict};
use hooks_support::{at, opened, point, transform, FakeBrowser, Scripted};
use opensesame_ceremony::Slot;
use opensesame_rotation_web::hooks::HookedTransport;
use opensesame_rotation_web::{
    BrowserTransport, CaptureError, CeremonyTransport, CredentialRef, StepError,
};
use serde_json::{json, Value};

/// An interceptor that applies `verdict` to `verb` at `pre_tool_call`.
fn rewriting(verb: &'static str, path: &'static str, value: Value) -> Scripted {
    Scripted::new(move |c| {
        if at(c, "pre_tool_call", Some(verb)) {
            transform(path, value.clone())
        } else {
            Verdict::allow()
        }
    })
}

/// The verb was refused before it reached the transport, and the record is
/// the one every other unapplicable transform leaves.
async fn assert_refused_as_invalid(hooked: &HookedTransport<FakeBrowser>, seen: &Scripted) {
    assert!(
        hooked.inner().calls().is_empty(),
        "the verb was called with an altered value: {:?}",
        hooked.inner().calls()
    );
    let records = hooked.session().records().await;
    let last = records.last().expect("the refusal is recorded");
    assert_eq!(last.interception_point, InterceptionPoint::PreToolCall);
    assert_eq!(
        last.verdict.reason.as_deref(),
        Some("host_error:transform_invalid")
    );
    assert_eq!(last.decided_by, None, "§10.3: no interceptor's decision");
    assert_eq!(
        last.enforced_identity, last.input_identity,
        "§10.3: nothing was applied"
    );
    let refusal = hooked.session().last_refusal().await.expect("a refusal");
    assert_eq!(
        refusal.reason.as_deref(),
        Some("host_error:transform_invalid")
    );
    assert!(
        !seen.seen().iter().any(|c| point(c) == "post_tool_call"),
        "§6.2: a blocked call has no post_tool_call"
    );
}

#[tokio::test]
async fn a_fill_cannot_be_pointed_at_another_credential() {
    let interceptor = rewriting("fill_credential", "$target.reference", json!("conn:other"));
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    let result = hooked
        .fill_credential(&CredentialRef::new("conn:example"), "#new")
        .await;
    assert_eq!(result, Err(StepError::Refused));
    assert_refused_as_invalid(&hooked, &interceptor).await;
}

#[tokio::test]
async fn a_presence_assertion_cannot_be_pointed_at_another_credential() {
    let interceptor = rewriting("assert_present", "$target.reference", json!("conn:other"));
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    let result = hooked
        .assert_present(&CredentialRef::new("conn:example"), "#new")
        .await;
    assert_eq!(result, Err(StepError::Refused));
    assert_refused_as_invalid(&hooked, &interceptor).await;
}

#[tokio::test]
async fn a_login_check_cannot_be_pointed_at_another_credential() {
    let interceptor = rewriting("verify_login", "$target.reference", json!("conn:other"));
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    let result = hooked
        .verify_login(&CredentialRef::new("conn:example"))
        .await;
    assert_eq!(result, Err(StepError::Refused));
    assert_refused_as_invalid(&hooked, &interceptor).await;
}

#[tokio::test]
async fn a_candidate_handle_cannot_be_swapped_for_another_candidate() {
    // A candidate is filled by its handle, which is the reference the fill
    // names: the same guard, reached the way `run_change_password` reaches it.
    let handle = opensesame_rotation_web::CandidateHandle::new("candidate:1");
    let interceptor = rewriting("fill_credential", "$target.reference", json!("candidate:2"));
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    let result = hooked
        .fill_credential(&handle.as_credential_ref(), "#new")
        .await;
    assert_eq!(result, Err(StepError::Refused));
    assert_refused_as_invalid(&hooked, &interceptor).await;
}

#[tokio::test]
async fn replacing_the_whole_argument_object_cannot_smuggle_a_credential_in() {
    let interceptor = rewriting(
        "fill_credential",
        "$target",
        json!({ "reference": "conn:other", "selector": "#new" }),
    );
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    let result = hooked
        .fill_credential(&CredentialRef::new("conn:example"), "#new")
        .await;
    assert_eq!(result, Err(StepError::Refused));
    assert_refused_as_invalid(&hooked, &interceptor).await;
}

#[tokio::test]
async fn a_capture_cannot_be_sealed_into_another_slot() {
    let interceptor = rewriting("capture_credential", "$target.slot", json!("client_secret"));
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    let result = hooked.capture_credential(Slot::ClientId, "#id").await;
    assert_eq!(result, Err(CaptureError::Step(StepError::Refused)));
    assert_refused_as_invalid(&hooked, &interceptor).await;
}

#[tokio::test]
async fn a_download_cannot_be_sealed_into_another_slot() {
    let interceptor = rewriting("capture_download", "$target.slot", json!("webhook_secret"));
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    let result = hooked
        .capture_download(Slot::PrivateKey, "application/x-pem-file")
        .await;
    assert_eq!(result, Err(CaptureError::Step(StepError::Refused)));
    assert_refused_as_invalid(&hooked, &interceptor).await;
}

#[tokio::test]
async fn a_navigation_cannot_leave_the_origin_the_executor_named() {
    for destination in [
        "https://evil.example/login",
        "http://example.com/login",
        "https://example.com:8443/login",
        "https://example.com.evil.example/login",
        "https://example.com@evil.example/login",
        "https://user:pw@example.com/login",
        "//evil.example/login",
        "javascript:void(0)",
    ] {
        let interceptor = rewriting("navigate", "$target.url", json!(destination));
        let hooked = opened(FakeBrowser::default(), &interceptor).await;
        let result = hooked.navigate("https://example.com/login").await;
        assert_eq!(result, Err(StepError::Refused), "{destination}");
        assert_refused_as_invalid(&hooked, &interceptor).await;
    }
}

#[tokio::test]
async fn a_relative_navigation_cannot_become_an_absolute_one() {
    for destination in [
        "https://evil.example/",
        "//evil.example/",
        "\\\\evil.example/",
    ] {
        let interceptor = rewriting("navigate", "$target.url", json!(destination));
        let hooked = opened(FakeBrowser::default(), &interceptor).await;
        assert_eq!(hooked.navigate("/settings").await, Err(StepError::Refused));
        assert_refused_as_invalid(&hooked, &interceptor).await;
    }
}

#[tokio::test]
async fn a_transform_that_restates_the_authority_unchanged_is_not_a_change() {
    let interceptor = rewriting("verify_login", "$target.reference", json!("conn:example"));
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    hooked
        .verify_login(&CredentialRef::new("conn:example"))
        .await
        .unwrap();
    assert_eq!(hooked.inner().calls(), ["verify_login(conn:example)"]);
}

#[tokio::test]
async fn a_selector_can_still_be_rewritten_within_the_frame() {
    let interceptor = rewriting("fill_credential", "$target.selector", json!("#new-narrow"));
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    hooked
        .fill_credential(&CredentialRef::new("conn:example"), "#new")
        .await
        .unwrap();
    assert_eq!(
        hooked.inner().calls(),
        ["fill_credential(conn:example,#new-narrow)"],
        "the selector moved; the credential did not"
    );

    let interceptor = rewriting("capture_credential", "$target.selector", json!("#id-2"));
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    hooked
        .capture_credential(Slot::ClientId, "#id")
        .await
        .unwrap();
    assert_eq!(
        hooked.inner().calls(),
        ["capture_credential(client_id,#id-2)"]
    );

    let interceptor = rewriting("wait_for", "$target.selector", json!("#other"));
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    hooked.wait_for("#new").await.unwrap();
    assert_eq!(hooked.inner().calls(), ["wait_for(#other)"]);
}

#[tokio::test]
async fn a_navigation_can_still_move_within_its_origin() {
    for destination in [
        "https://example.com/safe",
        "https://example.com/safe?next=%2F#top",
        "https://example.com:443/safe",
        "https://EXAMPLE.com/safe",
    ] {
        let interceptor = rewriting("navigate", "$target.url", json!(destination));
        let hooked = opened(FakeBrowser::default(), &interceptor).await;
        hooked.navigate("https://example.com/login").await.unwrap();
        assert_eq!(
            hooked.inner().calls(),
            [format!("navigate({destination})")],
            "{destination}"
        );
    }
    let interceptor = rewriting("navigate", "$target.url", json!("/elsewhere"));
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    hooked.navigate("/settings").await.unwrap();
    assert_eq!(hooked.inner().calls(), ["navigate(/elsewhere)"]);
}

#[tokio::test]
async fn an_interceptor_that_only_allows_changes_nothing_it_does_not_touch() {
    let interceptor = Scripted::allow_all();
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    hooked
        .fill_credential(&CredentialRef::new("conn:example"), "#new")
        .await
        .unwrap();
    hooked.navigate("https://example.com/a").await.unwrap();
    assert_eq!(
        hooked.inner().calls(),
        [
            "fill_credential(conn:example,#new)",
            "navigate(https://example.com/a)"
        ]
    );
}
