//! The stable failure codes are the HTTP contract (ADR 0217).

use super::*;

#[test]
fn failure_codes_are_frozen() {
    let table = [
        (StsFailure::AccessDenied, "aws.sts.access_denied", 502),
        (StsFailure::ExpiredSource, "aws.sts.expired_source", 502),
        (StsFailure::RegionDisabled, "aws.sts.region_disabled", 502),
        (StsFailure::Throttled, "aws.sts.throttled", 429),
        (
            StsFailure::MalformedResponse,
            "aws.sts.malformed_response",
            502,
        ),
        (StsFailure::Unreachable, "aws.sts.unreachable", 504),
    ];
    for (failure, code, status) in table {
        assert_eq!(failure.code(), code);
        assert_eq!(failure.http_status(), status, "{code}");
        let error = crate::BrokerError::AwsSts(failure);
        assert_eq!(error.code(), code);
        assert_eq!(error.http_status(), status);
        assert_eq!(error.hint(), failure.hint());
    }
}

#[test]
fn only_key_holding_aws_providers_can_mint() {
    for provider in ["aws", "aws-kms", "aws-ps", "aws-bedrock"] {
        assert!(is_mintable_provider(provider), "{provider}");
    }
    for provider in ["aws-sts", "github", "gcp", "awsx", ""] {
        assert!(!is_mintable_provider(provider), "{provider}");
    }
}
