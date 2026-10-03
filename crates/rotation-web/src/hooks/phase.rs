//! Where a session is in §3.1's ordering, and which emissions may overlap.
//!
//! The phase decides whether an interception point may be emitted at all.
//! §6.1a says a denied `agent_startup` means nothing else may be emitted, and
//! §3.1 says `agent_startup` precedes and `agent_shutdown` follows everything;
//! a tool verb called outside a turn is therefore refused **without an
//! emission**, because emitting it would be the violation.

use agent_hooks::InterceptionPoint;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Phase {
    /// Nothing emitted yet.
    Fresh,
    /// Started, between turns: an `input` may arrive.
    Idle,
    /// Inside a turn: tool verbs and the `output` may be emitted.
    Turn,
    /// A startup or input deny: nothing but `agent_shutdown` may follow.
    Refused,
    /// `agent_shutdown` was emitted.
    Closed,
}

pub(super) const fn admits(phase: Phase, point: InterceptionPoint) -> bool {
    match point {
        InterceptionPoint::AgentStartup => matches!(phase, Phase::Fresh),
        InterceptionPoint::Input => matches!(phase, Phase::Idle),
        InterceptionPoint::AgentShutdown => {
            matches!(phase, Phase::Idle | Phase::Turn | Phase::Refused)
        }
        // Tool verbs, the output and the model points belong to a turn. No run
        // this crate orders emits the model points (it makes no model calls,
        // §3.2); `dynamic` is the surface that can, under the same rule.
        _ => matches!(phase, Phase::Turn),
    }
}

/// Where the phase goes after an emission at `point` proceeds or blocks. An
/// emission abandoned before its verdict was known records a deny, so it moves
/// the phase the way a deny does (see `Flight`'s `Drop`).
pub(super) const fn after(phase: Phase, point: InterceptionPoint, proceeded: bool) -> Phase {
    match (point, proceeded) {
        // A refused output still ends the turn: the response is withheld.
        (InterceptionPoint::AgentStartup, true) | (InterceptionPoint::Output, _) => Phase::Idle,
        (InterceptionPoint::Input, true) => Phase::Turn,
        // Nothing follows a shutdown, whatever its verdict (§6.1a imposes
        // nothing on a shutdown deny): the session is closed, and a second
        // `agent_shutdown` would break §3.1's "once".
        (InterceptionPoint::AgentShutdown, _) => Phase::Closed,
        (InterceptionPoint::AgentStartup | InterceptionPoint::Input, false) => Phase::Refused,
        _ => phase,
    }
}

/// Whether emissions at `point` may overlap one another (§12.2.2).
///
/// Only the tool and model points do: they never move the phase, and the
/// phase is the same for every one of them. Every other point is a boundary
/// of the run — it changes what may be emitted next, and §3.1 wants it to
/// follow or precede *everything* — so it is emitted alone, after every
/// emission already in flight has finished and before any later one starts.
pub(super) const fn overlaps(point: InterceptionPoint) -> bool {
    matches!(
        point,
        InterceptionPoint::PreToolCall
            | InterceptionPoint::PostToolCall
            | InterceptionPoint::PreModelCall
            | InterceptionPoint::PostModelCall
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [InterceptionPoint; 8] = [
        InterceptionPoint::AgentStartup,
        InterceptionPoint::Input,
        InterceptionPoint::PreModelCall,
        InterceptionPoint::PostModelCall,
        InterceptionPoint::PreToolCall,
        InterceptionPoint::PostToolCall,
        InterceptionPoint::Output,
        InterceptionPoint::AgentShutdown,
    ];

    #[test]
    fn a_point_that_overlaps_never_moves_the_phase() {
        let phases = [Phase::Fresh, Phase::Idle, Phase::Turn, Phase::Refused];
        let cases = ALL
            .into_iter()
            .filter(|&point| overlaps(point))
            .flat_map(|point| phases.map(|phase| (point, phase)));
        for (point, phase) in cases {
            assert_eq!(after(phase, point, true), phase, "{point}");
            assert_eq!(after(phase, point, false), phase, "{point}");
        }
    }

    #[test]
    fn a_shutdown_closes_the_session_whatever_its_verdict() {
        for phase in [Phase::Idle, Phase::Turn, Phase::Refused] {
            for proceeded in [true, false] {
                let closed = after(phase, InterceptionPoint::AgentShutdown, proceeded);
                assert_eq!(closed, Phase::Closed);
            }
        }
    }

    #[test]
    fn a_denied_startup_leaves_only_the_shutdown_admitted() {
        let refused = after(Phase::Fresh, InterceptionPoint::AgentStartup, false);
        assert_eq!(refused, Phase::Refused);
        assert!(admits(refused, InterceptionPoint::AgentShutdown));
        assert!(!admits(refused, InterceptionPoint::Input));
    }

    #[test]
    fn the_boundaries_of_a_run_do_not_overlap() {
        for point in [
            InterceptionPoint::AgentStartup,
            InterceptionPoint::Input,
            InterceptionPoint::Output,
            InterceptionPoint::AgentShutdown,
        ] {
            assert!(!overlaps(point), "{point}");
        }
    }

    #[test]
    fn shutdown_is_admitted_from_every_open_phase_and_nothing_after() {
        let point = InterceptionPoint::AgentShutdown;
        assert!(!admits(Phase::Fresh, point));
        for phase in [Phase::Idle, Phase::Turn, Phase::Refused] {
            assert!(admits(phase, point));
        }
        assert!(!admits(Phase::Closed, point));
    }
}
