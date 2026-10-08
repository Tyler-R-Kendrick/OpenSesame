"""Exact adapter classification accounting. Native status/denominators are immutable."""
from collections import Counter
from pathlib import Path

from contract import code_binding, decode, regular, require, sha
from failure_contract import validate
import proof

BUNDLE = Path(__file__).resolve().parent
POLICY = {'v':1,'requirement':'exact-adapter-non-equivalent-v1','group':'adapters',
          'platforms':['linux','windows','macos'],'shards':8,
          'proofPolicySha256':proof.POLICY_SHA256,
          'classes':{'disjoint-flags':15,'supported-cfg':2,'outer-size':4},
          'rawResultsImmutable':True,'timeoutsAllowed':False,'unviableIsCaught':False,
          'requiresActualCaught':True}


def source_policy(bundle=BUNDLE):
    value = decode(regular(bundle,'requirement-policy.json').read_bytes())
    require(value==POLICY and type(value['v']) is int and type(value['shards']) is int,
            'unknown/permissive source policy')
    require(all(type(value[k]) is bool for k in ('rawResultsImmutable','timeoutsAllowed',
            'unviableIsCaught','requiresActualCaught')), 'nonboolean source contract')
    native = decode(regular(bundle,'policy.json').read_bytes())
    require(sha(regular(bundle,'policy.json').read_bytes())==proof.POLICY_SHA256 and
            Counter(s['proofClass'] for s in native['sites'])==value['classes'], 'proof registry changed')
    return value


def repository_code(root,bundle=BUNDLE):
    pins = decode(regular(bundle,'repository-code-pins.json').read_bytes())
    require(set(pins)=={'v','files'} and pins['v']==1, 'unknown repository code binding')
    for path,digest in pins['files'].items():
        require(sha(regular(root,path).read_bytes())==digest, 'repository code/input changed: '+path)
    return pins


def partition(receipt,document,diagnostic):
    full,active,assigned = receipt['full'],receipt['active'],receipt['assigned']
    generated,admitted,owned = map(proof.indexed,(full,active,assigned))
    require(set(admitted)<=set(generated) and all(generated[k]==v for k,v in admitted.items()) and
            set(owned)<=set(admitted) and all(admitted[k]==v for k,v in owned.items()), 'denominator identity changed')
    raw = {}
    sets = {name:[] for name in ('CaughtMutant','MissedMutant','Unviable','Timeout')}
    for row in document['outcomes']:
        if row['scenario']=='Baseline': continue
        item = row['scenario']['Mutant']; name=item['name']; status=row['summary']
        require(name in owned and name not in raw and status in sets and
                item=={k:v for k,v in owned[name].items() if k!='diff'}, 'raw object/status changed')
        raw[name]=row
        sets[status].append(owned[name])
    require(set(raw)==set(owned), 'missing/extra raw result')
    totals = {k:len(v) for k,v in sets.items() if v}
    require(totals==diagnostic['rawTotals'], 'diagnostic/raw totals differ')
    equivalent = {}
    for annotation in diagnostic['annotations']:
        item = annotation['mutant']; name=item['name']
        require(name in raw and name not in equivalent and raw[name]['summary']=='MissedMutant' and
                item==owned[name] and annotation['nativeSummary']=='MissedMutant' and
                annotation['disposition']=='reviewed-source-equivalent-in-domain', 'false equivalent class')
        proof.successful_phases(raw[name])
        equivalent[name]=annotation
    unresolved = [item for item in sets['MissedMutant'] if item['name'] not in equivalent]
    require([x['name'] for x in unresolved]==diagnostic['activeUncaught'], 'uncaught ledger differs')
    require(not sets['Timeout'], 'timeout never equivalent/admitted')
    count = len(owned)-len(sets['Unviable'])-len(equivalent)
    satisfied = bool(sets['CaughtMutant']) and not unresolved and count==len(sets['CaughtMutant'])
    return {'fullGenerated':full,'nativeApplicable':active,
            'cfgInactive':[v for v in full if v['name'] not in admitted],'assigned':assigned,
            'rawStatusObjects':sets,'rawStatusTotals':totals,
            'exactEquivalent':[equivalent[k] for k in equivalent],'unresolved':unresolved,
            'counts':{'G':len(full),'A':len(active),'I':len(full)-len(active),'assigned':len(assigned),
                      'C':len(sets['CaughtMutant']),'M':len(sets['MissedMutant']),
                      'U':len(sets['Unviable']),'T':len(sets['Timeout']),
                      'E':len(equivalent),'Q':len(unresolved),'viableNotDisposed':count},
            'adapterNonEquivalentRequirement':satisfied,'noReplacementKillScore':True}


def decide(root,evidence,output,source,expected_manifest,runner_exit,bundle=BUNDLE):
    source_policy(bundle)
    code_binding(bundle,expected_manifest)
    native = decode(regular(bundle,'policy.json').read_bytes())
    receipt = decode(regular(evidence,'shard-receipt.json').read_bytes())
    require(receipt['group']=='adapters', 'classification only applies to adapters')
    cause = validate(evidence,receipt,runner_exit)
    diagnostic = proof.analyze(root,evidence,None,output,native,source,expected_manifest)
    require(diagnostic['rawAdmitted']==(cause['toolExit']==0) and
            diagnostic['rawToolExit']==cause['toolExit'], 'raw failure conflict')
    document = decode(regular(evidence,'mutants/mutants.out/outcomes.json').read_bytes())
    from portable import Evidence
    from inputs import native_context
    from runner_invocation import validate as invocation_check
    portable = Evidence(evidence,native_context(evidence,receipt),bundle,native,expected_manifest)
    invocation = invocation_check(evidence,receipt,runner_exit,portable)
    accounting = partition(receipt,document,diagnostic)
    require(accounting['adapterNonEquivalentRequirement']==diagnostic['semanticAdmitted'],
            'proof/requirement conflict')
    result = {'v':1,'source':source,'group':'adapters','platform':receipt['platform'],
              'shard':receipt['shard'],'requirement':POLICY['requirement'],
              'rawRunnerExit':runner_exit,'rawToolExit':cause['toolExit'],
              'rawMutationAdmission':cause['rawAdmitted'],'rawFailureProvenance':cause,'originalRunnerInvocation':invocation,
              'exactEquivalenceClassification':'verified','accounting':accounting,
              'adapterNonEquivalentRequirement':accounting['adapterNonEquivalentRequirement'],
              'rawReceiptSha256':sha(regular(evidence,'shard-receipt.json').read_bytes()),
              'rawOutcomesSha256':sha(regular(evidence,'mutants/mutants.out/outcomes.json').read_bytes()),
              'proof':diagnostic,'verifierManifestSha256':expected_manifest,
              'qualification':'Separate adapter requirement; raw Missed/exit2 remains raw failure, never Caught.'}
    source_policy(bundle);code_binding(bundle,expected_manifest)
    return result
