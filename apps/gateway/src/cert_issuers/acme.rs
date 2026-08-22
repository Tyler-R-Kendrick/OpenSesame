use std::fmt;
use std::future::Future;
use std::pin::Pin;

use async_trait::async_trait;
use bytes::Bytes;
use http::{Request, Response};
use http_body_util::BodyExt;
use instant_acme::{
    Account, AccountBuilder, AccountCredentials, AuthorizationStatus, BodyWrapper, BytesResponse,
    ChallengeType, HttpClient, Identifier, LetsEncrypt, NewAccount, NewOrder, OrderStatus,
    RetryPolicy, ZeroSsl,
};
use serde_json::Value;
use zeroize::Zeroizing;

use super::model::{
    normalize_external_certificate, CertificateRequest, ChallengeKind, GeneratedLeafRequest,
    IssuedCertificate, IssuerError, IssuerKind,
};

const MAX_ACME_BODY_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
struct ReqwestAcmeHttp(reqwest::Client, &'static str);

impl ReqwestAcmeHttp {
    fn new(provider: AcmeProvider) -> Result<Self, IssuerError> {
        reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map(|client| Self(client, provider.endpoint_host()))
            .map_err(|_| IssuerError::Acme("client_setup"))
    }
}

impl HttpClient for ReqwestAcmeHttp {
    fn request(
        &self,
        request: Request<BodyWrapper<Bytes>>,
    ) -> Pin<Box<dyn Future<Output = Result<BytesResponse, instant_acme::Error>> + Send>> {
        let client = self.0.clone();
        let allowed_host = self.1;
        Box::pin(async move {
            let (parts, body) = request.into_parts();
            if parts.uri.scheme_str() != Some("https")
                || parts.uri.host() != Some(allowed_host)
                || !matches!(parts.uri.port_u16(), None | Some(443))
            {
                return Err(instant_acme::Error::Other(
                    std::io::Error::other("ACME endpoint is outside the issuer boundary").into(),
                ));
            }
            let body = body
                .collect()
                .await
                .expect("infallible ACME request body")
                .to_bytes();
            if body.len() > MAX_ACME_BODY_BYTES {
                return Err(instant_acme::Error::Other(
                    std::io::Error::other("ACME request body exceeds limit").into(),
                ));
            }
            let mut response = client
                .request(parts.method, parts.uri.to_string())
                .headers(parts.headers)
                .body(body)
                .send()
                .await
                .map_err(|error| instant_acme::Error::Other(error.into()))?;
            let status = response.status();
            let version = response.version();
            let headers = response.headers().clone();
            let mut body = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| instant_acme::Error::Other(error.into()))?
            {
                if body.len().saturating_add(chunk.len()) > MAX_ACME_BODY_BYTES {
                    return Err(instant_acme::Error::Other(
                        std::io::Error::other("ACME response body exceeds limit").into(),
                    ));
                }
                body.extend_from_slice(&chunk);
            }
            let mut response = Response::builder().status(status).version(version);
            *response
                .headers_mut()
                .expect("response builder accepts headers") = headers;
            Ok(response
                .body(BodyWrapper::from(body))
                .expect("response builder accepts bounded body")
                .into())
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AcmeEnvironment {
    Production,
    Staging,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AcmeProvider {
    LetsEncrypt(AcmeEnvironment),
    ZeroSsl,
}

impl AcmeProvider {
    pub const fn directory_url(self) -> &'static str {
        match self {
            Self::LetsEncrypt(AcmeEnvironment::Production) => LetsEncrypt::Production.url(),
            Self::LetsEncrypt(AcmeEnvironment::Staging) => LetsEncrypt::Staging.url(),
            Self::ZeroSsl => ZeroSsl::Production.url(),
        }
    }

    pub const fn issuer(self) -> IssuerKind {
        match self {
            Self::LetsEncrypt(AcmeEnvironment::Production) => IssuerKind::LetsEncrypt,
            Self::LetsEncrypt(AcmeEnvironment::Staging) => IssuerKind::LetsEncryptStaging,
            Self::ZeroSsl => IssuerKind::ZeroSsl,
        }
    }

    const fn endpoint_host(self) -> &'static str {
        match self {
            Self::LetsEncrypt(AcmeEnvironment::Production) => "acme-v02.api.letsencrypt.org",
            Self::LetsEncrypt(AcmeEnvironment::Staging) => "acme-staging-v02.api.letsencrypt.org",
            Self::ZeroSsl => "acme.zerossl.com",
        }
    }
}

pub struct ExternalAccountBinding {
    key_id: String,
    hmac_key: Zeroizing<Vec<u8>>,
}

impl fmt::Debug for ExternalAccountBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExternalAccountBinding")
            .field("key_id", &"[REDACTED]")
            .field("hmac_key", &"[REDACTED]")
            .finish()
    }
}

impl ExternalAccountBinding {
    pub fn new(key_id: String, hmac_key: Vec<u8>) -> Result<Self, IssuerError> {
        if key_id.is_empty()
            || key_id.len() > 256
            || !key_id.is_ascii()
            || key_id.bytes().any(|byte| byte.is_ascii_control())
            || hmac_key.len() < 16
            || hmac_key.len() > 1024
        {
            return Err(IssuerError::InvalidAccountConfiguration);
        }
        Ok(Self {
            key_id,
            hmac_key: Zeroizing::new(hmac_key),
        })
    }
}

pub struct AcmeAccountCredentials(Zeroizing<String>);

impl fmt::Debug for AcmeAccountCredentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AcmeAccountCredentials([REDACTED])")
    }
}

