//! Own the already bound TCP listener without changing startup or listener error policy.
use axum::Router;

pub(super) fn spawn_tcp(tcp: tokio::net::TcpListener, app: Router) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if let Err(e) = axum::serve(
            tcp,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        {
            tracing::error!(error = %e, "tcp serve failed");
        }
    })
}
