//! Every verb of the tool boundary, bracketed by `pre_tool_call` and
//! `post_tool_call` (ADR 0150; agent-hooks/0.1 §4.3, §6, §6.1, §12.2).
//!
//! Each property is asserted against what the inner transport actually
//! received, not against what the wrapper says it did: a deny means the inner
//! verb never ran, a transform means it ran with the transformed arguments.

mod hooks_support;

use agent_hooks::{Decision, InterceptionPoint, Verdict};
use hooks_support::{at, opened, point, token_shaped, transform, wire, FakeBrowser, Scripted};
use opensesame_ceremony::Slot;
use opensesame_rotation_web::hooks::{HookedTransport, OUT_OF_ORDER};
use opensesame_rotation_web::{
    BrowserTransport, CaptureError, CeremonyTransport, CredentialRef, Presence, StepError,
};
use opensesame_session_observe::{LayoutEpoch, MaskManifest};
use serde_json::json;

fn mask() -> MaskManifest {
    MaskManifest::solved(LayoutEpoch(7), 1, 1)
}

#[tokio::test]
async fn every_verb_is_one_pre_and_one_post_under_one_call_id() {
    let interceptor = Scripted::allow_all();
    let browser = FakeBrowser {
        dom: Some("<form></form>".into()),
        frame: Some(vec![1, 2, 3]),
        ..FakeBrowser::default()
    };
    let hooked = opened(browser, &interceptor).await;
    let reference = CredentialRef::new("conn:example");
    hooked.navigate("https://example.com/a").await.unwrap();
    hooked.wait_for("#new").await.unwrap();
    hooked.fill_credential(&reference, "#new").await.unwrap();
    hooked.assert_present(&reference, "#new").await.unwrap();
    hooked.submit("#save").await.unwrap();
    hooked.read_dom_redacted().await.unwrap();
    hooked.screenshot_redacted(mask()).await.unwrap();
    hooked.verify_login(&reference).await.unwrap();
    hooked.outstanding().await;
    hooked
        .capture_credential(Slot::ClientId, "#id")
        .await
        .unwrap();
    hooked
        .capture_download(Slot::PrivateKey, "application/x-pem-file")
        .await
        .unwrap();

    let tool_contexts: Vec<_> = interceptor
        .seen()
        .into_iter()
        .filter(|c| point(c).ends_with("_tool_call"))
        .collect();
    assert_eq!(tool_contexts.len(), 22, "11 verbs, a pre and a post each");
    for pair in tool_contexts.chunks(2) {
        assert_eq!(point(&pair[0]), "pre_tool_call");
        assert_eq!(point(&pair[1]), "post_tool_call");
        assert_eq!(pair[0]["tool_call"]["id"], pair[1]["tool_call"]["id"]);
        assert_eq!(pair[0]["tool_call"]["args"], pair[1]["tool_call"]["args"]);
    }
    assert_eq!(hooked.inner().verbs().len(), 11);
}

#[tokio::test]
async fn a_pre_tool_deny_never_reaches_the_inner_transport() {
    let interceptor = Scripted::new(|c| {
        if at(c, "pre_tool_call", Some("submit")) {
            Verdict::deny(Some("acme:no_submit".into()), None)
        } else {
            Verdict::allow()
        }
    });
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    assert_eq!(hooked.submit("#save").await, Err(StepError::Refused));
    assert!(hooked.inner().calls().is_empty());
    let refusal = hooked.session().last_refusal().await.unwrap();
    assert_eq!(refusal.point, InterceptionPoint::PreToolCall);
    assert_eq!(refusal.reason.as_deref(), Some("acme:no_submit"));
    // §6.2: no post_tool_call for a blocked action.
    assert!(!interceptor
        .seen()
        .iter()
        .any(|c| point(c) == "post_tool_call"));
}

