#!/usr/bin/env bash
# End-to-end verification of the local Grafana + Loki + Tempo + Prometheus.
# Never deletes volumes. Emits only disposable demo financial transactions.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "Verifying real financial event flow and generating correlated telemetry..."
bash scripts/local-verify.sh
echo "Checking actual exported traces, logs, metrics and dashboard provisioning..."
python3 - <<'PY'
import base64, json, os, time, urllib.request, urllib.parse

grafana = 'http://127.0.0.1:' + os.environ.get('GRAFANA_PORT', '3001')
loki = 'http://127.0.0.1:' + os.environ.get('LOKI_PORT', '3100')
tempo = 'http://127.0.0.1:' + os.environ.get('TEMPO_PORT', '3200')
prom = 'http://127.0.0.1:' + os.environ.get('PROMETHEUS_PORT', '9090')
username = os.environ.get('GRAFANA_ADMIN_USER', 'admin')
password = os.environ.get('GRAFANA_ADMIN_PASSWORD', 'local-grafana-change-me')

def get(url, credentials=False):
    req = urllib.request.Request(url)
    if credentials:
        encoded = base64.b64encode((username + ':' + password).encode()).decode()
        req.add_header('Authorization', 'Basic ' + encoded)
    with urllib.request.urlopen(req, timeout=8) as response:
        return json.load(response)

dashboard = get(grafana + '/api/dashboards/uid/wagering-observability', True)
assert dashboard['dashboard']['uid'] == 'wagering-observability'
assert len(dashboard['dashboard']['panels']) >= 12
print('TELEMETRY_DASHBOARD', dashboard['dashboard']['uid'], len(dashboard['dashboard']['panels']))

# Do not guess: require at least one real log with trace_id, a real trace
# in Tempo, and Prometheus counters exported through OTel Collector.
deadline = time.time() + 120
verified = {}
while time.time() < deadline:
    try:
        metric = get(prom + '/api/v1/query?' +
                     urllib.parse.urlencode({'query': '{__name__=~"wager_http_requests_total.*"}'}))
        verified['metrics'] = bool(metric.get('data', {}).get('result', []))
    except Exception:
        verified['metrics'] = False
    try:
        query = '{service_name=~"wager-.*"}'
        now = int(time.time() * 1_000_000_000)
        args = {'query': query, 'start': str(now - 300_000_000_000),
                'end': str(now), 'limit': 100}
        logs = get(loki + '/loki/api/v1/query_range?' + urllib.parse.urlencode(args))
        entries = logs.get('data', {}).get('result', [])
        verified['logs'] = any('trace_id' in entry[1] for stream in entries
                               for entry in stream.get('values', []))
    except Exception:
        verified['logs'] = False
    try:
        trace = get(tempo + '/api/search?limit=20')
        verified['traces'] = bool(trace.get('traces', []))
    except Exception:
        verified['traces'] = False
    if all(verified.values()):
        # Assert the same W3C trace crossed two independent processes,
        # not merely that Tempo and Loki each received unrelated data.
        def ids_for(message):
            params = {'query': '{service_name=~"wager-.*"} |= "' + message + '"',
                      'start': str(now - 300_000_000_000),
                      'end': str(now), 'limit': 1000}
            raw = get(loki + '/loki/api/v1/query_range?' + urllib.parse.urlencode(params))
            found = set()
            for stream in raw.get('data', {}).get('result', []):
                for _, line in stream.get('values', []):
                    try:
                        event = json.loads(line)
                        if 'trace_id' in event:
                            found.add(event['trace_id'])
                    except (ValueError, TypeError):
                        pass
            return found
        verified['cross_worker_trace'] = bool(
            ids_for('wager.transaction.committed') &
            ids_for('outbox.publish.completed')
        )
        if verified['cross_worker_trace']:
            print('TELEMETRY_SMOKE_PASSED', json.dumps(verified, sort_keys=True))
            break
    time.sleep(3)
else:
    raise SystemExit('TELEMETRY_SMOKE_FAILED ' + json.dumps(verified, sort_keys=True))
PY
