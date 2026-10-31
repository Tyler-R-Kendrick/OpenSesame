//! A local STS stand-in for tests (ADR 0217).
//!
//! It answers on loopback HTTP, the way `BrokerConfig::with_aws_sts_endpoint`
//! points a mint, and it checks what STS would check: it re-computes the `SigV4`
//! signature with `aws-sigv4` from the secret it was given and records whether
//! the request's `Authorization` matched, and it records the form parameters.
//! Then it answers the documented XML, or the failure a test asked for.
//!
//! Compiled for the crate's own tests and, behind the `sts-stand-in` feature,
//! for the gateway's — never into a shipped binary.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use chrono::{NaiveDateTime, Utc};
use secrecy::SecretString;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::signer::{SigV4Signer, SourceCredential};
use opensesame_invoke_through::{RequestSigner, SignableParts};

/// The temporary credential every successful answer carries.
pub const MINTED_ACCESS_KEY_ID: &str = "ASIAMINTEDDUMMY00001";
pub const MINTED_SECRET: &str = "MintedDummySecret0123456789abcdefABCDEFGH";
pub const MINTED_SESSION_TOKEN: &str = "MintedDummySessionToken0123456789+/abcdefABCDEF==";
pub const REQUEST_ID: &str = "c6104cbe-af31-11e0-8154-cbc7ccf896c7";
/// Text an error answer carries that must never reach a caller.
pub const UPSTREAM_MESSAGE: &str = "upstream words that must not be repeated";

/// What the stand-in answers.
#[derive(Clone, Debug)]
pub enum Reply {
    /// A success whose `Expiration` is this many seconds from now.
    Assume { expires_in: i64 },
    /// An `ErrorResponse` with this status and code.
    Error { status: u16, code: &'static str },
    /// A 307 to another host.
    Redirect,
    /// A success-shaped body past any sane size.
    Oversize,
    /// Accept, read, and never answer.
    Hang,
    /// A 200 that is not XML.
    Garbage,
}

/// One request the stand-in saw. No `Debug`: it holds the source session
/// token the request carried.
#[derive(Clone)]
pub struct Hit {
    pub form: BTreeMap<String, String>,
    pub signature_valid: bool,
    pub security_token: Option<String>,
    pub raw: String,
}

/// A running stand-in.
pub struct StandIn {
    pub base: String,
    hits: Arc<Mutex<Vec<Hit>>>,
}

impl StandIn {
    /// Everything seen so far.
    ///
    /// # Panics
    ///
    /// When the record's lock is poisoned.
    #[must_use]
    pub fn hits(&self) -> Vec<Hit> {
        self.hits.lock().expect("stand-in record").clone()
    }
}

/// What the stand-in verifies a signature against.
pub struct Expect {
    pub access_key_id: &'static str,
    pub secret: &'static str,
    pub session_token: Option<&'static str>,
    pub region: &'static str,
}

/// Start a stand-in that gives `reply` to every request.
///
/// # Panics
///
/// When loopback cannot be bound.
pub async fn spawn(expect: Expect, reply: Reply) -> StandIn {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind stand-in");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    let hits = Arc::new(Mutex::new(Vec::new()));
    let record = hits.clone();
    let expect = Arc::new(expect);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let record = record.clone();
            let expect = expect.clone();
            let reply = reply.clone();
            tokio::spawn(async move { serve(stream, &expect, &reply, &record).await });
        }
    });
    StandIn { base, hits }
}

async fn serve(mut stream: TcpStream, expect: &Expect, reply: &Reply, record: &Mutex<Vec<Hit>>) {
    let Some(raw) = read_request(&mut stream).await else {
        return;
    };
    record
        .lock()
        .expect("stand-in record")
        .push(inspect(&raw, expect));
    let (status, extra, body) = match reply {
        Reply::Hang => {
            tokio::time::sleep(Duration::from_secs(60)).await;
            return;
        }
        Reply::Assume { expires_in } => (200, "", assume_xml(*expires_in)),
        Reply::Error { status, code } => (*status, "", error_xml(code)),
        Reply::Redirect => (
            307,
            "Location: http://127.0.0.1:9/elsewhere\r\n",
            String::new(),
        ),
        Reply::Oversize => (
            200,
            "",
            format!(
                "<AssumeRoleResponse>{}</AssumeRoleResponse>",
                "x".repeat(64 * 1024)
            ),
        ),
        Reply::Garbage => (200, "", "not xml at all".to_string()),
    };
    let response = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: text/xml\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
}

