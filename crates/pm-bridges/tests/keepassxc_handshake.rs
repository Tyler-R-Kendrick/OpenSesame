//! Real-crypto handshake tests for the keepassxc bridge.
//!
//! A test client performs **actual `crypto_box` operations** against the
//! server core over a tempdir unix socket — no mocks in the crypto path — and
//! walks the whole journey a stock KeePassXC-Browser extension walks:
//!
//! ```text
//!   change-public-keys → associate (window closed → refused)
//!                      → pair + confirm → associate → test-associate
//!                      → get-logins → get-totp → set-login → lock-database
//! ```
//!
//! It also asserts the two things a reviewer most wants pinned: the reply
//! nonce is the request nonce **incremented**, and a client that never paired
//! is refused.

#![cfg(all(feature = "keepassxc", unix))]

mod support;

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use opensesame_pm_bridges::conflict::{probe_unix_socket, SocketState};
use opensesame_pm_bridges::keepassxc::crypto::{
    client_box, generate_client_keys, random_nonce_b64, ClientSecretKey, SessionBox,
};
use opensesame_pm_bridges::keepassxc::pairing::BRIDGE_NAME;
use opensesame_pm_bridges::keepassxc::proto::{decode_b64, increment_nonce_b64, NONCE_LEN};
use opensesame_pm_bridges::keepassxc::transport::{bind_uds, serve_uds_connection};
use opensesame_pm_bridges::keepassxc::{Session, SessionConfig};
use opensesame_pm_bridges::pairing::{PairingWindow, WindowState};
use opensesame_pm_bridges::store::{entry_uuid, StoreAccess};
use opensesame_pm_bridges::{now_unix, testing};
use support::Fixture;

/// `OPENSESAME_BRIDGES_DIR` is process-global; one server at a time.
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// The bridge polls the pairing window; make that fast in tests.
fn tiny_sleep(_: Duration) {
    std::thread::sleep(Duration::from_millis(5));
}

struct Server {
    socket: std::path::PathBuf,
    window: PairingWindow,
    _fixture: Fixture,
    _runtime: tempfile::TempDir,
    _guard: MutexGuard<'static, ()>,
    _thread: std::thread::JoinHandle<()>,
}

impl Server {
    fn start() -> Self {
        let guard = ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fixture = Fixture::new();
        std::env::set_var("OPENSESAME_BRIDGES_DIR", fixture.config.path());

        let runtime = tempfile::tempdir().expect("runtime tempdir");
        let socket = runtime.path().join("org.keepassxc.KeePassXC.BrowserServer");
        let listener = bind_uds(&socket, false).expect("bind");

        let window = PairingWindow::at(fixture.config.path().join("keepassxc-pairing.json"));
        let store = StoreAccess::open(fixture.store_path(), Some(testing::FIXTURE_PASSPHRASE))
            .expect("open store");
        let mut session = Session::new(
            store,
            SessionConfig {
                window: window.clone(),
                sleep: tiny_sleep,
                host_keys: opensesame_pm_bridges::keepassxc::crypto::HostKeys::generate(),
            },
        );
        let thread = std::thread::spawn(move || serve_connections(&listener, &mut session));

        Self {
            socket,
            window,
            _fixture: fixture,
            _runtime: runtime,
            _guard: guard,
            _thread: thread,
        }
    }

    fn connect(&self) -> Client {
        Client::connect(&self.socket)
    }

    /// Stand in for the human at the TTY: wait for the bridge to post a
    /// fingerprint, then answer.
    fn spawn_human(&self, confirm: bool) -> std::thread::JoinHandle<Option<String>> {
        let window = self.window.clone();
        std::thread::spawn(move || answer_pairing_request(&window, confirm))
    }
}

fn serve_connections(listener: &std::os::unix::net::UnixListener, session: &mut Session) {
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else {
            break;
        };
        let _ = serve_uds_connection(session, &mut stream);
    }
}

fn answer_pairing_request(window: &PairingWindow, confirm: bool) -> Option<String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(WindowState::Requested { fingerprint, .. }) = window.state(now_unix()) {
            if confirm {
                window.confirm(now_unix()).expect("confirm");
            } else {
                window.reject().expect("reject");
            }
            return Some(fingerprint);
        }
        if Instant::now() > deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// The extension's half of the protocol, with real `NaCl` boxes.
