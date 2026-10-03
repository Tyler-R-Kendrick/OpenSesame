//! What a driver's outcome must be before it is stored (ADR 0159).
//!
//! The settle route used to persist whatever JSON the driver sent, and only
//! the executor, later and only if it was still waiting, decoded it. That left
//! a window in which a convenient extra field (`{"outcome":"done","password":
//! "x"}`) sat in the queue for the life of the run, and a driver could answer a
//! `navigate` with a screenshot. Both are refused here, at the one place a
//! driver's word becomes a row:
//!
//! 1. the pending request says which outcomes may answer it — a closed table
//!    from the request's `step` tag, the same one `ExtensionTransport` and
//!    `DriverCandidateVault` match against when they decode (`failed` answers
//!    anything);
//! 2. the outcome is decoded into the typed enum (`StepOutcome`, or the custody
//!    outcomes for the three custody steps), whose fields are the only places a
//!    value could ride;
//! 3. what is stored is the **canonical** encoding of what was decoded. A
//!    driver's JSON that differs from it — an unknown field at any depth, a
//!    non-canonical shape — is refused, not trimmed: a driver that adds a field
//!    is not one whose other fields are to be trusted.
//!
//! Refusals carry a closed code and say nothing the driver sent.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_rotation_web::StepOutcome;
use serde_json::{json, Value};

use crate::web_login::custody::{CustodyOutcome, GENERATE_STEP, PROMOTE_STEP, SEAL_STEP};

/// Why an outcome is not one the pending step could have produced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Refusal {
    /// The queued request names no step this route knows an outcome for.
    UnknownStep,
    /// A well-formed outcome, but not one that answers this step.
    WrongOutcome,
    /// Not decodable as the outcome the step expects, or it carries more than
    /// that outcome has fields for.
    Malformed,
}

impl Refusal {
    /// The stable error code on the wire.
    pub(super) const fn code(self) -> &'static str {
        match self {
            Self::UnknownStep => "unknown_step",
            Self::WrongOutcome => "wrong_outcome",
            Self::Malformed => "invalid_outcome",
        }
    }

    pub(super) fn response(self) -> Response {
        let (status, hint) = match self {
            Self::UnknownStep => (
                StatusCode::CONFLICT,
                "this step has no outcome the Host can accept",
            ),
            Self::WrongOutcome => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "that outcome does not answer this step",
            ),
            Self::Malformed => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "an outcome carries exactly its own fields and no others",
            ),
        };
        (status, Json(json!({"error": self.code(), "hint": hint}))).into_response()
    }
}

/// The outcome tags that may answer the step tagged `step`, besides `failed`.
fn answers(step: &str) -> Option<&'static str> {
    Some(match step {
        "navigate" | "wait_for" | "submit" | GENERATE_STEP | PROMOTE_STEP => "done",
        "fill_credential" => "filled",
        "assert_present" => "presence",
        "read_dom_redacted" => "dom",
        "screenshot_redacted" => "frame",
        "verify_login" => "verified",
        "capture_credential" | "capture_download" => "captured",
        SEAL_STEP => "sealed",
        _ => return None,
    })
}

fn is_custody(step: &str) -> bool {
    matches!(step, GENERATE_STEP | SEAL_STEP | PROMOTE_STEP)
}