async fn read_request(stream: &mut TcpStream) -> Option<String> {
    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        raw.extend_from_slice(&chunk[..read]);
        let text = String::from_utf8_lossy(&raw).to_string();
        if let Some((head, body)) = text.split_once("\r\n\r\n") {
            let length = header(head, "content-length")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            if body.len() >= length {
                return Some(text);
            }
        }
    }
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

fn inspect(raw: &str, expect: &Expect) -> Hit {
    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw, ""));
    let form = url::form_urlencoded::parse(body.as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    Hit {
        form,
        signature_valid: signature_matches(head, body, expect),
        security_token: header(head, "x-amz-security-token").map(str::to_string),
        raw: raw.to_string(),
    }
}

/// Re-sign what arrived with the expected secret, at the request's own
/// `x-amz-date`, over the headers it says it signed, and compare.
fn signature_matches(head: &str, body: &str, expect: &Expect) -> bool {
    let (Some(authorization), Some(date), Some(host)) = (
        header(head, "authorization"),
        header(head, "x-amz-date"),
        header(head, "host"),
    ) else {
        return false;
    };
    let path = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    let Some(signed_names) = authorization
        .split("SignedHeaders=")
        .nth(1)
        .and_then(|rest| rest.split(',').next())
    else {
        return false;
    };
    let Ok(at) = NaiveDateTime::parse_from_str(date, "%Y%m%dT%H%M%SZ") else {
        return false;
    };
    let at = SystemTime::from(at.and_utc());
    let headers: Vec<(&str, &str)> = signed_names
        .split(';')
        .filter(|name| !matches!(*name, "host" | "x-amz-date" | "x-amz-security-token"))
        .filter_map(|name| Some((name, header(head, name)?)))
        .collect();
    let signer = SigV4Signer::new(
        SourceCredential::new(
            expect.access_key_id,
            SecretString::from(expect.secret),
            expect.session_token.map(SecretString::from),
        ),
        expect.region,
    )
    .at(at);
    let Ok(added) = signer.sign(&SignableParts {
        method: "POST",
        uri: format!("http://{host}{path}"),
        headers,
        body: body.as_bytes(),
    }) else {
        return false;
    };
    added
        .iter()
        .any(|(name, value)| name == "authorization" && value == authorization)
}

fn assume_xml(expires_in: i64) -> String {
    let expiration = (Utc::now() + chrono::Duration::seconds(expires_in))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    format!(
        r#"<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleResult>
    <SourceIdentity>stand-in</SourceIdentity>
    <AssumedRoleUser>
      <Arn>arn:aws:sts::123456789012:assumed-role/Deploy/session</Arn>
      <AssumedRoleId>AROA3XFRBF535PLBIFPI4:session</AssumedRoleId>
    </AssumedRoleUser>
    <Credentials>
      <AccessKeyId>{MINTED_ACCESS_KEY_ID}</AccessKeyId>
      <SecretAccessKey>{MINTED_SECRET}</SecretAccessKey>
      <SessionToken>{MINTED_SESSION_TOKEN}</SessionToken>
      <Expiration>{expiration}</Expiration>
    </Credentials>
    <PackedPolicySize>6</PackedPolicySize>
  </AssumeRoleResult>
  <ResponseMetadata>
    <RequestId>{REQUEST_ID}</RequestId>
  </ResponseMetadata>
</AssumeRoleResponse>"#
    )
}

fn error_xml(code: &str) -> String {
    format!(
        r#"<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <Error>
    <Type>Sender</Type>
    <Code>{code}</Code>
    <Message>{UPSTREAM_MESSAGE}</Message>
  </Error>
  <RequestId>{REQUEST_ID}</RequestId>
</ErrorResponse>"#
    )
}
