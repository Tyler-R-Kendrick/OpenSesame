//! One-shot JSON-line RPC handler for a connected peer.

use std::io::{BufRead, BufWriter, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;

use opensesame_uds_authn::peer_cred;

use crate::protocol::{Request, Response, PROTOCOL_VERSION};
use crate::storage::{OpenOutcome, StoreError, UidStore};

pub fn handle_connection(stream: &mut UnixStream, state_root: &Path) -> std::io::Result<()> {
    let cred = peer_cred(stream).map_err(std::io::Error::other)?;
    if cred.uid == 0 {
        write_response(stream, Response::err(String::new(), "invalid"))?;
        return Ok(());
    }
    let mut reader = std::io::BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    let read = reader.read_line(&mut line)?;
    if read == 0 {
        return Ok(());
    }
    if line.len() > crate::protocol::MAX_LINE_BYTES {
        write_response(stream, Response::err(String::new(), "invalid"))?;
        return Ok(());
    }
    let req: Request = match serde_json::from_str(line.trim()) {
        Ok(r) => r,
        Err(_) => {
            write_response(stream, Response::err(String::new(), "invalid"))?;
            return Ok(());
        }
    };
    if req.v != PROTOCOL_VERSION {
        write_response(stream, Response::err(req.id, "invalid"))?;
        return Ok(());
    }
    let store = UidStore::for_uid(state_root, cred.uid);
    let response = match req.method.as_str() {
        "open" => match store.open_record() {
            Ok(OpenOutcome::Absent) => Response::open_absent(req.id),
            Ok(OpenOutcome::Enrolled(record)) => Response::open_enrolled(
                req.id,
                record.spki_fingerprint().to_string(),
                record.enrollment_epoch(),
            ),
            Err(StoreError::Unreadable) => Response::err(req.id, "unreadable"),
            Err(StoreError::Invalid) => Response::err(req.id, "invalid"),
            Err(StoreError::Conflict) => Response::err(req.id, "conflict"),
        },
        "seal" => {
            let fingerprint = req.params.spki_fingerprint.as_deref().unwrap_or("");
            let epoch = req.params.enrollment_epoch.unwrap_or(0);
            let expected = req.params.expected_epoch.unwrap_or(0);
            match store.seal_record(fingerprint, epoch, expected) {
                Ok(()) => Response::sealed(req.id, epoch),
                Err(StoreError::Conflict) => Response::err(req.id, "conflict"),
                Err(StoreError::Unreadable | StoreError::Invalid) => Response::err(req.id, "invalid"),
            }
        }
        _ => Response::err(req.id, "invalid"),
    };
    write_response(stream, response)?;
    Ok(())
}

fn write_response(stream: &UnixStream, response: Response) -> std::io::Result<()> {
    let mut writer = BufWriter::new(stream);
    serde_json::to_writer(&mut writer, &response)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}
