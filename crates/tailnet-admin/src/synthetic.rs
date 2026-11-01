//! Synthetic Tailscale-shaped credentials for tests. Generated at runtime only.

use rand_core::{OsRng, RngCore};
use secrecy::{ExposeSecret as _, SecretString};

const ALPHANUM: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

fn random_chars(len: usize) -> String {
    let mut out = String::with_capacity(len);
    let mut buf = [0u8; 1];
    for _ in 0..len {
        OsRng.fill_bytes(&mut buf);
        let index = (buf[0] as usize) % ALPHANUM.len();
        out.push(char::from(ALPHANUM[index]));
    }
    out
}

fn random_segment(min: usize, max: usize) -> String {
    let span = max - min + 1;
    let length = min + ((OsRng.next_u32() as usize) % span);
    random_chars(length)
}

fn mint(kind: &str) -> String {
    format!("tskey-{kind}-{}", random_segment(8, 48))
}

pub fn api_token() -> SecretString {
    SecretString::from(mint("api"))
}

pub fn api_token_plain() -> String {
    api_token().expose_secret().to_owned()
}

pub fn client_secret() -> SecretString {
    SecretString::from(mint("client"))
}

pub fn auth_control_id() -> String {
    format!("k{}", random_chars(11).to_uppercase())
}

pub fn auth_key_for_control_id(control_id: &str) -> String {
    format!("tskey-auth-{control_id}-{}", random_segment(12, 32))
}

pub fn auth_key() -> String {
    let id = auth_control_id();
    auth_key_for_control_id(&id)
}

pub fn client_id() -> String {
    random_chars(12)
}
