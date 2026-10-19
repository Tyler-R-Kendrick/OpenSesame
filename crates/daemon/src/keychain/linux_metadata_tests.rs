use super::*;
use dbus::arg::Variant;
use dbus::channel::{MatchingReceiver, Sender};
use dbus::message::MatchRule;
use std::fmt::Write as _;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

struct PrivateBus(Child);

impl Drop for PrivateBus {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[derive(Clone, Copy, Debug)]
enum Scenario {
    Ordinary,
    Locked,
    UnreadableLock,
    WrongLockType,
    MissingCollection,
    UnreadableItems,
    UnexpectedPaths,
}

fn collection_path(scenario: Scenario) -> &'static str {
    if matches!(scenario, Scenario::UnexpectedPaths) {
        "/unexpected/collection"
    } else {
        "/org/freedesktop/secrets/collection/default"
    }
}

fn collection_reply(
    scenario: Scenario,
    message: &dbus::Message,
    property: &str,
) -> Option<dbus::Message> {
    match property {
        "Locked" if matches!(scenario, Scenario::UnreadableLock) => None,
        "Locked" if matches!(scenario, Scenario::WrongLockType) => {
            Some(message.method_return().append1(Variant("not-a-boolean")))
        }
        "Locked" => Some(
            message
                .method_return()
                .append1(Variant(matches!(scenario, Scenario::Locked))),
        ),
        "Items" if !matches!(scenario, Scenario::UnreadableItems) => {
            let paths: Vec<Path<'static>> = [
                "/items/ordinary",
                "/items/empty",
                "/items/missing",
                "/unexpected/item",
                "/",
            ]
            .into_iter()
            .map(|p| Path::new(p).expect("item path"))
            .collect();
            Some(message.method_return().append1(Variant(paths)))
        }
        _ => None,
    }
}

fn property_reply(
    scenario: Scenario,
    message: &dbus::Message,
    call: &mut String,
) -> Option<dbus::Message> {
    let (target, property): (String, String) = message.read2().expect("property arguments");
    write!(call, " {target}.{property}").expect("record property");
    let path = message.path().expect("property path").to_string();
    if path == collection_path(scenario) && target == COLLECTION {
        return collection_reply(scenario, message, &property);
    }
    if target != ITEM || property != "Label" {
        return None;
    }
    let label = match path.as_str() {
        "/items/ordinary" => "gh:github.com",
        "/items/empty" => "",
        "/unexpected/item" => "unexpected-label",
        _ => return None,
    };
    Some(message.method_return().append1(Variant(label.to_string())))
}

fn metadata_reply(scenario: Scenario, message: &dbus::Message) -> (String, dbus::Message) {
    let interface = message.interface().expect("method interface").to_string();
    let member = message.member().expect("method member").to_string();
    let path = message.path().expect("method path").to_string();
    let mut call = format!("{path} {interface}.{member}");
    let reply = if interface == "org.freedesktop.Secret.Service"
        && member == "ReadAlias"
        && path == SERVICE
    {
        let alias: String = message.read1().expect("alias argument");
        write!(call, " {alias}").expect("record alias");
        let alias_path = if matches!(scenario, Scenario::MissingCollection) {
            "/"
        } else {
            collection_path(scenario)
        };
        Some(
            message
                .method_return()
                .append1(Path::new(alias_path).expect("alias path")),
        )
    } else if interface == "org.freedesktop.DBus.Properties" && member == "Get" {
        property_reply(scenario, message, &mut call)
    } else {
        None
    };
    let reply = reply.unwrap_or_else(|| {
        message.error(
            &dbus::strings::ErrorName::new("org.freedesktop.DBus.Error.UnknownProperty")
                .expect("error name"),
            &std::ffi::CString::new("unreadable metadata").expect("error message"),
        )
    });
    (call, reply)
}

type LabelsResult = Result<Vec<(KeychainStore, String)>, ProbeError>;

fn run(scenario: Scenario) -> (LabelsResult, Vec<String>) {
    // Explicit addresses keep these tests away from the desktop session bus;
    // no process-global environment mutation is needed, even in parallel tests.
    let mut bus = PrivateBus(
        Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("private dbus-daemon must be installed"),
    );
    let mut address = String::new();
    BufReader::new(bus.0.stdout.take().expect("bus stdout"))
        .read_line(&mut address)
        .expect("bus address");
    let server = Connection::new_address(address.trim()).expect("mock bus connection");
    server
        .request_name(DESTINATION, false, true, false)
        .expect("mock service name");
    let calls = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&calls);
    server.start_receive(
        MatchRule::new_method_call(),
        Box::new(move |message, connection| {
            let (call, reply) = metadata_reply(scenario, &message);
            recorded.lock().expect("calls lock").push(call);
            connection.send(reply).expect("mock reply");
            true
        }),
    );
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = Arc::clone(&stop);
    let worker = std::thread::spawn(move || {
        while !stopped.load(Ordering::Relaxed) {
            server
                .process(Duration::from_millis(10))
                .expect("mock process");
        }
    });
    let client = Connection::new_address(address.trim()).expect("client private connection");
    let result = enumerate_labels(&client);
    stop.store(true, Ordering::Relaxed);
    worker.join().expect("mock worker");
    let calls = calls.lock().expect("calls lock").clone();
    (result, calls)
}

#[test]
fn private_bus_metadata_contract() {
    for scenario in [
        Scenario::Ordinary,
        Scenario::Locked,
        Scenario::UnreadableLock,
        Scenario::WrongLockType,
        Scenario::MissingCollection,
        Scenario::UnreadableItems,
        Scenario::UnexpectedPaths,
    ] {
        let (result, calls) = run(scenario);
        let collection = if matches!(scenario, Scenario::UnexpectedPaths) {
            "/unexpected/collection"
        } else {
            "/org/freedesktop/secrets/collection/default"
        };
        let mut expected = vec![format!(
            "{SERVICE} org.freedesktop.Secret.Service.ReadAlias default"
        )];
        if !matches!(scenario, Scenario::MissingCollection) {
            expected.push(format!(
                "{collection} org.freedesktop.DBus.Properties.Get {COLLECTION}.Locked"
            ));
        }
        if matches!(
            scenario,
            Scenario::Ordinary | Scenario::UnreadableItems | Scenario::UnexpectedPaths
        ) {
            expected.push(format!(
                "{collection} org.freedesktop.DBus.Properties.Get {COLLECTION}.Items"
            ));
        }
        match scenario {
            Scenario::Ordinary | Scenario::UnexpectedPaths => {
                for path in [
                    "/items/ordinary",
                    "/items/empty",
                    "/items/missing",
                    "/unexpected/item",
                    "/",
                ] {
                    expected.push(format!(
                        "{path} org.freedesktop.DBus.Properties.Get {ITEM}.Label"
                    ));
                }
                assert_eq!(
                    result.expect("labels"),
                    vec![
                        (KeychainStore::SecretService, "gh:github.com".to_string()),
                        (KeychainStore::SecretService, "unexpected-label".to_string()),
                    ]
                );
            }
            Scenario::Locked | Scenario::UnreadableLock | Scenario::WrongLockType => {
                assert!(result.expect("locked result").is_empty());
            }
            Scenario::MissingCollection | Scenario::UnreadableItems => {
                assert!(matches!(result, Err(ProbeError::Keychain(_))));
            }
        }
        // Exact wire transcript rules out OpenSession, Unlock, GetSecret,
        // GetAll, attributes, and any calls beyond the metadata allowlist.
        assert_eq!(calls, expected, "{scenario:?}");
    }
}
