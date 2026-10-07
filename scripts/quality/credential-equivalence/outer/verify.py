#!/usr/bin/env python3
"""Private source-pinned arithmetic check, not a Rust execution/mutation verdict."""
import copy
import hashlib
import json
from pathlib import Path
import re
import tomllib

HERE = Path(__file__).resolve().parent
ROOT = Path('/workspace/OpenSesame-retired-traps')
PIN = json.loads((HERE / 'source-pins.json').read_text())


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def compact_size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode())


def norm(value):
    return re.sub(r'\s+', '', value)


def source_contains(sources, name, fragment):
    require(norm(fragment) in norm(sources[name]), f'missing source fact: {name}: {fragment}')


def fields(sources, name, struct, expected):
    match = re.search(r'pub struct ' + struct + r'\s*\{([^}]+)\}', sources[name])
    require(match is not None, f'missing struct {struct}')
    found = re.findall(r'pub (\w+):\s*([^,\n]+)', match[1])
    require([(a, norm(b)) for a, b in found] == [(a, norm(b)) for a, b in expected],
            f'layout differs: {struct}')


def constant(sources, name, symbol):
    match = re.search(r'(?:pub )?const ' + symbol + r': usize = ([\d_]+);', sources[name])
    require(match is not None, f'missing constant {symbol}')
    return int(match[1].replace('_', ''))


