use serde::{Deserialize, Serialize};

use super::model::{
    normalize_external_certificate, CertificateRequest, GeneratedLeafRequest, IssuedCertificate,
    IssuerError, IssuerKind,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CloudflareOriginValidity {
    Days7,
    Days30,
    Days90,
}

impl CloudflareOriginValidity {
    pub const fn days(self) -> u16 {
        match self {
            Self::Days7 => 7,
            Self::Days30 => 30,
            Self::Days90 => 90,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct CloudflareOriginRequest {
    pub hostnames: Vec<String>,
    pub request_type: &'static str,
    pub requested_validity: u16,
    pub csr: String,
}

impl CloudflareOriginRequest {
    pub fn from_generated(
        request: &CertificateRequest,
        leaf: &GeneratedLeafRequest,
        validity: CloudflareOriginValidity,
    ) -> Result<Self, IssuerError> {
        request.require_public_dns()?;
        Ok(Self {
            hostnames: request.dns_names().to_vec(),
            request_type: "origin-ecc",
            requested_validity: validity.days(),
            csr: leaf.csr_pem().to_owned(),
        })
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct CloudflareOriginApiError {
    #[serde(rename = "code")]
    pub _code: u32,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CloudflareOriginResult {
    pub certificate: String,
    #[serde(default)]
    #[serde(rename = "expires_on")]
    pub _expires_on: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CloudflareOriginApiResponse {
    pub success: bool,
    #[serde(default)]
    pub errors: Vec<CloudflareOriginApiError>,
    pub result: Option<CloudflareOriginResult>,
}

impl CloudflareOriginApiResponse {
    pub fn normalize(
        self,
        request: &CertificateRequest,
        leaf: GeneratedLeafRequest,
    ) -> Result<IssuedCertificate, IssuerError> {
        if !self.success || !self.errors.is_empty() {
            return Err(IssuerError::CloudflareRejected);
        }
        let result = self.result.ok_or(IssuerError::CloudflareRejected)?;
        normalize_external_certificate(
            result.certificate,
            leaf,
            request,
            IssuerKind::CloudflareOriginCa,
            false,
        )
    }
}

#[cfg(test)]
mod tests {
    use rcgen::{
        BasicConstraints, CertificateParams, CertificateSigningRequestParams, DistinguishedName,
        DnType, IsCa, KeyPair,
    };

    use super::super::model::{CertificateRequestInput, TrustClass};
    use super::*;

    fn signed_response(
        request: &CertificateRequest,
        leaf: &GeneratedLeafRequest,
    ) -> CloudflareOriginApiResponse {
        let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let mut params = CertificateParams::default();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.distinguished_name = DistinguishedName::new();
        params
            .distinguished_name
            .push(DnType::CommonName, "Mock Cloudflare Origin CA");
        let ca = params.self_signed(&key).unwrap();
        let csr = CertificateSigningRequestParams::from_pem(leaf.csr_pem()).unwrap();
        let certificate = csr.signed_by(&ca, &key).unwrap().pem();
        assert_eq!(request.dns_names(), &["example.com"]);
        CloudflareOriginApiResponse {
            success: true,
            errors: vec![],
            result: Some(CloudflareOriginResult {
                certificate,
                _expires_on: Some("2030-01-01T00:00:00Z".into()),
            }),
        }
    }

    #[test]
    fn contract_cloudflare_origin_normalizes_as_origin_only() {
        let request =
            CertificateRequest::try_from(CertificateRequestInput::new("example.com")).unwrap();
        let leaf = GeneratedLeafRequest::generate(&request).unwrap();
        let api_request = CloudflareOriginRequest::from_generated(
            &request,
            &leaf,
            CloudflareOriginValidity::Days90,
        )
        .unwrap();
        assert_eq!(api_request.request_type, "origin-ecc");
        assert_eq!(api_request.requested_validity, 90);
        assert!(!format!("{api_request:?}").contains("PRIVATE KEY"));

        let response = signed_response(&request, &leaf);
        let issued = response.normalize(&request, leaf).unwrap();
        assert_eq!(issued.bundle().issuer, IssuerKind::CloudflareOriginCa);
        assert_eq!(issued.bundle().trust, TrustClass::OriginOnly);
    }

    #[test]
    fn adversarial_cloudflare_rejects_key_substitution_and_api_errors() {
        let request =
            CertificateRequest::try_from(CertificateRequestInput::new("example.com")).unwrap();
        let expected_leaf = GeneratedLeafRequest::generate(&request).unwrap();
        let substituted_leaf = GeneratedLeafRequest::generate(&request).unwrap();
        let response = signed_response(&request, &substituted_leaf);
        assert_eq!(
            response.normalize(&request, expected_leaf).unwrap_err(),
            IssuerError::CertificateKeyMismatch
        );

        let rejected = CloudflareOriginApiResponse {
            success: false,
            errors: vec![CloudflareOriginApiError { _code: 1000 }],
            result: None,
        };
        let leaf = GeneratedLeafRequest::generate(&request).unwrap();
        assert_eq!(
            rejected.normalize(&request, leaf).unwrap_err(),
            IssuerError::CloudflareRejected
        );
    }
}