impl AcmeAccountCredentials {
    pub fn as_bytes_for_sealing(&self) -> &[u8] {
        self.0.as_bytes()
    }

    pub fn from_unsealed(json: String) -> Self {
        Self(Zeroizing::new(json))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Dns01Failure {
    Unavailable,
    Rejected,
    CleanupFailed,
}

pub struct Dns01Record {
    name: String,
    value: Zeroizing<String>,
}

impl fmt::Debug for Dns01Record {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Dns01Record")
            .field("name", &self.name)
            .field("value", &"[REDACTED]")
            .finish()
    }
}

impl Dns01Record {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn value(&self) -> &str {
        &self.value
    }
}

pub struct Dns01Lease<T>(pub T);

#[async_trait]
pub trait Dns01Provisioner: Send + Sync {
    type Lease: Send;

    /// Returns after the DNS provider accepts the TXT value. The bounded ACME
    /// authorization poll is the authoritative propagation check.
    async fn present(&self, record: &Dns01Record) -> Result<Dns01Lease<Self::Lease>, Dns01Failure>;

    async fn cleanup(&self, lease: Dns01Lease<Self::Lease>) -> Result<(), Dns01Failure>;
}

pub struct AcmeAccount {
    provider: AcmeProvider,
    account: Account,
}

impl fmt::Debug for AcmeAccount {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AcmeAccount")
            .field("provider", &self.provider)
            .field("account", &"[REDACTED]")
            .finish()
    }
}

impl AcmeAccount {
    pub const fn provider_kind(&self) -> IssuerKind {
        self.provider.issuer()
    }

    pub async fn create(
        provider: AcmeProvider,
        contacts: &[String],
        external_account: Option<ExternalAccountBinding>,
    ) -> Result<(Self, AcmeAccountCredentials), IssuerError> {
        let builder = Account::builder_with_http(Box::new(ReqwestAcmeHttp::new(provider)?));
        Self::create_with_builder(builder, provider, contacts, external_account).await
    }

