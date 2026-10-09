use super::*;
use std::cell::{Cell, RefCell};
#[derive(PartialEq, Eq)]
enum SendBehavior {
    Success,
    Fail,
    Hang,
}
struct Fake {
    addresses: Vec<SocketAddr>,
    events: RefCell<Vec<&'static str>>,
    read_fails: bool,
    rotated: bool,
    inspections: Cell<u32>,
    status: u16,
    body_size: usize,
    send_behavior: SendBehavior,
    claim_check: Option<(std::path::PathBuf, String)>,
}
impl Backend for Fake {
    async fn addresses(&self, _: &policy::Binding) -> anyhow::Result<Vec<SocketAddr>> {
        self.events.borrow_mut().push("dns");
        Ok(self.addresses.clone())
    }
    async fn inspect(&self, _: &str) -> anyhow::Result<lease::Resource> {
        self.events.borrow_mut().push("inspect");
        self.inspections.set(self.inspections.get() + 1);
        Ok(lease::Resource {
            id: "a".repeat(26),
            version: if self.rotated && self.inspections.get() > 1 {
                8
            } else {
                7
            },
        })
    }
    async fn read(&self, _: &str) -> anyhow::Result<zeroize::Zeroizing<Vec<u8>>> {
        self.events.borrow_mut().push("read");
        if let Some((root, id)) = &self.claim_check {
            assert_eq!(
                Store::at(root.clone())
                    .await?
                    .status(id)
                    .await?
                    .uses_remaining,
                0
            );
        }
        anyhow::ensure!(!self.read_fails, "Private read failed");
        Ok(zeroize::Zeroizing::new(b"PRIVATE-TOKEN\n".to_vec()))
    }
    async fn send(
        &self,
        _: &policy::Binding,
        addresses: &[SocketAddr],
        secret: &str,
    ) -> anyhow::Result<(u16, zeroize::Zeroizing<Vec<u8>>)> {
        assert_eq!(addresses, self.addresses);
        assert_eq!(secret, "PRIVATE-TOKEN");
        self.events.borrow_mut().push("send");
        anyhow::ensure!(
            self.send_behavior != SendBehavior::Fail,
            "Private send failed"
        );
        if self.send_behavior == SendBehavior::Hang {
            std::future::pending::<()>().await;
        }
        let body = if self.body_size == 0 {
            b"PRIVATE-TOKEN".to_vec()
        } else {
            vec![b'x'; self.body_size]
        };
        Ok((self.status, zeroize::Zeroizing::new(body)))
    }
}
fn fake() -> Fake {
    Fake {
        addresses: vec!["8.8.8.8:443".parse().unwrap()],
        events: RefCell::default(),
        read_fails: false,
        rotated: false,
        inspections: Cell::new(0),
        status: 200,
        body_size: 0,
        send_behavior: SendBehavior::Success,
        claim_check: None,
    }
}
#[tokio::test]
async fn private_requests_pin_public_dns_claim_before_read_and_withhold_response() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::at(root.path().to_path_buf()).await.unwrap();
    let binding = policy::describe(
        "https://example.com/private?token=url-token",
        "op://Vault/Item/token",
        "Authorization",
        "Bearer ",
    )
    .unwrap();
    let grant = store
        .grant(
            binding.clone(),
            lease::Resource {
                id: "a".repeat(26),
                version: 7,
            },
            600,
            1,
        )
        .await
        .unwrap();
    let mut backend = fake();
    backend.claim_check = Some((root.path().to_path_buf(), grant.id.clone()));
    let result = execute_with(&mut store, &grant.id, &binding, &backend)
        .await
        .unwrap();
    assert_eq!(
        *backend.events.borrow(),
        ["dns", "inspect", "read", "inspect", "send"]
    );
    assert_eq!(result["lease"]["usesRemaining"], 0);
    assert_eq!(result["secretEchoes"], 1);
    assert!(!result.to_string().contains("PRIVATE-TOKEN"));
    assert!(!result.to_string().contains("url-token"));
    assert_eq!(store.status(&grant.id).await.unwrap().uses_remaining, 0);
}
#[tokio::test]
async fn mixed_dns_denies_before_inspection_and_read_failures_or_rotation_burn_claims() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::at(root.path().to_path_buf()).await.unwrap();
    let binding = policy::describe(
        "https://example.com",
        "op://Vault/Item/token",
        "X-API-Key",
        "",
    )
    .unwrap();
    for mode in 0..3 {
        let grant = store
            .grant(
                binding.clone(),
                lease::Resource {
                    id: "a".repeat(26),
                    version: 7,
                },
                600,
                1,
            )
            .await
            .unwrap();
        let mut backend = fake();
        match mode {
            0 => backend.addresses.push("127.0.0.1:443".parse().unwrap()),
            1 => backend.read_fails = true,
            _ => backend.rotated = true,
        }
        assert!(execute_with(&mut store, &grant.id, &binding, &backend)
            .await
            .is_err());
        assert!(!backend.events.borrow().contains(&"send"));
        assert_eq!(
            store.status(&grant.id).await.unwrap().uses_remaining,
            u32::from(mode == 0)
        );
        if mode == 0 {
            assert_eq!(*backend.events.borrow(), ["dns"]);
        }
    }
}

