#!/usr/bin/env python3
"""PRIVATE prepared semantic annotation, preserving authentic native reports/exits."""
import argparse
import hashlib
import json
from pathlib import Path
import re

from inputs import (applicable, native_context, native_flags, ordinary, outer_proof, read_json,
                    require, sha, source_inputs, whole_inputs)

POLICY_SHA256 = 'fd1da7bb441ede84c468fbb3e168a12a6b9fda7146d4c94f5bba736cdf15fb9b'
BUNDLE = Path(__file__).resolve().parent


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def object_digest(value):
    return sha(canonical(value))


def indexed(values):
    require(isinstance(values,list) and values, 'empty/malformed native inventory')
    result = {}
    for value in values:
        require(isinstance(value,dict) and set(value) ==
                {'name','package','file','function','span','replacement','genre','diff'},
                'unknown native mutant object')
        name = value['name']
        require(type(name) is str and name not in result and type(value['diff']) is str,
                'duplicate/unknown native mutant identity')
        result[name] = value
    return result


def extract(text, span):
    require(isinstance(span,dict) and set(span) == {'start','end'}, 'unknown source span')
    lines = text.splitlines(keepends=True)
    points = []
    for point in (span['start'],span['end']):
        require(isinstance(point,dict) and set(point) == {'line','column'} and
                all(type(point[k]) is int and point[k] > 0 for k in point), 'invalid source point')
        line, column = point['line'], point['column']
        require(line <= len(lines) and column <= len(lines[line-1].rstrip('\n'))+1,
                'source point outside file')
        points.append(sum(len(x) for x in lines[:line-1])+column-1)
    require(points[0] < points[1], 'empty/reversed source span')
    return text[points[0]:points[1]]


def candidate(site, mutant, source):
    expected = site['mutant']
    actual = {k:v for k,v in mutant.items() if k != 'diff'}
    require(actual == expected, 'current mutant object does not match reviewed operator/function')
    fragment = extract(source, mutant['span'])
    require(fragment == site['sourceText'] and sha(fragment.encode()) == site['sourceTextSha256'],
            'mutant operator/body span is not the reviewed source')
    function_source = extract(source, mutant['function']['span'])
    require(sha(function_source.encode()) == site['functionSourceSha256'],
            'function source or cfg attribute changed')
    require(function_source.lstrip().startswith(('pub','fn')) or
            function_source.startswith('#[cfg(unix)]\nfn '),
            'function span does not bound the exact reviewed function prefix')
    return site


def flags_identity(flags, names):
    require(len(names) >= 2 and len(set(names)) == len(names) and all(x in flags for x in names),
            'unknown flag expression')
    require(all(type(flags[x]) is int and flags[x] >= 0 for x in names), 'invalid native mask value')
    for index, name in enumerate(names):
        for other in names[index+1:]:
            require(flags[name] & flags[other] == 0, 'overlapping flag masks')
    mask_or = mask_xor = 0
    for name in names:
        mask_or |= flags[name]
        mask_xor ^= flags[name]
    require(mask_or == mask_xor, 'flag identity failed')
    return {'flags':{name:flags[name] for name in names}, 'orMask':mask_or, 'xorMask':mask_xor}


def successful_phases(outcome):
    phases = outcome['phase_results']
    require([p['phase'] for p in phases] == ['Build','Test'] and
            all(p['process_status'] == 'Success' for p in phases), 'proof lacks completed genuine phases')


def native_outcomes(document, assigned, tool_exit):
    require(document.get('cargo_mutants_version') == '27.1.0', 'outcome tool differs')
    wanted = indexed(assigned)
    baselines, outcomes, counts = [], {}, {}
    for outcome in document['outcomes']:
        scenario = outcome['scenario']
        if scenario == 'Baseline':
            baselines.append(outcome)
            continue
        require(isinstance(scenario,dict) and set(scenario) == {'Mutant'}, 'unknown native scenario')
        mutant = scenario['Mutant']
        name = mutant['name']
        require(name in wanted and name not in outcomes and mutant ==
                {k:v for k,v in wanted[name].items() if k != 'diff'}, 'incomplete/altered native outcome')
        summary = outcome['summary']
        require(summary in {'CaughtMutant','MissedMutant','Unviable','Timeout'}, 'unknown native status')
        if summary == 'MissedMutant':
            successful_phases(outcome)
        counts[summary] = counts.get(summary,0)+1
        outcomes[name] = outcome
    require(len(baselines) == 1 and baselines[0]['summary'] == 'Success' and
            set(outcomes) == set(wanted), 'failed baseline or missing native result')
    successful_phases(baselines[0])
    require(type(tool_exit) is int and tool_exit in (0,2), 'raw native tool did not finish accepted outcome protocol')
    require(not counts.get('Timeout'), 'timeout remains blocking, never equivalent/caught')
    require((tool_exit == 2) == bool(counts.get('MissedMutant')), 'raw exit/status conflict')
    return outcomes, counts


