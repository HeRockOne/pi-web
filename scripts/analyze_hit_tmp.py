import json, os, datetime

SESSION = "C:/Users/Sophia/.pi/agent/sessions/--C--Users-Sophia-Downloads-Compressed-pi-web-main--/2026-09-15T15-26-43-028Z_01a0a5ad-7354-748a-aa5b-dcafc672a89b.jsonl"
compress = []
with open(SESSION, encoding='utf-8') as fh:
    for line in fh:
        try: m = json.loads(line)
        except: continue
        if m.get('type') != 'message': continue
        content = m.get('message', {}).get('content', [])
        if any(isinstance(p, dict) and p.get('type') == 'toolCall' and p.get('name') == 'compress' for p in content):
            compress.append(datetime.datetime.fromisoformat(m['timestamp'].replace('Z', '+00:00')).timestamp())

usage = os.path.expanduser('~/.pi/agent/analytics/usage.jsonl')
rel = SESSION.replace('\\', '/').split('/')[-1][:-6]
print(f"{'time':8} {'input':>7} {'cacheR':>7} {'hit%':>5}  距compress  分类")
print("-" * 72)
for line in open(usage, encoding='utf-8'):
    line = line.strip()
    if not line: continue
    try: r = json.loads(line)
    except: continue
    if not isinstance(r, list) or len(r) < 8: continue
    if r[1] and rel not in str(r[1]).replace('\\', '/'): continue
    ts, inp, out, cr, cw = r[0], r[4], r[5], r[6], r[7]
    denom = inp + cr + cw
    if denom <= 0: continue
    hit = cr / denom * 100
    if hit >= 82: continue
    dts = datetime.datetime.fromtimestamp(ts / 1000).strftime('%H:%M:%S')
    before = [c for c in compress if c <= ts / 1000]
    near = max(before) if before else None
    delta = (ts / 1000 - near) if near else None
    dist = f"{delta:>6.0f}s" if delta is not None else "  前无"
    if delta is not None and delta <= 120: tag = "compress后"
    elif delta is not None and delta <= 600: tag = "compress延迟"
    elif inp > 30000 and cr < 25000: tag = "非compress-大input"
    else: tag = "其他"
    print(f"{dts:8} {inp:>7} {cr:>7} {hit:5.1f}%  {dist}  {tag}")