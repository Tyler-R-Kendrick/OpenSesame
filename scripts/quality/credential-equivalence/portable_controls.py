"""Relocated controlled parser fixtures, not genuine native proof executions."""
import copy
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from contract import decode, regular, sha
from fixtures import BUNDLE, POLICY, ROOT, SOURCE, job
from portable import Evidence
import proof


def packet(evidence):
    path = evidence/'semantic-inputs/portable-capture.json'
    return path,json.loads(path.read_text())


def update_role(evidence,value,role,transform):
    row = next(v for v in value['files'] if v['role']==role)
    file = evidence/'semantic-inputs'/row['path']
    raw = transform(file.read_bytes())
    file.write_bytes(raw)
    row.update(sha256=sha(raw),size=len(raw))


def alter(evidence,mode):
    path,value = packet(evidence)
    if mode in ('values','target'):
        def changed(raw):
            output = json.loads(raw)
            if mode=='values': output['flags']['O_CREAT']=output['flags']['O_EXCL']
            else: output['arch']='aarch64'
            return json.dumps(output).encode()
        update_role(evidence,value,'probe-stdout',changed)
        value['probe']['stdoutSha256']=next(r['sha256'] for r in value['files'] if r['role']=='probe-stdout')
    if mode=='lock':
        update_role(evidence,value,'libc-checksum',lambda _:json.dumps({'package':'0'*64}).encode())
    if mode=='version':
        def changed(raw):
            output = json.loads(raw)
            next(p for p in output['packages'] if p['name']=='libc')['version']='0.2.188'
            return json.dumps(output).encode()
        update_role(evidence,value,'metadata',changed)
    if mode=='argv': value['probe']['argv'].extend(['--cfg','unix'])
    if mode=='stdout': value['probe']['stdoutSha256']='0'*64
    if mode=='artifact':
        row = next(r for r in value['files'] if r['role']=='rlib')
        (evidence/'semantic-inputs'/row['path']).write_bytes(b'changed artifact')
    path.write_text(json.dumps(value)+'\n')


def opened(evidence,context):
    return Evidence(evidence,context,BUNDLE,POLICY,sha((BUNDLE/'verifier-inputs.json').read_bytes()))


