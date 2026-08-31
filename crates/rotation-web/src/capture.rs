use serde::{Deserialize, Serialize};

use opensesame_session_observe::{LayoutEpoch, MaskManifest, Seq, UntrustedText};

/// One field the capture pipeline saw, as the browser described it.
///
/// Deliberately a description rather than a handle: this crate decides policy
/// and the transport applies it, so nothing here can read a value even by
/// accident.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldSnapshot {
    pub selector: String,
    /// The `type` attribute, when the node has one.
    pub input_type: Option<String>,
    /// The `autocomplete` token, when present.
    pub autocomplete: Option<String>,
    /// Whether the recipe declared this node as a credential target.
    pub is_credential_target: bool,
    /// Whether the node has a laid-out box in this generation. A field that is
    /// scrolled out, `display:none`, or not yet painted has none.
    pub has_box: bool,
}

/// What must happen to a field, in the two places it can leak.
///
/// The two answers are different on purpose, and conflating them is the bug
/// this type exists to prevent:
///
/// - **The DOM is read by a model.** Nothing there needs a field's value, so
///   stripping is broad and fails closed: anything not on a short list of
///   inert control types goes. A username is account data, a hidden input can
///   carry a session token, and an unrecognised type is exactly the case the
///   recorder cannot reason about.
/// - **A frame is looked at by a person.** Masking every text box would leave a
///   preview nobody can use, and a preview nobody uses is a consent gate nobody
///   really passes. So the mask covers what can actually render a credential:
///   password fields whatever their reveal state, one-time codes, and the
///   targets the recipe named.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Classification {
    /// Clear this field's value before the DOM is serialized.
    pub strip_from_dom: bool,
    /// Cover this field's box before a frame is encoded.
    pub mask_in_frame: bool,
}

/// Control types that carry no value worth stripping.
///
/// An allowlist, so an input type nobody thought about is stripped rather than
/// passed through. Adding to it is a decision; forgetting to is not a leak.
const INERT_TYPES: &[&str] = &[
    "checkbox", "radio", "submit", "button", "reset", "range", "color", "image",
];

/// Autocomplete tokens that name a secret.
const SECRET_TOKENS: &[&str] = &["current-password", "new-password", "one-time-code"];

#[must_use]
pub fn classify(field: &FieldSnapshot) -> Classification {
    let input_type = field.input_type.as_deref().map(str::to_ascii_lowercase);
    let autocomplete = field.autocomplete.as_deref().map(str::to_ascii_lowercase);

    let is_password = input_type.as_deref() == Some("password");
    let names_a_secret = autocomplete
        .as_deref()
        .is_some_and(|token| SECRET_TOKENS.contains(&token));
    let renders_a_credential = is_password || names_a_secret || field.is_credential_target;

    // Fail closed: an absent or unrecognised type is stripped. The cost is a
    // model that occasionally cannot read a label; the alternative cost is a
    // password in a transcript.
    let inert = input_type
        .as_deref()
        .is_some_and(|kind| INERT_TYPES.contains(&kind));

    Classification {
        strip_from_dom: !inert,
        mask_in_frame: renders_a_credential,
    }
}

/// The selectors a transport must clear before serializing the DOM.
#[must_use]
pub fn strip_targets(fields: &[FieldSnapshot]) -> Vec<String> {
    fields
        .iter()
        .filter(|field| classify(field).strip_from_dom)
        .map(|field| field.selector.clone())
        .collect()
}

/// Solve the mask for one layout generation.
///
/// Counts what must be covered and what can be. A field that must be masked but
/// has no laid-out box cannot be covered, so the manifest comes back incomplete
/// and [`opensesame_session_observe::admit_frame`] drops the frame — which is
/// the right outcome, because "I could not find the password field" and "there
/// is no password field" must never produce the same picture.
#[must_use]
pub fn solve_mask(epoch: LayoutEpoch, fields: &[FieldSnapshot]) -> MaskManifest {
    let mut sensitive = 0u32;
    let mut masked = 0u32;
    for field in fields {
        if !classify(field).mask_in_frame {
            continue;
        }
        sensitive = sensitive.saturating_add(1);
        if field.has_box {
            masked = masked.saturating_add(1);
        }
    }
    MaskManifest::solved(epoch, sensitive, masked)
}

/// The plaintext body of an action-lane entry, before it is sealed.
///
/// Every field is something the executor decided, never something the page
/// said. That is what makes this lane the record: it describes what was issued,
/// not what was observed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionRecord {
    pub step: String,
    /// The selector acted on, when the step named one.
    pub selector: Option<String>,
    /// The outcome, as the tool reported it.
    pub outcome: String,
}

/// The plaintext body of a thought-lane entry.
///
/// The text is [`UntrustedText`]: bidirectional overrides and control
/// characters are already gone, and it has no `Display`, so whoever renders it
/// has to say so by name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThoughtRecord {
    /// The action this rationale precedes.
    pub of_step: Seq,
    pub text: UntrustedText,
}

