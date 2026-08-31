use serde::{Deserialize, Serialize};
use thiserror::Error;

/// The three lanes a run is observed through.
///
/// A live preview is not a screen share. The structured lanes are the record;
/// the picture corroborates it. A pixel stream cannot be cited by a receipt,
/// cannot be diffed against a recipe, and cannot be checked for what it failed
/// to redact — a typed action can.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lane {
    /// What the run did: the step IR the executor actually issued. This lane
    /// is the truth, and the only one a receipt binds.
    Action,
    /// Why the model says it did it. Narration, not authority, and not present
    /// at all on a deterministic (T3) run — a silent thought lane is itself
    /// informative, because it means no model was in the loop.
    Thought,
    /// A masked still of the page. Admitted only through [`admit_frame`].
    Frame,
}

/// Position in the run's append-only observation log.
///
/// One log serves both readers: a live viewer tails it, the replay overlay
/// seeks in it. There is no second pipeline for the live case, which is what
/// keeps the live path from skipping a redaction the recorded path applies.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Seq(pub u64);

/// The layout generation a frame was composited under.
///
/// Screencast frames arrive asynchronously and are coalesced by the browser,
/// so a frame can reach the encoder describing a page that has already moved
/// on. A mask solved for a different generation is not a mask.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayoutEpoch(pub u64);

/// Ciphertext, sealed by the runner to the owner's viewer key.
///
/// There is no constructor taking plaintext and no accessor returning any: the
/// gateway relays these and cannot read them, so the courier property is a
/// shape rather than a promise (ADR 0046 §7).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SealedPayload(Vec<u8>);

impl SealedPayload {
    #[must_use]
    pub const fn from_ciphertext(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub fn ciphertext(&self) -> &[u8] {
        &self.0
    }
}

/// One entry in the observation log.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "lane")]
pub enum ObservationEvent {
    Action {
        seq: Seq,
        payload: SealedPayload,
    },
    /// Bound to the action it precedes, so a viewer reading a rationale can
    /// always find the step it was a rationale *for*.
    Thought {
        seq: Seq,
        of_step: Seq,
        payload: SealedPayload,
    },
    /// Carries the epoch it was admitted under, so drift is auditable after
    /// the fact and not only at capture time.
    Frame {
        seq: Seq,
        epoch: LayoutEpoch,
        payload: SealedPayload,
    },
}

impl ObservationEvent {
    #[must_use]
    pub const fn lane(&self) -> Lane {
        match self {
            Self::Action { .. } => Lane::Action,
            Self::Thought { .. } => Lane::Thought,
            Self::Frame { .. } => Lane::Frame,
        }
    }

    #[must_use]
    pub const fn seq(&self) -> Seq {
        match self {
            Self::Action { seq, .. } | Self::Thought { seq, .. } | Self::Frame { seq, .. } => *seq,
        }
    }
}

/// What the capture pipeline knows about the credential geometry of one layout
/// generation.
///
/// `sensitive` counts the nodes the classifier decided must not be visible,
/// including every node it could not classify — unknown fields fail closed to
/// sensitive (`docs/architecture/rotation-teaching-and-replay.md`). `masked`
/// counts the ones it produced a covering rectangle for. The two are equal or
/// the frame does not ship.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaskManifest {
    epoch: LayoutEpoch,
    sensitive: u32,
    masked: u32,
}

impl MaskManifest {
    #[must_use]
    pub const fn solved(epoch: LayoutEpoch, sensitive: u32, masked: u32) -> Self {
        Self {
            epoch,
            sensitive,
            masked,
        }
    }

    #[must_use]
    pub const fn epoch(self) -> LayoutEpoch {
        self.epoch
    }
}

/// Why a frame was not sent.
///
/// Dropping is the correct outcome, not a degraded one. The visible cost is a
/// preview that stutters while a page churns; the alternative cost is a frame
/// of somebody's password.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FrameDrop {
    /// No mask was solved for this page at all.
    #[error("no mask solved for the captured layout")]
    NoMask,
    /// The mask describes a different layout generation than the frame.
    #[error("mask is stale for the captured layout")]
    StaleMask,
    /// The classifier found sensitive nodes the solver could not cover.
    #[error("mask does not cover every sensitive node")]
    IncompleteMask,
}

/// The gate every frame passes before it is encoded.
///
/// # Errors
///
/// [`FrameDrop`] when the frame cannot be proven masked. There is deliberately
/// no fallback that encodes the frame anyway with a warning attached.
pub fn admit_frame(frame: LayoutEpoch, mask: Option<MaskManifest>) -> Result<(), FrameDrop> {
    let Some(mask) = mask else {
        return Err(FrameDrop::NoMask);
    };
    if mask.epoch != frame {
        return Err(FrameDrop::StaleMask);
    }
    if mask.masked < mask.sensitive {
        return Err(FrameDrop::IncompleteMask);
    }
    Ok(())
}

/// The longest thought text a viewer will be shown.
pub const MAX_THOUGHT_CHARS: usize = 2_000;