class PortableControls(unittest.TestCase):
    def test_opaque_nonexistent_original_paths_and_relocated_copies_parse(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence,_,context = job(root/'old','linux',0)
            self.assertFalse(Path('/PRODUCER/root').exists())
            before = opened(evidence,context)
            shutil.move(str(root/'old'),root/'relocated')
            after = opened(root/'relocated/mutation-shard',context)
            self.assertEqual(before.flags,after.flags)
            self.assertEqual(after.flags,POLICY['nativeFlags']['linux:x86_64:gnu'])

    def test_three_native_context_parser_domains_windows_has_no_invented_unix_probe(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for platform in ('linux','macos','windows'):
                evidence,_,context = job(root/platform,platform,0)
                result = opened(evidence,context)
                if platform=='windows':
                    self.assertIsNone(result.value['selection'])
                    self.assertIsNone(result.value['probe'])
                    self.assertFalse(hasattr(result,'flags'))
                else: self.assertTrue(result.flags)

    def test_duplicate_missing_unknown_unlisted_absolute_traversal_or_symlink_copy_refuses(self):
        for mode in ('duplicate','missing','unknown','unlisted','absolute','traversal','symlink'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                evidence,_,context = job(Path(temporary)/'job','linux',0)
                path,value = packet(evidence)
                row = value['files'][0]
                if mode=='duplicate': value['files'].append(copy.deepcopy(row))
                if mode=='missing': value['files'].pop()
                if mode=='unknown': row['role']='unexpected'
                if mode=='unlisted': (evidence/'semantic-inputs/files/extra.bin').write_bytes(b'extra')
                if mode=='absolute': row['path']=str(evidence/'semantic-inputs'/row['path'])
                if mode=='traversal': row['path']='../source.txt'
                if mode=='symlink':
                    file = evidence/'semantic-inputs'/row['path']
                    saved = file.with_suffix('.original')
                    file.rename(saved)
                    file.symlink_to(saved)
                path.write_text(json.dumps(value)+'\n')
                with self.assertRaises(ValueError): opened(evidence,context)

    def test_changed_code_copied_source_native_host_sha_or_manifest_refuses(self):
        for mode in ('code','outer','host','source','manifest'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                evidence,_,context = job(Path(temporary)/'job','linux',0)
                path,value = packet(evidence)
                if mode=='code': update_role(evidence,value,'code:inputs.py',lambda raw:raw+b'\n# changed\n')
                if mode=='outer': update_role(evidence,value,'outer:device',lambda raw:raw+b'\n// changed\n')
                if mode=='host': value['host']='aarch64-unknown-linux-gnu'
                if mode=='source': value['source'][0]='0'*40
                if mode=='manifest': value['codeManifestSha256']='0'*64
                path.write_text(json.dumps(value)+'\n')
                with self.assertRaises(ValueError): opened(evidence,context)

    def test_cached_same_name_rlib_unlinked_or_fresh_only_or_wrong_fingerprint_refuses(self):
        for mode in ('cached','fresh','fingerprint','depinfo','probe-copy'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                evidence,_,context = job(Path(temporary)/'job','linux',0)
                path,value = packet(evidence)
                if mode=='cached': value['selection']['rlib']='/other/liblibc-0123456789abcdef.rlib'
                if mode=='fresh':
                    log = evidence/value['baseline']['logPath']
                    log.write_text(' Fresh opensesame-sealed-store v0.1.0\n')
                    value['baseline']['logSha256']=sha(log.read_bytes())
                if mode=='fingerprint': value['selection']['fingerprint']+='/other'
                if mode=='depinfo': update_role(evidence,value,'rustc-dep',lambda _:b'foreign: /other/src/lib.rs\n')
                if mode=='probe-copy': value['probe']['linkedCopySha256']='0'*64
                path.write_text(json.dumps(value)+'\n')
                with self.assertRaises(ValueError): opened(evidence,context)

    def test_no_successful_test_phase_or_foreign_log_never_closes_capture(self):
        for mode in ('build-only','failed-test','foreign-log'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                evidence,_,context = job(Path(temporary)/'job','linux',0)
                path,value = packet(evidence)
                raw = evidence/'mutants/mutants.out/outcomes.json'
                report = json.loads(raw.read_text())
                if mode=='build-only': report['outcomes'][0]['phase_results'].pop()
                if mode=='failed-test': report['outcomes'][0]['phase_results'][-1]['process_status']='Failure'
                if mode=='foreign-log': value['baseline']['logPath']='other.log'
                raw.write_text(json.dumps(report)+'\n')
                value['baseline']['outcomesSha256']=sha(raw.read_bytes())
                path.write_text(json.dumps(value)+'\n')
                with self.assertRaises((ValueError,FileNotFoundError)): opened(evidence,context)

    def test_changed_masks_output_resource_pointer_or_real_package_checksum_refuses(self):
        for mode in ('values','target','lock','version','argv','stdout','artifact'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                evidence,_,context = job(Path(temporary)/'job','linux',0)
                alter(evidence,mode)
                with self.assertRaises(ValueError): opened(evidence,context)

    def test_root_source_code_membership_and_original_command_replay_keep_raw_missed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence,_,_ = job(root/'job','linux',0)
            output = root/'replay'
            output.mkdir()
            result = proof.analyze(ROOT,evidence,None,output,POLICY,SOURCE,
                                   sha((BUNDLE/'verifier-inputs.json').read_bytes()))
            self.assertEqual(result['rawToolExit'],2)
            self.assertFalse(result['rawAdmitted'])
            self.assertEqual(result['fullGeneratedCount'],len(json.loads((evidence/'all-generated.json').read_text())))
            self.assertTrue(result['semanticAdmitted'])
            self.assertTrue(result['annotations'])
            self.assertTrue(all(r['nativeSummary']=='MissedMutant' for r in result['annotations']))

    def test_source_code_capture_omission_or_changed_original_dispatch_argument_refuses(self):
        for mode in ('code','command'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                evidence,receipt,_ = job(root/'job','linux',0)
                if mode=='code':
                    path = evidence/'source.before.json'
                    document = json.loads(path.read_text())
                    del document['scripts/quality/credential-equivalence/inputs.py']
                    path.write_text(json.dumps(document))
                    (evidence/'source.after.json').write_text(json.dumps(document))
                    receipt['sourcePins']=document
                if mode=='command': receipt['command'].append('--timeout=1')
                (evidence/'shard-receipt.json').write_text(json.dumps(receipt))
                output = root/'replay'
                output.mkdir()
                with self.assertRaises(ValueError):
                    proof.analyze(ROOT,evidence,None,output,POLICY,SOURCE,
                                  sha((BUNDLE/'verifier-inputs.json').read_bytes()))
