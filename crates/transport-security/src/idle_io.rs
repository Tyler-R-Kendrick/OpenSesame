//! An `AsyncRead + AsyncWrite` wrapper that fails the connection when no
//! byte moves in either direction for `idle_timeout`.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::{sleep, Instant, Sleep};

pub(crate) struct IdleTimeout<S> {
    inner: S,
    timeout: Duration,
    sleep: Pin<Box<Sleep>>,
}

impl<S> IdleTimeout<S> {
    pub(crate) fn new(inner: S, timeout: Duration) -> Self {
        Self {
            inner,
            timeout,
            sleep: Box::pin(sleep(timeout)),
        }
    }

    fn touch(&mut self) {
        let deadline = Instant::now() + self.timeout;
        self.sleep.as_mut().reset(deadline);
    }

    fn poll_idle(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.sleep.as_mut().poll(cx) {
            Poll::Ready(()) => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "connection idle timeout",
            ))),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for IdleTimeout<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match Pin::new(&mut self.inner).poll_read(cx, buf) {
            Poll::Ready(result) => {
                self.touch();
                Poll::Ready(result)
            }
            Poll::Pending => self.poll_idle(cx),
        }
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for IdleTimeout<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match Pin::new(&mut self.inner).poll_write(cx, buf) {
            Poll::Ready(result) => {
                self.touch();
                Poll::Ready(result)
            }
            Poll::Pending => self.poll_idle(cx).map(|r| r.map(|()| 0)),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