def verify(sources, pin_check=True):
    if pin_check:
        for row in PIN:
            require(hashlib.sha256(sources[row['name']].encode()).hexdigest() == row['sha256'],
                    f'source drift: {row["name"]}')
    fields(sources, 'device', 'DeviceState', [('v','u32'), ('registry','Registry'),
           ('receiver','Option<Config>'), ('outbox','Outbox'), ('owner_test_witnesses','Vec<OwnerTestWitness>')])
    fields(sources, 'device', 'OwnerTestWitness', [('package_id','String'), ('manifest_digest_b64','String')])
    fields(sources, 'queue', 'Config', [('v','u32'), ('tomb','String'), ('vault_identity','String'),
           ('revision','String'), ('provision','Provision'), ('enabled','bool'), ('verified','bool')])
    fields(sources, 'receiver', 'Provision', [('v','u32'), ('receiver_id','String'), ('binding_id','String'),
           ('origin','String'), ('independent_key_material_b64','String'), ('key_epoch','u32'),
           ('expires_at','String'), ('allow_loopback','bool')])
    fields(sources, 'crypto', 'AssociatedData', [('envelope_version','u32'), ('item_id','String'),
           ('organization_id','String'), ('project_id','String'), ('collection_id','String'),
           ('key_id','String'), ('revision','u64')])
    fields(sources, 'crypto', 'EncryptedEnvelope', [('version','u32'), ('nonce','String'),
           ('ciphertext','String'), ('ad','AssociatedData'), ('ad_digest','String')])
    facts = {
        'device': ['#[serde(rename_all = "camelCase", deny_unknown_fields)]',
                   '#[serde(default, skip_serializing_if = "Vec::is_empty")]',
                   'self.registry.encode().map_err(|_| ReceiverError::Limit)?;',
                   'self.outbox.validate(tomb, identity)?;',
                   'self.owner_test_witnesses.len() > super::receiver::MAX_ENTRIES',
                   '!super::protocol::valid_uuid(&witness.package_id)',
                   'super::protocol::decode_digest(&witness.manifest_digest_b64).is_err()',
                   'receiver.validate(tomb, identity)?;', 'self.encode()?;',
                   'if raw.len() > MAX_DEVICE_STATE_BYTES'],
        'registry': ['if text.len() > super::MAX_REGISTRY_BYTES',
                     'let text = serde_json::to_string(self)', 'self.validate(&self.tomb, &self.vault_identity)?;'],
        'queue': ['#[serde(rename_all = "camelCase", deny_unknown_fields)]',
                  '!text(tomb, 256)', '!text(identity, 256)',
                  '!super::super::protocol::valid_uuid(&self.revision)',
                  'self.provision.validate()', 'self.encode()?;',
                  'if raw.len() > MAX_OUTBOX_BYTES'],
        'receiver': ['#[serde(rename_all = "camelCase", deny_unknown_fields)]',
                     'value.encode_utf16().count() <= max', 'self.v != 1',
                     '!text(&self.receiver_id, 128)', '!text(&self.binding_id, 128)',
                     'self.origin.len() > 2048', 'iso(&self.expires_at)?;', 'value.len() != 24',
                     'STANDARD.encode(result) != value', 'b64::<64>(&self.independent_key_material_b64)?'],
        'protocol': ['value.encode_utf16().count() <= 256',
                     'id.to_string().eq_ignore_ascii_case(value)',
                     'pub(super) fn decode_digest(value: &str) -> Result<[u8; 32], CanaryError>',
                     'STANDARD.encode(result) != value'],
        'storage': ['let clear = Zeroizing::new(self.state.encode().map_err(failure)?);',
                    'if clear.len() > MAX_DEVICE_STATE_BYTES', 'if bytes.len() > MAX_SEALED_BYTES',
                    'let bytes = serde_json::to_vec(&envelope)',
                    'associated(&self.state.registry.vault_identity)',
                    'project_id: identity.into()', 'envelope_version: 1', 'revision: 1'],
        'crypto': ['pub const ENVELOPE_VERSION: u32 = 1;',
                   'let mut nonce = [0u8; 24];', 'ciphertext: STANDARD.encode(ct)',
                   'nonce: STANDARD.encode(nonce)', 'Ok(format!("blake3:{}", blake3::hash(&bytes).to_hex()))',
                   'msg: plaintext,', 'version: ENVELOPE_VERSION'],
        'chacha': ['type TagSize = U16;'],
        'aead': ['buffer.extend_from_slice(tag.as_slice())?;',
                 'let mut buffer = Vec::with_capacity(payload.msg.len() + Self::TagSize::to_usize());'],
        'serde': ['tri!(formatter.write_string_fragment(writer, string_run));',
                  'self::UU => CharEscape::AsciiControl(byte)', 'static ESCAPE: [u8; 256]'],
    }
    for name, fragments in facts.items():
        for fragment in fragments:
            source_contains(sources, name, fragment)
    table = re.search(r'static ESCAPE: \[u8; 256\] = \[([^]]+)\]', sources['serde'])
    require(table is not None, 'serde escape table missing')
    entries = re.sub(r'//[^\n]*', '', table[1]).replace('\n', '').split(',')
    entries = [entry.strip() for entry in entries if entry.strip()]
    require(len(entries) == 256, 'serde escape table length changed')
    alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=:-._'
    require(all(entries[ord(char)] == '__' for char in alphabet), 'bounded ASCII field now escaped')
    clear_cap = constant(sources, 'device', 'MAX_DEVICE_STATE_BYTES')
    sealed_cap = constant(sources, 'storage', 'MAX_SEALED_BYTES')
    registry_cap = constant(sources, 'mod', 'MAX_REGISTRY_BYTES')
    outbox_cap = constant(sources, 'queue', 'MAX_OUTBOX_BYTES')
    witnesses = constant(sources, 'queue', 'MAX_ENTRIES')
    require((clear_cap, sealed_cap, registry_cap, outbox_cap, witnesses) ==
            (131072, 196608, 32768, 65536, 32), 'constant scope changed')
    packages = tomllib.loads(sources['lock'])['package']
    for name, version in [('serde_json','1.0.151'), ('chacha20poly1305','0.10.1'), ('aead','0.5.2')]:
        require(any(p['name'] == name and p['version'] == version for p in packages), 'dependency changed')
    provision = dict(v=1, receiverId='', bindingId='', origin='', independentKeyMaterialB64='',
                     keyEpoch=4294967295, expiresAt='', allowLoopback=False)
    config = dict(v=1, tomb='', vaultIdentity='', revision='', provision=provision, enabled=False, verified=False)
    config_fixed = compact_size(config)
    config_bound = config_fixed + 6*256*2 + 36 + 6*128*2 + 6*2048 + 88 + 24
    witness_fixed = compact_size(dict(packageId='', manifestDigestB64=''))
    one_witness = witness_fixed + 36 + 44
    witnesses_bound = 2 + witnesses*one_witness + witnesses-1
    wrapper = compact_size(dict(v=1, registry={}, receiver={}, outbox={}, ownerTestWitnesses=[])) - 8
    state_bound = registry_cap + outbox_cap + config_bound + witnesses_bound + wrapper
    ad = dict(envelope_version=1, item_id='credential-observation-device-state.v1',
              organization_id='local-device-detector', project_id='',
              collection_id='closed-credential-observations', key_id='independent-device-key.v1', revision=1)
    for field in ['item_id', 'organization_id', 'collection_id', 'key_id']:
        source_contains(sources, 'storage', f'{field}: "{ad[field]}".into()')
    envelope_fixed = compact_size(dict(version=1, nonce='', ciphertext='', ad=ad, ad_digest=''))
    ciphertext_bound = 4*((clear_cap + 16 + 2)//3)
    envelope_bound = envelope_fixed + ciphertext_bound + 32 + 71 + 6*256
    require(state_bound < clear_cap, 'state bound reaches clear comparison')
    require(envelope_bound < sealed_cap, 'envelope bound reaches sealed comparison')
    return dict(configFixed=config_fixed, configBound=config_bound, oneWitnessBound=one_witness,
                witnessesArrayBound=witnesses_bound, stateWrapper=wrapper, completeAdmittedStateBound=state_bound,
                clearCap=clear_cap, envelopeFixed=envelope_fixed, ciphertextBase64Upper=ciphertext_bound,
                sealedEnvelopeBoundAtClearCap=envelope_bound, sealedCap=sealed_cap)


def main():
    sources = {row['name']: Path(row['absolutePath']).read_text() for row in PIN}
    result = verify(sources)
    controls = []
    challenges = [
        ('source-byte-drift', 'device', '//! Protected', '//! Reviewed', True),
        ('device-field-added', 'device', 'pub v: u32,', 'pub unbounded: String,\n    pub v: u32,', False),
        ('provision-field-added', 'receiver', 'pub receiver_id: String,', 'pub unbounded: String,\n    pub receiver_id: String,', False),
        ('envelope-field-added', 'crypto', 'pub nonce: String,', 'pub extension: String,\n    pub nonce: String,', False),
        ('clear-encode-comparison-weakened', 'device', 'if raw.len() > MAX_DEVICE_STATE_BYTES', 'if raw.len() < MAX_DEVICE_STATE_BYTES', False),
        ('registry-encode-comparison-weakened', 'registry', 'if text.len() > super::MAX_REGISTRY_BYTES', 'if text.len() < super::MAX_REGISTRY_BYTES', False),
        ('outbox-encode-comparison-weakened', 'queue', 'if raw.len() > MAX_OUTBOX_BYTES', 'if raw.len() < MAX_OUTBOX_BYTES', False),
        ('receiver-id-limit-expanded', 'receiver', '!text(&self.receiver_id, 128)', '!text(&self.receiver_id, 8192)', False),
        ('origin-limit-expanded', 'receiver', 'self.origin.len() > 2048', 'self.origin.len() > 65536', False),
        ('witness-retention-expanded', 'queue', 'MAX_ENTRIES: usize = 32', 'MAX_ENTRIES: usize = 32000', False),
        ('aead-tag-size-changed', 'chacha', 'type TagSize = U16;', 'type TagSize = U32;', False),
        ('serializer-escape-table-malformed', 'serde', 'static ESCAPE: [u8; 256]', 'static ESCAPE: [u8; 512]', False),
        ('static-associated-id-expanded', 'storage', 'item_id: "credential-observation-device-state.v1".into()', 'item_id: "unexpected-extended-purpose".into()', False),
    ]
    for name, source, old, new, pinned in challenges:
        altered = copy.copy(sources)
        require(old in altered[source], f'control not exercised: {name}')
        altered[source] = altered[source].replace(old, new)
        try:
            verify(altered, pin_check=pinned)
        except ValueError as error:
            controls.append(dict(name=name, status='rejected', reason=str(error)))
        else:
            raise ValueError(f'negative control admitted: {name}')
    evidence = dict(kind='independent-private-source-arithmetic', bounds=result, controls=controls,
                    negativeControlCount=len(controls), rustExecuted=False, mutationStatusesChanged=False)
    (HERE / 'verification.json').write_text(json.dumps(evidence, indent=2)+'\n')
    print(json.dumps(dict(bounds=result, negativeControlsRejected=len(controls))))


if __name__ == '__main__':
    main()