struct Client {
    stream: UnixStream,
    id: String,
    public: String,
    secret: ClientSecretKey,
    session: Option<SessionBox>,
    id_key: String,
    association_id: Option<String>,
}

impl Client {
    fn connect(socket: &std::path::Path) -> Self {
        let stream = UnixStream::connect(socket).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("read timeout");
        let (secret, public) = generate_client_keys();
        // The identification key is a *separate*, persistent keypair.
        let (_id_secret, id_key) = generate_client_keys();
        Self {
            stream,
            id: random_nonce_b64(),
            public,
            secret,
            session: None,
            id_key,
            association_id: None,
        }
    }

    fn send(&mut self, value: &Value) -> Value {
        let bytes = serde_json::to_vec(value).expect("serialize");
        self.stream.write_all(&bytes).expect("write");
        self.stream.flush().expect("flush");
        self.recv()
    }

    fn recv(&mut self) -> Value {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let read = self.stream.read(&mut chunk).expect("read");
            assert!(read > 0, "server closed the connection");
            buffer.extend_from_slice(&chunk[..read]);
            if let Ok(value) = serde_json::from_slice::<Value>(&buffer) {
                return value;
            }
        }
    }

    /// `change-public-keys`, asserting the nonce contract on the way through.
    fn change_public_keys(&mut self) -> Value {
        let nonce = random_nonce_b64();
        let response = self.send(&json!({
            "action": "change-public-keys",
            "publicKey": self.public,
            "nonce": nonce,
            "clientID": self.id,
        }));
        assert_eq!(response["success"], "true", "response: {response}");
        assert_eq!(
            response["nonce"],
            increment_nonce_b64(&nonce).unwrap(),
            "the reply must use the incremented nonce"
        );
        let host_public = response["publicKey"].as_str().expect("host publicKey");
        self.session = Some(client_box(&self.secret, host_public).expect("client box"));
        response
    }

    /// Send an encrypted action and return `(outer, inner)`.
    ///
    /// `inner` is `None` when the server answered with an unencrypted error.
    fn action(&mut self, action: &str, inner: &Value) -> (Value, Option<Value>) {
        let nonce = random_nonce_b64();
        let session = self.session.as_ref().expect("handshake first");
        let sealed = session
            .seal(&serde_json::to_vec(inner).unwrap(), &nonce)
            .expect("seal");
        let outer = self.send(&json!({
            "action": action,
            "message": sealed,
            "nonce": nonce,
            "clientID": self.id,
        }));
        if outer.get("errorCode").is_some() {
            return (outer, None);
        }
        let reply_nonce = outer["nonce"].as_str().expect("reply nonce");
        assert_eq!(
            reply_nonce,
            increment_nonce_b64(&nonce).unwrap(),
            "every encrypted reply increments the request nonce"
        );
        let session = self.session.as_ref().unwrap();
        let plaintext = session
            .open(outer["message"].as_str().expect("message"), reply_nonce)
            .expect("open reply");
        let inner: Value = serde_json::from_slice(&plaintext).expect("inner json");
        (outer, Some(inner))
    }

    /// An action whose outer envelope carries no encrypted message.
    fn bare_action(&mut self, action: &str) -> (Value, Option<Value>) {
        let nonce = random_nonce_b64();
        let outer = self.send(&json!({
            "action": action,
            "nonce": nonce,
            "clientID": self.id,
            "requestID": "abcd1234",
        }));
        if outer.get("errorCode").is_some() {
            return (outer, None);
        }
        let reply_nonce = outer["nonce"].as_str().expect("reply nonce");
        assert_eq!(reply_nonce, increment_nonce_b64(&nonce).unwrap());
        let plaintext = self
            .session
            .as_ref()
            .unwrap()
            .open(outer["message"].as_str().unwrap(), reply_nonce)
            .expect("open reply");
        (
            outer.clone(),
            Some(serde_json::from_slice(&plaintext).unwrap()),
        )
    }

    fn keys(&self) -> Value {
        json!([{ "id": self.association_id.clone().unwrap_or_default(), "key": self.id_key }])
    }
}

