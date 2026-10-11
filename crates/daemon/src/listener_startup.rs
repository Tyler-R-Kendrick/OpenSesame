//! Own startup validation and logging before the original transport decisions.
use super::{
    startup::{build_state, secured_router},
    App, Args,
};
use axum::Router;
use std::env;

pub(super) struct Prepared {
    pub(super) listen: String,
    pub(super) sock: Option<String>,
    pub(super) state: App,
    pub(super) app: Router,
    pub(super) uds_only: bool,
}

pub(super) fn prepare(args: &Args) -> anyhow::Result<Prepared> {
    let listen = args.listen.clone();
    let sock = args
        .sock
        .clone()
        .or_else(|| env::var("OPENSESAME_AGENT_SOCK").ok());

    let (state, hsts) = build_state(args)?;
    let app = secured_router(state.clone(), hsts)?;

    let uds_only = opensesame_host_core::daemon::uds_only_requested();
    tracing::info!(
        %listen,
        sock = ?sock,
        uds_only,
        wit = opensesame_host_core::wit_contract::PACKAGE,
        "daemon starting"
    );

    Ok(Prepared {
        listen,
        sock,
        state,
        app,
        uds_only,
    })
}
