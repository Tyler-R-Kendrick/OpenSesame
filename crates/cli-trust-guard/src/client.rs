//! Daemon-side client for the root trust guard.

use std::io::{BufRead, BufWriter, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use opensesame_cli_app_integration::RootTrustRecord;

use crate::protocol::{Request, Response, PROTOCOL_VERSION};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardError {
    Unavailable,
    Unreadable,
    Conflict,
    Invalid,
}

pub enum GuardOpen {
    Absent,
    Enrolled(RootTrustRecord),
}

pub fn socket_path_from_env() -> Option<std::path::PathBuf> {
    std::env::var_os("OPENSESAME_CLI_TRUST_GUARD_SOCKET")
        .map(std::path::PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

pub fn guard_required() -> bool {
    matches!(
        std::env::var("OPENSESAME_CLI_TRUST_GUARD_REQUIRED").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

pub fn open_via_guard(socket: &Path) -> Result<GuardOpen, GuardError> {
    let response = rpc(socket, "open", None, None, None)?;
    if !response.ok {
        return map_error(response);
    }
    let result = response.result.as_ref().ok_or(GuardError::Unreadable)?;
    let status = result
        .get("status")
        .and_then(|v| v.as_str())
        .ok_or(GuardError::Unreadable)?;
    if status == "absent" {
        return Ok(GuardOpen::Absent);
    }
    if status != "enrolled" {
        return Err(GuardError::Unreadable);
    }
    let fp = result
        .get("spkiFingerprint")
        .and_then(|v| v.as_str())
        .ok_or(GuardError::Unreadable)?;
    let epoch = result
        .get("enrollmentEpoch")
        .and_then(|v| v.as_u64())
        .ok_or(GuardError::Unreadable)?;
    let record = RootTrustRecord::new(fp, epoch).map_err(|_| GuardError::Unreadable)?;
    Ok(GuardOpen::Enrolled(record))
}

pub fn seal_via_guard(
    socket: &Path,
    record: &RootTrustRecord,
    expected_epoch: u64,
) -> Result<(), GuardError> {
    let response = rpc(
        socket,
        "seal",
        Some(record.spki_fingerprint()),
        Some(record.enrollment_epoch()),
        Some(expected_epoch),
    )?;
    if !response.ok {
        return Err(map_error_code(response));
    }
    Ok(())
}

fn map_error(response: Response) -> Result<GuardOpen, GuardError> {
    Err(map_error_code(response))
}

fn map_error_code(response: Response) -> GuardError {
    let code = response
        .error
        .as_ref()
        .map(|e| e.code.as_str())
        .unwrap_or("invalid");
    match code {
        "unreadable" => GuardError::Unreadable,
        "conflict" => GuardError::Conflict,
        _ => GuardError::Invalid,
    }
}

fn rpc(
    socket: &Path,
    method: &str,
    fingerprint: Option<&str>,
    epoch: Option<u64>,
    expected_epoch: Option<u64>,
) -> Result<Response, GuardError> {
    let stream = UnixStream::connect(socket).map_err(|_| GuardError::Unavailable)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| GuardError::Unavailable)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| GuardError::Unavailable)?;
    let id = "daemon";
    let req = Request {
        v: PROTOCOL_VERSION,
        id: id.to_string(),
        method: method.to_string(),
        params: crate::protocol::RequestParams {
            spki_fingerprint: fingerprint.map(str::to_string),
            enrollment_epoch: epoch,
            expected_epoch,
        },
    };
    let mut writer = BufWriter::new(&stream);
    serde_json::to_writer(&mut writer, &req).map_err(|_| GuardError::Unavailable)?;
    writer.write_all(b"\n").map_err(|_| GuardError::Unavailable)?;
    writer.flush().map_err(|_| GuardError::Unavailable)?;
    let mut reader = std::io::BufReader::new(&stream);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|_| GuardError::Unavailable)?;
    serde_json::from_str(line.trim()).map_err(|_| GuardError::Unreadable)
}