#[tokio::test]
async fn a_pre_tool_transform_is_what_the_inner_transport_receives() {
    let interceptor = Scripted::new(|c| {
        if at(c, "pre_tool_call", Some("navigate")) {
            transform("$target.url", json!("https://example.com/safe"))
        } else {
            Verdict::allow()
        }
    });
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    hooked.navigate("https://example.com/risky").await.unwrap();
    assert_eq!(
        hooked.inner().calls(),
        ["navigate(https://example.com/safe)"]
    );
    // §4.2: post_tool_call's args are the arguments actually passed.
    let post = interceptor
        .seen()
        .into_iter()
        .find(|c| point(c) == "post_tool_call")
        .unwrap();
    assert_eq!(
        post["tool_call"]["args"],
        json!({ "url": "https://example.com/safe" })
    );
}

#[tokio::test]
async fn a_transform_the_verb_cannot_take_is_refused_as_transform_invalid() {
    let interceptor = Scripted::new(|c| {
        if at(c, "pre_tool_call", Some("fill_credential")) {
            transform("$target.selector", json!(42))
        } else {
            Verdict::allow()
        }
    });
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    let reference = CredentialRef::new("conn:example");
    assert_eq!(
        hooked.fill_credential(&reference, "#new").await,
        Err(StepError::Refused)
    );
    assert!(
        hooked.inner().calls().is_empty(),
        "never ignored, never applied"
    );
    let records = hooked.session().records().await;
    let last = records.last().unwrap();
    assert_eq!(
        last.verdict.reason.as_deref(),
        Some("host_error:transform_invalid")
    );
    assert_eq!(
        last.decided_by, None,
        "§10.3: a transform-application failure"
    );
    assert!(last.input_identity.is_some());
    assert_eq!(
        last.enforced_identity, last.input_identity,
        "§10.3: no transform was applied, so nothing else was enforced"
    );
}

#[tokio::test]
async fn a_post_tool_deny_discards_a_result_that_did_happen() {
    let interceptor = Scripted::new(|c| {
        if at(c, "post_tool_call", Some("assert_present")) {
            Verdict::deny(Some("acme:unsure".into()), None)
        } else {
            Verdict::allow()
        }
    });
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    let reference = CredentialRef::new("conn:example");
    assert_eq!(
        hooked.assert_present(&reference, "#new").await,
        Err(StepError::Refused)
    );
    assert_eq!(
        hooked.inner().verbs(),
        ["assert_present"],
        "it ran; its answer did not count"
    );
}

#[tokio::test]
async fn a_post_tool_transform_replaces_the_result() {
    let interceptor = Scripted::new(|c| {
        if at(c, "post_tool_call", Some("assert_present")) {
            transform("$target", json!("Absent"))
        } else {
            Verdict::allow()
        }
    });
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    let reference = CredentialRef::new("conn:example");
    assert_eq!(
        hooked.assert_present(&reference, "#new").await,
        Ok(Presence::Absent)
    );
}

#[tokio::test]
async fn a_transform_cannot_turn_an_error_into_a_success() {
    let interceptor = Scripted::new(|c| {
        if at(c, "post_tool_call", Some("wait_for")) {
            transform("$target", json!(null))
        } else {
            Verdict::allow()
        }
    });
    let browser = FakeBrowser {
        wait_error: Some(StepError::Timeout),
        ..FakeBrowser::default()
    };
    let hooked = opened(browser, &interceptor).await;
    // `null` is a success for `()`, but `is_error` is not in the target.
    assert_eq!(hooked.wait_for("#new").await, Err(StepError::Refused));
}

#[tokio::test]
async fn a_redacting_transform_is_what_the_caller_reads_and_no_record_keeps_it() {
    let secret = token_shaped();
    let interceptor = Scripted::new(|c| {
        if at(c, "post_tool_call", Some("read_dom_redacted")) {
            transform("$target.text", json!("[redacted:github_token]"))
        } else {
            Verdict::allow()
        }
    });
    let browser = FakeBrowser {
        dom: Some(format!("<p>{secret}</p>")),
        ..FakeBrowser::default()
    };
    let hooked = opened(browser, &interceptor).await;
    let dom = hooked.read_dom_redacted().await.unwrap();
    assert_eq!(dom.text(), "[redacted:github_token]");
    let records = serde_json::to_string(&wire(&hooked.session().records().await)).unwrap();
    assert!(!records.contains(&secret));
    assert!(
        !records.contains("[redacted:github_token]"),
        "§10.3 drops transform.value"
    );
}