    async fn create_with_builder(
        builder: AccountBuilder,
        provider: AcmeProvider,
        contacts: &[String],
        external_account: Option<ExternalAccountBinding>,
    ) -> Result<(Self, AcmeAccountCredentials), IssuerError> {
        validate_contacts(contacts)?;
        match (provider, external_account.as_ref()) {
            (AcmeProvider::ZeroSsl, None) => {
                return Err(IssuerError::ExternalAccountBindingRequired)
            }
            (AcmeProvider::LetsEncrypt(_), Some(_)) => {
                return Err(IssuerError::UnexpectedExternalAccountBinding)
            }
            _ => {}
        }
        let contact_refs = contacts.iter().map(String::as_str).collect::<Vec<_>>();
        let external_key = external_account.as_ref().map(|binding| {
            instant_acme::ExternalAccountKey::new(
                binding.key_id.clone(),
                binding.hmac_key.as_slice(),
            )
        });
        let (account, credentials) = builder
            .create(
                &NewAccount {
                    contact: &contact_refs,
                    terms_of_service_agreed: true,
                    only_return_existing: false,
                },
                provider.directory_url().to_owned(),
                external_key.as_ref(),
            )
            .await
            .map_err(|_| IssuerError::Acme("account_create"))?;
        let credentials = serde_json::to_string(&credentials)
            .map(Zeroizing::new)
            .map(AcmeAccountCredentials)
            .map_err(|_| IssuerError::InvalidAccountConfiguration)?;
        Ok((Self { provider, account }, credentials))
    }

    pub async fn restore(
        provider: AcmeProvider,
        credentials: AcmeAccountCredentials,
    ) -> Result<Self, IssuerError> {
        let value: Value = serde_json::from_str(&credentials.0)
            .map_err(|_| IssuerError::InvalidAccountConfiguration)?;
        if value.get("directory").and_then(Value::as_str) != Some(provider.directory_url()) {
            return Err(IssuerError::InvalidAccountConfiguration);
        }
        let parsed: AccountCredentials =
            serde_json::from_value(value).map_err(|_| IssuerError::InvalidAccountConfiguration)?;
        let account = Account::builder_with_http(Box::new(ReqwestAcmeHttp::new(provider)?))
            .from_credentials(parsed)
            .await
            .map_err(|_| IssuerError::Acme("account_restore"))?;
        Ok(Self { provider, account })
    }

    pub async fn issue_dns01<P: Dns01Provisioner>(
        &self,
        request: &CertificateRequest,
        challenge: ChallengeKind,
        dns: &P,
    ) -> Result<IssuedCertificate, IssuerError> {
        challenge.require_dns01()?;
        request.require_public_dns()?;

        let identifiers = request
            .dns_names()
            .iter()
            .cloned()
            .map(Identifier::Dns)
            .collect::<Vec<_>>();
        let mut order = self
            .account
            .new_order(&NewOrder::new(&identifiers))
            .await
            .map_err(|_| IssuerError::Acme("order_create"))?;
        let mut leases = Vec::new();

        let outcome = async {
            let mut authorizations = order.authorizations();
            while let Some(result) = authorizations.next().await {
                let mut authorization = result.map_err(|_| IssuerError::Acme("authorization"))?;
                match authorization.status {
                    AuthorizationStatus::Valid => continue,
                    AuthorizationStatus::Pending => {}
                    _ => return Err(IssuerError::Acme("authorization_state")),
                }
                let mut challenge = authorization
                    .challenge(ChallengeType::Dns01)
                    .ok_or(IssuerError::Acme("dns01_unavailable"))?;
                let identifier = challenge.identifier().to_string();
                let bare = identifier.strip_prefix("*.").unwrap_or(&identifier);
                let record = Dns01Record {
                    name: format!("_acme-challenge.{bare}"),
                    value: Zeroizing::new(challenge.key_authorization().dns_value()),
                };
                let lease = dns
                    .present(&record)
                    .await
                    .map_err(|_| IssuerError::Dns01("present"))?;
                leases.push(lease);
                challenge
                    .set_ready()
                    .await
                    .map_err(|_| IssuerError::Acme("challenge_ready"))?;
            }

            if order
                .poll_ready(&RetryPolicy::default())
                .await
                .map_err(|_| IssuerError::Acme("order_validation"))?
                != OrderStatus::Ready
            {
                return Err(IssuerError::Acme("order_invalid"));
            }
            let leaf = GeneratedLeafRequest::generate(request)?;
            order
                .finalize_csr(leaf.csr_der())
                .await
                .map_err(|_| IssuerError::Acme("finalize"))?;
            let chain = order
                .poll_certificate(&RetryPolicy::default())
                .await
                .map_err(|_| IssuerError::Acme("certificate"))?;
            normalize_external_certificate(chain, leaf, request, self.provider.issuer(), true)
        }
        .await;

        let mut cleanup_failed = false;
        while let Some(lease) = leases.pop() {
            cleanup_failed |= dns.cleanup(lease).await.is_err();
        }
        match (outcome, cleanup_failed) {
            (Ok(_), true) => Err(IssuerError::Dns01("cleanup")),
            (Err(_), true) => Err(IssuerError::AcmeAndDnsCleanup),
            (result, false) => result,
        }
    }
}