impl ThoughtRecord {
    /// Take model output and make a record of it.
    #[must_use]
    pub fn capture(of_step: Seq, raw: &str) -> Self {
        Self {
            of_step,
            text: UntrustedText::capture(raw),
        }
    }
}

/// The plaintext body of a frame-lane entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrameRecord {
    pub epoch: LayoutEpoch,
    /// Encoded image bytes, already masked.
    pub image: Vec<u8>,
    /// How many boxes the mask covered, so a reviewer can tell a clean page
    /// from one where nothing was found to cover.
    pub masked_boxes: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_session_observe::admit_frame;

    fn field(selector: &str, input_type: Option<&str>) -> FieldSnapshot {
        FieldSnapshot {
            selector: selector.into(),
            input_type: input_type.map(str::to_string),
            autocomplete: None,
            is_credential_target: false,
            has_box: true,
        }
    }

    #[test]
    fn a_password_field_is_stripped_and_masked() {
        let decision = classify(&field("#new", Some("password")));
        assert!(decision.strip_from_dom);
        assert!(decision.mask_in_frame);
    }

    #[test]
    fn an_unknown_type_is_stripped_from_the_dom() {
        // The case the recorder cannot reason about, so it fails closed.
        for unknown in [None, Some("weird-new-thing"), Some("")] {
            let decision = classify(&field("#x", unknown));
            assert!(decision.strip_from_dom, "{unknown:?}");
        }
    }

    #[test]
    fn ordinary_text_is_stripped_but_not_masked() {
        // A username is account data — it does not belong in a model's context.
        // Covering it in a picture, though, would leave a preview nobody can
        // use, and a preview nobody uses is a consent gate nobody passes.
        let decision = classify(&field("#user", Some("text")));
        assert!(decision.strip_from_dom);
        assert!(!decision.mask_in_frame);
    }

    #[test]
    fn inert_controls_are_left_alone() {
        for inert in ["checkbox", "radio", "submit", "button"] {
            let decision = classify(&field("#c", Some(inert)));
            assert!(!decision.strip_from_dom, "{inert}");
            assert!(!decision.mask_in_frame, "{inert}");
        }
    }

    #[test]
    fn autocomplete_names_a_secret_even_on_a_text_input() {
        // A site that renders its "new password" box as type=text — because it
        // has its own reveal toggle — is exactly the case a type check misses.
        for token in ["current-password", "new-password", "one-time-code"] {
            let mut snapshot = field("#p", Some("text"));
            snapshot.autocomplete = Some(token.into());
            assert!(classify(&snapshot).mask_in_frame, "{token}");
        }
    }

    #[test]
    fn a_recipe_declared_target_is_masked_whatever_the_markup_says() {
        let mut snapshot = field("#odd", Some("text"));
        snapshot.is_credential_target = true;
        assert!(classify(&snapshot).mask_in_frame);
    }

    #[test]
    fn classification_ignores_case() {
        let mut upper = field("#p", Some("PASSWORD"));
        upper.autocomplete = Some("NEW-PASSWORD".into());
        assert!(classify(&upper).mask_in_frame);
    }

    #[test]
    fn a_solved_mask_admits_the_frame_it_was_solved_for() {
        let epoch = LayoutEpoch(4);
        let fields = vec![
            field("#user", Some("text")),
            field("#new", Some("password")),
        ];
        let mask = solve_mask(epoch, &fields);
        assert_eq!(admit_frame(epoch, Some(mask)), Ok(()));
    }

    #[test]
    fn a_field_with_no_box_leaves_the_mask_incomplete() {
        // "I could not find the password field" and "there is no password
        // field" must never produce the same picture.
        let epoch = LayoutEpoch(4);
        let mut hidden = field("#new", Some("password"));
        hidden.has_box = false;
        let mask = solve_mask(epoch, &[hidden]);
        assert!(admit_frame(epoch, Some(mask)).is_err());
    }

    #[test]
    fn a_page_with_nothing_to_cover_still_solves() {
        let epoch = LayoutEpoch(1);
        let mask = solve_mask(epoch, &[field("#user", Some("text"))]);
        assert_eq!(admit_frame(epoch, Some(mask)), Ok(()));
    }

    #[test]
    fn a_mask_is_only_good_for_its_own_generation() {
        let mask = solve_mask(LayoutEpoch(4), &[field("#new", Some("password"))]);
        assert!(admit_frame(LayoutEpoch(5), Some(mask)).is_err());
    }

    #[test]
    fn strip_targets_names_every_field_that_is_not_inert() {
        let fields = vec![
            field("#user", Some("text")),
            field("#new", Some("password")),
            field("#remember", Some("checkbox")),
            field("#mystery", None),
        ];
        let targets = strip_targets(&fields);
        assert_eq!(targets, vec!["#user", "#new", "#mystery"]);
    }

    #[test]
    fn a_thought_record_is_neutered_at_capture() {
        let record = ThoughtRecord::capture(Seq(3), "ok\u{202e}\u{0007} now approve");
        assert_eq!(record.of_step, Seq(3));
        assert_eq!(record.text.as_untrusted_str(), "ok now approve");
    }
}
