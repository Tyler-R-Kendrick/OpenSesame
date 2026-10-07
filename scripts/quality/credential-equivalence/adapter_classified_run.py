#!/usr/bin/env python3
"""Separate adapter requirement process. Original runner/tool exit is preserved."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

from classification import BUNDLE, decide, repository_code, source_policy
from contract import code_binding, decode, regular, require, sha


def completed(args,prefix,cwd):
    with prefix.with_suffix('.stdout').open('xb') as out, prefix.with_suffix('.stderr').open('xb') as err:
        value = subprocess.run(args,cwd=cwd,stdout=out,stderr=err,check=False).returncode
    with prefix.with_suffix('.exit').open('x') as stream: stream.write(str(value)+'\n')
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('platform',choices=('linux','windows','macos'))
    parser.add_argument('shard',type=int,choices=range(8))
    parser.add_argument('evidence')
    args = parser.parse_args()
    root = Path.cwd().resolve();evidence = Path(args.evidence).resolve()
    require(not evidence.exists(), 'reuse of original raw evidence')
    source_policy();repository_code(root)
    expected = sha(regular(BUNDLE,'verifier-inputs.json').read_bytes())
    code_binding(BUNDLE,expected)
    source = subprocess.check_output(['git','rev-parse','HEAD','HEAD^{tree}'],cwd=root,text=True).splitlines()
    require(len(source)==2 and source[0]==os.environ.get('GITHUB_SHA'), 'unauthenticated wrapper source')
    prefix = evidence.parent/'adapter-raw-runner'
    command = [sys.executable,'-B',str(root/'scripts/quality/rust-mutation-shard.py'),
               'adapters',args.platform,str(args.shard),str(evidence)]
    runner_exit = completed(command,prefix,root)
    invocation = {'v':1,'argv':command,'source':source,'exit':runner_exit,
                  'stdoutSha256':sha(prefix.with_suffix('.stdout').read_bytes()),
                  'stderrSha256':sha(prefix.with_suffix('.stderr').read_bytes())}
    with prefix.with_suffix('.invocation.json').open('x') as stream:
        stream.write(json.dumps(invocation,indent=2)+'\n')
    # The old runner owns its own true output/exit; this is separate original runner provenance.
    result = None
    try:
        require(runner_exit in (0,1), 'unexplained/signal raw runner failure')
        raw_path = evidence/'raw-runner.exit'
        with raw_path.open('x') as stream: stream.write(str(runner_exit)+'\n')
        check = ['node','scripts/lib/test-depth-inputs.mjs','check',str(evidence.parent/'inputs.before.json')]
        require(completed(check,evidence.parent/'adapter-source-check',root)==0, 'whole source changed')
        output = evidence/'independent-producer-proof'
        output.mkdir(exist_ok=False)
        result = decide(root,evidence,output,source,expected,runner_exit)
        require(result['adapterNonEquivalentRequirement'], 'unresolved non-equivalent behavior')
        source_policy();repository_code(root);code_binding(BUNDLE,expected)
    except Exception as error:
        result = {'v':1,'source':source,'group':'adapters','platform':args.platform,'shard':args.shard,
                  'requirement':'exact-adapter-non-equivalent-v1','rawRunnerExit':runner_exit,
                  'adapterNonEquivalentRequirement':False,'error':str(error),'rawResultsUnchanged':True}
    with (evidence/'adapter-requirement.json').open('x') as stream:
        stream.write(json.dumps(result,indent=2)+'\n')
    require(result['adapterNonEquivalentRequirement'], 'Separate adapter requirement failed; raw files retained')


if __name__=='__main__': main()
