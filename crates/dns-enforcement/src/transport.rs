//! Talking to a Blocky instance, and refusing when there is not one.
//!
//! This module is deliberately thin: [`crate::blocky`] already decided what the
//! request is and what the response means, so everything here is address
//! validation, sending, and turning an absence into a [`Refusal`] rather than
//! into a shrug.
//!
//! Two things are worth reading before changing it.
//!
//! **[`BlockyEndpoint::preflight`] is the capability check, and it fails in two
//! different ways on purpose.** Unreachable is
//! [`Refusal::CapabilityUnavailable`]; reachable-but-switched-off is
//! [`Refusal::NotEnforcing`]. Neither is a success, and neither is reported as
//! "nothing to do".
//!
//! **[`BlockyEndpoint::apply_allowlist`] writes through a temporary file and
//! renames.** `lists/refresh` re-reads the file whenever it is asked, including
//! part-way through someone else's write, and a truncated allowlist is a silently
//! narrower permission set than the one that was granted.

use std::fs;
use std::path::Path;

use url::Url;

use crate::blocky::{
    admitted_but_unresolved, allowlist_document, parse_query, parse_status, BlockingStatus, Method,
    Operation, RequestSpec, Resolution,
};
use crate::refusal::Refusal;
use crate::scope::DomainRule;

/// A Blocky HTTP API endpoint.
#[derive(Clone, Debug)]
pub struct BlockyEndpoint {
    base: Url,
    client: reqwest::Client,
}

impl BlockyEndpoint {
    /// Point at a Blocky API base URL.
    ///
    /// The address rules match the rest of the host plane: `https` anywhere, or
    /// `http` to a loopback address, and never embedded credentials. Blocky's API
    /// is unauthenticated, so an `http` endpoint off-box would be a filter
    /// anybody on the path could rewrite.
    ///
    /// # Errors
    ///
    /// Returns [`Refusal::BadEndpoint`] for an unparseable address, an address
    /// carrying userinfo, or plain `http` to anywhere but loopback.
    pub fn new(base: &str) -> Result<Self, Refusal> {
        let url = Url::parse(base.trim()).map_err(|e| Refusal::BadEndpoint {
            detail: e.to_string(),
        })?;
        if !url.username().is_empty() || url.password().is_some() {
            return Err(Refusal::BadEndpoint {
                detail: "endpoint must not embed credentials".to_owned(),
            });
        }
        let loopback = match url.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
            None => false,
        };
        match url.scheme() {
            "https" => {}
            "http" if loopback => {}
            _ => {
                return Err(Refusal::BadEndpoint {
                    detail: "endpoint must be https, or http to loopback".to_owned(),
                })
            }
        }

