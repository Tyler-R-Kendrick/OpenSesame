use super::protocol::{b64, iso, SKEW_MILLIS, TTL_MILLIS};
use super::{
    Acknowledgement, Metadata, Package, Provision, ReceiverError, ACK_PURPOSE, MAX_PACKAGE_BYTES,
    PURPOSE,
};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;
use zeroize::Zeroizing;

fn sign(provision: &Provision, purpose: &str, body: &str) -> Result<String, ReceiverError> {
    let key = Zeroizing::new(b64::<64>(&provision.independent_key_material_b64)?);
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(&key[32..]).map_err(|_| ReceiverError::Invalid)?;
    mac.update(purpose.as_bytes());
    mac.update(b"\n");
    mac.update(body.as_bytes());
    Ok(STANDARD.encode(mac.finalize().into_bytes()))
}
fn verify(
    provision: &Provision,
    purpose: &str,
    body: &str,
    signature: &str,
) -> Result<(), ReceiverError> {
    let key = Zeroizing::new(b64::<64>(&provision.independent_key_material_b64)?);
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(&key[32..]).map_err(|_| ReceiverError::Invalid)?;
    mac.update(purpose.as_bytes());
    mac.update(b"\n");
    mac.update(body.as_bytes());
    mac.verify_slice(&b64::<32>(signature)?)
        .map_err(|_| ReceiverError::Authentication)
}
fn times(
    package: &Package,
    provision: &Provision,
    now: DateTime<Utc>,
) -> Result<(), ReceiverError> {
    provision.validate()?;
    let issued = iso(&package.issued_at)?;
    let expires = iso(&package.expires_at)?;
    if package.v != 1
        || package.receiver_id != provision.receiver_id
        || package.binding_id != provision.binding_id
        || package.key_epoch != provision.key_epoch
        || issued > now + Duration::milliseconds(SKEW_MILLIS)
        || expires <= now
        || expires <= issued
        || expires - issued > Duration::milliseconds(TTL_MILLIS)
        || expires > iso(&provision.expires_at)?
        || !super::super::protocol::valid_uuid(&package.package_id)
        || package.ciphertext_b64.len() > 6000
    {
        return Err(ReceiverError::Expired);
    }
    b64::<16>(&package.nonce_b64)?;
    b64::<32>(&package.mac_b64)?;
    Ok(())
}

/// # Errors
/// Seals only bounded closed metadata using independent provisioned material.
pub fn seal(
    metadata: &Metadata,
    provision: &Provision,
    now: DateTime<Utc>,
) -> Result<Package, ReceiverError> {
    let mut iv = [0u8; 12];
    let mut nonce = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut iv);
    rand::thread_rng().fill_bytes(&mut nonce);
    seal_with_randomness(
        metadata,
        provision,
        now,
        &uuid::Uuid::new_v4().to_string(),
        iv,
        nonce,
    )
}
pub(super) fn seal_with_randomness(
    metadata: &Metadata,
    provision: &Provision,
    now: DateTime<Utc>,
    package_id: &str,
    iv: [u8; 12],
    nonce: [u8; 16],
) -> Result<Package, ReceiverError> {
    metadata.validate()?;
    provision.validate()?;
    let at = iso(&metadata.at)?;
    if !super::super::protocol::valid_uuid(package_id)
        || at > now + Duration::milliseconds(SKEW_MILLIS)
        || at < now - Duration::milliseconds(TTL_MILLIS)
    {
        return Err(ReceiverError::Invalid);
    }
    let expires = (now + Duration::milliseconds(TTL_MILLIS)).min(iso(&provision.expires_at)?);
    if expires <= now {
        return Err(ReceiverError::Expired);
    }
    let clear = Zeroizing::new(serde_json::to_vec(metadata).map_err(|_| ReceiverError::Invalid)?);
    if clear.len() > 2048 {
        return Err(ReceiverError::Limit);
    }
    let key = Zeroizing::new(b64::<64>(&provision.independent_key_material_b64)?);
    let cipher = Aes256Gcm::new_from_slice(&key[..32]).map_err(|_| ReceiverError::Invalid)?;
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &clear,
                aad: PURPOSE.as_bytes(),
            },
        )
        .map_err(|_| ReceiverError::Authentication)?;
    let mut packed = iv.to_vec();
    packed.extend(encrypted);
    let mut package = Package {
        v: 1,
        package_id: package_id.into(),
        receiver_id: provision.receiver_id.clone(),
        binding_id: provision.binding_id.clone(),
        key_epoch: provision.key_epoch,
        issued_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        expires_at: expires.to_rfc3339_opts(SecondsFormat::Millis, true),
        nonce_b64: STANDARD.encode(nonce),
        ciphertext_b64: STANDARD.encode(packed),
        mac_b64: String::new(),
    };
    package.mac_b64 = sign(provision, PURPOSE, &package.body()?)?;
    if serde_json::to_vec(&package)
        .map_err(|_| ReceiverError::Invalid)?
        .len()
        > MAX_PACKAGE_BYTES
    {
        return Err(ReceiverError::Limit);
    }
    Ok(package)
}

