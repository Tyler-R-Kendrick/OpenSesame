//! Unit and pact tests for the OpenBao adapter.

mod unit {
    use crate::*;

    #[tokio::test]
    async fn fails_closed_when_sealed() {
        let a = MemoryAuthority {
            quorum_ok: true,
            sealed: true,
        };
        assert!(matches!(
            a.create_handle("key").await,
            Err(AuthorityError::Unavailable)
        ));
    }

    #[tokio::test]
    async fn memory_denies_bearer_export() {
        let a = MemoryAuthority {
            quorum_ok: true,
            sealed: false,
        };
        let h = a.create_handle("x").await.unwrap();
        assert!(matches!(
            a.use_credential(&h, CredentialOperation::BearerHttpPlaceholder)
                .await,
            Err(AuthorityError::Denied(_))
        ));
    }

    #[test]
    fn from_env_absent() {
        std::env::remove_var("OPENSESAME_OPENBAO_URL");
        assert!(OpenBaoHttpAuthority::from_env().unwrap().is_none());
    }

    #[test]
    fn health_missing_sealed_is_unavailable() {
        assert!(parse_sys_health(&json!({})).is_err());
        assert!(handle_from_health(&json!({"sealed": true}), "k").is_err());
        let open = parse_sys_health(&json!({"sealed": false, "initialized": true})).unwrap();
        assert!(!open.sealed);
        assert!(open.quorum_ok);
    }
}

mod pact {
    use crate::*;

    #[test]
    fn property_https_and_loopback_http_are_accepted() {
        for ok in [
            "https://bao.example",
            "http://127.0.0.1:8200",
            "http://localhost:8200",
            "http://[::1]:8200",
        ] {
            assert!(assert_authority_base_url(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn adversarial_cleartext_remote_userinfo_and_bearer_are_refused() {
        for bad in [
            "http://evil.example",
            "https://user:secret@bao.example",
            "ftp://127.0.0.1",
        ] {
            assert!(assert_authority_base_url(bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn chaos_sealed_and_missing_health_never_mint_handles() {
        let sealed = MemoryAuthority {
            quorum_ok: true,
            sealed: true,
        };
        assert!(sealed.create_handle("k").await.is_err());
        assert!(parse_sys_health(&json!({})).is_err());
        assert!(handle_from_health(&json!({"sealed": true}), "k").is_err());
    }

    #[test]
    fn contract_url_guard_is_in_source_before_send() {
        let src = include_str!("lib.rs");
        let production = src.split("#[cfg(test)]").next().unwrap();
        let request = production
            .split("async fn request")
            .nth(1)
            .expect("request");
        let pin = request
            .find("assert_authority_base_url(&self.base)")
            .expect("assert_authority_base_url");
        let send = request.find(".send()").expect("send");
        assert!(pin < send);
    }

    #[tokio::test]
    #[ignore = "requires live OpenBao on OPENSESAME_OPENBAO_URL"]
    async fn live_openbao_denies_bearer() {
        let base = std::env::var("OPENSESAME_OPENBAO_URL").expect("url");
        let token = std::env::var("OPENSESAME_OPENBAO_TOKEN")
            .or_else(|_| std::env::var("BAO_TOKEN"))
            .expect("token");
        let a = OpenBaoHttpAuthority::new(base, token);
        let health = a.health().await.expect("health");
        assert!(!health.sealed);
        assert!(health.quorum_ok);
        a.kv_put("secret", "github/acme", json!({"token": "never-to-agent"}))
            .await
            .expect("kv put");
        let got = a.kv_get("secret", "github/acme").await.expect("kv get");
        // Internal plane can read — agent API must not.
        assert_eq!(got["token"], "never-to-agent");
        let h = a.create_handle("github/acme").await.unwrap();
        let err = a
            .use_credential(&h, CredentialOperation::BearerHttpPlaceholder)
            .await
            .unwrap_err();
        assert!(matches!(err, AuthorityError::Denied(_)));
    }
}
