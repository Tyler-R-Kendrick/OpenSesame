//! The expiry ladder, on two independent tracks.
//!
//! Every stage is a **seconds-remaining threshold**: it fires when the
//! subject's remaining lifetime falls at or below it, and a monotonic
//! watermark — the smallest threshold already fired — makes firing idempotent
//! across passes and restarts.
//!
//! The rungs sit on two tracks, and that split is load-bearing rather than
//! cosmetic. [`ExpiryStage::Renewal`]'s threshold is per-subject
//! (`renew_before_seconds`) and can land on any value, including exactly the
//! 7-day [`ExpiryStage::Warning`] rung — which is the default renewal lead. On
//! a single shared watermark that collision does not merely reorder the two,
//! it makes `Warning` **permanently unreachable**: the rungs are crossed in
//! the same pass forever after, so the one that loses the tie never fires at
//! all, and a subscriber filtering on `lifecycle.expiry.warning` silently
//! receives nothing.
//!
//! So the informational escalation ([`Track::Alert`]: notice → warning →
//! urgent → expired, fixed thresholds, never aliased) and the actionable
//! renewal window ([`Track::Renewal`]) advance on separate watermarks. Each
//! track is independently monotonic; a pass emits at most one event per track.

use serde::{Deserialize, Serialize};

/// Seconds remaining at which [`ExpiryStage::Notice`] fires (30 days).
pub const NOTICE_SECONDS: i64 = 30 * 86_400;
/// Seconds remaining at which [`ExpiryStage::Warning`] fires (7 days).
pub const WARNING_SECONDS: i64 = 7 * 86_400;
/// Seconds remaining at which [`ExpiryStage::Urgent`] fires (24 hours).
pub const URGENT_SECONDS: i64 = 86_400;
/// Fallback renewal lead time when a subject declares none (7 days).
pub const DEFAULT_RENEW_BEFORE_SECONDS: i64 = 7 * 86_400;

/// Watermark value meaning "no stage has fired on this track yet".
///
/// The watermark holds the smallest threshold already fired, so "nothing yet"
/// must compare greater than every real threshold.
pub const WATERMARK_UNFIRED: i64 = i64::MAX;

/// Which watermark a stage advances.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Track {
    /// Informational escalation on fixed thresholds.
    Alert,
    /// The actionable renewal window, on the subject's own lead time.
    Renewal,
}

impl Track {
    pub const ALL: [Self; 2] = [Self::Alert, Self::Renewal];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Alert => "alert",
            Self::Renewal => "renewal",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|track| track.as_str() == raw)
    }
}

/// One rung of the expiry ladder.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ExpiryStage {
    /// Far-out heads-up: the thing expires within 30 days.
    Notice,
    /// The thing expires within 7 days.
    Warning,
    /// The thing expires within 24 hours.
    Urgent,
    /// The thing has expired. Emitted once; the platform never silently
    /// pretends an expiry did not happen.
    Expired,
    /// The renewal window opened — reissue now. This is the rung `OpenSesame`'s
    /// own rotation and certificate responders act on.
    Renewal,
}

impl ExpiryStage {
    /// Every stage, for exhaustive iteration in tests and ladder construction.
    pub const ALL: [Self; 5] = [
        Self::Notice,
        Self::Warning,
        Self::Urgent,
        Self::Expired,
        Self::Renewal,
    ];

