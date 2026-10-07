"""Typed original-command failures. No generic runner error is eligible."""
from contract import decode, regular, require, sha


def command_failure(exit_code, returned, exception, output):
    if exit_code == 0 and returned and exception is None:
        return 'none'
    expected = {'class':'ValueError','message':'Real command failed; retained output: '+str(output)}
    if type(exit_code) is int and exit_code == 2 and not returned and exception == expected:
        return 'tool-exit-2'
    return 'unexpected-command-failure'


def provenance(exit_code, returned, exception, output, complete, unchanged, admission, errors):
    kind = command_failure(exit_code,returned,exception,output)
    reasons = []
    if kind != 'none': reasons.append(kind)
    if not complete: reasons.append('incomplete-report')
    if not unchanged: reasons.append('source-changed')
    if not admission: reasons.append('raw-not-admitted')
    if errors: reasons.append('runner-error')
    return {'v':1,'toolExit':exit_code,'commandReturned':returned,'exception':exception,
            'commandFailureKind':kind,'reportComplete':complete,'sourceUnchanged':unchanged,
            'rawAdmitted':admission,'errors':errors,'reasons':reasons}


def validate(evidence, receipt, runner_exit):
    value = receipt['rawFailureProvenance']
    keys = {'v','toolExit','commandReturned','exception','commandFailureKind','reportComplete',
            'sourceUnchanged','rawAdmitted','errors','reasons'}
    require(set(value)==keys and type(value['v']) is int and value['v']==1, 'unknown raw provenance')
    require(type(runner_exit) is int and runner_exit in (0,1), 'signal/unexpected raw runner exit')
    for name in ('commandReturned','reportComplete','sourceUnchanged','rawAdmitted'):
        require(type(value[name]) is bool, 'invalid provenance boolean')
    text = regular(evidence,'campaign.log.exit').read_text().strip()
    require(text in ('0','2') and type(value['toolExit']) is int and value['toolExit']==int(text),
            'raw command exit not complete protocol')
    require(value['errors']==[] and value['reportComplete'] and value['sourceUnchanged'] and
            'reportError' not in receipt, 'generic runner/source/report failure')
    # The exact exception path belongs to the original producer, not relocated collector paths.
    command = receipt['command']
    require(len(command)>=2 and command[-2]=='-o', 'unknown original command')
    from portable import original
    output = original(command[-1],receipt['platform']).parent/'campaign.log'
    expected = provenance(int(text),value['commandReturned'],value['exception'],output,
                          True,True,receipt['admission']['admitted'],[])
    require(value==expected, 'raw failure causes differ from actual protocol')
    if text=='0':
        require(runner_exit==0 and receipt['status']=='success' and value['rawAdmitted'] and
                value['commandFailureKind']=='none' and value['reasons']==[], 'false raw success')
    else:
        require(runner_exit==1 and receipt['status']=='failure' and not value['rawAdmitted'] and
                value['commandFailureKind']=='tool-exit-2' and
                value['reasons']==['tool-exit-2','raw-not-admitted'], 'unexplained runner failure')
    return value