        Ok(Self {
            base: url,
            client: reqwest::Client::new(),
        })
    }

    /// The base URL.
    #[must_use]
    pub const fn base(&self) -> &Url {
        &self.base
    }

    /// Send an operation and return the response body, whatever the status.
    ///
    /// Callers that only accept success want [`Self::send`]. This exists because
    /// `query` has a failure mode that is not a failure of the filter — see
    /// [`Resolution`].
    ///
    /// # Errors
    ///
    /// Returns [`Refusal::CapabilityUnavailable`] only when the instance cannot
    /// be reached or its body cannot be read.
    pub async fn send_raw(
        &self,
        operation: &Operation,
    ) -> Result<(reqwest::StatusCode, String), Refusal> {
        let RequestSpec {
            method,
            path,
            query,
            body,
        } = operation.spec();

        let url =
            self.base
                .join(path.trim_start_matches('/'))
                .map_err(|e| Refusal::BadEndpoint {
                    detail: e.to_string(),
                })?;

        let mut request = match method {
            Method::Get => self.client.get(url),
            Method::Post => self.client.post(url),
        };
        if !query.is_empty() {
            request = request.query(&query);
        }
        if let Some(body) = body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
        }

        let response = request
            .send()
            .await
            .map_err(|e| Refusal::unavailable(format!("{} {path}: {e}", method.as_str())))?;

        let status = response.status();
        let text = response.text().await.map_err(|e| {
            Refusal::unavailable(format!("{} {path}: reading body: {e}", method.as_str()))
        })?;
        Ok((status, text))
    }

    /// Send an operation that must succeed, and return its body.
    ///
    /// # Errors
    ///
    /// Returns [`Refusal::CapabilityUnavailable`] when the instance cannot be
    /// reached or answers with a non-success status — including the `400` Blocky
    /// returns for a group it does not know, which was measured to leave blocking
    /// untouched.
    pub async fn send(&self, operation: &Operation) -> Result<String, Refusal> {
        let spec = operation.spec();
        let (status, text) = self.send_raw(operation).await?;
        if !status.is_success() {
            return Err(Refusal::unavailable(format!(
                "{} {}: HTTP {}: {}",
                spec.method.as_str(),
                spec.path,
                status.as_u16(),
                text.trim()
            )));
        }
        Ok(text)
    }

    /// Read whether this instance is enforcing.
    ///
    /// # Errors
    ///
    /// Returns [`Refusal::CapabilityUnavailable`] when unreachable, or
    /// [`Refusal::Protocol`] when the body is not this version's JSON.
    pub async fn status(&self) -> Result<BlockingStatus, Refusal> {
        let body = self.send(&Operation::Status).await?;
        Ok(parse_status(&body)?)
    }

    /// Check that there is a Blocky here and that it is actually filtering.
    ///
    /// # Errors
    ///
    /// Returns [`Refusal::CapabilityUnavailable`] when there is nothing to talk
    /// to, and [`Refusal::NotEnforcing`] when the instance answers but its
    /// blocking is off. A caller must not proceed as though a denial were in
    /// force after either.
    pub async fn preflight(&self) -> Result<BlockingStatus, Refusal> {
        let status = self.status().await?;
        if !status.enabled {
            return Err(Refusal::NotEnforcing {
                detail: if status.is_indefinitely_disabled() {
                    format!(
                        "blocking is off for {:?} with nothing scheduled to re-enable it",
                        status.disabled_groups
                    )
                } else {
                    format!(
                        "blocking is off for {:?}, re-enabling in {:?}s",
                        status.disabled_groups, status.auto_enable_in_sec
                    )
                },
            });
        }
        Ok(status)
    }

    /// Re-read every list source from disk.
    ///
    /// # Errors
    ///
    /// Returns [`Refusal::CapabilityUnavailable`] when the refresh does not
    /// succeed, so a caller never records an allowance the resolver has not read.
    pub async fn refresh_lists(&self) -> Result<(), Refusal> {
        self.send(&Operation::RefreshLists).await.map(|_| ())
    }

    /// Resolve a name through Blocky and report how the filter decided.
    ///
    /// A name the filter admits is forwarded upstream, so an unreachable upstream
    /// produces `HTTP 500` here. That is [`Resolution::AdmittedButUnresolved`],
    /// not a capability gap: the filter ran and let the name through. Only a
    /// Blocky that cannot be reached, or a `500` that is not a query-resolution
    /// failure, is a gap.
    ///
    /// # Errors
    ///
    /// Returns [`Refusal::CapabilityUnavailable`] when the instance is
    /// unreachable or fails for a reason unrelated to resolving the name, or
    /// [`Refusal::Protocol`] when a success body cannot be read.
    pub async fn resolve(&self, name: &str, record_type: &str) -> Result<Resolution, Refusal> {
        let operation = Operation::Query {
            name: name.to_owned(),
            record_type: record_type.to_owned(),
        };
        let (status, body) = self.send_raw(&operation).await?;

        if status.is_success() {
            return Ok(Resolution::Answered(parse_query(&body)?));
        }
        if let Some(detail) = admitted_but_unresolved(&body) {
            return Ok(Resolution::AdmittedButUnresolved { detail });
        }
        Err(Refusal::unavailable(format!(
            "POST /api/query for {name}: HTTP {}: {}",
            status.as_u16(),
            body.trim()
        )))
    }

    /// Write a unit's allowlist and have Blocky re-read it.
    ///
    /// The write is atomic — temporary file, then rename — because `refresh` may
    /// read the file at any moment and a partial read is a quieter permission set
    /// than the one granted.
    ///
    /// # Errors
    ///
    /// Returns [`Refusal::CapabilityUnavailable`] when the file cannot be written
    /// or the refresh fails. The allowance is not in force in either case, and
    /// saying so is the point.
    pub async fn apply_allowlist(&self, path: &Path, rules: &[DomainRule]) -> Result<(), Refusal> {
        let document = allowlist_document(rules);
        let temporary = path.with_extension("tmp");

        fs::write(&temporary, document.as_bytes())
            .map_err(|e| Refusal::unavailable(format!("writing {}: {e}", temporary.display())))?;
        fs::rename(&temporary, path)
            .map_err(|e| Refusal::unavailable(format!("renaming onto {}: {e}", path.display())))?;

        self.refresh_lists().await
    }
}

#[cfg(test)]
mod tests {
    use super::BlockyEndpoint;
    use crate::refusal::Refusal;

    #[test]
    fn loopback_http_and_https_are_accepted() {
        assert!(BlockyEndpoint::new("http://127.0.0.1:54780").is_ok());
        assert!(BlockyEndpoint::new("http://localhost:54780").is_ok());
        assert!(BlockyEndpoint::new("https://dns.example.org").is_ok());
    }

    #[test]
    fn plain_http_off_box_is_refused() {
        // Blocky's API is unauthenticated, so this would be a filter anybody on
        // the path could rewrite.
        let refusal = BlockyEndpoint::new("http://dns.example.org").expect_err("refused");
        assert!(matches!(refusal, Refusal::BadEndpoint { .. }));
        assert!(!refusal.is_capability_gap());
    }

    #[test]
    fn credentials_in_the_endpoint_are_refused() {
        assert!(matches!(
            BlockyEndpoint::new("https://user:pass@dns.example.org"),
            Err(Refusal::BadEndpoint { .. })
        ));
    }

    #[test]
    fn an_unparseable_endpoint_is_refused_rather_than_guessed_at() {
        assert!(matches!(
            BlockyEndpoint::new("not a url"),
            Err(Refusal::BadEndpoint { .. })
        ));
    }

    #[tokio::test]
    async fn an_absent_instance_is_a_capability_gap_never_an_answer() {
        // The "do not fake success" case, at the transport boundary: nothing is
        // listening, so every read is an error and none of them is "not blocked".
        let endpoint = BlockyEndpoint::new("http://127.0.0.1:1").expect("endpoint");

        let status = endpoint.status().await.expect_err("must refuse");
        assert!(status.is_capability_gap(), "{status}");

        let preflight = endpoint.preflight().await.expect_err("must refuse");
        assert!(preflight.is_capability_gap(), "{preflight}");

        let resolve = endpoint
            .resolve("blocked.example.org", "A")
            .await
            .expect_err("must refuse");
        assert!(resolve.is_capability_gap(), "{resolve}");

        let refresh = endpoint.refresh_lists().await.expect_err("must refuse");
        assert!(refresh.is_capability_gap(), "{refresh}");
    }
}
