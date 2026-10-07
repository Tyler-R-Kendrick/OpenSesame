#!/usr/bin/env python3
"""Independent required classified union; raw strict collector always retained separately."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

from classification import BUNDLE, repository_code, source_policy
from contract import code_binding, decode, regular, require, sha
import collect


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('artifacts');parser.add_argument('matrix_result');parser.add_argument('output')
    args = parser.parse_args()
    root = Path.cwd().resolve();output = Path(args.output).resolve()
    work = output.parent/(output.stem+'-work');work.mkdir(exist_ok=False)
    source = subprocess.check_output(['git','rev-parse','HEAD','HEAD^{tree}'],cwd=root,text=True).splitlines()
    require(len(source)==2 and source[0]==os.environ.get('GITHUB_SHA'), 'unauthenticated collector source')
    source_policy();repository_code(root)
    expected = sha(regular(BUNDLE,'verifier-inputs.json').read_bytes());code_binding(BUNDLE,expected)
    raw_output = output.parent/'credential-native-union.json'
    require(not raw_output.exists(), 'reuse of raw strict collector artifact')
    raw_command = [sys.executable,'-B','scripts/quality/rust-mutation-shard-collect.py',
                   'credential',args.artifacts,args.matrix_result,str(raw_output)]
    prefix = output.parent/'credential-raw-collector'
    with prefix.with_suffix('.stdout').open('xb') as out, prefix.with_suffix('.stderr').open('xb') as err:
        raw_exit = subprocess.run(raw_command,cwd=root,stdout=out,stderr=err,check=False).returncode
    with prefix.with_suffix('.exit').open('x') as stream: stream.write(str(raw_exit)+'\n')
    result = None
    try:
        require(raw_exit in (0,1), 'signal/unexplained strict collector failure')
        require(args.matrix_result=='success', 'failed/skipped/canceled actual required family matrix')
        result = collect.run(root,Path(args.artifacts).resolve(),args.matrix_result,work,source,expected,
                             classified=True)
        require(result['proofVerification']=='verified', 'independent union/classification failed')
        raw_admitted = result['rawAdmission']
        raw = decode(regular(output.parent,raw_output.name).read_bytes())
        from raw_collector_contract import validate as raw_collector_validate
        cause = raw_collector_validate(root,Path(args.artifacts).resolve(),source,raw_admitted,raw_exit,raw)
        result.update({'adapterNonEquivalentRequirement':True,'rawCollectorExit':raw_exit,
                       'rawCollectorReportSha256':sha(raw_output.read_bytes()),'rawCollectorProvenance':cause,
                       'requirement':'exact-adapter-non-equivalent-v1'})
        source_policy();repository_code(root);code_binding(BUNDLE,expected)
    except Exception as error:
        result = {'v':1,'source':source,'requirement':'exact-adapter-non-equivalent-v1',
                  'adapterNonEquivalentRequirement':False,'rawCollectorExit':raw_exit,
                  'matrixResult':args.matrix_result,'error':str(error),'rawResultsUnchanged':True}
    with output.open('x') as stream: stream.write(json.dumps(result,indent=2)+'\n')
    require(result['adapterNonEquivalentRequirement'], 'Classified requirement failed; raw failures retained')


if __name__=='__main__': main()
