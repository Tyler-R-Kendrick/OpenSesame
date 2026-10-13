//! WSL Tailscale bridge listener (Windows cannot reach WSL via 127.0.0.1).
use axum::Router;

pub(crate) async fn spawn_wsl_bridge(listen: &str, app: &Router) {
    let Some(port) = crate::tailscale::listen_port(listen) else {
        return;
    };
    let Some(bridge) = crate::tailscale::wsl_bridge_listen(port) else {
        return;
    };
    if bridge == listen {
        return;
    }
    let bridge_tcp = match tokio::net::TcpListener::bind(&bridge).await {
        Ok(listener) => listener,
        Err(error) => {
            tracing::warn!(%bridge, %error, "failed to bind WSL Tailscale bridge listen");
            return;
        }
    };
    tracing::info!(%bridge, "daemon TCP listening (WSL↔Windows Tailscale bridge)");
    let bridge_app = app.clone();
    tokio::spawn(async move {
        if let Err(error) = axum::serve(
            bridge_tcp,
            bridge_app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        {
            tracing::error!(%error, "wsl bridge serve failed");
        }
    });
}
