"""Replay the exact strict collector refusal; unrelated errors are never eligible."""
from contract import require
from collect import gate_module


def validate(root, artifacts, source, raw_admitted, raw_exit, raw_report):
    require(type(raw_exit) is int and raw_exit in (0,1) and type(raw_admitted) is bool,
            'unknown raw collector process/result')
    gate = gate_module(root)
    try:
        replay = gate.collect(artifacts,'credential','success',source)
    except Exception as error:
        require(not raw_admitted and raw_exit==1 and type(error) is ValueError and
                str(error)=='Unexpected/failed native shard receipt',
                'unexplained strict raw collector refusal')
        replay = {'status':'failure','mode':'credential','matrixResult':'success',
                  'error':str(error),'actualAvailableShardMetrics':gate.failure_inventory(artifacts)}
        cause = {'class':'ValueError','message':str(error)}
    else:
        require(raw_admitted and raw_exit==0, 'raw collector success/admission conflict')
        cause = None
    require(raw_report==replay, 'actual raw collector cause/report not independently reproduced')
    return {'v':1,'rawCollectorExit':raw_exit,'rawCollectorAdmission':raw_admitted,
            'cause':cause,'reportIndependentlyReproduced':True}
