//! Current-user DPAPI for the independent detector key; never a production vault root.
//! Additional entropy binds the fixed purpose and stable canonical vault identity.
use std::{io, ptr, slice};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
};
use zeroize::{Zeroize, Zeroizing};

pub const MAX_SEALED_KEY_BYTES: usize = 4096;
const MAGIC: &[u8] = b"OSDK\0\x01";
const PURPOSE: &[u8] = b"OpenSesame credential observation device key v1\0";

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "independent Windows detector key is unavailable",
    )
}

fn entropy(identity: &str) -> io::Result<Vec<u8>> {
    let uuid = uuid::Uuid::parse_str(identity).map_err(|_| invalid())?;
    if uuid.to_string() != identity {
        return Err(invalid());
    }
    let mut value = PURPOSE.to_vec();
    value.extend_from_slice(
        &u32::try_from(identity.len())
            .map_err(|_| invalid())?
            .to_be_bytes(),
    );
    value.extend_from_slice(identity.as_bytes());
    Ok(value)
}

fn input(bytes: &[u8]) -> io::Result<CRYPT_INTEGER_BLOB> {
    Ok(CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(|_| invalid())?,
        // The DPAPI input structure uses a mutable pointer but its input contract does not mutate bytes.
        pbData: bytes.as_ptr().cast_mut(),
    })
}

struct Output(CRYPT_INTEGER_BLOB);
impl Output {
    fn new() -> Self {
        Self(CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        })
    }
    fn bytes(&self) -> io::Result<&[u8]> {
        let length = usize::try_from(self.0.cbData).map_err(|_| invalid())?;
        if self.0.pbData.is_null() || length == 0 || length > MAX_SEALED_KEY_BYTES {
            return Err(invalid());
        }
        // SAFETY: successful DPAPI allocated this exact output span; its lifetime is retained by self.
        Ok(unsafe { slice::from_raw_parts(self.0.pbData, length) })
    }
}
impl Drop for Output {
    fn drop(&mut self) {
        if self.0.pbData.is_null() {
            return;
        }
        // SAFETY: DPAPI's successful/allocated output is owned exclusively and released with LocalFree.
        unsafe {
            slice::from_raw_parts_mut(self.0.pbData, self.0.cbData as usize).zeroize();
            LocalFree(self.0.pbData.cast());
        }
    }
}

/// # Errors
/// Refuses noncanonical identity or anything except the independent 32-byte detector key.
pub fn seal(identity: &str, key: &[u8]) -> io::Result<Vec<u8>> {
    if key.len() != 32 {
        return Err(invalid());
    }
    let binding = entropy(identity)?;
    let data = input(key)?;
    let binding = input(&binding)?;
    let mut output = Output::new();
    // SAFETY: fixed-sized live input, retained entropy, null optional pointers, and owned output.
    // LOCAL_MACHINE is deliberately absent: the logged-on user's DPAPI profile owns this key.
    let success = unsafe {
        CryptProtectData(
            &data,
            ptr::null(),
            &binding,
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output.0,
        )
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    let protected = output.bytes()?;
    if protected.len() + MAGIC.len() > MAX_SEALED_KEY_BYTES {
        return Err(invalid());
    }
    let mut sealed = MAGIC.to_vec();
    sealed.extend_from_slice(protected);
    Ok(sealed)
}

/// # Errors
/// Refuses unknown codecs, malformed/tampered blobs, another vault's purpose, or unavailable DPAPI profile.
pub fn open(identity: &str, sealed: &[u8]) -> io::Result<Zeroizing<[u8; 32]>> {
    if sealed.len() > MAX_SEALED_KEY_BYTES
        || !sealed.starts_with(MAGIC)
        || sealed.len() <= MAGIC.len()
    {
        return Err(invalid());
    }
    let binding = entropy(identity)?;
    let data = input(&sealed[MAGIC.len()..])?;
    let binding = input(&binding)?;
    let mut output = Output::new();
    // SAFETY: bounded retained ciphertext/entropy, no UI or description output, owned DPAPI allocation.
    let success = unsafe {
        CryptUnprotectData(
            &data,
            ptr::null_mut(),
            &binding,
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output.0,
        )
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    let clear = output.bytes()?;
    if clear.len() != 32 {
        return Err(invalid());
    }
    let mut key = Zeroizing::new([0_u8; 32]);
    key.copy_from_slice(clear);
    Ok(key)
}

#[cfg(test)]
#[path = "windows_detector_key/tests.rs"]
mod tests;
