//! Scripted-fault loopback listener shared by the chaos integration tests.
//!
//! Deterministic by construction: the test picks the fault, the listener
//! applies it to every connection it accepts, and the accepted-connection
//! count is observable so fail-closed cases can prove the wire was — or was
//! never — touched. No randomness, no real network, no sleeps beyond the
//! `SlowDrip` byte cadence.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};

/// What the listener does to every connection it accepts.
#[derive(Debug, Clone, Copy)]
pub enum Fault {
    /// Accept, then close immediately — an abrupt reset from the client's
    /// point of view, whether it is mid-write or awaiting the response head.
    Reset,
    /// Accept, then never respond. The connection is held open until the
    /// listener is dropped, so it outlives any client-side timeout.
    Stall,
    /// Accept, then write bytes that are not an HTTP response and close.
    Garbage,
    /// Write a partial, otherwise valid HTTP/1.1 response one byte at a
    /// time, then close in the middle of the declared body.
    SlowDrip,
}

/// A loopback TCP listener applying one scripted fault to everything it
/// accepts. Dropping it aborts the accept loop and every parked connection,
/// so no test can leave a wedged task behind.
pub struct FaultListener {
    addr: SocketAddr,
    connections: Arc<AtomicUsize>,
    accept_loop: JoinHandle<()>,
}

impl FaultListener {
    #[expect(
        clippy::excessive_nesting,
        reason = "the nested tasks model the test listener's accept and connection lifetimes"
    )]
    pub async fn spawn(fault: Fault) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let counting = connections.clone();
        let accept_loop = tokio::spawn(async move {
            // The JoinSet aborts every per-connection task when it is
            // dropped, which happens when the accept loop itself is aborted
            // — a parked Stall connection cannot outlive the test.
            let mut tasks = JoinSet::new();
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                counting.fetch_add(1, Ordering::SeqCst);
                tasks.spawn(async move { apply(fault, &mut stream).await });
            }
        });
        Self {
            addr,
            connections,
            accept_loop,
        }
    }

    /// Loopback base URL (`http://127.0.0.1:PORT`) for test invokers.
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Connections accepted so far — the fail-closed witness.
    pub fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }
}

impl Drop for FaultListener {
    fn drop(&mut self) {
        self.accept_loop.abort();
    }
}

async fn apply(fault: Fault, stream: &mut TcpStream) {
    match fault {
        // Drop on the spot: the peer sees an abrupt close.
        Fault::Reset => {}
        // Hold the socket open and say nothing, until aborted.
        Fault::Stall => std::future::pending::<()>().await,
        Fault::Garbage => {
            let _ = stream
                .write_all(b"\x89chaos: this is not an HTTP response\r\n\r\n")
                .await;
        }
        Fault::SlowDrip => {
            // A valid head promising 64 body bytes, dripped out, then an
            // abrupt close after only a few of them. The per-byte cadence
            // keeps this well under any sane client timeout.
            let head: &[u8] = b"HTTP/1.1 200 OK\r\n\
                content-type: application/json\r\n\
                content-length: 64\r\n\
                \r\n";
            for chunk in head.iter().chain(b"{\"partial".iter()) {
                if stream.write_all(&[*chunk]).await.is_err() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
    }
}
