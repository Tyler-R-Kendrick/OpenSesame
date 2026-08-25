#![cfg(feature = "concurrency-test")]

use opensesame_rotation::RotationState;
use shuttle::sync::{Arc, Mutex};

const DEFAULT_ITERATIONS: usize = 1_000;

fn apply_if_valid(state: &Mutex<RotationState>, next: RotationState) {
    let mut guard = state.lock().unwrap();
    let from = *guard;
    if from.can_transition(next) {
        *guard = from.transition(next).unwrap();
    }
}

#[test]
fn shared_state_never_takes_an_illegal_edge() {
    let iterations = std::env::var("SHUTTLE_ITERATIONS").map_or(DEFAULT_ITERATIONS, |raw| {
        raw.parse().expect("SHUTTLE_ITERATIONS must be a usize")
    });
    shuttle::check_random(
        || {
            let state = Arc::new(Mutex::new(RotationState::Scheduled));
            let nexts = [
                RotationState::Discovering,
                RotationState::CandidateGenerated,
                RotationState::RollbackStarted,
                RotationState::Completed,
            ];
            let a = shuttle::thread::spawn({
                let state = Arc::clone(&state);
                move || apply_if_valid(&state, nexts[0])
            });
            let b = shuttle::thread::spawn({
                let state = Arc::clone(&state);
                move || apply_if_valid(&state, nexts[1])
            });
            a.join().unwrap();
            b.join().unwrap();
            let final_state = *state.lock().unwrap();
            assert!(
                final_state == RotationState::Scheduled
                    || final_state == RotationState::Discovering
                    || final_state == RotationState::CandidateGenerated
            );
        },
        iterations,
    );
}
