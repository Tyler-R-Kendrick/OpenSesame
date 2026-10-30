//! The optional TLS listener cannot preserve a local-only startup policy.
use super::{Args, GatewayProfile, StartupSecurity};

struct Restore(Vec<(String, Option<std::ffi::OsString>)>);

impl Restore {
    fn new() -> Self {
        let mut names: Vec<_> = [
            "OPENSESAME_ENV",
            "NODE_ENV",
            "OPENSESAME_ALLOW_DEV_DEFAULTS",
            "OPENSESAME_TLS_LISTEN",
            "OPENSESAME_TLS_POLICY",
            "OPENSESAME_TLS_IDENTITY_SOURCE",
            "OPENSESAME_TLS_CERT_FILE",
            "OPENSESAME_TLS_KEY_FILE",
            "OPENSESAME_TLS_TRUST_FILE",
            "OPENSESAME_TLS_TRUST_KIND",
            "OPENSESAME_PUBLIC_URL",
            "OPENSESAME_CALLBACK_BASE",
            "OPENSESAME_A2H_ATTACH_BASE",
            "OPENSESAME_HOST_AUTHORIZATION_ISSUER",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        names.extend(
            opensesame_host_core::endpoints::all()
                .filter(|(id, _)| *id != opensesame_host_core::endpoints::DAEMON)
                .flat_map(|(_, endpoint)| endpoint.address.names())
                .map(str::to_owned),
        );
        let saved = names
            .into_iter()
            .map(|name| {
                let previous = std::env::var_os(&name);
                std::env::remove_var(&name);
                (name, previous)
            })
            .collect();
        Self(saved)
    }
}

impl Drop for Restore {
    fn drop(&mut self) {
        for (name, previous) in self.0.drain(..) {
            match previous {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

#[test]
fn every_network_listener_disables_local_development_defaults_before_secrets_or_io() {
    let _lock = crate::app_state::test_env::lock();
    let _restore = Restore::new();
    for (name, value) in [
        ("OPENSESAME_ENV", "development"),
        ("OPENSESAME_ALLOW_DEV_DEFAULTS", "1"),
        ("OPENSESAME_TLS_POLICY", "server_tls"),
        ("OPENSESAME_TLS_IDENTITY_SOURCE", "pem"),
        ("OPENSESAME_TLS_CERT_FILE", "/not-read/server.pem"),
        ("OPENSESAME_TLS_KEY_FILE", "/not-read/server.key"),
    ] {
        std::env::set_var(name, value);
    }
    let args = Args {
        listen: "127.0.0.1:8787".parse().unwrap(),
        resource: "http://localhost:8787".into(),
        issuer: "http://localhost:8788".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
        profile: GatewayProfile::Host,
    };
    for listen in ["0.0.0.0:8443", "[::]:8443", "192.0.2.1:8443"] {
        std::env::set_var("OPENSESAME_TLS_LISTEN", listen);
        let error = StartupSecurity::load(&args)
            .err()
            .expect("networked defaults refused");
        assert!(error.contains("requires local-only exposure"), "{error}");
    }
}
