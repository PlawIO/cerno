#!/bin/bash
# Phase C probe monitoring script
# Usage: ./scripts/probe-monitor.sh [YYYYMMDD] [YYYYMMDD]
# Pulls verification logs from cerno-cloud KV and analyzes probe metrics.

set -euo pipefail

FROM=${1:-$(date -u +%Y%m%d)}
TO=${2:-$FROM}
KV_NS="d22c19ad9db1485196d79e3cce159e43"
CLOUD_DIR="${CLOUD_DIR:-/Users/yaz/Documents/Repos/cerno-cloud}"
TMPFILE=$(mktemp)

echo "=== Cerno Phase C Probe Monitor ==="
echo "Date range: $FROM — $TO"
echo ""

# Collect all log entries
for day in $(python3 -c "
from datetime import datetime, timedelta
d = datetime.strptime('$FROM', '%Y%m%d')
end = datetime.strptime('$TO', '%Y%m%d')
while d <= end:
    print(d.strftime('%Y%m%d'))
    d += timedelta(days=1)
"); do
  keys=$(cd "$CLOUD_DIR" && npx wrangler kv key list --namespace-id "$KV_NS" --prefix "vlog:$day" 2>/dev/null)
  echo "$keys" | python3 -c "
import json, sys
keys = json.load(sys.stdin)
for k in keys:
    print(k['name'])
" 2>/dev/null | while IFS= read -r key; do
    cd "$CLOUD_DIR" && npx wrangler kv key get --namespace-id "$KV_NS" "$key" 2>/dev/null >> "$TMPFILE"
    echo "" >> "$TMPFILE"
  done
done

# Analyze
python3 -c "
import json, sys, math
from collections import Counter

entries = []
with open('$TMPFILE') as f:
    for line in f:
        line = line.strip()
        if line:
            try:
                entries.append(json.loads(line))
            except:
                pass

if not entries:
    print('No entries found.')
    sys.exit(0)

passes = [e for e in entries if e.get('ok')]
fails = [e for e in entries if not e.get('ok')]
errors = Counter(e.get('err', 'unknown') for e in fails)

print(f'Total entries: {len(entries)}')
print(f'  Passes: {len(passes)}')
print(f'  Failures: {len(fails)}')
print(f'  Error breakdown: {dict(errors)}')
print()

# Probe analysis
probe_entries = []
no_probe_entries = []
for e in passes:
    sec = e.get('sec', {}) or {}
    pmc = sec.get('probe_motor_continuity')
    # NaN serializes as null in JSON
    if pmc is not None and not (isinstance(pmc, float) and math.isnan(pmc)):
        probe_entries.append(e)
    else:
        no_probe_entries.append(e)

print(f'Human passes WITH probe data (PMC != NaN): {len(probe_entries)}')
print(f'Human passes WITHOUT probe data: {len(no_probe_entries)}')
print()

if probe_entries:
    pmc_vals = [e['sec']['probe_motor_continuity'] for e in probe_entries]
    print(f'Probe Motor Continuity (PMC):')
    print(f'  Mean:  {sum(pmc_vals)/len(pmc_vals):.3f}  (target: >0.3)')
    print(f'  Min:   {min(pmc_vals):.3f}')
    print(f'  Max:   {max(pmc_vals):.3f}')
    print(f'  Stdev: {(sum((v - sum(pmc_vals)/len(pmc_vals))**2 for v in pmc_vals) / len(pmc_vals))**0.5:.3f}')
    print()

    # Probe completion rate: passes with PMC > 0 / all passes with PMC data
    completed = sum(1 for v in pmc_vals if v > 0)
    print(f'Probe completion rate: {completed}/{len(pmc_vals)} ({100*completed/len(pmc_vals):.0f}%)  (target: >90%)')
    print()

    # False positives: failed with probe data
    fp = [e for e in fails if (e.get('sec') or {}).get('probe_motor_continuity') is not None
          and e.get('err') == 'behavioral_rejected']
    print(f'False positives (probe-related behavioral_rejected): {len(fp)}  (target: 0)')
    print()

# VKA/RTE/TK for context
for label, elist in [('Passes', passes), ('Failures', fails)]:
    if not elist:
        continue
    sec_list = [(e.get('sec') or {}) for e in elist]
    vka = [s.get('velocity_autocorrelation') for s in sec_list if s.get('velocity_autocorrelation') is not None]
    rte = [s.get('raw_timing_entropy') for s in sec_list if s.get('raw_timing_entropy') is not None]
    tk = [s.get('timing_kurtosis') for s in sec_list if s.get('timing_kurtosis') is not None]
    cer = [s.get('coalesced_event_ratio') for s in sec_list if s.get('coalesced_event_ratio') is not None]
    vcr = [s.get('velocity_curvature_r2') for s in sec_list if s.get('velocity_curvature_r2') is not None]

    print(f'{label} ({len(elist)}):')
    if vka: print(f'  VKA: mean={sum(vka)/len(vka):.3f} min={min(vka):.3f} max={max(vka):.3f}')
    if rte: print(f'  RTE: mean={sum(rte)/len(rte):.3f} min={min(rte):.3f} max={max(rte):.3f}')
    if tk: print(f'  TK:  mean={sum(tk)/len(tk):.1f} min={min(tk):.1f} max={max(tk):.1f}')
    if cer: print(f'  CER: mean={sum(cer)/len(cer):.3f} min={min(cer):.3f} max={max(cer):.3f}')
    if vcr: print(f'  VCR: mean={sum(vcr)/len(vcr):.3f} min={min(vcr):.3f} max={max(vcr):.3f}')
    print()
"

rm -f "$TMPFILE"
echo "=== Monitor complete ==="