/// # Errors
/// Authenticating a queued package does not decrypt or expose its metadata to the sender.
pub fn authenticate(
    package: &Package,
    provision: &Provision,
    now: DateTime<Utc>,
) -> Result<(), ReceiverError> {
    times(package, provision, now)?;
    verify(provision, PURPOSE, &package.body()?, &package.mac_b64)
}
/// # Errors
/// Refuses malformed, tampered, expired or cross-binding packages before releasing metadata.
pub fn open(
    raw: &str,
    provision: &Provision,
    now: DateTime<Utc>,
) -> Result<Metadata, ReceiverError> {
    if raw.len() > MAX_PACKAGE_BYTES {
        return Err(ReceiverError::Limit);
    }
    let package: Package = serde_json::from_str(raw).map_err(|_| ReceiverError::Invalid)?;
    authenticate(&package, provision, now)?;
    let packed = STANDARD
        .decode(&package.ciphertext_b64)
        .map_err(|_| ReceiverError::Invalid)?;
    if packed.len() < 28 || STANDARD.encode(&packed) != package.ciphertext_b64 {
        return Err(ReceiverError::Invalid);
    }
    let key = Zeroizing::new(b64::<64>(&provision.independent_key_material_b64)?);
    let cipher = Aes256Gcm::new_from_slice(&key[..32]).map_err(|_| ReceiverError::Invalid)?;
    let clear = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&packed[..12]),
                Payload {
                    msg: &packed[12..],
                    aad: PURPOSE.as_bytes(),
                },
            )
            .map_err(|_| ReceiverError::Authentication)?,
    );
    if clear.len() > 2048 {
        return Err(ReceiverError::Limit);
    }
    let metadata: Metadata = serde_json::from_slice(&clear).map_err(|_| ReceiverError::Invalid)?;
    metadata.validate()?;
    let at = iso(&metadata.at)?;
    if at > now + Duration::milliseconds(SKEW_MILLIS)
        || at < iso(&package.issued_at)? - Duration::milliseconds(TTL_MILLIS)
    {
        return Err(ReceiverError::Expired);
    }
    Ok(metadata)
}
/// # Errors
/// Only a valid current binding can acknowledge this package.
pub fn acknowledge(
    package: &Package,
    provision: &Provision,
    now: DateTime<Utc>,
) -> Result<Acknowledgement, ReceiverError> {
    authenticate(package, provision, now)?;
    let mut ack = Acknowledgement {
        v: 1,
        package_id: package.package_id.clone(),
        binding_id: package.binding_id.clone(),
        key_epoch: package.key_epoch,
        accepted_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        mac_b64: String::new(),
    };
    ack.mac_b64 = sign(provision, ACK_PURPOSE, &ack.body()?)?;
    Ok(ack)
}
/// # Errors
/// A transport success is not delivery: only an authenticated bounded acknowledgement counts.
pub fn verify_acknowledgement(
    raw: &str,
    package: &Package,
    provision: &Provision,
    now: DateTime<Utc>,
) -> Result<(), ReceiverError> {
    if raw.len() > 2048 {
        return Err(ReceiverError::Limit);
    }
    authenticate(package, provision, now)?;
    let ack: Acknowledgement = serde_json::from_str(raw).map_err(|_| ReceiverError::Invalid)?;
    let accepted = iso(&ack.accepted_at)?;
    if ack.v != 1
        || ack.package_id != package.package_id
        || ack.binding_id != package.binding_id
        || ack.key_epoch != package.key_epoch
        || accepted < iso(&package.issued_at)? - Duration::milliseconds(SKEW_MILLIS)
        || accepted > iso(&package.expires_at)?.min(now + Duration::milliseconds(SKEW_MILLIS))
    {
        return Err(ReceiverError::Authentication);
    }
    verify(provision, ACK_PURPOSE, &ack.body()?, &ack.mac_b64)
}
