#!/usr/bin/env python3
"""Prepared pure/input controls. Fictional capture fixtures never claim native execution."""
import copy
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

import inputs
import proof
from fixtures import job, REGISTRY
from portable import Evidence

BUNDLE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get('OPENSESAME_EQUIVALENCE_TEST_ROOT',Path.cwd())).resolve()
POLICY = inputs.read_json(BUNDLE/'policy.json')


def listing():
    return [{**copy.deepcopy(site['mutant']), 'diff':'controlled metadata fixture; not native execution'}
            for site in POLICY['sites']]


def phases():
    return [{'phase':'Build','process_status':'Success','duration':1.0},
            {'phase':'Test','process_status':'Success','duration':1.0}]


def document(values):
    return {'cargo_mutants_version':'27.1.0','outcomes':[
        {'scenario':'Baseline','summary':'Success','phase_results':phases()},
        *[{'scenario':{'Mutant':{k:v for k,v in value.items() if k != 'diff'}},
           'summary':'MissedMutant','phase_results':phases()} for value in values]]}


def capture(root, name, content):
    (root/name).write_text(content)
    (root/(name+'.exit')).write_text('0\n')


def context_fixture(root):
    # Synthetic parser input using the reviewed public release metadata, never an execution receipt.
    rust = ('rustc 1.88.0 (6b00bc388 2025-06-23)\nbinary: rustc\n'
            'commit-hash: 6b00bc3880198600130e1cf62b8f8a93494488cc\ncommit-date: 2025-06-23\n'
            'host: x86_64-unknown-linux-gnu\nrelease: 1.88.0\nLLVM version: 20.1.5\n')
    cfg = ['unix','target_os="linux"','target_arch="x86_64"','target_env="gnu"']
    capture(root,'rustc.txt',rust)
    capture(root,'mutants-version.txt','cargo-mutants 27.1.0\n')
    capture(root,'native.cfg','\n'.join(cfg)+'\n')
    for package in inputs.PACKAGES:
        features = ['feature="default"'] if package == inputs.PACKAGES[0] else []
        capture(root,package+'.cfg','\n'.join(cfg+features)+'\n')
    receipt = {'platform':'linux','compiler':{'rustc':rust,'tool':'cargo-mutants 27.1.0',
               'cfg':cfg,'packageCfg':{package:sorted(cfg+(['feature="default"'] if package == inputs.PACKAGES[0] else []))
                                     for package in inputs.PACKAGES}}}
    return receipt


