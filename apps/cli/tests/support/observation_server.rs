//! Independent loopback HTTP transport using genuine AES/HMAC protocol validation.
use opensesame_human_vault::credential_canaries::receiver::{self, Metadata, Package, Provision};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    time::{Duration, Instant},
};
pub fn read_request(stream: &mut TcpStream) -> Package {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut raw = Vec::new();
    let end = loop {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        raw.push(byte[0]);
        assert!(raw.len() <= 4096);
        if raw.ends_with(b"\r\n\r\n") {
            break raw.len();
        }
    };
    let headers = String::from_utf8(raw.clone()).unwrap();
    assert!(headers.starts_with("POST /v1/credential-observations HTTP/1.1\r\n"));
    assert!(!headers.to_lowercase().contains("authorization:"));
    assert!(!headers.to_lowercase().contains("cookie:"));
    let length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap();
    assert!(length <= 8192);
    raw.resize(end + length, 0);
    stream.read_exact(&mut raw[end..]).unwrap();
    assert!(!raw
        .windows(b"generated owner".len())
        .any(|part| part == b"generated owner"));
    serde_json::from_slice(&raw[end..]).unwrap()
}
pub fn accept(listener: &TcpListener) -> TcpStream {
    listener.set_nonblocking(true).unwrap();
    let start = Instant::now();
    loop {
        match listener.accept() {
            Ok((stream, _)) => return stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    start.elapsed() < Duration::from_secs(15),
                    "expected receiver request never arrived"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("receiver accept failed: {error}"),
        }
    }
}
pub fn valid_response(stream: &mut TcpStream, packet: &Package, provision: &Provision) -> Metadata {
    let now = chrono::Utc::now();
    let metadata = receiver::open(&serde_json::to_string(packet).unwrap(), provision, now).unwrap();
    let ack =
        serde_json::to_string(&receiver::acknowledge(packet, provision, now).unwrap()).unwrap();
    respond(stream, "200 OK", &ack, "");
    metadata
}
pub fn respond(stream: &mut TcpStream, status: &str, body: &str, extra: &str) {
    let response=format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}",body.len());
    stream.write_all(response.as_bytes()).unwrap();
    stream.flush().unwrap();
}
pub fn provision(listener: &TcpListener) -> Provision {
    use base64::{engine::general_purpose::STANDARD, Engine};
    Provision {
        v: 1,
        receiver_id: "generated-cli-receiver".into(),
        binding_id: uuid::Uuid::new_v4().to_string(),
        origin: format!("http://{}", listener.local_addr().unwrap()),
        independent_key_material_b64: STANDARD.encode([7u8; 64]),
        key_epoch: 1,
        expires_at: (chrono::Utc::now() + chrono::Duration::days(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        allow_loopback: true,
    }
}
pub fn pairing_file(root: &std::path::Path, provision: &Provision) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = root.join("independent-pairing.json");
    std::fs::write(&path, serde_json::to_vec(provision).unwrap()).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    path
}