    /// Frozen wire name. Changing one of these is a breaking change for every
    /// registered hook, so they are pinned by a unit test here and by
    /// [`crate::event`]'s type strings.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Notice => "notice",
            Self::Warning => "warning",
            Self::Urgent => "urgent",
            Self::Expired => "expired",
            Self::Renewal => "renewal",
        }
    }

    /// Parse a persisted stage name. Unknown names are refused rather than
    /// defaulted — a watermark row we cannot interpret must not silently
    /// re-fire the whole ladder.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|stage| stage.as_str() == raw)
    }

    /// Which watermark this rung advances.
    #[must_use]
    pub const fn track(self) -> Track {
        match self {
            Self::Notice | Self::Warning | Self::Urgent | Self::Expired => Track::Alert,
            Self::Renewal => Track::Renewal,
        }
    }

    /// Seconds-remaining threshold for this stage on a subject whose renewal
    /// lead time is `renew_before_seconds`.
    #[must_use]
    pub const fn threshold_seconds(self, renew_before_seconds: i64) -> i64 {
        match self {
            Self::Notice => NOTICE_SECONDS,
            Self::Warning => WARNING_SECONDS,
            Self::Urgent => URGENT_SECONDS,
            Self::Expired => 0,
            Self::Renewal => renew_before_seconds,
        }
    }

    /// Whether this stage means "act now" rather than "be aware".
    ///
    /// Responders key off this instead of matching stage names, so adding a
    /// rung cannot accidentally start or stop triggering renewals.
    #[must_use]
    pub const fn is_actionable(self) -> bool {
        matches!(self, Self::Renewal | Self::Expired)
    }
}

/// One track's rungs, ordered from earliest-firing to latest.
#[must_use]
pub fn ladder(track: Track, renew_before_seconds: i64) -> Vec<ExpiryStage> {
    let mut rungs: Vec<ExpiryStage> = ExpiryStage::ALL
        .into_iter()
        .filter(|stage| stage.track() == track)
        .collect();
    rungs.sort_by_key(|stage| {
        (
            std::cmp::Reverse(stage.threshold_seconds(renew_before_seconds)),
            *stage,
        )
    });
    rungs
}

