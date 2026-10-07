"""Controlled accounting/protocol fixtures. Never native execution or owner verdicts."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from classification import POLICY, decide, partition, repository_code, source_policy
from contract import sha
from failure_contract import provenance, validate
from fixtures import BUNDLE, ROOT, SOURCE, job, write
from portable import Evidence
from runner_invocation import validate as invocation_validate
import collect
from collect_controls import core_jobs


def sample(root,misses=True):
    evidence,receipt,context = job(root/'job','linux',0,misses)
    raw = json.loads((evidence/'mutants/mutants.out/outcomes.json').read_text())
    owned = {x['name']:x for x in receipt['assigned']}
    sets = {};equivalent=[]
    for row in raw['outcomes']:
        if row['scenario']=='Baseline': continue
        status=row['summary'];sets[status]=sets.get(status,0)+1
        if status=='MissedMutant':
            equivalent.append({'mutant':owned[row['scenario']['Mutant']['name']],
                               'nativeSummary':'MissedMutant',
                               'disposition':'reviewed-source-equivalent-in-domain'})
    diagnostic={'rawTotals':sets,'annotations':equivalent,'activeUncaught':[]}
    return evidence,receipt,context,raw,diagnostic


def classified_job(root,platform,index):
    evidence,receipt,context = job(root,platform,index)
    output=root/'producer-proof';output.mkdir()
    result=decide(ROOT,evidence,output,SOURCE,sha((BUNDLE/'verifier-inputs.json').read_bytes()),
                  0 if receipt['admission']['admitted'] else 1)
    write(evidence/'adapter-requirement.json',result)
    text=(root/'steps.txt').read_text().replace('execute=failure','execute=success')
    (root/'steps.txt').write_text(text)
    return evidence,receipt,context


class ClassificationControls(unittest.TestCase):
    def test_raw_missed_exit_two_remains_visible_with_full_exact_denominators(self):
        with tempfile.TemporaryDirectory() as temp:
            _,receipt,_,raw,diagnostic=sample(Path(temp))
            before=copy.deepcopy(raw);result=partition(receipt,raw,diagnostic)
            self.assertEqual(raw,before)
            self.assertEqual(result['fullGenerated'],receipt['full'])
            self.assertEqual(result['nativeApplicable'],receipt['active'])
            self.assertEqual(result['counts']['G'],result['counts']['A']+result['counts']['I'])
            self.assertEqual(result['counts']['M'],result['counts']['E'])
            self.assertGreater(result['counts']['M'],0)
            self.assertEqual(result['counts']['Q'],0)
            self.assertEqual(result['counts']['T'],0)
            self.assertTrue(result['adapterNonEquivalentRequirement'])
            self.assertTrue(result['noReplacementKillScore'])

    def test_one_unreviewed_viable_miss_keeps_requirement_failed(self):
        with tempfile.TemporaryDirectory() as temp:
            _,receipt,_,raw,diagnostic=sample(Path(temp))
            row=next(r for r in raw['outcomes'] if r['summary']=='CaughtMutant')
            row['summary']='MissedMutant'
            diagnostic['rawTotals']['CaughtMutant']-=1
            diagnostic['rawTotals']['MissedMutant']+=1
            diagnostic['activeUncaught']=[row['scenario']['Mutant']['name']]
            result=partition(receipt,raw,diagnostic)
            self.assertEqual(result['counts']['Q'],1)
            self.assertFalse(result['adapterNonEquivalentRequirement'])

    def test_timeout_unknown_missing_duplicate_and_altered_raw_objects_refuse(self):
        for mode in ('timeout','unknown','missing','duplicate','object','totals','inactive'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as temp:
                _,receipt,_,raw,d=sample(Path(temp));row=raw['outcomes'][1]
                if mode in ('timeout','unknown'): row['summary']='Timeout' if mode=='timeout' else 'Unknown'
                if mode=='missing': raw['outcomes'].pop()
                if mode=='duplicate': raw['outcomes'].append(copy.deepcopy(row))
                if mode=='object': row['scenario']['Mutant']['replacement']='changed'
                if mode=='totals': d['rawTotals']['CaughtMutant']+=1
                if mode=='inactive': receipt['active'][0]['replacement']='changed'
                with self.assertRaises(ValueError):partition(receipt,raw,d)

    def test_equivalence_cannot_relabel_caught_unviable_or_an_unexecuted_miss(self):
        for mode in ('caught','unviable','incomplete','failed','duplicate','object'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as temp:
                _,receipt,_,raw,d=sample(Path(temp))
                annotation=d['annotations'][0];name=annotation['mutant']['name']
                row=next(r for r in raw['outcomes'] if r['scenario']!='Baseline' and r['scenario']['Mutant']['name']==name)
                if mode in ('caught','unviable'):
                    old=row['summary'];row['summary']='CaughtMutant' if mode=='caught' else 'Unviable'
                    d['rawTotals'][old]-=1;d['rawTotals'][row['summary']]=d['rawTotals'].get(row['summary'],0)+1
                if mode=='incomplete':row['phase_results'].pop()
                if mode=='failed':row['phase_results'][1]['process_status']='Failure'
                if mode=='duplicate':d['annotations'].append(copy.deepcopy(annotation))
                if mode=='object':annotation['mutant']['replacement']='changed'
                with self.assertRaises(ValueError):partition(receipt,raw,d)

    def test_unviable_remains_explicit_and_all_equivalent_or_unviable_is_not_nonvacuous(self):
        for status in ('MissedMutant','Unviable'):
            with self.subTest(status=status),tempfile.TemporaryDirectory() as temp:
                _,receipt,_,raw,d=sample(Path(temp))
                rows=[r for r in raw['outcomes'] if r['scenario']!='Baseline' and r['summary']=='MissedMutant']
                receipt['assigned']=[a['mutant'] for a in d['annotations']]
                raw['outcomes']=[raw['outcomes'][0],*rows]
                for row in rows:row['summary']=status
                d['rawTotals']={status:len(rows)}
                if status=='Unviable':d['annotations']=[]
                result=partition(receipt,raw,d)
                self.assertEqual(result['counts']['C'],0)
                self.assertFalse(result['adapterNonEquivalentRequirement'])
                if status=='Unviable':self.assertEqual(result['counts']['U'],len(rows))

    def test_only_specific_original_tool_two_cause_is_eligible(self):
        with tempfile.TemporaryDirectory() as temp:
            evidence,receipt,_,_,_=sample(Path(temp))
            self.assertEqual(validate(evidence,receipt,1)['toolExit'],2)
            for mode in ('exception','kind','reasons','errors','source','complete','exit','signal','report'):
                value=copy.deepcopy(receipt)
                if mode=='exception':value['rawFailureProvenance']['exception']['class']='OSError'
                if mode=='kind':value['rawFailureProvenance']['commandFailureKind']='none'
                if mode=='reasons':value['rawFailureProvenance']['reasons'].append('other-error')
                if mode=='errors':value['rawFailureProvenance']['errors']=['unrelated-runner-error']
                if mode=='source':value['rawFailureProvenance']['sourceUnchanged']=False
                if mode=='complete':value['rawFailureProvenance']['reportComplete']=False
                if mode=='exit':value['rawFailureProvenance']['toolExit']=0
                if mode=='report':value['reportError']='other error'
                with self.subTest(mode=mode),self.assertRaises(ValueError):
                    validate(evidence,value,-9 if mode=='signal' else 1)

    def test_raw_clean_success_has_no_equivalence_or_failed_runner_cause(self):
        with tempfile.TemporaryDirectory() as temp:
            evidence,receipt,_,raw,d=sample(Path(temp),False)
            self.assertTrue(validate(evidence,receipt,0)['rawAdmitted'])
            result=partition(receipt,raw,d)
            self.assertEqual(result['counts']['E'],0)
            self.assertEqual(result['counts']['M'],0)
            self.assertTrue(result['adapterNonEquivalentRequirement'])
            with self.assertRaises(ValueError):validate(evidence,receipt,1)

    def test_permissive_source_modes_types_classes_or_environment_cannot_select_policy(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            (root/'policy.json').write_bytes((BUNDLE/'policy.json').read_bytes())
            for key,value in [('requirement','accept-any-missed'),('group','core'),('shards',16),
                              ('v',True),('timeoutsAllowed',True),('rawResultsImmutable',1),
                              ('classes',{'outer-size':21})]:
                candidate=copy.deepcopy(POLICY);candidate[key]=value
                write(root/'requirement-policy.json',candidate)
                with self.subTest(key=key),self.assertRaises(ValueError):source_policy(root)
            with patch.dict('os.environ',{'OPENSESAME_EQUIVALENCE_MODE':'accept-any','ALLOW_EQUIVALENTS':'1'}):
                self.assertEqual(source_policy(),POLICY)

    def test_runner_invocation_family_executable_source_exit_and_log_hashes_are_bound(self):
        for mode in ('family','python','source','exit','log','hash'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as temp:
                evidence,receipt,context,_,_=sample(Path(temp))
                native=json.loads((BUNDLE/'policy.json').read_text())
                portable=Evidence(evidence,context,BUNDLE,native,sha((BUNDLE/'verifier-inputs.json').read_bytes()))
                path=evidence.parent/'adapter-raw-runner.invocation.json';value=json.loads(path.read_text())
                if mode=='family':value['argv'][3]='core'
                if mode=='python':value['argv'][0]='/alternate/python'
                if mode=='source':value['source'][0]='0'*40
                if mode=='exit':value['exit']=0
                if mode=='log':(evidence.parent/'adapter-raw-runner.stderr').write_bytes(b'changed')
                if mode=='hash':value['stdoutSha256']='0'*64
                write(path,value)
                with self.assertRaises(ValueError):invocation_validate(evidence,receipt,1,portable)

    def test_exact_proof_decision_is_separate_from_raw_failure_and_core_is_not_eligible(self):
        with tempfile.TemporaryDirectory() as temp:
            evidence,receipt,_,_,_=sample(Path(temp));output=Path(temp)/'proof';output.mkdir()
            result=decide(ROOT,evidence,output,SOURCE,sha((BUNDLE/'verifier-inputs.json').read_bytes()),1)
            self.assertTrue(result['adapterNonEquivalentRequirement'])
            self.assertFalse(result['rawMutationAdmission'])
            self.assertEqual((result['rawToolExit'],result['rawRunnerExit']),(2,1))
            self.assertEqual(result['accounting']['counts']['M'],result['accounting']['counts']['E'])
            receipt['group']='core';write(evidence/'shard-receipt.json',receipt)
            with self.assertRaises(ValueError):decide(ROOT,evidence,output,SOURCE,sha((BUNDLE/'verifier-inputs.json').read_bytes()),1)

    def test_new_collector_requires_successful_family_matrix_and_actual_execute_requirement(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);artifacts=root/'artifacts';artifacts.mkdir()
            for label in collect.labels():(artifacts/label).mkdir()
            output=root/'out';output.mkdir()
            for state in ('failure','cancelled','skipped','unknown'):
                with self.subTest(state=state),self.assertRaises(ValueError):
                    collect.run(ROOT,artifacts,state,output,SOURCE,sha((BUNDLE/'verifier-inputs.json').read_bytes()),True)
            evidence,_,_=classified_job(root/'job','linux',0)
            collect.prerequisites(evidence.parent,'linux',2,True)
            (evidence.parent/'steps.txt').write_text((evidence.parent/'steps.txt').read_text().replace('execute=success','execute=failure'))
            with self.assertRaises(ValueError):collect.prerequisites(evidence.parent,'linux',2,True)

    def test_repository_helpers_are_exact_bytes_not_a_reported_code_boolean(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            pins=json.loads((BUNDLE/'repository-code-pins.json').read_text())
            for path in pins['files']:
                target=root/path;target.parent.mkdir(parents=True,exist_ok=True)
                data=(BUNDLE/'runner-source.py').read_bytes() if path.endswith('/rust-mutation-shard.py') else (ROOT/path).read_bytes()
                target.write_bytes(data)
            self.assertEqual(repository_code(root),pins)
            target=root/'scripts/quality/rust-mutation-shard.py';target.write_bytes(target.read_bytes()+b'\n# changed')
            with self.assertRaises(ValueError):repository_code(root)

    def test_complete_independent_union_keeps_raw_failure_and_every_platform_object(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);artifacts=root/'artifacts';artifacts.mkdir();core_jobs(artifacts)
            for platform in ('linux','windows','macos'):
                for index in range(8):
                    classified_job(artifacts/f'credential-rust-mutation-adapters-{platform}-{index}of8',platform,index)
            output=root/'collector';output.mkdir()
            result=collect.run(ROOT,artifacts,'success',output,SOURCE,sha((BUNDLE/'verifier-inputs.json').read_bytes()),True)
            self.assertEqual(result['proofVerification'],'verified')
            self.assertFalse(result['rawAdmission'])
            self.assertEqual(len(result['shards']),24)
            self.assertTrue(any(row['actualRawExit']==2 for row in result['shards']))
            for row in result['shards']:
                ledger=row['diagnostics']['classificationAccounting']
                self.assertEqual(ledger['counts']['Q'],0)
                self.assertEqual(ledger['counts']['M'],ledger['counts']['E'])
                self.assertEqual(ledger['counts']['G'],ledger['counts']['A']+ledger['counts']['I'])
                self.assertTrue(ledger['adapterNonEquivalentRequirement'])
            self.assertEqual(result['historicalReference']['missed'],100)

    def test_forged_producer_pass_is_rejected_by_independent_target_replay(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);artifacts=root/'artifacts';artifacts.mkdir();core_jobs(artifacts)
            target='credential-rust-mutation-adapters-linux-0of8'
            for label,(group,_,_) in collect.labels().items():
                if group=='adapters' and label!=target:(artifacts/label).mkdir()
            evidence,_,_=classified_job(artifacts/target,'linux',0)
            path=evidence/'adapter-requirement.json';value=json.loads(path.read_text())
            value['rawMutationAdmission']=True;write(path,value)
            output=root/'collector';output.mkdir()
            result=collect.run(ROOT,artifacts,'success',output,SOURCE,sha((BUNDLE/'verifier-inputs.json').read_bytes()),True)
            self.assertEqual(result['proofVerification'],'failure')
            failures=[row for row in result['errors'] if row.get('artifact')==target]
            self.assertEqual(len(failures),1)
            self.assertIn('not independently reproducible',failures[0]['error'])
