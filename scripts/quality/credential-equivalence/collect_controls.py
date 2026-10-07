"""Independent aggregation controls using explicit parser-only outcome fixtures."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from contract import sha
from fixtures import BUNDLE, POLICY, ROOT, SOURCE, job, write
import collect
from proof import object_digest


def core_jobs(artifacts):
    full = [{**copy.deepcopy(POLICY['sites'][0]['mutant']),'diff':'CONTROLLED core parser fixture',
             'name':'CONTROLLED core '+str(i)} for i in range(8)]
    for index in range(8):
        root = artifacts/f'credential-rust-mutation-core-{index}of8'
        evidence = root/'mutation-shard'
        evidence.mkdir(parents=True)
        write(root/'inputs.before.json',[])
        write(root/'inputs.changed-paths.json',[])
        (root/'source.txt').write_text('\n'.join(SOURCE)+'\n')
        (root/'steps.txt').write_text('\n'.join(k+'=success' for k in
            ['checkout','source','python','rust','tools','execute','freshness'])+'\n')
        write(root/'python.json',{'os':'posix','version':[3,12,0],'executable':'CONTROLLED fixture'})
        mutant = {k:v for k,v in full[index].items() if k!='diff'}
        phases = [{'phase':'Build','process_status':'Success'},{'phase':'Test','process_status':'Success'}]
        document = {'cargo_mutants_version':'27.1.0','outcomes':[
            {'scenario':'Baseline','summary':'Success','phase_results':phases},
            {'scenario':{'Mutant':mutant},'summary':'CaughtMutant','phase_results':phases}]}
        write(evidence/'mutants/mutants.out/outcomes.json',document)
        write(evidence/'assigned.json',[full[index]])
        (evidence/'campaign.log.exit').write_text('0\n')
        admission = {'totals':{'CaughtMutant':1},'admitted':True,
            'qualification':'Applicable equivalents remain in selection and block success when missed; unviable counts are never caught.'}
        write(evidence/'shard-receipt.json',{'v':1,'group':'core','platform':'linux','shard':index,'shards':8,
            'source':SOURCE,'status':'success','sourcePins':{},'canonicalCommand':None,'compiler':{},
            'wholeSourceBeforeSHA256':sha((root/'inputs.before.json').read_bytes()),
            'full':full,'active':full,'assigned':[full[index]],'admission':admission,
            'applicability':[{'mutant':v,'condition':'always','active':True} for v in full],
            'fullInventorySHA256':object_digest(full),'activeInventorySHA256':object_digest(full),
            'outcomesSHA256':sha((evidence/'mutants/mutants.out/outcomes.json').read_bytes())})


def campaign(root,mutate=None):
    artifacts = root/'artifacts'
    artifacts.mkdir()
    core_jobs(artifacts)
    for platform in ('linux','windows','macos'):
        for index in range(8):
            job(artifacts/f'credential-rust-mutation-adapters-{platform}-{index}of8',platform,index)
    if mutate is not None: mutate(artifacts)
    output = root/'diagnostics'
    output.mkdir()
    return collect.run(ROOT,artifacts,'failure',output,SOURCE,
                       sha((BUNDLE/'verifier-inputs.json').read_bytes()))


class CollectorControls(unittest.TestCase):
    def test_expected32_artifact_labels_keep8shards_and3_native_adapter_platforms(self):
        labels = collect.labels()
        self.assertEqual(len(labels),32)
        self.assertEqual(sum(kind=='core' for kind,_,_ in labels.values()),8)
        for platform in ('linux','windows','macos'):
            self.assertEqual({index for kind,p,index in labels.values() if kind=='adapters' and p==platform},
                             set(range(8)))

    def test_full_controlled_union_recomputes_proof_without_admitting_raw_missed(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = campaign(Path(temporary))
            self.assertEqual(result['proofVerification'],'verified')
            self.assertFalse(result['rawAdmission'])
            self.assertEqual(result['matrixResult'],'failure')
            self.assertEqual(len(result['shards']),24)
            self.assertTrue(any(r['actualRawExit']==2 for r in result['shards']))
            self.assertTrue(result['currentStrictRawAdmissionUnchanged'])
            self.assertEqual(result['historicalReference']['missed'],100)

    def test_missing_extra_duplicate_or_mixed_shard_never_verifies_complete_union(self):
        for mode in ('missing','extra','duplicate','source'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                def change(artifacts):
                    root = artifacts/'credential-rust-mutation-adapters-linux-0of8'
                    if mode=='missing': root.rename(artifacts/'missing-original')
                    if mode=='extra': (artifacts/'unexpected').mkdir()
                    if mode in ('duplicate','source'):
                        path = root/'mutation-shard/shard-receipt.json'
                        value = json.loads(path.read_text())
                        if mode=='duplicate': value['shard']=1
                        else: value['source'][0]='0'*40
                        write(path,value)
                if mode in ('missing','extra'):
                    with self.assertRaises(ValueError): campaign(Path(temporary),change)
                else:
                    result = campaign(Path(temporary),change)
                    self.assertEqual(result['proofVerification'],'failure')
                    self.assertTrue(result['errors'])

    def test_false_producer_semantic_result_is_ignored_and_unreviewed_miss_remains_active(self):
        with tempfile.TemporaryDirectory() as temporary:
            def change(artifacts):
                root = artifacts/'credential-rust-mutation-adapters-linux-0of8'
                path = root/'mutation-shard/mutants/mutants.out/outcomes.json'
                value = json.loads(path.read_text())
                next(v for v in value['outcomes'] if v.get('summary')=='CaughtMutant')['summary']='MissedMutant'
                write(path,value)
                # Forge sidecar success; independent report/provenance checks must not accept it.
                write(root/'mutation-shard/semantic-disposition.json',{'semanticAdmitted':True})
            result = campaign(Path(temporary),change)
            self.assertEqual(result['proofVerification'],'failure')
            self.assertFalse(result['rawAdmission'])

    def test_wrong_execute_state_unknown_exit_failed_setup_or_changed_python_refuses(self):
        for mode in ('execute','setup','python','changed'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)/'job'
                evidence,_,_ = job(root,'linux',0)
                if mode in ('execute','setup'):
                    path = root/'steps.txt'
                    text = path.read_text()
                    if mode=='execute': text=text.replace('execute=failure','execute=success')
                    else: text=text.replace('source=success','source=skipped')
                    path.write_text(text)
                if mode=='python': write(root/'python.json',{'os':'nt','version':[3,12,0],'executable':'fixture'})
                if mode=='changed': write(root/'inputs.changed-paths.json',['Cargo.lock'])
                with self.assertRaises(ValueError): collect.prerequisites(root,'linux',2)

    def test_canceled_or_skipped_matrix_remains_diagnostic_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = root/'artifacts'
            artifacts.mkdir()
            for name in collect.labels(): (artifacts/name).mkdir()
            output = root/'out'
            output.mkdir()
            for state in ('cancelled','skipped','unknown'):
                with self.subTest(state=state), self.assertRaises(ValueError):
                    collect.run(ROOT,artifacts,state,output,SOURCE,sha((BUNDLE/'verifier-inputs.json').read_bytes()))