/// Model-authored text, held in a type that will not render itself.
///
/// The thought lane is downstream of a redacted DOM read, so a hostile page can
/// place text into it and have that text appear inside `OpenSesame`'s own chrome.
/// Two things follow, and this type carries the second:
///
/// - a thought never authorizes anything; approvals cite the action lane and
///   the ADR 0046 §8 binding message;
/// - the text is neutered at capture — bidirectional overrides and control
///   characters are stripped, so what a reviewer sees is what is there.
///
/// There is no `Display` and no `Deref`. Rendering untrusted text is a
/// decision, and a caller has to make it by name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UntrustedText {
    text: String,
    truncated: bool,
}

impl UntrustedText {
    /// Take in model output and make it safe to put on a screen.
    #[must_use]
    pub fn capture(raw: &str) -> Self {
        let mut text = String::with_capacity(raw.len());
        let mut chars = 0usize;
        let mut truncated = false;
        for ch in raw.chars() {
            if is_display_hazard(ch) {
                continue;
            }
            if chars == MAX_THOUGHT_CHARS {
                truncated = true;
                break;
            }
            text.push(ch);
            chars += 1;
        }
        Self { text, truncated }
    }

    /// The text, named so a reader of the calling code can see what it is.
    #[must_use]
    pub fn as_untrusted_str(&self) -> &str {
        &self.text
    }

    #[must_use]
    pub const fn was_truncated(&self) -> bool {
        self.truncated
    }
}

/// Characters that let displayed text differ from actual text, plus the C0/C1
/// controls that let it escape a terminal or a log line. Newline and tab
/// survive because a rationale is prose.
fn is_display_hazard(ch: char) -> bool {
    matches!(
        ch,
        '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
    ) || (ch.is_control() && ch != '\n' && ch != '\t')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_ships_only_when_its_mask_matches_its_layout() {
        let epoch = LayoutEpoch(7);
        assert_eq!(
            admit_frame(epoch, Some(MaskManifest::solved(epoch, 2, 2))),
            Ok(())
        );
        assert_eq!(admit_frame(epoch, None), Err(FrameDrop::NoMask));
        assert_eq!(
            admit_frame(epoch, Some(MaskManifest::solved(LayoutEpoch(6), 2, 2))),
            Err(FrameDrop::StaleMask)
        );
        assert_eq!(
            admit_frame(epoch, Some(MaskManifest::solved(epoch, 2, 1))),
            Err(FrameDrop::IncompleteMask)
        );
    }

    #[test]
    fn a_page_with_nothing_sensitive_still_needs_a_solved_mask() {
        // "No password fields here" is a claim about a layout, and the claim is
        // what a solved manifest records. Absence of a manifest means nobody
        // looked.
        let epoch = LayoutEpoch(1);
        assert_eq!(
            admit_frame(epoch, Some(MaskManifest::solved(epoch, 0, 0))),
            Ok(())
        );
        assert_eq!(admit_frame(epoch, None), Err(FrameDrop::NoMask));
    }

    #[test]
    fn an_event_reports_its_own_lane_and_position() {
        let payload = SealedPayload::from_ciphertext(vec![1, 2, 3]);
        let action = ObservationEvent::Action {
            seq: Seq(4),
            payload: payload.clone(),
        };
        let thought = ObservationEvent::Thought {
            seq: Seq(5),
            of_step: Seq(4),
            payload: payload.clone(),
        };
        let frame = ObservationEvent::Frame {
            seq: Seq(6),
            epoch: LayoutEpoch(2),
            payload,
        };
        assert_eq!(action.lane(), Lane::Action);
        assert_eq!(thought.lane(), Lane::Thought);
        assert_eq!(frame.lane(), Lane::Frame);
        assert_eq!(frame.seq(), Seq(6));
        assert!(action.seq() < thought.seq());
    }

    #[test]
    fn bidi_overrides_and_controls_are_stripped_from_model_text() {
        let hostile = "Session expired\u{202e}\u{0007}: re-enter your master password\u{2066}";
        let captured = UntrustedText::capture(hostile);
        assert_eq!(
            captured.as_untrusted_str(),
            "Session expired: re-enter your master password"
        );
        assert!(!captured.was_truncated());
    }

    #[test]
    fn prose_whitespace_survives_capture() {
        let captured = UntrustedText::capture("line one\n\tline two");
        assert_eq!(captured.as_untrusted_str(), "line one\n\tline two");
    }

    #[test]
    fn thoughts_are_capped_and_say_so() {
        let long = "a".repeat(MAX_THOUGHT_CHARS + 500);
        let captured = UntrustedText::capture(&long);
        assert_eq!(
            captured.as_untrusted_str().chars().count(),
            MAX_THOUGHT_CHARS
        );
        assert!(captured.was_truncated());

        let exact = "b".repeat(MAX_THOUGHT_CHARS);
        assert!(!UntrustedText::capture(&exact).was_truncated());
    }

    #[test]
    fn stripped_characters_do_not_consume_the_cap() {
        let padded = format!("{}{}", "\u{202e}".repeat(100), "c".repeat(10));
        let captured = UntrustedText::capture(&padded);
        assert_eq!(captured.as_untrusted_str(), "c".repeat(10));
    }
}
