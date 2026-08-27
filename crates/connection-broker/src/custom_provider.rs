//! Org-scoped custom connectors: any HTTPS service with standard OAuth 2.0
//! authorization-code or API-key auth — an MCP server, an `OpenAPI` backend, an
//! internal API.
//!
//! A definition is public metadata only. OAuth client credentials for a custom
//! provider are sealed through the existing integrations surface, and API keys
//! through connection credentials, so nothing here ever touches a secret.
//!
//! The egress allowlist is derived from the base URL, never stated by the
//! caller: a custom connector's credential can only ever be attached to
//! requests to that origin (ADR 0048 D6/D7 posture).

use serde::Deserialize;
use url::Url;

use crate::catalog::{AuthMethod, Category, EgressSpec, Provider, ScopeDef, TokenAuth};
use crate::error::{BrokerError, Result};

/// Ids must carry this prefix so a custom definition can never shadow a
/// catalog provider, present or future.
pub const CUSTOM_PROVIDER_PREFIX: &str = "custom-";

const MAX_ID: usize = 64;
const MAX_NAME: usize = 80;
const MAX_URL: usize = 512;
const MAX_SCOPES: usize = 32;
const MAX_SCOPE_NAME: usize = 64;
const MAX_HEADER: usize = 64;
const MAX_PREFIX: usize = 32;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CustomAuthSpec {
    Oauth2AuthorizationCode {
        authorize_url: String,
        token_url: String,
        #[serde(default)]
        supports_refresh: bool,
        #[serde(default)]
        scopes: Vec<String>,
    },
    ApiKey {
        header: String,
        #[serde(default)]
        value_prefix: String,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateCustomProvider {
    pub id: String,
    pub display_name: String,
    pub base_url: String,
    #[serde(default)]
    pub docs_url: Option<String>,
    pub auth: CustomAuthSpec,
}

fn invalid(message: impl Into<String>) -> BrokerError {
    BrokerError::Invalid(message.into())
}

fn valid_id(id: &str) -> Result<()> {
    if id.len() > MAX_ID {
        return Err(invalid(format!("id exceeds {MAX_ID} characters")));
    }
    let Some(rest) = id.strip_prefix(CUSTOM_PROVIDER_PREFIX) else {
        return Err(invalid(format!(
            "id must start with `{CUSTOM_PROVIDER_PREFIX}`"
        )));
    };
    let ok = !rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !rest.starts_with('-')
        && !rest.ends_with('-');
    if !ok {
        return Err(invalid(
            "id may only contain lowercase letters, digits, and interior dashes",
        ));
    }
    Ok(())
}

/// HTTPS only, host required, no userinfo/query/fragment. An authorization
/// fabric must not learn plaintext-HTTP habits from its most flexible surface.
fn https_url(raw: &str, field: &str) -> Result<Url> {
    if raw.len() > MAX_URL {
        return Err(invalid(format!("{field} exceeds {MAX_URL} characters")));
    }
    let url = Url::parse(raw).map_err(|_| invalid(format!("{field} is not a valid URL")))?;
    if url.scheme() != "https" {
        return Err(invalid(format!("{field} must be https")));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(invalid(format!("{field} needs a host")));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid(format!("{field} must not carry credentials")));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(invalid(format!(
            "{field} must not carry a query or fragment"
        )));
    }
    Ok(url)
}

fn authority(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

fn scope_defs(names: &[String]) -> Result<Vec<ScopeDef>> {
    if names.len() > MAX_SCOPES {
        return Err(invalid(format!("at most {MAX_SCOPES} scopes")));
    }
    let mut defs = Vec::new();
    for name in names {
        let name = name.trim();
        if name.is_empty() || name.len() > MAX_SCOPE_NAME || name.chars().any(char::is_whitespace) {
            return Err(invalid("scope names must be short and whitespace-free"));
        }
        if defs.iter().any(|d: &ScopeDef| d.name == name) {
            return Err(invalid(format!("duplicate scope `{name}`")));
        }
        defs.push(ScopeDef {
            name: name.to_string(),
            description: String::new(),
            sensitive: false,
            default: true,
        });
    }
    Ok(defs)
}

/// Validate a request and derive the catalog `Provider` it defines.
///
/// # Errors
///
/// Returns an error when any field fails validation.
pub fn derive_provider(request: &CreateCustomProvider) -> Result<Provider> {
    let id = request.id.trim().to_string();
    valid_id(&id)?;
    let display_name = request.display_name.trim().to_string();
    if display_name.is_empty() || display_name.len() > MAX_NAME {
        return Err(invalid(format!(
            "display_name is required and capped at {MAX_NAME} characters"
        )));
    }
    let base = https_url(request.base_url.trim(), "base_url")?;
    let docs_url = match request.docs_url.as_deref().map(str::trim) {
        None | Some("") => request.base_url.trim().to_string(),
        Some(docs) => https_url(docs, "docs_url")?.to_string(),
    };

    let (auth, scopes) = match &request.auth {
        CustomAuthSpec::Oauth2AuthorizationCode {
            authorize_url,
            token_url,
            supports_refresh,
            scopes,
        } => {
            https_url(authorize_url.trim(), "authorize_url")?;
            https_url(token_url.trim(), "token_url")?;
            (
                AuthMethod::OAuth2AuthCode {
                    authorize_url: authorize_url.trim().to_string(),
                    token_url: token_url.trim().to_string(),
                    revoke_url: None,
                    supports_refresh: *supports_refresh,
                    token_auth: TokenAuth::ClientSecretPost,
                    scope_separator: None,
                    extra_authorize_params: Vec::new(),
                },
                scope_defs(scopes)?,
            )
        }
        CustomAuthSpec::ApiKey {
            header,
            value_prefix,
        } => {
            let header = header.trim();
            let header_ok = !header.is_empty()
                && header.len() <= MAX_HEADER
                && header
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-');
            if !header_ok {
                return Err(invalid("header must be a plain HTTP header name"));
            }
            if value_prefix.len() > MAX_PREFIX || value_prefix.chars().any(|c| c.is_ascii_control())
            {
                return Err(invalid("value_prefix must be short printable text"));
            }
            (
                AuthMethod::ApiKey {
                    header: header.to_string(),
                    value_prefix: value_prefix.clone(),
                },
                Vec::new(),
            )
        }
    };

    let path = base.path().trim_end_matches('/');
    Ok(Provider {
        id,
        display_name,
        category: Category::Custom,
        docs_url: docs_url.clone(),
        provenance_url: docs_url,
        auth,
        scopes,
        egress: EgressSpec {
            scheme: "https".to_string(),
            authorities: vec![authority(&base)],
            path_prefixes: if path.is_empty() {
                Vec::new()
            } else {
                vec![path.to_string()]
            },
        },
        operations: vec!["http.authorized".into()],
        integration_configuration_fields: Vec::new(),
        connection_configuration_fields: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oauth_request() -> CreateCustomProvider {
        CreateCustomProvider {
            id: "custom-acme-mcp".into(),
            display_name: "Acme MCP".into(),
            base_url: "https://mcp.acme.dev".into(),
            docs_url: None,
            auth: CustomAuthSpec::Oauth2AuthorizationCode {
                authorize_url: "https://mcp.acme.dev/oauth/authorize".into(),
                token_url: "https://mcp.acme.dev/oauth/token".into(),
                supports_refresh: true,
                scopes: vec!["tools:read".into(), "tools:invoke".into()],
            },
        }
    }

    #[test]
    fn derives_an_oauth_provider_with_origin_bound_egress() {
        let provider = derive_provider(&oauth_request()).expect("derive");
        assert_eq!(provider.id, "custom-acme-mcp");
        assert_eq!(provider.category, Category::Custom);
        assert_eq!(provider.egress.scheme, "https");
        assert_eq!(provider.egress.authorities, vec!["mcp.acme.dev"]);
        assert!(provider.egress.path_prefixes.is_empty());
        assert!(provider.auth.is_oauth());
        assert!(provider.auth.supports_refresh());
        assert_eq!(provider.default_scopes().len(), 2);
    }

    #[test]
    fn keeps_a_base_path_as_the_egress_prefix_and_port_in_authority() {
        let mut request = oauth_request();
        request.base_url = "https://internal.acme.dev:8443/api/v2/".into();
        let provider = derive_provider(&request).expect("derive");
        assert_eq!(provider.egress.authorities, vec!["internal.acme.dev:8443"]);
        assert_eq!(provider.egress.path_prefixes, vec!["/api/v2"]);
    }

    #[test]
    fn derives_an_api_key_provider_with_the_key_field() {
        let request = CreateCustomProvider {
            id: "custom-internal".into(),
            display_name: "Internal API".into(),
            base_url: "https://api.internal.dev".into(),
            docs_url: None,
            auth: CustomAuthSpec::ApiKey {
                header: "Authorization".into(),
                value_prefix: "Bearer ".into(),
            },
        };
        let provider = derive_provider(&request).expect("derive");
        assert_eq!(provider.auth.kind(), "api_key");
        assert_eq!(
            provider
                .connection_configuration_fields()
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>(),
            vec!["api_key"],
        );
    }

    #[test]
    fn rejects_ids_that_could_shadow_the_catalog() {
        for bad in ["github", "custom-", "custom-Bad", "custom--x", "custom-x-"] {
            let mut request = oauth_request();
            request.id = bad.into();
            assert!(derive_provider(&request).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_plaintext_and_decorated_urls() {
        for bad in [
            "http://mcp.acme.dev",
            "https://user:pw@mcp.acme.dev",
            "https://mcp.acme.dev/?x=1",
            "https://mcp.acme.dev/#frag",
            "not a url",
        ] {
            let mut request = oauth_request();
            request.base_url = bad.into();
            assert!(derive_provider(&request).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_hostile_scope_and_header_shapes() {
        let mut request = oauth_request();
        request.auth = CustomAuthSpec::Oauth2AuthorizationCode {
            authorize_url: "https://mcp.acme.dev/a".into(),
            token_url: "https://mcp.acme.dev/t".into(),
            supports_refresh: false,
            scopes: vec!["with space".into()],
        };
        assert!(derive_provider(&request).is_err());

        let request = CreateCustomProvider {
            id: "custom-x".into(),
            display_name: "X".into(),
            base_url: "https://x.dev".into(),
            docs_url: None,
            auth: CustomAuthSpec::ApiKey {
                header: "X-Key\r\nEvil".into(),
                value_prefix: String::new(),
            },
        };
        assert!(derive_provider(&request).is_err());
    }
}
