import json, os, datetime

SESSION_ID = "01a0a5ad-7354-748a-aa5b-dcafc672a89b"
SESSION_FILE = "C:/Users/Sophia/.pi/agent/sessions/--C--Users-Sophia-Downloads-Compressed-pi-web-main--/2026-09-15T15-26-43-028Z_01a0a5ad-7354-748a-aa5b-dcafc672a89b.jsonl"
usage_path = os.path.expanduser('~/.pi/agent/analytics/usage.jsonl')

# ── 1. 从会话文件提取所有 compress 事件的 epoch ms ──
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

# ── 2. 加载该 session 的全部 usage 记录 ──
rows = []
for line in open(usage_path, encoding='utf-8'):
    line = line.strip()
    if not line: continue
    try: r = json.loads(line)
    except: continue
    if not isinstance(r, list) or len(r) < 8: continue
    if SESSION_ID not in str(r[1]): continue
    rows.append(r)  # [ts_ms, session, cwd, model, input, output, cacheR, cacheW, ...]

rows.sort(key=lambda r: r[0])
print(f"usage 记录数: {len(rows)}  (compress 事件: {len(compress_ms)})")

# ── 3. 逐 compress 事件计算重算损失 ──
# 基线: compress 前最后一条 cacheR>0 的请求
# 首条: compress 后第一条请求
total_loss = 0
events = []
for ci, cms in enumerate(compress_ms):
    before = [r for r in rows if r[0] < cms]
    after  = [r for r in rows if r[0] > cms]
    baseline = None
    for r in reversed(before):
        if r[6] > 0:
            baseline = r
            break
    first = after[0] if after else None
    if baseline is None or first is None: continue
    b_inp, b_cr = baseline[4], baseline[6]
    f_inp, f_cr = first[4], first[6]
    loss = max(0, b_cr - f_cr)
    # 恢复时间: 找 cacheR 回到基线 80% 以上的时间
    recover = None
    for r in after:
        if r[6] >= b_cr * 0.8:
            recover = r
            break
    rec_t = (recover[0] - cms) / 1000 if recover else None
    rec_inp = recover[4] if recover else None
    total_loss += loss
    events.append((ci+1, cms, b_inp, b_cr, f_inp, f_cr, loss, rec_t, rec_inp))

print(f"\n{'#':>3} {'时间':8} {'基线inp':>8} {'基线cacheR':>9} {'首条inp':>8} {'首条cacheR':>9} {'损失tok':>9} {'恢复s':>7}")
print("-" * 80)
for e in events:
    t = datetime.datetime.fromtimestamp(e[1]/1000).strftime('%H:%M:%S')
    rec = f"{e[7]:.0f}" if e[7] is not None else "-"
    print(f"{e[0]:>3} {t:8} {e[2]:>8,} {e[3]:>9,} {e[4]:>8,} {e[5]:>9,} {e[6]:>9,} {rec:>7}")

print(f"\n有效事件: {len(events)}/{len(compress_ms)}")
print(f"重算损失合计: {total_loss:,} tokens")
print(f"  = 命中价 ${total_loss*0.0002/1e6:.5f} -> 全价 ${total_loss*0.01/1e6:.5f} -> 多付 ${total_loss*(0.01-0.0002)/1e6:.5f}")

# ── 4. 全局统计 ──
inp = sum(r[4] for r in rows); cr = sum(r[6] for r in rows)
cw = sum(r[7] for r in rows); out = sum(r[5] for r in rows)
denom = inp + cr + cw
print(f"\n全局: input {inp:,} cacheR {cr:,} cacheW {cw:,} output {out:,}")
print(f"命中率 = {cr}/{denom} = {cr/denom*100:.2f}%")
cost = inp*0.01/1e6 + cr*0.0002/1e6 + out*0.04/1e6
print(f"总费用 = ${cost:.5f}")

# ── 5. 若 compress 未发生（重算损失全部命中）的理想值 ──
ideal_cr = cr + total_loss
ideal_inp = inp - total_loss
ideal_denom = ideal_cr + ideal_inp + cw
ideal_cost = ideal_inp*0.01/1e6 + ideal_cr*0.0002/1e6 + out*0.04/1e6
print(f"\n理想态(无重算损失): 命中率 {ideal_cr}/{ideal_denom} = {ideal_cr/ideal_denom*100:.2f}%")
print(f"理想费用 = ${ideal_cost:.5f}  省 ${cost-ideal_cost:.5f}")
