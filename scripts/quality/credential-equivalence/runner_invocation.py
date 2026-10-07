"""Bind original runner exit/argv/log bytes to the separately captured subprocess."""
from contract import decode, regular, require, sha
from portable import original


def validate(evidence,receipt,runner_exit,portable):
    directory = evidence.parent
    value = decode(regular(directory,'adapter-raw-runner.invocation.json').read_bytes())
    require(set(value)=={'v','argv','source','exit','stdoutSha256','stderrSha256'} and
            type(value['v']) is int and value['v']==1 and type(value['exit']) is int and
            value['exit']==runner_exit and value['source']==receipt['source'], 'runner invocation differs')
    text = regular(directory,'adapter-raw-runner.exit').read_text().strip()
    require(text==str(runner_exit), 'original captured runner exit differs')
    python = decode(regular(directory,'python.json').read_bytes())
    producer = portable.value['producer']; platform=receipt['platform']
    executable = original(python['executable'],platform)
    wanted = [str(executable),'-B',str(original(producer['root'],platform)/
              'scripts'/'quality'/'rust-mutation-shard.py'),'adapters',platform,
              str(receipt['shard']),str(original(producer['evidence'],platform))]
    require(value['argv']==wanted, 'runner family/scope/platform/source changed')
    for role in ('stdout','stderr'):
        file = regular(directory,'adapter-raw-runner.'+role)
        require(file.stat().st_size<=32*1024*1024 and sha(file.read_bytes())==value[role+'Sha256'],
                'runner log bytes changed')
    return value
