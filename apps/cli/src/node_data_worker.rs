//! Fixed native process transport for retained physical DATA, never owner authentication.
#[path = "node_data_worker/framing.rs"]
mod framing;
#[path = "node_data_worker/wire.rs"]
mod wire;

use std::{io, path::Path};

#[cfg(any(unix, windows))]
#[path = "node_data_worker/original.rs"]
mod original;

pub(crate) fn run(state_path: &Path) -> io::Result<()> {
    #[cfg(any(unix, windows))]
    {
        original::run(state_path)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = state_path;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "native physical DATA unavailable",
        ))
    }
}
