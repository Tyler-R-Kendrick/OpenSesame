"""Authenticated manifest check; native artifact linkage lives in portable.py."""
from contract import code_binding, require, sha, regular


def verifier_binding(bundle, expected_sha):
    manifest = code_binding(bundle,expected_sha)
    return {'manifestSha256':sha(regular(bundle,'verifier-inputs.json').read_bytes()),
            'files':manifest['files'],
            'qualification':'Collector must independently authenticate source and these exact bytes.'}