fn validate_contacts(contacts: &[String]) -> Result<(), IssuerError> {
    if contacts.len() > 4
        || contacts.iter().any(|contact| {
            contact.len() > 320
                || !contact.is_ascii()
                || !contact.starts_with("mailto:")
                || contact.bytes().any(|byte| byte.is_ascii_control())
                || contact.bytes().any(|byte| byte.is_ascii_whitespace())
                || !contact[7..].contains('@')
        })
    {
        return Err(IssuerError::InvalidAccountConfiguration);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};

    use base64::prelude::{Engine, BASE64_URL_SAFE_NO_PAD};
    use bytes::Bytes;
    use http::{Method, Request, Response, StatusCode};
    use http_body_util::BodyExt;
    use instant_acme::{BodyWrapper, BytesResponse, HttpClient};
    use rcgen::{
        BasicConstraints, CertificateParams, CertificateSigningRequestParams, DistinguishedName,
        DnType, IsCa, KeyPair,
    };

    use super::super::model::{CertificateRequestInput, TrustClass};
    use super::*;

    #[derive(Default)]
    struct MockDns {
        presented: Mutex<Vec<String>>,
        cleaned: Mutex<Vec<String>>,
        cleanup_fails: bool,
    }

    #[async_trait]
    impl Dns01Provisioner for MockDns {
        type Lease = String;

        async fn present(
            &self,
            record: &Dns01Record,
        ) -> Result<Dns01Lease<Self::Lease>, Dns01Failure> {
            assert_eq!(record.name(), "_acme-challenge.example.test");
            assert!(!record.value().is_empty());
            self.presented
                .lock()
                .unwrap()
                .push(record.name().to_owned());
            Ok(Dns01Lease(record.name().to_owned()))
        }

        async fn cleanup(&self, lease: Dns01Lease<Self::Lease>) -> Result<(), Dns01Failure> {
            self.cleaned.lock().unwrap().push(lease.0);
            if self.cleanup_fails {
                Err(Dns01Failure::CleanupFailed)
            } else {
                Ok(())
            }
        }
    }

    struct MockAcmeHttp {
        ca: Arc<(rcgen::Certificate, KeyPair)>,
        issued_chain: Arc<Mutex<Option<String>>>,
    }

    impl MockAcmeHttp {
        fn new() -> Self {
            let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
            let mut params = CertificateParams::default();
            params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
            params.distinguished_name = DistinguishedName::new();
            params
                .distinguished_name
                .push(DnType::CommonName, "Mock ACME CA");
            let cert = params.self_signed(&key).unwrap();
            Self {
                ca: Arc::new((cert, key)),
                issued_chain: Arc::new(Mutex::new(None)),
            }
        }

        fn response(
            status: StatusCode,
            location: Option<&str>,
            body: impl Into<Vec<u8>>,
        ) -> BytesResponse {
            let mut builder = Response::builder()
                .status(status)
                .header("replay-nonce", uuid::Uuid::new_v4().to_string());
            if let Some(location) = location {
                builder = builder.header("location", location);
            }
            let response = builder.body(BodyWrapper::from(body.into())).unwrap();
            response.into()
        }
    }

    impl HttpClient for MockAcmeHttp {
        fn request(
            &self,
            mut request: Request<BodyWrapper<Bytes>>,
        ) -> Pin<Box<dyn Future<Output = Result<BytesResponse, instant_acme::Error>> + Send>>
        {
            let ca = self.ca.clone();
            let issued_chain = self.issued_chain.clone();
            Box::pin(async move {
                let path = request.uri().path().to_owned();
                let method = request.method().clone();
                let body = request
                    .body_mut()
                    .collect()
                    .await
                    .expect("infallible in-memory request body")
                    .to_bytes();
                let response = match (method, path.as_str()) {
                    (Method::GET, "/directory") => Self::response(
                        StatusCode::OK,
                        None,
                        br#"{"newNonce":"https://acme.test/nonce","newAccount":"https://acme.test/account","newOrder":"https://acme.test/new-order","revokeCert":"https://acme.test/revoke","keyChange":"https://acme.test/key-change","meta":{}}"#.to_vec(),
                    ),
                    (Method::HEAD, "/nonce") => Self::response(StatusCode::OK, None, Vec::new()),
                    (Method::POST, "/account") => Self::response(
                        StatusCode::CREATED,
                        Some("https://acme.test/account/1"),
                        Vec::new(),
                    ),
                    (Method::POST, "/new-order") => Self::response(
                        StatusCode::CREATED,
                        Some("https://acme.test/order/1"),
                        br#"{"status":"pending","authorizations":["https://acme.test/authz/1"],"error":null,"finalize":"https://acme.test/finalize/1","certificate":null}"#.to_vec(),
                    ),
                    (Method::POST, "/authz/1") => Self::response(
                        StatusCode::OK,
                        None,
                        br#"{"identifier":{"type":"dns","value":"example.test"},"status":"pending","challenges":[{"type":"dns-01","url":"https://acme.test/challenge/1","token":"mock-token","status":"pending","error":null}],"wildcard":false}"#.to_vec(),
                    ),
                    (Method::POST, "/challenge/1") => Self::response(
                        StatusCode::OK,
                        None,
                        br#"{"type":"dns-01","url":"https://acme.test/challenge/1","token":"mock-token","status":"processing","error":null}"#.to_vec(),
                    ),
                    (Method::POST, "/order/1") => {
                        let certificate = issued_chain.lock().unwrap().is_some();
                        let body = if certificate {
                            br#"{"status":"valid","authorizations":["https://acme.test/authz/1"],"error":null,"finalize":"https://acme.test/finalize/1","certificate":"https://acme.test/cert/1"}"#.to_vec()
                        } else {
                            br#"{"status":"ready","authorizations":["https://acme.test/authz/1"],"error":null,"finalize":"https://acme.test/finalize/1","certificate":null}"#.to_vec()
                        };
                        Self::response(StatusCode::OK, None, body)
                    }
                    (Method::POST, "/finalize/1") => {
                        let jose: Value = serde_json::from_slice(&body).unwrap();
                        let payload = BASE64_URL_SAFE_NO_PAD
                            .decode(jose["payload"].as_str().unwrap())
                            .unwrap();
                        let finalize: Value = serde_json::from_slice(&payload).unwrap();
                        let csr = BASE64_URL_SAFE_NO_PAD
                            .decode(finalize["csr"].as_str().unwrap())
                            .unwrap();
                        let csr = CertificateSigningRequestParams::from_der(&csr.into()).unwrap();
                        let cert = csr.signed_by(&ca.0, &ca.1).unwrap();
                        *issued_chain.lock().unwrap() = Some(format!("{}{}", cert.pem(), ca.0.pem()));
                        Self::response(
                            StatusCode::OK,
                            None,
                            br#"{"status":"processing","authorizations":["https://acme.test/authz/1"],"error":null,"finalize":"https://acme.test/finalize/1","certificate":null}"#.to_vec(),
                        )
                    }
                    (Method::POST, "/cert/1") => Self::response(
                        StatusCode::OK,
                        None,
                        issued_chain.lock().unwrap().clone().unwrap().into_bytes(),
                    ),
                    _ => panic!("unexpected mock ACME request: {path}"),
                };
                Ok(response)
            })
        }
    }

    #[tokio::test]
    async fn contract_acme_dns01_uses_generated_key_and_cleans_up() {
        let http = Box::new(MockAcmeHttp::new());
        let (account, credentials) = AcmeAccount::create_with_builder(
            Account::builder_with_http(http),
            AcmeProvider::LetsEncrypt(AcmeEnvironment::Staging),
            &[],
            None,
        )
        .await
        .unwrap();
        assert!(credentials.as_bytes_for_sealing().len() > 32);
        assert!(!format!("{credentials:?}").contains("key_pkcs8"));

        let request =
            CertificateRequest::try_from(CertificateRequestInput::new("example.test")).unwrap();
        let dns = MockDns::default();
        let issued = account
            .issue_dns01(&request, ChallengeKind::Dns01, &dns)
            .await
            .unwrap();
        assert_eq!(issued.bundle().issuer, IssuerKind::LetsEncryptStaging);
        assert_eq!(issued.bundle().trust, TrustClass::TestOnly);
        assert_eq!(dns.presented.lock().unwrap().len(), 1);
        assert_eq!(dns.cleaned.lock().unwrap().len(), 1);
        assert!(issued.into_delivery().1.contains("BEGIN PRIVATE KEY"));
    }

    #[tokio::test]
    async fn adversarial_acme_refuses_challenge_downgrade_before_network() {
        let http = Box::new(MockAcmeHttp::new());
        let (account, _) = AcmeAccount::create_with_builder(
            Account::builder_with_http(http),
            AcmeProvider::LetsEncrypt(AcmeEnvironment::Staging),
            &[],
            None,
        )
        .await
        .unwrap();
        let request =
            CertificateRequest::try_from(CertificateRequestInput::new("example.test")).unwrap();
        let error = account
            .issue_dns01(&request, ChallengeKind::Http01, &MockDns::default())
            .await
            .unwrap_err();
        assert_eq!(
            error,
            IssuerError::UnsupportedChallenge(ChallengeKind::Http01)
        );
    }

    #[tokio::test]
    async fn chaos_acme_refuses_delivery_when_dns_cleanup_fails() {
        let (account, _) = AcmeAccount::create_with_builder(
            Account::builder_with_http(Box::new(MockAcmeHttp::new())),
            AcmeProvider::LetsEncrypt(AcmeEnvironment::Staging),
            &[],
            None,
        )
        .await
        .unwrap();
        let request =
            CertificateRequest::try_from(CertificateRequestInput::new("example.test")).unwrap();
        let dns = MockDns {
            cleanup_fails: true,
            ..MockDns::default()
        };
        assert_eq!(
            account
                .issue_dns01(&request, ChallengeKind::Dns01, &dns)
                .await
                .unwrap_err(),
            IssuerError::Dns01("cleanup")
        );
        assert_eq!(dns.cleaned.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn adversarial_acme_transport_refuses_endpoint_substitution() {
        let client =
            ReqwestAcmeHttp::new(AcmeProvider::LetsEncrypt(AcmeEnvironment::Production)).unwrap();
        let request = Request::builder()
            .uri("https://127.0.0.1/latest/meta-data")
            .body(BodyWrapper::default())
            .unwrap();
        assert!(HttpClient::request(&client, request).await.is_err());
    }

    #[test]
    fn atomic_provider_profiles_are_exact_and_zero_ssl_requires_eab() {
        assert_eq!(
            AcmeProvider::LetsEncrypt(AcmeEnvironment::Production).directory_url(),
            "https://acme-v02.api.letsencrypt.org/directory"
        );
        assert_eq!(
            AcmeProvider::ZeroSsl.directory_url(),
            "https://acme.zerossl.com/v2/DV90"
        );
        assert_eq!(
            AcmeProvider::ZeroSsl.issuer().trust(),
            TrustClass::PublicWeb
        );
    }
}