#[test]
fn the_socket_is_bound_and_conflict_detection_sees_it() {
    let server = Server::start();
    assert!(matches!(
        probe_unix_socket(&server.socket),
        SocketState::Live { .. }
    ));
    // A second bind must refuse, naming the owner, rather than stealing.
    let error = bind_uds(&server.socket, false).unwrap_err().to_string();
    assert!(error.contains("refusing to take over"), "{error}");
    // …and `--takeover` must not remove a *live* socket either.
    let error = bind_uds(&server.socket, true).unwrap_err().to_string();
    assert!(error.contains("refusing to take over"), "{error}");
}

#[test]
fn associate_is_refused_while_no_pairing_window_is_open() {
    let server = Server::start();
    let mut client = server.connect();
    client.change_public_keys();

    let (outer, inner) = client.action(
        "associate",
        &json!({ "action": "associate", "key": client.public, "idKey": client.id_key }),
    );
    assert!(inner.is_none(), "an unpaired associate must not succeed");
    assert_eq!(outer["errorCode"], "6");
    assert_eq!(outer["action"], "associate");

    // Nothing was persisted.
    let file = opensesame_pm_bridges::pairing::load_pairings(BRIDGE_NAME).unwrap();
    assert!(file.associations.is_empty());
}

#[test]
fn associate_is_refused_when_the_human_says_no() {
    let server = Server::start();
    let mut client = server.connect();
    client.change_public_keys();

    server.window.open(now_unix(), 60).unwrap();
    let human = server.spawn_human(false);
    let (outer, inner) = client.action(
        "associate",
        &json!({ "action": "associate", "key": client.public, "idKey": client.id_key }),
    );
    assert!(
        human.join().unwrap().is_some(),
        "the bridge posted a fingerprint"
    );
    assert!(inner.is_none());
    assert_eq!(outer["errorCode"], "6");
}

#[test]
fn associate_is_refused_when_the_echoed_session_key_is_wrong() {
    let server = Server::start();
    let mut client = server.connect();
    client.change_public_keys();
    server.window.open(now_unix(), 60).unwrap();

    let (_other_secret, other_public) = generate_client_keys();
    let (outer, inner) = client.action(
        "associate",
        &json!({ "action": "associate", "key": other_public, "idKey": client.id_key }),
    );
    assert!(inner.is_none());
    assert_eq!(outer["errorCode"], "8");
    // The window was never even consumed.
    assert!(matches!(
        server.window.state(now_unix()).unwrap(),
        WindowState::Open { .. }
    ));
}

#[test]
fn the_full_paired_journey() {
    let server = Server::start();
    let mut client = server.connect();

    establish_pairing(&server, &mut client);
    let uuid = verify_fixture_login(&mut client);
    verify_totp(&mut client, &uuid);
    verify_generated_password_and_groups(&mut client);
    save_and_refind_login(&mut client);
    lock_store_and_verify_refusal(&mut client);
}

fn establish_pairing(server: &Server, client: &mut Client) {
    let handshake = client.change_public_keys();
    insta::assert_json_snapshot!("change_public_keys", handshake, {
        ".publicKey" => "[host-public-key]",
        ".nonce" => "[nonce]",
        ".clientID" => "[client-id]",
    });

    // The extension asks for the database hash before pairing to recognize it.
    let (_outer, hash) =
        client.action("get-databasehash", &json!({ "action": "get-databasehash" }));
    let hash = hash.expect("hash reply");
    assert_eq!(hash["action"], "hash");
    insta::assert_json_snapshot!("get_databasehash", hash, {
        ".hash" => "[database-hash]",
        ".nonce" => "[nonce]",
    });

    server.window.open(now_unix(), 60).unwrap();
    let human = server.spawn_human(true);
    let (outer, associate) = client.action(
        "associate",
        &json!({ "action": "associate", "key": client.public, "idKey": client.id_key }),
    );
    let fingerprint = human.join().unwrap().expect("the human saw a fingerprint");
    assert_eq!(
        fingerprint,
        opensesame_pm_bridges::pairing::key_fingerprint(&client.id_key),
        "the human confirms the fingerprint of the key that actually arrived"
    );
    let associate = associate.unwrap_or_else(|| panic!("associate reply: {outer}"));
    assert_eq!(associate["success"], "true");
    client.association_id = associate["id"].as_str().map(str::to_string);
    insta::assert_json_snapshot!("associate", associate, {
        ".hash" => "[database-hash]",
        ".nonce" => "[nonce]",
    });

    let stored = opensesame_pm_bridges::pairing::load_pairings(BRIDGE_NAME).unwrap();
    assert_eq!(stored.associations.len(), 1);
    assert_eq!(stored.associations[0].id_key, client.id_key);

    let (_outer, tested) = client.action(
        "test-associate",
        &json!({
            "action": "test-associate",
            "id": client.association_id,
            "key": client.id_key,
        }),
    );
    let tested = tested.expect("test-associate reply");
    assert_eq!(tested["success"], "true");
    insta::assert_json_snapshot!("test_associate", tested, {
        ".hash" => "[database-hash]",
        ".nonce" => "[nonce]",
        ".id" => "[association-id]",
    });
}

