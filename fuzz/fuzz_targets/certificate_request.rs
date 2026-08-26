#![no_main]

use std::time::Duration;

use libfuzzer_sys::fuzz_target;
use opensesame_gateway::cert_issuers::{CertificateRequest, CertificateRequestInput};

fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(data);
    let mut parts = text.split('\0');
    let common_name = parts.next().unwrap_or_default().to_owned();
    let dns_names = parts.map(str::to_owned).collect();
    let ttl = data
        .get(..8)
        .and_then(|bytes| bytes.try_into().ok())
        .map(u64::from_le_bytes)
        .map(Duration::from_secs);

    if let Ok(request) = CertificateRequest::try_from(CertificateRequestInput {
        common_name,
        dns_names,
        ip_addrs: Vec::new(),
        ttl,
    }) {
        assert!(!request.common_name().is_empty());
        assert!(request.dns_names().len() <= 100);
        assert!(request.dns_names().windows(2).all(|pair| pair[0] < pair[1]));
    }
});