#[tokio::test]
async fn bounded_private_requests_reject_redirects_oversize_stalls_and_send_failures_without_retry()
{
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::at(root.path().to_path_buf()).await.unwrap();
    let binding = policy::describe(
        "https://example.com/private",
        "op://Vault/Item/token",
        "Authorization",
        "Bearer ",
    )
    .unwrap();
    for mode in 0..4 {
        let grant = store
            .grant(
                binding.clone(),
                lease::Resource {
                    id: "a".repeat(26),
                    version: 7,
                },
                600,
                1,
            )
            .await
            .unwrap();
        let mut backend = fake();
        match mode {
            0 => backend.status = 302,
            1 => backend.body_size = 65_537,
            2 => backend.send_behavior = SendBehavior::Hang,
            _ => backend.send_behavior = SendBehavior::Fail,
        }
        let sends_before = backend
            .events
            .borrow()
            .iter()
            .filter(|e| **e == "send")
            .count();
        assert!(execute_bounded(
            &mut store,
            &grant.id,
            &binding,
            &backend,
            // CI runners can schedule slowly; a short deadline sometimes expired before
            // `send` was entered, yielding zero send events despite a consumed lease.
            Duration::from_millis(500)
        )
        .await
        .is_err());
        assert_eq!(
            backend
                .events
                .borrow()
                .iter()
                .filter(|e| **e == "send")
                .count(),
            sends_before + 1,
            "leased private request must reach send once before failing"
        );
        assert_eq!(store.status(&grant.id).await.unwrap().uses_remaining, 0);
    }
    for (url, header, prefix) in [
        ("http://example.com", "Authorization", ""),
        ("https://example.com:444", "Authorization", ""),
        ("https://user:pass@example.com", "Authorization", ""),
        ("https://example.com/#frag", "Authorization", ""),
        ("https://example.com", "Cookie", ""),
        ("https://example.com", "Authorization", "\r\n"),
    ] {
        assert!(policy::describe(url, "op://Vault/Item/token", header, prefix).is_err());
    }
}

#[tokio::test]
async fn native_transport_pins_socket_preserves_sni_verifies_tls_and_never_retries() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let binding = policy::describe(
        "https://example.com/private",
        "op://Vault/Item/token",
        "Authorization",
        "Bearer ",
    )
    .unwrap();
    let backend = NativeBackend {
        deadline: std::time::Instant::now() + Duration::from_secs(3),
    };
    let peer = async {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut bytes = vec![0; 8192];
        let count = stream.read(&mut bytes).await.unwrap();
        bytes.truncate(count);
        assert!(bytes
            .windows(b"example.com".len())
            .any(|w| w == b"example.com"));
        assert!(!bytes
            .windows(b"PRIVATE-TOKEN".len())
            .any(|w| w == b"PRIVATE-TOKEN"));
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
        drop(stream);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    };
    let addresses = [address];
    let (result, ()) = tokio::join!(backend.send(&binding, &addresses, "PRIVATE-TOKEN"), peer);
    assert!(result.is_err());
}

#[tokio::test]
async fn native_deadline_bounds_blocked_local_io_and_drops_late_private_results() {
    let start = std::time::Instant::now();
    let result = local_call(start + Duration::from_millis(20), move || {
        std::thread::sleep(Duration::from_millis(100));
        Ok(zeroize::Zeroizing::new(b"late-private-value".to_vec()))
    })
    .await;
    assert!(result.is_err());
    assert!(start.elapsed() < Duration::from_millis(80));
    assert!(!result
        .unwrap_err()
        .to_string()
        .contains("late-private-value"));
}