/// The most urgent stage on `track` newly crossed at `remaining_seconds`,
/// given that every threshold at or below `watermark` has already fired.
///
/// Returns `None` when nothing new has been crossed. At most one stage is
/// returned: when a pass skips rungs (a long outage, a freshly discovered
/// subject already past several thresholds), the *most* urgent crossed rung
/// fires, because the ones it skipped are strictly less informative than it
/// is. Because the tracks never share a watermark, this superseding can only
/// ever drop an alert in favour of a louder alert — it can never drop the
/// renewal window.
#[must_use]
pub fn newly_crossed(
    track: Track,
    remaining_seconds: i64,
    renew_before_seconds: i64,
    watermark: i64,
) -> Option<ExpiryStage> {
    ladder(track, renew_before_seconds)
        .into_iter()
        .filter(|stage| {
            let threshold = stage.threshold_seconds(renew_before_seconds);
            remaining_seconds <= threshold && threshold < watermark
        })
        .next_back()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every reading a rung could be observed at, for exhaustive walks.
    fn walk(renew: i64, track: Track) -> Vec<ExpiryStage> {
        let mut watermark = WATERMARK_UNFIRED;
        let mut fired = Vec::new();
        for hour in (-24..=(40 * 24)).rev() {
            let remaining = i64::from(hour) * 3_600;
            if let Some(stage) = newly_crossed(track, remaining, renew, watermark) {
                fired.push(stage);
                watermark = stage.threshold_seconds(renew);
            }
        }
        fired
    }

    #[test]
    fn stage_names_are_frozen() {
        assert_eq!(
            ExpiryStage::ALL.map(ExpiryStage::as_str),
            ["notice", "warning", "urgent", "expired", "renewal"],
        );
        assert_eq!(Track::ALL.map(Track::as_str), ["alert", "renewal"]);
    }

    #[test]
    fn every_name_round_trips_and_unknown_is_refused() {
        for stage in ExpiryStage::ALL {
            assert_eq!(ExpiryStage::parse(stage.as_str()), Some(stage));
        }
        for track in Track::ALL {
            assert_eq!(Track::parse(track.as_str()), Some(track));
        }
        assert_eq!(ExpiryStage::parse("catastrophe"), None);
        assert_eq!(Track::parse("catastrophe"), None);
    }

    #[test]
    fn each_track_is_ordered_by_remaining_time() {
        for track in Track::ALL {
            let thresholds: Vec<i64> = ladder(track, DEFAULT_RENEW_BEFORE_SECONDS)
                .iter()
                .map(|stage| stage.threshold_seconds(DEFAULT_RENEW_BEFORE_SECONDS))
                .collect();
            assert!(
                thresholds.windows(2).all(|pair| pair[0] >= pair[1]),
                "{track:?} ladder must be non-increasing: {thresholds:?}",
            );
        }
    }

    #[test]
    fn the_alert_ladder_never_contains_the_renewal_rung() {
        for renew in [1, 3_600, WARNING_SECONDS, 45 * 86_400] {
            assert!(!ladder(Track::Alert, renew).contains(&ExpiryStage::Renewal));
            assert_eq!(ladder(Track::Renewal, renew), vec![ExpiryStage::Renewal]);
        }
    }

    #[test]
    fn the_alert_ladder_is_identical_at_every_renewal_lead() {
        // The regression this split exists for: the alert rungs must not move
        // or vanish because a subject configured a particular renewal lead.
        let baseline = ladder(Track::Alert, DEFAULT_RENEW_BEFORE_SECONDS);
        for renew in [1, 60, URGENT_SECONDS, WARNING_SECONDS, NOTICE_SECONDS, 400 * 86_400] {
            assert_eq!(ladder(Track::Alert, renew), baseline, "renew={renew}");
        }
    }

    #[test]
    fn a_renewal_lead_that_aliases_a_warning_still_fires_both() {
        // renew_before == WARNING_SECONDS is the *default*, and the shared
        // watermark this split replaced lost the warning rung entirely here.
        let renew = WARNING_SECONDS;
        assert_eq!(
            walk(renew, Track::Alert),
            vec![
                ExpiryStage::Notice,
                ExpiryStage::Warning,
                ExpiryStage::Urgent,
                ExpiryStage::Expired,
            ],
        );
        assert_eq!(walk(renew, Track::Renewal), vec![ExpiryStage::Renewal]);
    }

    #[test]
    fn every_rung_fires_exactly_once_at_any_renewal_lead() {
        for renew in [1, 3_600, URGENT_SECONDS, WARNING_SECONDS, NOTICE_SECONDS, 45 * 86_400] {
            let mut fired: Vec<ExpiryStage> = Track::ALL
                .into_iter()
                .flat_map(|track| walk(renew, track))
                .collect();
            let before = fired.len();
            fired.sort_unstable();
            fired.dedup();
            assert_eq!(before, fired.len(), "a rung fired twice at renew={renew}");
            assert_eq!(
                fired.len(),
                ExpiryStage::ALL.len(),
                "a rung never fired at renew={renew}: {fired:?}",
            );
        }
    }

    #[test]
    fn a_skipped_pass_fires_only_the_most_urgent_crossed_alert() {
        // Discovered for the first time already expired: one alert, not four.
        assert_eq!(
            newly_crossed(Track::Alert, -10, DEFAULT_RENEW_BEFORE_SECONDS, WATERMARK_UNFIRED),
            Some(ExpiryStage::Expired),
        );
        // …and the renewal window is still reported, on its own track.
        assert_eq!(
            newly_crossed(Track::Renewal, -10, DEFAULT_RENEW_BEFORE_SECONDS, WATERMARK_UNFIRED),
            Some(ExpiryStage::Renewal),
        );
    }

    #[test]
    fn nothing_fires_twice_at_the_same_watermark() {
        let renew = DEFAULT_RENEW_BEFORE_SECONDS;
        for track in Track::ALL {
            let first = newly_crossed(track, 0, renew, WATERMARK_UNFIRED).unwrap();
            let watermark = first.threshold_seconds(renew);
            assert_eq!(newly_crossed(track, 0, renew, watermark), None);
            assert_eq!(newly_crossed(track, -86_400, renew, watermark), None);
        }
    }

    #[test]
    fn a_far_future_subject_fires_nothing() {
        for track in Track::ALL {
            assert_eq!(
                newly_crossed(track, 400 * 86_400, DEFAULT_RENEW_BEFORE_SECONDS, WATERMARK_UNFIRED),
                None,
            );
        }
    }

    #[test]
    fn only_renewal_and_expired_are_actionable() {
        let actionable: Vec<&str> = ExpiryStage::ALL
            .into_iter()
            .filter(|s| s.is_actionable())
            .map(ExpiryStage::as_str)
            .collect();
        assert_eq!(actionable, ["expired", "renewal"]);
    }
}
