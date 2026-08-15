#![cfg(feature = "concurrency-test")]

use opensesame_rotation::RotationState;
use std::sync::Mutex;

#[shuttle::test]
fn shared_state_never_takes_an_illegal_edge() {
    let state = Mutex::new(RotationState::Scheduled);
    let nexts = [
        RotationState::Discovering,
        RotationState::CandidateGenerated,
        RotationState::RollbackStarted,
        RotationState::Completed,
    ];
    let a = shuttle::thread::spawn({
        let state = &state;
        move || {
            let mut g = state.lock().unwrap();
            let from = *g;
            if from.can_transition(nexts[0]) {
                *g = from.transition(nexts[0]).unwrap();
            }
        }
    });
    let b = shuttle::thread::spawn({
        let state = &state;
        move || {
            let mut g = state.lock().unwrap();
            let from = *g;
            if from.can_transition(nexts[1]) {
                *g = from.transition(nexts[1]).unwrap();
            }
        }
    });
    a.join().unwrap();
    b.join().unwrap();
    let final_state = *state.lock().unwrap();
    assert!(
        final_state == RotationState::Scheduled
            || final_state == RotationState::Discovering
            || final_state == RotationState::CandidateGenerated
    );
}
