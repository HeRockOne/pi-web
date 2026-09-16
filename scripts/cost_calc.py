import json, os
rel = '2026-09-15T15-26-43-028Z_01a0a5ad-7354-748a-aa5b-dcafc672a89b'
usage = os.path.expanduser('~/.pi/agent/analytics/usage.jsonl')
tot = {"inp":0,"cacheR":0,"cacheW":0,"out":0,"n":0}
for line in open(usage, encoding='utf-8'):
    line=line.strip()
    if not line: continue
    try: r=json.loads(line)
    except: continue
    if not isinstance(r,list) or len(r)<8: continue
    if rel not in str(r[1]): continue
    tot["inp"]+=r[4]; tot["cacheR"]+=r[6]; tot["cacheW"]+=r[7]
    tot["out"]+=r[5]; tot["n"]+=1
M=1_000_000
inp,tot_cr,cw,out,n = tot["inp"],tot["cacheR"],tot["cacheW"],tot["out"],tot["n"]
cost_input = inp*0.01/M
cost_cr    = tot_cr*0.0002/M
cost_cw    = cw*0.01/M
cost_out   = out*0.04/M
total = cost_input+cost_cr+cost_cw+cost_out
print(f"请求数: {n}")
print(f"input(全价): {inp:>12,} tokens  -> ${cost_input:.4f} ({cost_input/total*100:.0f}%)")
print(f"cacheR(命中): {tot_cr:>12,} tokens  -> ${cost_cr:.4f} ({cost_cr/total*100:.0f}%)")
print(f"cacheW(写):   {cw:>12,} tokens  -> ${cost_cw:.4f} ({cost_cw/total*100:.0f}%)")
print(f"output:       {out:>12,} tokens  -> ${cost_out:.4f} ({cost_out/total*100:.0f}%)")
print(f"总计: ${total:.4f}")
print()
loss_tokens = 1_214_000
loss_hit_cost   = loss_tokens*0.0002/M
loss_miss_cost  = loss_tokens*0.01/M
print("-- compress 重算损失账 --")
print(f"重算 {loss_tokens:,} tokens: 若命中 ${loss_hit_cost:.4f} -> 实际全价 ${loss_miss_cost:.4f} -> 多付 ${loss_miss_cost-loss_hit_cost:.4f}")
tot_denom = inp+tot_cr+cw
print(f"总输入口径: {tot_denom:,}  全局命中率 {tot_cr/tot_denom*100:.1f}%")
print()
print("-- 若不压缩(估算) --")
avg_ctx = 118_000
no_comp = n*avg_ctx
miss_paid = no_comp-tot_cr-inp if no_comp>tot_cr+inp else 0
print(f"若常驻 {avg_ctx:,} tokens 且无压缩重发: 每年撞~所有 input 全价")
print(f"对比: 当前实际全价input {inp:,} + cacheW {cw:,} = {(inp+cw)/M*0.01:.4f} 美元")
print(f"无压缩假设: 每条~{avg_ctx:,}tokens x {n}条 = {no_comp:,} tokens 全价(miss) = ${no_comp/M*0.01:.2f} 美元")