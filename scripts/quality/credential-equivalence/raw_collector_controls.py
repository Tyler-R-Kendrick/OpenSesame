"""Actual strict Python parser controls; controlled artifacts, no native execution."""
import copy
import tempfile
import unittest
from pathlib import Path

from collect import gate_module, labels
from collect_controls import core_jobs
from fixtures import ROOT, SOURCE, write
from raw_collector_contract import validate


def artifacts_fixture(root):
    artifacts = root/'artifacts';artifacts.mkdir();core_jobs(artifacts)
    for name,(group,_,_) in labels().items():
        if group=='adapters':
            job=artifacts/name;job.mkdir();(job/'mutation-shard').mkdir()
            (job/'steps.txt').write_text(''.join(k+'=success\n' for k in
                ('checkout','source','python','rust','tools','execute','freshness')))
            write(job/'python.json',{'os':'nt' if '-windows-' in name else 'posix',
                'version':[3,12,0],'executable':'CONTROLLED parser Python'})
            write(job/'inputs.changed-paths.json',[])
            write(job/'mutation-shard/shard-receipt.json',{'v':1,'group':'adapters',
                'platform':'linux','status':'failure','shards':8})
    return artifacts


def raw_failure(artifacts):
    gate=gate_module(ROOT)
    try:
        gate.collect(artifacts,'credential','success',SOURCE)
    except ValueError as error:
        return {'status':'failure','mode':'credential','matrixResult':'success','error':str(error),
                'actualAvailableShardMetrics':gate.failure_inventory(artifacts)}
    raise AssertionError('Controlled failed adapter receipt must be refused')


class RawCollectorControls(unittest.TestCase):
    def test_actual_expected_raw_refusal_is_preserved_and_unexplained_report_cannot_green(self):
        with tempfile.TemporaryDirectory() as temporary:
            artifacts=artifacts_fixture(Path(temporary));raw=raw_failure(artifacts)
            result=validate(ROOT,artifacts,SOURCE,False,1,raw)
            self.assertEqual(result['cause'],{'class':'ValueError','message':'Unexpected/failed native shard receipt'})
            self.assertFalse(result['rawCollectorAdmission'])
            for key,value in [('error','unrelated filesystem failure'),('matrixResult','failure'),
                              ('status','success'),('mode','canonical'),('extra',True)]:
                altered=copy.deepcopy(raw);altered[key]=value
                with self.subTest(key=key),self.assertRaises(ValueError):
                    validate(ROOT,artifacts,SOURCE,False,1,altered)
            for exit_code in (0,2,-9,True):
                with self.subTest(exit=exit_code),self.assertRaises(ValueError):
                    validate(ROOT,artifacts,SOURCE,False,exit_code,raw)

    def test_actual_missing_job_refusal_cannot_be_classified_as_expected_missed_refusal(self):
        with tempfile.TemporaryDirectory() as temporary:
            artifacts=artifacts_fixture(Path(temporary))
            original=raw_failure(artifacts)
            missing=artifacts/'credential-rust-mutation-adapters-macos-7of8'
            missing.rename(artifacts/'unexpected-original')
            actual=raw_failure(artifacts)
            self.assertEqual(actual['error'],'Missing or unexpected requested shard artifact')
            for report in (actual,original):
                with self.assertRaises(ValueError):validate(ROOT,artifacts,SOURCE,False,1,report)
