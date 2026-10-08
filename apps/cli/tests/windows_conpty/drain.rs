use super::process::failed;
use std::fs::File;
use std::io::{self, Read};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use zeroize::Zeroizing;

const LIMIT: usize = 1_048_576;
pub(super) struct State {
    bytes: Zeroizing<Vec<u8>>,
    failed: bool,
    closing: bool,
}
pub(super) type Shared = Arc<Mutex<State>>;

pub(super) fn start(mut input: File) -> (Shared, JoinHandle<()>) {
    let state = Arc::new(Mutex::new(State {
        bytes: Zeroizing::new(Vec::new()),
        failed: false,
        closing: false,
    }));
    let shared = Arc::clone(&state);
    let thread = thread::spawn(move || {
        let mut buffer = Zeroizing::new([0u8; 4096]);
        loop {
            let count = match input.read(buffer.as_mut()) {
                Ok(0) => break,
                Err(_) => {
                    if let Ok(mut state) = shared.lock() {
                        state.failed |= !state.closing;
                    }
                    break;
                }
                Ok(count) => count,
            };
            let Ok(mut state) = shared.lock() else {
                break;
            };
            if state.bytes.len().saturating_add(count) > LIMIT {
                state.failed = true;
            }
            if !state.failed {
                state.bytes.extend_from_slice(&buffer[..count]);
            }
            // Continue draining even after overflow, so close cannot deadlock on backpressure.
        }
    });
    (state, thread)
}

/// Normalize bounded CSI/OSC presentation bytes, never interpret them as commands.
pub(super) fn closing(state: &Shared) {
    if let Ok(mut state) = state.lock() {
        state.closing = true;
    }
}

pub(super) fn visible(state: &Shared, complete: bool) -> io::Result<Zeroizing<String>> {
    let state = state
        .lock()
        .map_err(|_| failed("Terminal drain unavailable"))?;
    if state.failed {
        return Err(failed("Terminal output limit exceeded"));
    }
    let source = match std::str::from_utf8(&state.bytes) {
        Ok(source) => source,
        Err(error) if !complete && error.error_len().is_none() => {
            std::str::from_utf8(&state.bytes[..error.valid_up_to()])
                .map_err(|_| failed("Invalid terminal UTF8"))?
        }
        Err(_) => return Err(failed("Invalid terminal UTF8")),
    };
    let mut result = Zeroizing::new(String::new());
    let mut mode = 0u8;
    for character in source.chars() {
        mode = match (mode, character) {
            (0, '\u{1b}') => 1,
            (0, '\r') => 0,
            (0, character) => {
                result.push(character);
                0
            }
            (1, '[') => 2,
            (1, ']') => 3,
            (1, _) => 0,
            (2, '@'..='~') => 0,
            (3, '\u{7}') | (4, '\\') => 0,
            (3, '\u{1b}') => 4,
            (4, _) => 3,
            (mode, _) => mode,
        };
    }
    Ok(result)
}
