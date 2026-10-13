//! TCP/UDS/tailnet axum listeners (keeps `lib.rs` under the module-size gate).
use axum::Router;
use std::net::SocketAddr;

use crate::peer_auth::UdsConnectInfo;
use crate::App;

#[cfg(unix)]
pub(crate) async fn serve_uds_only(sock_path: &str, app: Router) -> anyhow::Result<()> {
    let _ = std::fs::remove_file(sock_path);
    if let Some(parent) = std::path::Path::new(sock_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let listener = tokio::net::UnixListener::bind(sock_path)?;
    tracing::info!(%sock_path, "daemon UDS-only listening (TCP disabled)");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<UdsConnectInfo>(),
    )
    .await?;
    Ok(())
}

#[cfg(unix)]
pub(crate) fn spawn_uds(sock_path: &str, app: Router) -> anyhow::Result<()> {
    let _ = std::fs::remove_file(sock_path);
    if let Some(parent) = std::path::Path::new(sock_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let listener = tokio::net::UnixListener::bind(sock_path)?;
    tracing::info!(%sock_path, "daemon UDS listening (peer-credential auth)");
    tokio::spawn(async move {
        if let Err(error) = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<UdsConnectInfo>(),
        )
        .await
        {
            tracing::error!(%error, "uds serve failed");
        }
    });
    Ok(())
}

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
            bridge_app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        {
            tracing::error!(%error, "wsl bridge serve failed");
        }
    });
}

#[cfg(all(unix, feature = "tailscale"))]
pub(crate) async fn spawn_tailnet(listen: &str, state: &App) {
    let policy = crate::tailnet::TailnetPolicy::from_env();
    if policy.allows_anyone() {
        let Some(listener) = crate::tailnet::bind_listener(listen, &policy).await else {
            tracing::warn!("tailnet listener not bound");
            return;
        };
        let addr = listener.local_addr().ok();
        tracing::info!(?addr, "daemon tailnet listening (whois auth)");
        let tailnet_app = crate::tailnet::router(state.clone(), policy);
        tokio::spawn(async move {
            if let Err(error) = axum::serve(
                listener,
                tailnet_app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            {
                tracing::error!(%error, "tailnet serve failed");
            }
        });
        return;
    }
    tracing::warn!(
        "tailscale feature on but {}/{} are empty — tailnet listener disabled (fail closed)",
        crate::tailnet::ENV_ALLOW_USERS,
        crate::tailnet::ENV_ALLOW_TAGS
    );
}
