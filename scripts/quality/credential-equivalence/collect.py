#!/usr/bin/env python3
"""Independent diagnostics only. Existing strict raw collector remains mandatory/unchanged."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess

from contract import code_binding, decode, regular, require, sha
import proof

BUNDLE = Path(__file__).resolve().parent


def gate_module(root):
    path = regular(root,'scripts/quality/rust-mutation-shard-collect.py')
    spec = importlib.util.spec_from_file_location('strict_native_collector',path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def prerequisites(root, platform, tool_exit, classified=False):
    states = {}
    for line in regular(root,'steps.txt').read_text().splitlines():
        key,value = line.split('=',1)
        require(key not in states, 'duplicate job prerequisite')
        states[key] = value
    needed = {'checkout','source','python','rust','tools','execute','freshness'}
    require(set(states)==needed and all(states[key]=='success' for key in needed-{'execute'}),
            'nonexecution prerequisite failed/skipped/missing')
    require(states['execute']==('success' if classified or tool_exit==0 else 'failure'), 'job/raw requirement conflict')
    python = decode(regular(root,'python.json').read_bytes())
    version = python['version']
    require(python['os']==('nt' if platform=='windows' else 'posix') and type(python['executable']) is str and
            python['executable'] and type(version) is list and len(version)==3 and
            all(type(v) is int and v>=0 for v in version) and tuple(version)>=(3,11,0), 'wrong native Python')
    require(decode(regular(root,'inputs.changed-paths.json').read_bytes())==[], 'job source freshness failed')


def labels():
    result = {f'credential-rust-mutation-core-{i}of8':('core','linux',i) for i in range(8)}
    for platform in ('linux','windows','macos'):
        result.update({f'credential-rust-mutation-adapters-{platform}-{i}of8':('adapters',platform,i)
                       for i in range(8)})
    return result


def core_check(gate, roots, source):
    result = gate.group_union(roots,'core','linux')
    require(result['identity']['source']==source, 'core source differs from authenticated collector')
    return result


def run(root, artifacts, matrix_result, output, source, expected_manifest, classified=False):
    manifest = code_binding(BUNDLE,expected_manifest)
    policy = decode(regular(BUNDLE,'policy.json').read_bytes())
    proof.source_inputs(root,policy)
    wanted = labels()
    require({p.name for p in artifacts.iterdir()}==set(wanted), 'missing/extra requested native artifact')
    require(matrix_result in (('success',) if classified else ('success','failure')), 'matrix failed/canceled/skipped/unknown')
    gate = gate_module(root)
    groups,errors = {},[]
    try:
        core = core_check(gate,[artifacts/name for name,(kind,_,_) in wanted.items() if kind=='core'],source)
    except Exception as error:
        core = None
        errors.append({'group':'core','error':str(error)})
    reports = []
    for name,(kind,platform,index) in wanted.items():
        if kind!='adapters': continue
        try:
            job = artifacts/name
            evidence = job/'mutation-shard'
            receipt = decode(regular(evidence,'shard-receipt.json').read_bytes())
            raw_exit = regular(evidence,'campaign.log.exit').read_text().strip()
            require(raw_exit in ('0','2'), 'raw tool did not complete outcome protocol')
            tool_exit = int(raw_exit)
            prerequisites(job,platform,tool_exit,classified)
            require(receipt['status']==('success' if tool_exit==0 else 'failure') and
                    receipt['source']==source and receipt['platform']==platform and receipt['shard']==index,
                    'actual shard/source/status differs')
            require(regular(job,'source.txt').read_text().splitlines()==source, 'job source differs')
            diagnostic_dir = output/f'{platform}-{index}'
            diagnostic_dir.mkdir()
            if classified:
                from classification import decide, source_policy
                source_policy()
                exit_text = regular(evidence,'raw-runner.exit').read_text().strip()
                require(exit_text in ('0','1'), 'missing/unexpected original runner exit')
                requirement = decide(root,evidence,diagnostic_dir,source,expected_manifest,int(exit_text))
                require(requirement==decode(regular(evidence,'adapter-requirement.json').read_bytes()),
                        'producer requirement not independently reproducible')
                result = {**requirement['proof'],'classificationAccounting':requirement['accounting']}
            else:
                result = proof.analyze(root,evidence,None,diagnostic_dir,policy,source,expected_manifest)
            raw = decode(regular(evidence,'mutants/mutants.out/outcomes.json').read_bytes())
            actual = gate.gate.platform_gate.outcomes_analyze(raw,[{'mutant':v} for v in receipt['assigned']])
            require(actual==receipt['admission'] and actual['admitted']==(tool_exit==0), 'raw admission differs')
            identity = {key:receipt[key] for key in ('source','sourcePins','full','active','applicability',
                       'fullInventorySHA256','activeInventorySHA256')}
            context = receipt['compiler']
            group = groups.setdefault(platform,{'identity':identity,'compiler':context,'seen':set(),'rows':{}})
            require(group['identity']==identity and group['compiler']==context and index not in group['seen'],
                    'mixed source/inventory/context or duplicate shard')
            group['seen'].add(index)
            for value in receipt['assigned']:
                require(value['name'] not in group['rows'], 'overlapping actual shard')
                group['rows'][value['name']] = value
            result['verifier'] = {'manifestSha256':expected_manifest,'files':manifest['files']}
            reports.append({'artifact':name,'platform':platform,'shard':index,'actualRawExit':tool_exit,
                            'actualReceiptStatus':receipt['status'],'diagnostics':result})
            if not result['semanticAdmitted']:
                errors.append({'artifact':name,'activeUncaught':result['activeUncaught']})
        except Exception as error:
            errors.append({'artifact':name,'error':str(error)})
    union_groups = []
    union = None
    try:
        for platform,group in groups.items():
            require(group['seen']==set(range(8)) and group['rows']==
                    {v['name']:v for v in group['identity']['active']}, 'incomplete native assigned union')
            union_groups.append({'platform':platform,'identity':group['identity']})
        require(set(groups)=={'linux','windows','macos'}, 'missing native diagnostic platform')
        union = gate.platform_union(union_groups)
    except Exception as error:
        errors.append({'group':'supported-platform-union','error':str(error)})
    code_binding(BUNDLE,expected_manifest)
    proof.source_inputs(root,policy)
    raw_admitted = (core is not None and all(r['actualRawExit']==0 for r in reports) and
                    len(reports)==24 and matrix_result=='success')
    verified = not errors and len(reports)==24
    return {'v':1,'source':source,'matrixResult':matrix_result,'rawAdmission':raw_admitted,
            'proofVerification':'verified' if verified else 'failure','currentStrictRawAdmissionUnchanged':True,
            'historicalReference':policy['historicalReference'],'core':core,'supportedPlatformUnion':union,
            'verifier':{'manifestSha256':expected_manifest,'files':manifest['files']},
            'shards':reports,'errors':errors,
            'qualification':'Independent diagnostics. Verified proof is not Caught or raw/CI admission.'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('artifacts')
    parser.add_argument('matrix_result')
    parser.add_argument('output')
    args = parser.parse_args()
    output_file = Path(args.output).resolve()
    work = output_file.parent/(output_file.stem+'-work')
    work.mkdir(exist_ok=False)
    result = None
    try:
        source = subprocess.check_output(['git','rev-parse','HEAD','HEAD^{tree}'],text=True).splitlines()
        require(len(source)==2 and source[0]==os.environ.get('GITHUB_SHA'), 'unauthenticated collector source')
        expected = sha(regular(BUNDLE,'verifier-inputs.json').read_bytes())
        result = run(Path.cwd().resolve(),Path(args.artifacts).resolve(),args.matrix_result,work,source,expected)
    except Exception as error:
        result = {'v':1,'proofVerification':'failure','error':str(error),'matrixResult':args.matrix_result,
                  'currentStrictRawAdmissionUnchanged':True}
    with output_file.open('x') as stream:
        stream.write(json.dumps(result,indent=2)+'\n')
    require(result['proofVerification']=='verified', 'proof diagnostics unavailable/failed; raw states preserved')


if __name__=='__main__':
    main()