def analyze(root, evidence, registry, output, policy, expected_source, expected_manifest):
    source_inputs(root, policy)
    receipt = read_json(ordinary(evidence, 'shard-receipt.json'))
    shards = policy['shards']
    require(shards == 8 and receipt['v'] == 1 and receipt['group'] == 'adapters' and
            receipt['shards'] == shards and type(receipt['shard']) is int and
            receipt['shard'] in range(shards), 'unreviewed shard')
    require(receipt['source'] == expected_source and ordinary(evidence,'source.txt').read_text().splitlines() ==
            expected_source, 'source differs from authenticated caller identity')
    before = read_json(ordinary(evidence,'source.before.json'))
    after = read_json(ordinary(evidence,'source.after.json'))
    require(before == after == receipt['sourcePins'], 'native source freshness failed')
    for path, digest in policy['repoPins'].items():
        if path in before:
            require(before[path] == digest, 'native opening source differs from reviewed pin')
    whole_inputs(evidence,receipt,policy)
    context = native_context(evidence, receipt)
    from portable import Evidence, original
    portable_evidence = Evidence(evidence,context,BUNDLE,policy,expected_manifest)
    from contract import CODE
    captured = read_json(ordinary(evidence.parent,'inputs.before.json'))
    files = {v['path']:v['sha256'] for v in captured if v['kind']=='file'}
    for name in (*CODE,'verifier-inputs.json'):
        relative = 'scripts/quality/credential-equivalence/'+name
        digest = sha(ordinary(BUNDLE,name).read_bytes())
        require(before.get(relative)==files.get(relative)==digest, 'code not bound to original source captures')
    repository = read_json(ordinary(BUNDLE,'repository-code-pins.json'))
    for path,digest in repository['files'].items():
        require(before.get(path)==files.get(path)==digest, 'repository helper not bound to native source')
    require(receipt['compiler']['cfgInventorySHA256'] == policy['cfgInventorySha256'],
            'native cfg classification identity changed')
    full = read_json(ordinary(evidence,'all-generated.json'))
    active = read_json(ordinary(evidence,'active.json'))
    assigned = read_json(ordinary(evidence,'assigned.json'))
    require(full == receipt['full'] and active == receipt['active'] and assigned == receipt['assigned'],
            'receipt inventory differs from actual native lists')
    require(object_digest(full) == receipt['fullInventorySHA256'] and
            object_digest(active) == receipt['activeInventorySHA256'], 'native inventory digest changed')
    all_ids, active_ids = indexed(full), indexed(active)
    require(set(active_ids) <= set(all_ids) and all(all_ids[k] == v for k,v in active_ids.items()),
            'active list changed native objects')
    require(active == applicable(root,full,context,policy,BUNDLE), 'native applicable list is incomplete')
    require(assigned == active[receipt['shard']::shards], 'not the exact original disjoint partition')
    base = ['cargo','+1.88.0','mutants','--gitignore','true']
    for package in policy['adapterScope']['packages']:
        base.extend(['-p',package])
    for path in policy['adapterScope']['files']:
        base.extend(['--file',path])
    expected_command = base + ['--config',str(original(portable_evidence.value['producer']['evidence'],context['os'])/'exact-selection.toml'),'--shard',
                               str(receipt['shard'])+'/'+str(shards),'--sharding','round-robin','-j','2',
                               '-o',str(original(portable_evidence.value['producer']['evidence'],context['os'])/'mutants')]
    require(receipt['command'] == expected_command, 'original command/scope/deadlines changed')
    require({x['file'] for x in full} == set(policy['adapterScope']['files']), 'original full scope incomplete')
    raw = ordinary(evidence,'mutants/mutants.out/outcomes.json')
    require(sha(raw.read_bytes()) == receipt['outcomesSHA256'], 'native report bytes differ')
    exit_text = ordinary(evidence,'campaign.log.exit').read_text().strip()
    require(exit_text in {'0','2'}, 'unknown native tool exit')
    tool_exit = int(exit_text)
    document = read_json(raw)
    outcomes, counts = native_outcomes(document, assigned, tool_exit)
    reviewed = {site['mutant']['name']:site for site in policy['sites']}
    require(len(reviewed) == 21, 'reviewed site identity changed')
    for name, site in reviewed.items():
        # A missed old/moved object cannot receive a function-name or file-wide exception.
        require(name in all_ids, 'reviewed mutant missing/moved in genuine full inventory')
        candidate(site, all_ids[name], ordinary(root,site['mutant']['file']).read_text())
    outer = outer_proof(root,registry,BUNDLE,policy,output,portable_evidence)
    flags = None
    annotations, unresolved = [], []
    for name, outcome in outcomes.items():
        if outcome['summary'] != 'MissedMutant':
            continue
        if name not in reviewed:
            unresolved.append(name)
            continue
        site = reviewed[name]
        proof_class = site['proofClass']
        detail = {}
        if proof_class == 'disjoint-flags':
            require(context['family'] == 'unix', 'Unix site is not compiled on this target')
            if flags is None:
                flags = native_flags(evidence,context,BUNDLE,policy,portable_evidence)
            detail = {**flags_identity(flags,site['flags']),
                      'portableCaptureSha256':sha((evidence/'semantic-inputs/portable-capture.json').read_bytes()),
                      'baseline':portable_evidence.value['baseline'],
                      'linkedRlibSha256':portable_evidence.rows['rlib']['sha256'],
                      'probeStdoutSha256':portable_evidence.rows['probe-stdout']['sha256']}
        elif proof_class == 'supported-cfg':
            require(context['family'] in {'unix','windows'}, 'unsupported cfg is not equivalent')
        elif proof_class == 'outer-size':
            detail = outer['bounds']
        else:
            raise ValueError('unknown proof class')
        annotations.append({'mutant':all_ids[name], 'mutantObjectSha256':object_digest(all_ids[name]),
                            'nativeSummary':'MissedMutant', 'disposition':'reviewed-source-equivalent-in-domain',
                            'proofClass':proof_class, 'domain':context, 'detail':detail})
    source_inputs(root,policy)
    return {'v':1,'source':expected_source,'historicalReference':policy['historicalReference'],
            'rawToolExit':tool_exit,'rawTotals':counts,
            'rawAdmitted':tool_exit == 0 and bool(counts.get('CaughtMutant')),
            'semanticAdmitted':not unresolved and bool(counts.get('CaughtMutant')),
            'annotations':annotations,'activeUncaught':unresolved,'assignedCount':len(assigned),
            'fullGeneratedCount':len(full),'policySha256':POLICY_SHA256,
            'policyCanonicalSha256':sha(canonical(policy)),
            'rawOutcomesSha256':sha(raw.read_bytes()),'nativeStatusesUnchanged':True,
            'qualification':'Independent proof diagnostics only; raw tool/CI admission remains unchanged.'}


