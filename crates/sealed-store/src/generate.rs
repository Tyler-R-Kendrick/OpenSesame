use rand::Rng;

const ALNUM: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SYMBOLS: &[u8] = b"!@#$%^&*()-_=+[]{}:,.?";

/// Generate a password with CSPRNG. When `symbols` is false, alphanumeric only.
pub fn generate_password(length: usize, symbols: bool) -> String {
    let length = length.max(1);
    let alphabet: Vec<u8> = if symbols {
        ALNUM.iter().chain(SYMBOLS.iter()).copied().collect()
    } else {
        ALNUM.to_vec()
    };
    let mut rng = rand::thread_rng();
    (0..length)
        .map(|_| {
            let idx = rng.gen_range(0..alphabet.len());
            alphabet[idx] as char
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_length_and_no_symbols() {
        let p = generate_password(32, false);
        assert_eq!(p.len(), 32);
        assert!(p.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn generate_with_symbols_can_include_symbol() {
        // Probabilistic: try several times
        let mut saw = false;
        for _ in 0..20 {
            let p = generate_password(64, true);
            if p.chars().any(|c| !c.is_ascii_alphanumeric()) {
                saw = true;
                break;
            }
        }
        assert!(saw);
    }
}