#[tokio::test]
async fn a_frame_can_be_dropped_by_a_transform_but_never_replaced() {
    let drop_it = Scripted::new(|c| {
        if at(c, "post_tool_call", Some("screenshot_redacted")) {
            transform("$target", json!(null))
        } else {
            Verdict::allow()
        }
    });
    let browser = FakeBrowser {
        frame: Some(vec![9; 4]),
        ..FakeBrowser::default()
    };
    let hooked = opened(browser, &drop_it).await;
    assert_eq!(hooked.screenshot_redacted(mask()).await, Ok(None));

    let replace_it = Scripted::new(|c| {
        if at(c, "post_tool_call", Some("screenshot_redacted")) {
            transform("$target.byte_length", json!(1))
        } else {
            Verdict::allow()
        }
    });
    let browser = FakeBrowser {
        frame: Some(vec![9; 4]),
        ..FakeBrowser::default()
    };
    let hooked = opened(browser, &replace_it).await;
    assert_eq!(
        hooked.screenshot_redacted(mask()).await,
        Err(StepError::Refused)
    );
}

#[tokio::test]
async fn a_refused_capture_is_a_step_error_and_a_refused_ledger_read_is_never_complete() {
    let interceptor = Scripted::new(|c| {
        if point(c) == "pre_tool_call" {
            Verdict::deny(Some("acme:no_capture".into()), None)
        } else {
            Verdict::allow()
        }
    });
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    assert_eq!(
        hooked
            .capture_credential(Slot::ClientSecret, "#secret")
            .await,
        Err(CaptureError::Step(StepError::Refused))
    );
    assert_eq!(hooked.outstanding().await, Slot::ALL.to_vec());
    assert!(hooked.inner().calls().is_empty());
}

#[tokio::test]
async fn a_verb_outside_a_turn_is_refused_without_an_emission() {
    let interceptor = Scripted::allow_all();
    let session = hooks_support::session(&interceptor);
    let hooked = HookedTransport::new(FakeBrowser::default(), session);
    assert_eq!(
        hooked.navigate("https://example.com").await,
        Err(StepError::Refused)
    );
    assert!(
        interceptor.seen().is_empty(),
        "§3.1: nothing precedes agent_startup"
    );
    assert!(hooked.inner().calls().is_empty());
    let refusal = hooked.session().last_refusal().await.unwrap();
    assert_eq!(refusal.reason.as_deref(), Some(OUT_OF_ORDER));
}

#[tokio::test]
async fn concurrent_verbs_keep_sequence_strictly_increasing_and_pairs_intact() {
    let interceptor = Scripted::allow_all();
    let hooked = opened(FakeBrowser::default(), &interceptor).await;
    let reference = CredentialRef::new("conn:example");
    let (a, b, c, d) = futures::join!(
        hooked.navigate("https://example.com/1"),
        hooked.wait_for("#a"),
        hooked.fill_credential(&reference, "#b"),
        hooked.submit("#c"),
    );
    assert!(a.is_ok() && b.is_ok() && c.is_ok() && d.is_ok());
    let records = hooked.session().records().await;
    let sequences: Vec<i64> = records.iter().map(|r| r.sequence).collect();
    assert!(sequences.windows(2).all(|w| w[0] < w[1]), "{sequences:?}");
    let seen = interceptor.seen();
    for pre in seen.iter().filter(|c| point(c) == "pre_tool_call") {
        let id = &pre["tool_call"]["id"];
        let posts = seen
            .iter()
            .filter(|c| point(c) == "post_tool_call" && &c["tool_call"]["id"] == id)
            .count();
        assert_eq!(posts, 1, "§3.1.5: one post per pre, same id");
    }
    assert!(records
        .iter()
        .all(|r| r.verdict.decision == Decision::Allow));
}