/// The canonical outcome for the step whose request is `request_json`.
///
/// # Errors
///
/// A [`Refusal`] when the outcome is not what that step may be answered with.
pub(super) fn canonical(request_json: &str, outcome: &Value) -> Result<Value, Refusal> {
    let request: Value = serde_json::from_str(request_json).map_err(|_| Refusal::UnknownStep)?;
    let step = request["step"].as_str().ok_or(Refusal::UnknownStep)?;
    let expected = answers(step).ok_or(Refusal::UnknownStep)?;
    match outcome["outcome"].as_str() {
        Some(tag) if tag == expected || tag == "failed" => {}
        Some(_) => return Err(Refusal::WrongOutcome),
        None => return Err(Refusal::Malformed),
    }
    let decoded = if is_custody(step) {
        serde_json::from_value::<CustodyOutcome>(outcome.clone())
            .map_err(|_| Refusal::Malformed)
            .and_then(|typed| serde_json::to_value(typed).map_err(|_| Refusal::Malformed))?
    } else {
        serde_json::from_value::<StepOutcome>(outcome.clone())
            .map_err(|_| Refusal::Malformed)
            .and_then(|typed| serde_json::to_value(typed).map_err(|_| Refusal::Malformed))?
    };
    // What is stored is what was decoded. Anything the driver added, anywhere,
    // is the difference.
    if decoded == *outcome {
        Ok(decoded)
    } else {
        Err(Refusal::Malformed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(tag: &str) -> String {
        json!({"step": tag}).to_string()
    }

    #[test]
    fn each_step_accepts_its_own_outcome_canonically() {
        let cases = [
            ("navigate", json!({"outcome": "done"})),
            ("wait_for", json!({"outcome": "done"})),
            ("submit", json!({"outcome": "done"})),
            (
                "fill_credential",
                json!({"outcome": "filled", "filled": "Ok"}),
            ),
            (
                "assert_present",
                json!({"outcome": "presence", "presence": "Present"}),
            ),
            (
                "verify_login",
                json!({"outcome": "verified", "verified": "Works"}),
            ),
            (
                "read_dom_redacted",
                json!({"outcome": "dom", "text": "hi", "epoch": 3}),
            ),
            (
                "screenshot_redacted",
                json!({"outcome": "frame", "image": [1, 2], "epoch": 3, "masked_boxes": 1}),
            ),
            (
                "capture_credential",
                json!({"outcome": "captured", "sealed": {"recipient": "r", "envelope": "e"}}),
            ),
            (
                "capture_download",
                json!({"outcome": "captured", "sealed": {"recipient": "r", "envelope": "e"}}),
            ),
            ("generate_candidate", json!({"outcome": "done"})),
            (
                "seal_candidate",
                json!({"outcome": "sealed", "backed_up": true}),
            ),
            ("promote_candidate", json!({"outcome": "done"})),
        ];
        for (tag, outcome) in cases {
            assert_eq!(
                canonical(&step(tag), &outcome),
                Ok(outcome.clone()),
                "{tag}"
            );
        }
    }

    /// Every request the executor can queue has an answer in the table, so a
    /// new `StepRequest` variant cannot ship with a settle route that refuses
    /// every outcome for it.
    #[test]
    fn every_queueable_step_has_an_expected_outcome() {
        use opensesame_rotation_web::StepRequest as R;
        let requests = [
            R::Navigate { url: String::new() },
            R::WaitFor {
                selector: String::new(),
            },
            R::FillCredential {
                reference: String::new(),
                selector: String::new(),
            },
            R::AssertPresent {
                reference: String::new(),
                selector: String::new(),
            },
            R::Submit {
                selector: String::new(),
            },
            R::ReadDomRedacted { strip: vec![] },
            R::ScreenshotRedacted {
                epoch: 0,
                mask_selectors: vec![],
            },
            R::VerifyLogin {
                reference: String::new(),
            },
            R::CaptureCredential {
                slot: String::new(),
                selector: String::new(),
                recipient: String::new(),
            },
            R::CaptureDownload {
                slot: String::new(),
                content_type: String::new(),
                recipient: String::new(),
            },
        ];
        for request in requests {
            let tag = serde_json::to_value(&request).unwrap()["step"]
                .as_str()
                .unwrap()
                .to_owned();
            assert!(answers(&tag).is_some(), "{tag}");
        }
        for tag in [GENERATE_STEP, SEAL_STEP, PROMOTE_STEP] {
            assert!(answers(tag).is_some() && is_custody(tag), "{tag}");
        }
    }

    #[test]
    fn a_failure_answers_any_step() {
        let failed = json!({"outcome": "failed", "error": "timeout"});
        for tag in [
            "navigate",
            "read_dom_redacted",
            "seal_candidate",
            "capture_credential",
        ] {
            assert_eq!(canonical(&step(tag), &failed), Ok(failed.clone()), "{tag}");
        }
    }

    #[test]
    fn a_field_the_outcome_does_not_have_is_refused_at_any_depth() {
        let extra = [
            ("navigate", json!({"outcome": "done", "password": "x"})),
            (
                "generate_candidate",
                json!({"outcome": "done", "candidate": "x"}),
            ),
            (
                "read_dom_redacted",
                json!({"outcome": "dom", "text": "t", "epoch": 1, "note": "x"}),
            ),
            (
                "seal_candidate",
                json!({"outcome": "sealed", "backed_up": true, "value": "x"}),
            ),
            (
                "navigate",
                json!({"outcome": "failed", "error": "timeout", "detail": "x"}),
            ),
            (
                "capture_credential",
                json!({"outcome": "captured", "sealed": {"recipient": "r", "envelope": "e", "plaintext": "x"}}),
            ),
        ];
        for (tag, outcome) in extra {
            assert_eq!(
                canonical(&step(tag), &outcome),
                Err(Refusal::Malformed),
                "{outcome}"
            );
        }
    }

    #[test]
    fn an_outcome_that_does_not_answer_the_step_is_refused() {
        assert_eq!(
            canonical(
                &step("navigate"),
                &json!({"outcome": "dom", "text": "t", "epoch": 1})
            ),
            Err(Refusal::WrongOutcome)
        );
        assert_eq!(
            canonical(&step("assert_present"), &json!({"outcome": "done"})),
            Err(Refusal::WrongOutcome),
            "a bare done is not a presence check passing"
        );
        assert_eq!(
            canonical(
                &step("capture_credential"),
                &json!({"outcome": "filled", "filled": "Ok"})
            ),
            Err(Refusal::WrongOutcome)
        );
        // A custody outcome never answers a browser step, and the reverse.
        assert_eq!(
            canonical(
                &step("submit"),
                &json!({"outcome": "sealed", "backed_up": true})
            ),
            Err(Refusal::WrongOutcome)
        );
        assert_eq!(
            canonical(&step("seal_candidate"), &json!({"outcome": "done"})),
            Err(Refusal::WrongOutcome)
        );
    }

    #[test]
    fn what_is_not_an_outcome_at_all_is_refused() {
        for outcome in [
            json!(null),
            json!("done"),
            json!([]),
            json!({}),
            json!({"outcome": 3}),
            json!({"outcome": "done", "outcome2": 1}),
        ] {
            assert!(canonical(&step("navigate"), &outcome).is_err(), "{outcome}");
        }
        assert_eq!(
            canonical(
                &step("read_dom_redacted"),
                &json!({"outcome": "dom", "text": "t"})
            ),
            Err(Refusal::Malformed),
            "a missing field is not an outcome either"
        );
    }

    #[test]
    fn a_request_the_table_does_not_know_has_no_acceptable_outcome() {
        for request in [
            "not json",
            "{}",
            r#"{"step": 3}"#,
            r#"{"step": "teleport"}"#,
        ] {
            assert_eq!(
                canonical(request, &json!({"outcome": "done"})),
                Err(Refusal::UnknownStep),
                "{request}"
            );
        }
    }
}