def main():
    parser = argparse.ArgumentParser()
    for key in ('root','evidence','registry','output','head','tree','verifier-manifest-sha256'):
        parser.add_argument('--'+key,required=True)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(exist_ok=False)
    result = None
    try:
        from provenance import verifier_binding
        verifier = verifier_binding(BUNDLE,args.verifier_manifest_sha256)
        policy_path = ordinary(BUNDLE,'policy.json')
        require(sha(policy_path.read_bytes()) == POLICY_SHA256, 'review policy changed')
        require(re.fullmatch('[0-9a-f]{40}',args.head) is not None and
                re.fullmatch('[0-9a-f]{40}',args.tree) is not None, 'missing authenticated source identity')
        result = analyze(Path(args.root).resolve(),Path(args.evidence).resolve(),
                         Path(args.registry).resolve(),output,read_json(policy_path),[args.head,args.tree],args.verifier_manifest_sha256)
        result['verifier'] = verifier
        verifier_binding(BUNDLE,args.verifier_manifest_sha256)
        result['semanticStatus'] = 'accepted' if result['semanticAdmitted'] else 'failure'
    except (ValueError,KeyError,TypeError,OSError,json.JSONDecodeError) as error:
        result = {'semanticStatus':'failure','error':str(error),'rawAdmissionUnchanged':True}
    (output / 'semantic-disposition.json').write_text(json.dumps(result,indent=2)+'\n')
    require(result['semanticStatus'] == 'accepted', 'semantic proof remains blocking; raw report retained')


if __name__ == '__main__':
    main()