fn verify_fixture_login(client: &mut Client) -> String {
    let (_outer, logins) = client.action(
        "get-logins",
        &json!({
            "action": "get-logins",
            "url": "https://login.example.com/signin",
            "keys": client.keys(),
        }),
    );
    let logins = logins.expect("get-logins reply");
    assert_eq!(logins["count"], "1");
    assert_eq!(logins["entries"][0]["login"], "alice");
    assert_eq!(logins["entries"][0]["password"], "hunter2");
    let uuid = logins["entries"][0]["uuid"].as_str().unwrap().to_string();
    assert_eq!(uuid, entry_uuid("Web/example.com"));
    insta::assert_json_snapshot!("get_logins", logins, {
        ".hash" => "[database-hash]",
        ".nonce" => "[nonce]",
    });
    uuid
}

fn verify_totp(client: &mut Client, uuid: &str) {
    let (_outer, totp) = client.action("get-totp", &json!({ "action": "get-totp", "uuid": uuid }));
    let totp = totp.expect("get-totp reply");
    let code = totp["totp"].as_str().expect("totp");
    assert_eq!(code.len(), 6);
    assert!(code.chars().all(|c| c.is_ascii_digit()));
    insta::assert_json_snapshot!("get_totp", totp, {
        ".totp" => "[totp]",
        ".nonce" => "[nonce]",
    });
}

fn verify_generated_password_and_groups(client: &mut Client) {
    let (_outer, generated) = client.bare_action("generate-password");
    let generated = generated.expect("generate-password reply");
    assert_eq!(generated["password"].as_str().unwrap().len(), 24);
    insta::assert_json_snapshot!("generate_password", generated, {
        ".password" => "[generated]",
        ".nonce" => "[nonce]",
    });

    let (_outer, groups) = client.action(
        "get-database-groups",
        &json!({ "action": "get-database-groups" }),
    );
    let groups = groups.expect("groups reply");
    assert_eq!(groups["groups"][0]["children"][0]["name"], "Dev");
    insta::assert_json_snapshot!("get_database_groups", groups, {
        ".nonce" => "[nonce]",
        ".groups[0].uuid" => "[uuid]",
        ".groups[0].children[].uuid" => "[uuid]",
    });
}

fn save_and_refind_login(client: &mut Client) {
    let (_outer, saved) = client.action(
        "set-login",
        &json!({
            "action": "set-login",
            "url": "https://new.example/login",
            "login": "bob",
            "password": "s3kr1t",
            "keys": client.keys(),
        }),
    );
    let saved = saved.expect("set-login reply");
    assert_eq!(saved["success"], "true");
    insta::assert_json_snapshot!("set_login", saved, {
        ".hash" => "[database-hash]",
        ".nonce" => "[nonce]",
    });

    let (_outer, refound) = client.action(
        "get-logins",
        &json!({
            "action": "get-logins",
            "url": "https://new.example/",
            "keys": client.keys(),
        }),
    );
    let refound = refound.expect("get-logins reply");
    assert_eq!(refound["entries"][0]["login"], "bob");
    assert_eq!(refound["entries"][0]["password"], "s3kr1t");
    assert_eq!(
        refound["entries"][0]["name"],
        "keepassxc-browser/new.example/bob"
    );
}

fn lock_store_and_verify_refusal(client: &mut Client) {
    let (_outer, locked) = client.action("lock-database", &json!({ "action": "lock-database" }));
    let locked = locked.expect("lock reply");
    assert_eq!(locked["errorCode"], 1);
    insta::assert_json_snapshot!("lock_database", locked, { ".nonce" => "[nonce]" });

    let (outer, inner) = client.action(
        "get-logins",
        &json!({
            "action": "get-logins",
            "url": "https://login.example.com/",
            "keys": client.keys(),
        }),
    );
    assert!(inner.is_none(), "a locked store must serve nothing");
    assert_eq!(outer["errorCode"], "1");
}

