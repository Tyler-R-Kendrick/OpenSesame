use url::Url;

use crate::request_host::host_is_private;
use crate::{single_value, AuthenticatorError, InvocationPolicy};

impl InvocationPolicy {
    /// Custom-scheme OID4VCI entry points must carry only a by-reference offer URI.
    ///
    /// # Errors
    ///
    /// Rejects malformed URLs, unsupported schemes, forbidden or ambiguous
    /// parameters, and insecure or private credential-offer URIs.
    pub fn validate_credential_offer_scheme(
        &self,
        raw: &str,
    ) -> Result<String, AuthenticatorError> {
        let url = Url::parse(raw).map_err(|_| AuthenticatorError::UnverifiedInvocationOrigin)?;
        if url.scheme() != "openid-credential-offer" && url.scheme() != "haip-vci" {
            return Err(AuthenticatorError::UnsupportedInvocation);
        }
        self.validate_scheme_request_uri_only(
            &url,
            "credential_offer_uri",
            &["openid-credential-offer", "haip-vci"],
        )?;
        Ok(raw.to_owned())
    }

    /// Custom-scheme OID4VP entry points must carry only a by-reference request URI.
    ///
    /// # Errors
    ///
    /// Rejects malformed URLs, unsupported schemes, forbidden or ambiguous
    /// parameters, and insecure or private request URIs.
    pub fn validate_presentation_scheme(&self, raw: &str) -> Result<String, AuthenticatorError> {
        let url = Url::parse(raw).map_err(|_| AuthenticatorError::UnverifiedInvocationOrigin)?;
        if !matches!(url.scheme(), "openid4vp" | "haip-vp" | "mdoc") {
            return Err(AuthenticatorError::UnsupportedInvocation);
        }
        self.validate_scheme_request_uri_only(&url, "request_uri", &["openid4vp", "haip-vp", "mdoc"])?;
        Ok(raw.to_owned())
    }

    fn validate_scheme_request_uri_only(
        &self,
        url: &Url,
        uri_key: &str,
        allowed_schemes: &[&str],
    ) -> Result<(), AuthenticatorError> {
        if !allowed_schemes.iter().any(|scheme| scheme == &url.scheme()) {
            return Err(AuthenticatorError::UnsupportedInvocation);
        }
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err(AuthenticatorError::ForbiddenInvocationParameter);
        }
        let pairs: Vec<_> = url.query_pairs().collect();
        if pairs.iter().any(|(key, _)| {
            matches!(
                key.as_ref(),
                "token"
                    | "access_token"
                    | "id_token"
                    | "code"
                    | "credential_offer"
                    | "password"
                    | "secret"
            )
        }) {
            return Err(AuthenticatorError::ForbiddenInvocationParameter);
        }
        let request_uri = single_value(&pairs, uri_key)?;
        if pairs.iter().any(|(key, _)| key.as_ref() != uri_key) {
            return Err(AuthenticatorError::ForbiddenInvocationParameter);
        }
        let Some(request_uri_value) = request_uri else {
            return Err(AuthenticatorError::InvalidInvocationPayload);
        };
        self.validate_request_uri(request_uri_value)?;
        Ok(())
    }

    pub(crate) fn validate_request_uri(&self, raw: &str) -> Result<Url, AuthenticatorError> {
        let uri = Url::parse(raw).map_err(|_| AuthenticatorError::InvalidInvocationPayloadValue)?;
        if uri.scheme() != "https" || uri.host_str().is_none() {
            return Err(AuthenticatorError::InsecureRequestUri);
        }
        if !uri.username().is_empty() || uri.password().is_some() || uri.fragment().is_some() {
            return Err(AuthenticatorError::InvalidInvocationPayloadValue);
        }
        if !self.allow_private_request_uris && host_is_private(&uri) {
            return Err(AuthenticatorError::PrivateRequestUri);
        }
        Ok(uri)
    }
}
