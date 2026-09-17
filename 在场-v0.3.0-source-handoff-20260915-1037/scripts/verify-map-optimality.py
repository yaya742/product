"""Independent min-cost unit-flow oracle for the V2 walking graph.

One nonnegative flow variable per directed, permitted road segment (0 <= x <= 1).
Every graph node conserves flow. A super-source supplies one unit to all eligible
origin entrances; a super-sink receives one unit from all eligible destinations.
Minimize sum(segment length in meters * flow). The network matrix is integral,
so an optimal LP gives the shortest entrance-to-entrance route. No connectors
are invented, and this does not certify unmapped real-world access conditions.
Requires the separately verified full Gurobi 13.0.2 Academic installation.
"""
import json
import os
import gzip
from pathlib import Path
import gurobipy as gp
from gurobipy import GRB

root = Path(__file__).resolve().parents[1]
out = root / 'artifacts' / 'map-v2'
out.mkdir(parents=True, exist_ok=True)
os.chdir(out)  # Gurobi's Windows model writer needs an ASCII relative filename.
graph = json.loads((root / 'assets/map-v2/network.json').read_text(encoding='utf8'))
places = {p['id']: p for p in json.loads((root / 'assets/map-v2/places.json').read_text(encoding='utf8'))}
cases = json.loads((out / 'route-cases.json').read_text(encoding='utf8'))
assert gp.gurobi.version() == (13, 0, 2)
results = []
with gp.Env(empty=True) as env:
    env.setParam('OutputFlag', 0)
    env.start()
    for index, case in enumerate(cases):
        arcs = [(e['from'], e['to'], e['meters']) for e in graph['edges']]
        arcs += [(e['to'], e['from'], e['meters']) for e in graph['edges'] if not e['oneway']]
        origins = [e['id'] for e in places[case['from']]['entrances'] if e['connected']]
        targets = [e['id'] for e in places[case['to']]['entrances'] if e['connected']]
        arcs += [('source', n, 0.0) for n in origins] + [(n, 'sink', 0.0) for n in targets]
        with gp.Model(f'walking_{index}', env=env) as model:
            model.Params.Threads = 2
            model.Params.Seed = 0
            model.Params.TimeLimit = 20
            model.Params.Method = 1
            x = model.addVars(len(arcs), lb=0, ub=1, vtype=GRB.CONTINUOUS, name='flow')
            model.setObjective(gp.quicksum(w * x[i] for i, (_, _, w) in enumerate(arcs)), GRB.MINIMIZE)
            outgoing, incoming = {}, {}
            for i, (a, b, _) in enumerate(arcs):
                outgoing.setdefault(a, []).append(i)
                incoming.setdefault(b, []).append(i)
            for n in set(outgoing) | set(incoming):
                rhs = 1 if n == 'source' else -1 if n == 'sink' else 0
                model.addConstr(gp.quicksum(x[i] for i in outgoing.get(n, [])) - gp.quicksum(x[i] for i in incoming.get(n, [])) == rhs, name=f'balance_{n}')
            if index == 0:
                model.write('walking-oracle.lp')
                model_text = Path('walking-oracle.lp').read_bytes()
                Path('walking-oracle.lp.gz').write_bytes(gzip.compress(model_text))
                Path('walking-oracle.lp').unlink()
            model.optimize()
            status = int(model.Status)
            if status == GRB.OPTIMAL:
                objective = model.ObjVal
                assert case['status'] == 'ready'
                assert abs(objective - case['meters']) < 1e-5, (objective, case)
                residual = max(abs(c.Slack) for c in model.getConstrs())
                integrality = max(abs(v.X - round(v.X)) for v in model.getVars())
                assert residual < 1e-6 and integrality < 1e-6
                results.append({**case, 'gurobiStatus': status, 'objectiveMeters': objective, 'optimalBoundMeters': objective, 'differenceMeters': abs(objective-case['meters']), 'flowResidual': residual, 'integralityResidual': integrality, 'runtimeSeconds': model.Runtime})
            else:
                assert status == GRB.INFEASIBLE and case['status'] == 'unreachable', (status, case)
                results.append({**case, 'gurobiStatus': status, 'verifiedUnreachable': True})
report = {'solver': 'Gurobi 13.0.2', 'method': 'independent minimum-cost unit-flow LP', 'dataVersion': graph['version'], 'cases': results, 'allPassed': True, 'scope': 'Known directed walking graph and recorded eligible entrances only; no claim about every real-world road or current gate access.'}
(out / 'route-optimality.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
print(json.dumps({'cases': len(results), 'allPassed': True, 'maxDifferenceMeters': max((c.get('differenceMeters',0) for c in results), default=0)}, ensure_ascii=False))