class ExactObjectControls(unittest.TestCase):
    def test_twenty_one_source_sites_match_the_current_frozen_text(self):
        values = listing()
        self.assertEqual(len(values),21)
        classes = {}
        for site,value in zip(POLICY['sites'],values):
            self.assertIs(proof.candidate(site,value,(ROOT/value['file']).read_text()),site)
            classes[site['proofClass']] = classes.get(site['proofClass'],0)+1
        self.assertEqual(classes,{'disjoint-flags':15,'supported-cfg':2,'outer-size':4})

    def test_changed_name_package_file_replacement_genre_function_and_span_refuse(self):
        site = POLICY['sites'][0]
        original = listing()[0]
        source = (ROOT/original['file']).read_text()
        changed = {key:'unreviewed' for key in ['name','package','file','replacement','genre']}
        for key,value in changed.items():
            with self.subTest(key=key), self.assertRaises(ValueError):
                proof.candidate(site,{**original,key:value},source)
        for key in ['function','span']:
            with self.subTest(key=key), self.assertRaises(ValueError):
                proof.candidate(site,{**original,key:{}},source)
        function_start = original['function']['span']['start']
        lines = source.splitlines(keepends=True)
        index = sum(len(line) for line in lines[:function_start['line']-1])
        for prefix in ['#[cfg(windows)]\n', '#[allow(dead_code)]\n']:
            with self.subTest(prefix=prefix), self.assertRaises(ValueError):
                proof.candidate(site,original,source[:index]+prefix+source[index:])

    def test_span_is_one_based_unicode_char_exclusive_end_and_rejects_bad_points(self):
        self.assertEqual(proof.extract('é|x\n',{'start':{'line':1,'column':2},
                                                 'end':{'line':1,'column':3}}),'|')
        for point in [{'line':1,'column':True},{'line':0,'column':1},{'line':8,'column':1}]:
            with self.subTest(point=point), self.assertRaises(ValueError):
                proof.extract('x',{'start':point,'end':{'line':1,'column':2}})

    def test_listing_unknown_fields_duplicates_and_vacuous_list_refuse(self):
        value = listing()[0]
        for values in [[],[value,value],[{**value,'authority':True}],
                       [{k:v for k,v in value.items() if k != 'diff'}]]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                proof.indexed(values)

    def test_source_pin_drift_is_not_a_new_revision_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for path in POLICY['repoPins']:
                target = root/path
                target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes((ROOT/path).read_bytes())
            inputs.source_inputs(root,POLICY)
            path = root/POLICY['sites'][0]['mutant']['file']
            path.write_bytes(path.read_bytes()+b'\n// changed source')
            with self.assertRaises(ValueError):
                inputs.source_inputs(root,POLICY)

    def test_duplicate_and_nonfinite_json_refuse_before_proof(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/'input.json'
            for raw in ['{"v":1,"v":2}','{"nested":{"x":1,"x":2}}','{"x":NaN}']:
                path.write_text(raw)
                with self.subTest(raw=raw), self.assertRaises(ValueError):
                    inputs.read_json(path)

    def test_whole_capture_missing_duplicate_changed_or_nonfresh_inputs_refuse(self):
        for mode in ['valid','missing','duplicate','digest','freshness']:
            with tempfile.TemporaryDirectory() as temporary:
                parent = Path(temporary)
                evidence = parent/'mutation-shard'
                evidence.mkdir()
                rows = [{'path':path,'kind':'file','sha256':digest}
                        for path,digest in POLICY['repoPins'].items()]
                if mode == 'missing': rows.pop()
                if mode == 'duplicate': rows.append(copy.deepcopy(rows[0]))
                if mode == 'digest': rows[0]['sha256'] = '0'*64
                opening = parent/'inputs.before.json'
                opening.write_text(json.dumps(rows))
                (parent/'inputs.changed-paths.json').write_text('[]' if mode != 'freshness' else '["changed"]')
                receipt = {'wholeSourceBeforeSHA256':inputs.sha(opening.read_bytes())}
                if mode == 'valid': inputs.whole_inputs(evidence,receipt,POLICY)
                else:
                    with self.subTest(mode=mode), self.assertRaises(ValueError):
                        inputs.whole_inputs(evidence,receipt,POLICY)

    def test_reuses_exact_outer_checker_and_all_thirteen_controls(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = inputs.outer_proof(ROOT,REGISTRY,BUNDLE,POLICY,Path(temporary))
            self.assertEqual(result['negativeControlCount'],13)
            self.assertEqual(result['bounds'],POLICY['outerBounds'])

    def test_outer_checker_code_or_pin_tampering_refuses_before_import(self):
        for name in ['verify.py','source-pins.json']:
            with tempfile.TemporaryDirectory() as temporary:
                bundle = Path(temporary)
                (bundle/'outer').mkdir()
                for source in ['verify.py','source-pins.json']:
                    shutil.copyfile(BUNDLE/'outer'/source,bundle/'outer'/source)
                target = bundle/'outer'/name
                target.write_bytes(target.read_bytes()+b' ')
                with self.subTest(name=name), self.assertRaises(ValueError):
                    inputs.outer_proof(ROOT,REGISTRY,bundle,POLICY,bundle)


class RawOutcomeControls(unittest.TestCase):
    def test_exit_two_and_missed_statuses_are_retained_not_caught(self):
        values = listing()
        original = document(values)
        snapshot = copy.deepcopy(original)
        outcomes,counts = proof.native_outcomes(original,values,2)
        self.assertEqual(counts,{'MissedMutant':21})
        self.assertEqual(len(outcomes),21)
        self.assertEqual(original,snapshot)
        self.assertTrue(all(x['summary'] == 'MissedMutant' for x in outcomes.values()))

    def test_exit_zero_cannot_cover_survivors_and_other_exit_cannot_be_semantic_pass(self):
        values = listing()
        for status in [0,1,3,4,True]:
            with self.subTest(status=status), self.assertRaises(ValueError):
                proof.native_outcomes(document(values),values,status)

    def test_missing_duplicate_extra_and_changed_mutant_outcomes_refuse(self):
        values = listing()
        base = document(values)
        variants = []
        missing = copy.deepcopy(base); missing['outcomes'].pop(); variants.append(missing)
        duplicate = copy.deepcopy(base); duplicate['outcomes'].append(duplicate['outcomes'][-1]); variants.append(duplicate)
        changed = copy.deepcopy(base); changed['outcomes'][-1]['scenario']['Mutant']['replacement'] = '<'; variants.append(changed)
        extra = copy.deepcopy(base); extra['outcomes'][-1]['scenario']['Mutant']['name'] = 'foreign'; variants.append(extra)
        for value in variants:
            with self.assertRaises(ValueError):
                proof.native_outcomes(value,values,2)

    def test_failed_missing_or_incomplete_baseline_is_not_equivalent(self):
        values = listing()
        for modify in ['failed','absent','incomplete','duplicate']:
            value = document(values)
            if modify == 'failed': value['outcomes'][0]['summary'] = 'Failure'
            if modify == 'absent': value['outcomes'].pop(0)
            if modify == 'incomplete': value['outcomes'][0]['phase_results'].pop()
            if modify == 'duplicate': value['outcomes'].insert(0,copy.deepcopy(value['outcomes'][0]))
            with self.subTest(modify=modify), self.assertRaises(ValueError):
                proof.native_outcomes(value,values,2)

    def test_timeout_unknown_status_or_incomplete_missed_execution_refuse(self):
        values = listing()
        for mode in ['timeout','unknown','build-only','failed-test']:
            value = document(values)
            outcome = value['outcomes'][1]
            if mode == 'timeout': outcome['summary'] = 'Timeout'
            if mode == 'unknown': outcome['summary'] = 'SkippedAsEquivalent'
            if mode == 'build-only': outcome['phase_results'].pop()
            if mode == 'failed-test': outcome['phase_results'][1]['process_status'] = 'Failure'
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                proof.native_outcomes(value,values,2)


class NativeDomainControls(unittest.TestCase):
    def test_all_reviewed_target_masks_and_zero_flag_identity(self):
        for flags in POLICY['nativeFlags'].values():
            for site in POLICY['sites']:
                if site['proofClass'] == 'disjoint-flags':
                    result = proof.flags_identity(flags,site['flags'])
                    self.assertEqual(result['orMask'],result['xorMask'])
        self.assertEqual(proof.flags_identity({'a':0,'b':1},['a','b'])['orMask'],1)

    def test_overlap_negative_boolean_or_unknown_flags_refuse(self):
        for flags,names in [({'a':1,'b':1},['a','b']),({'a':-1,'b':2},['a','b']),
                            ({'a':True,'b':2},['a','b']),({'a':1},['a','b'])]:
            with self.subTest(flags=flags), self.assertRaises(ValueError):
                proof.flags_identity(flags,names)

    def test_fixture_context_parser_and_supported_only_domain_refusal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            receipt = context_fixture(root)
            self.assertEqual(inputs.native_context(root,receipt)['family'],'unix')
            for cfg in [[],['unix','windows'],['target_os="haiku"'],
                        ['unix','target_os="linux"','target_arch="riscv64"','target_env="gnu"']]:
                with self.subTest(cfg=cfg), self.assertRaises(ValueError):
                    inputs.cfg_validate(cfg,('linux','x86_64','gnu','unix'))

    def test_missing_capture_exit_changed_tool_or_feature_injection_refuse(self):
        for mode in ['exit','tool','features','missing-default','host']:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                receipt = context_fixture(root)
                if mode == 'exit': (root/'rustc.txt.exit').write_text('1')
                if mode == 'tool': (root/'mutants-version.txt').write_text('cargo-mutants 26.0.0')
                if mode == 'features':
                    path = root/(inputs.PACKAGES[0]+'.cfg')
                    path.write_text(path.read_text()+'feature="ffi"\n')
                if mode == 'missing-default':
                    path = root/(inputs.PACKAGES[0]+'.cfg')
                    path.write_text(path.read_text().replace('feature="default"\n',''))
                if mode == 'host': (root/'rustc.txt').write_text('rustc 1.88.0 X\nhost: riscv64-unknown-linux-gnu\n')
                with self.subTest(mode=mode), self.assertRaises(ValueError):
                    inputs.native_context(root,receipt)

    def test_constant_receipt_parser_preserves_actual_integer_shape(self):
        with tempfile.TemporaryDirectory() as temporary:
            evidence,_,context = job(Path(temporary)/'job','linux',0)
            digest = inputs.sha((BUNDLE/'verifier-inputs.json').read_bytes())
            portable = Evidence(evidence,context,BUNDLE,POLICY,digest)
            self.assertEqual(inputs.native_flags(evidence,context,BUNDLE,POLICY,portable),
                             POLICY['nativeFlags']['linux:x86_64:gnu'])

    def test_changed_constant_values_target_provenance_argv_or_rlib_refuse(self):
        from portable_controls import alter
        for mode in ['values','target','lock','version','argv','stdout','artifact']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                evidence,_,context = job(Path(temporary)/'job','linux',0)
                alter(evidence,mode)
                digest = inputs.sha((BUNDLE/'verifier-inputs.json').read_bytes())
                with self.assertRaises(ValueError):
                    Evidence(evidence,context,BUNDLE,POLICY,digest)

    def test_cfg_selection_keeps_every_applicable_object_and_refuses_missing_scope(self):
        config = inputs.read_json(BUNDLE/'cfg-inventory.json')
        values = listing()
        represented = {x['file'] for x in values}
        for path, alternatives in config['files'].items():
            if path in represented:
                continue
            value = copy.deepcopy(values[0])
            value.update(name='controlled cfg fixture '+path,file=path,
                         package=alternatives[0]['package'],function=None,
                         span={'start':{'line':1,'column':1},'end':{'line':1,'column':2}})
            values.append(value)
        context = {'family':'unix','packages':{name:[] for name in inputs.PACKAGES}}
        self.assertEqual(inputs.applicable(ROOT,values,context,POLICY,BUNDLE),values)
        windows = {**context,'family':'windows'}
        active = inputs.applicable(ROOT,values,windows,POLICY,BUNDLE)
        flag_names = {site['mutant']['name'] for site in POLICY['sites'] if site['proofClass']=='disjoint-flags'}
        self.assertFalse(flag_names & {value['name'] for value in active})
        for changed in [values[:-1],[{**values[0],'file':'foreign.rs'},*values[1:]]]:
            with self.assertRaises(ValueError):
                inputs.applicable(ROOT,changed,context,POLICY,BUNDLE)


if __name__ == '__main__':
    unittest.main()
