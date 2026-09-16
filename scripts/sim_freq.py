import json, os, datetime

SESSION_ID = "01a0a5ad-7354-748a-aa5b-dcafc672a89b"
SESSION_FILE = "C:/Users/Sophia/.pi/agent/sessions/--C--Users-Sophia-Downloads-Compressed-pi-web-main--/2026-09-15T15-26-43-028Z_01a0a5ad-7354-748a-aa5b-dcafc672a89b.jsonl"
usage_path = os.path.expanduser('~/.pi/agent/analytics/usage.jsonl')

compress_ms = []
with open(SESSION_FILE, encoding='utf-8') as fh:
    for line in fh:
        try: m = json.loads(line)
        except: continue
        if m.get('type') != 'message': continue
        content = m.get('message', {}).get('content', [])
        if any(isinstance(p, dict) and p.get('type') == 'toolCall' and p.get('name') == 'compress' for p in content):
            ts = datetime.datetime.fromisoformat(m['timestamp'].replace('Z', '+00:00'))
            compress_ms.append(int(ts.timestamp() * 1000))
compress_ms.sort()

rows = []
for line in open(usage_path, encoding='utf-8'):
    line = line.strip()
    if not line: continue
    try: r = json.loads(line)
    except: continue
    if not isinstance(r, list) or len(r) < 8: continue
    if SESSION_ID not in str(r[1]): continue
    rows.append(r)
rows.sort(key=lambda r: r[0])

# 逐 compress：基线 cacheR（前一条 cacheR>0）→ 首条 cacheR → 损失
events = []
for cms in compress_ms:
    before = [r for r in rows if r[0] < cms]
    after  = [r for r in rows if r[0] > cms]
    b = next((r for r in reversed(before) if r[6] > 0), None)
    f = after[0] if after else None
    if not b or not f: continue
    events.append((cms, b[6], f[6]))

print(f"compress 事件: {len(events)}")
print(f"{'#':>3} {'间隔s':>7} {'基线':>8} {'首条':>8} {'损失':>8} {'累计损失':>10}")
cum = 0
prev = None
for i, (cms, b, f) in enumerate(events, 1):
    gap = (cms - prev) / 1000 if prev else 0
    loss = max(0, b - f)
    cum += loss
    print(f"{i:>3} {gap:>7.0f} {b:>8,} {f:>8,} {loss:>8,} {cum:>10,}")
    prev = cms

print(f"\n当前总损失: {cum:,} tokens")

# ── 模拟：合并连续压缩（间隔 < GAP s 的合成一次）──
print("\n── 模拟：把相邻(间隔<X秒)的压缩合并为一次，损失 = 合并组首尾差 ──")
for GAP in [0, 120, 600, 1800, 3600, 7200]:
    groups = []
    cur = [events[0]]
    for e in events[1:]:
        if (e[0] - cur[-1][0]) / 1000 < GAP:
            cur.append(e)
        else:
            groups.append(cur); cur = [e]
    groups.append(cur)
    sim = sum(max(0, g[0][1] - g[-1][2]) for g in groups)
    print(f"间隔<{GAP:>5}s 合并 → {len(groups):>3} 次压缩, 总损失 {sim:>10,} tokens (较现值 {sim-cum:+,})")

# ── 模拟：调低频率（nudge 阈值提高，压缩点更晚，每次压更多）──
print("\n── 模拟：减少压缩次数 N（阈值↑→每次压掉比例↑, 总压掉量≈不变） ──")
# 二十四次压缩的基线 cacheR 峰值 ≈ 每次"压掉量"= 峰值-压后值
per = [max(0, b - f) for cms, b, f in events]
for N in [26, 18, 13, 9, 6]:
    # 合并最近邻，使组数 = N：贪心合并最小损失的相邻对
    merged = [list(events[0])] if False else [[e] for e in events]
    while len(merged) > N:
        # 找损失和最小的相邻组对合并
        best = None; bestv = 1e18
        for i in range(len(merged) - 1):
            gi, gj = merged[i], merged[i+1]
            b = gi[0][1]; f = gj[-1][2]
            v = max(0, b - f)
            if v < bestv:
                bestv = v; best = i
        i = best
        merged[i] = [*merged[i], *merged[i+1]]
        del merged[i+1]
    sim = sum(max(0, g[0][1] - g[-1][2]) for g in merged)
    avg_peak = sum(max(g[i][1] for i in range(len(g))) for g in merged) / len(merged)
    print(f"{N:>3} 次压缩: 总损失 {sim:>10,} (较26次 {sim-cum:+,})  平均单次峰值cacheR {avg_peak:>7,.0f}")