#[test]
fn an_unassociated_client_is_refused_every_store_action() {
    let server = Server::start();
    let mut client = server.connect();
    client.change_public_keys();

    for (action, inner) in [
        (
            "get-logins",
            json!({ "action": "get-logins", "url": "https://login.example.com/" }),
        ),
        (
            "set-login",
            json!({ "action": "set-login", "url": "https://x.example", "login": "a", "password": "b" }),
        ),
        (
            "get-totp",
            json!({ "action": "get-totp", "uuid": "deadbeef" }),
        ),
        (
            "get-database-groups",
            json!({ "action": "get-database-groups" }),
        ),
        ("lock-database", json!({ "action": "lock-database" })),
    ] {
        let (outer, decrypted) = client.action(action, &inner);
        assert!(decrypted.is_none(), "{action} answered an unpaired client");
        assert_eq!(outer["errorCode"], "8", "{action}: {outer}");
    }

    // A forged key that names no stored association is refused too.
    let (outer, decrypted) = client.action(
        "get-logins",
        &json!({
            "action": "get-logins",
            "url": "https://login.example.com/",
            "keys": [{ "id": "made-up", "key": "AAAA" }],
        }),
    );
    assert!(decrypted.is_none());
    assert_eq!(outer["errorCode"], "10");
}

#[test]
fn passkeys_actions_answer_not_supported() {
    let server = Server::start();
    let mut client = server.connect();
    client.change_public_keys();

    for action in ["passkeys-get", "passkeys-register"] {
        let (outer, inner) = client.action(action, &json!({ "action": action }));
        assert!(inner.is_none());
        assert_eq!(outer["errorCode"], "12", "{action}");
        assert_eq!(outer["action"], action);
    }
}

#[test]
fn malformed_traffic_is_answered_not_crashed() {
    let server = Server::start();
    let mut client = server.connect();

    // An encrypted action before any key exchange.
    let response = client.send(&json!({
        "action": "get-databasehash",
        "message": "AAAA",
        "nonce": random_nonce_b64(),
        "clientID": "unknown-client",
    }));
    assert_eq!(response["errorCode"], "3");

    // A ciphertext that is not a valid box.
    client.change_public_keys();
    let response = client.send(&json!({
        "action": "get-databasehash",
        "message": "AAAAAAAAAAAAAAAAAAAAAAAA",
        "nonce": random_nonce_b64(),
        "clientID": client.id,
    }));
    assert_eq!(response["errorCode"], "4");

    // A nonce of the wrong width.
    let response = client.send(&json!({
        "action": "get-databasehash",
        "message": "AAAA",
        "nonce": "AAAA",
        "clientID": client.id,
    }));
    assert_eq!(response["errorCode"], "4");

    // An unknown action.
    let response = client.send(&json!({
        "action": "make-me-a-sandwich",
        "nonce": random_nonce_b64(),
        "clientID": client.id,
    }));
    assert_eq!(response["errorCode"], "12");

    // Junk that is not even an envelope.
    client.stream.write_all(b"[1,2,3]").unwrap();
    let response = client.recv();
    assert_eq!(response["errorCode"], "4");

    // The connection is still usable afterwards.
    let (_outer, hash) =
        client.action("get-databasehash", &json!({ "action": "get-databasehash" }));
    assert!(hash.is_some());
}

#[test]
fn nonces_are_the_documented_width_and_always_increment() {
    let server = Server::start();
    let mut client = server.connect();
    client.change_public_keys();

    for _ in 0..3 {
        let nonce = random_nonce_b64();
        assert_eq!(
            decode_b64(&nonce, Some(NONCE_LEN)).unwrap().len(),
            NONCE_LEN
        );
        let session = client.session.as_ref().unwrap();
        let sealed = session
            .seal(br#"{"action":"get-databasehash"}"#, &nonce)
            .unwrap();
        let outer = client.send(&json!({
            "action": "get-databasehash",
            "message": sealed,
            "nonce": nonce,
            "clientID": client.id,
        }));
        assert_eq!(outer["nonce"], increment_nonce_b64(&nonce).unwrap());
        assert_eq!(outer["clientID"], client.id);
    }
}
