// 整个流程：读表（内存里生成的 xlsx / csv）→ 检查 → 冷却 → 推到假渠道 → 记录。不访问网络。
import { describe, expect, it } from 'vitest';
import { addHistory, loadSource, pushAlerts, runCheck, testPush, type Config } from './engine';
import { DEFAULT_RULES } from './core';
import { INV_HEADER, INV_ROWS, ORDER_HEADER, orderRowsFixed } from './samples';
import type { FetchLike } from './platforms';
import { writeXlsx } from './xlsx';

const NOW = new Date(2026, 9, 23, 10, 0, 0);
const files = new Map<string, Uint8Array>();
const readFile = async (p: string) => { const f = files.get(p); if (!f) throw new Error('找不到文件'); return f; };
const WECOM = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=EXAMPLE-KEY';
const FEISHU = 'https://open.feishu.cn/open-apis/bot/v2/hook/example-hook';

async function config(): Promise<Config> {
  files.set('/库存.xlsx', await writeXlsx('库存', INV_HEADER, INV_ROWS));
  files.set('/订单.xlsx', await writeXlsx('订单', ORDER_HEADER, orderRowsFixed()));
  const a = await loadSource(readFile, '/库存.xlsx');
  const b = await loadSource(readFile, '/订单.xlsx');
  return {
    channels: [
      { id: 'a', name: '企微', platform: 'wecom', url: WECOM, secret: '', keyword: '', on: true },
      { id: 'b', name: '飞书', platform: 'feishu', url: FEISHU, secret: '', keyword: '', on: true },
    ],
    rules: DEFAULT_RULES, inventory: a.source, orders: b.source, cooldownHours: 6, auto: false, minutes: 30,
  };
}
const okFetch = () => {
  const calls: string[] = [];
  const f: FetchLike = async (url) => {
    calls.push(url);
    return { status: 200, text: async () => (url.includes('feishu') ? '{"code":0,"msg":"success"}' : '{"errcode":0,"errmsg":"ok"}') };
  };
  return { f, calls };
};

describe('读表与检查', () => {
  it('自动认出库存表和订单表并对上列', async () => {
    const cfg = await config();
    expect(cfg.inventory).toMatchObject({ kind: 'inventory', map: { sku: 0, name: 1, stock: 2, safe: 3 } });
    expect(cfg.orders).toMatchObject({ kind: 'orders', map: { id: 0, product: 1, status: 2, time: 3 } });
  });
  it('csv（GBK 之外的 UTF-8）也能读；认不出的表给出表头', async () => {
    files.set('/x.csv', new TextEncoder().encode('姓名,电话\n甲,1'));
    await expect(loadSource(readFile, '/x.csv')).rejects.toThrow(/认不出.*姓名/);
    files.set('/inv.csv', new TextEncoder().encode('商品编码,库存\nA,0\nB,5'));
    expect((await loadSource(readFile, '/inv.csv')).source.kind).toBe('inventory');
  });
  it('检查出告警；列变了或文件没了会记入 errors 而不是整个失败', async () => {
    const cfg = await config();
    const r = await runCheck(cfg, readFile, NOW);
    expect(r.errors).toEqual([]);
    expect(r.alerts.length).toBeGreaterThan(5);
    files.delete('/订单.xlsx');
    const r2 = await runCheck(cfg, readFile, NOW);
    expect(r2.errors).toHaveLength(1);
    expect(r2.alerts.some((a) => a.kind === 'zeroStock')).toBe(true);
  });
});

describe('推送', () => {
  it('推到所有启用渠道，之后同样的告警进入冷却；强制推送忽略冷却', async () => {
    const cfg = await config();
    const { alerts } = await runCheck(cfg, readFile, NOW);
    const { f, calls } = okFetch();
    const deps = { fetch: f, now: () => NOW.getTime(), trigger: '手动' as const };
    const o1 = await pushAlerts(cfg, alerts, {}, deps);
    expect(o1.entries.map((e) => [e.channel, e.ok])).toEqual([['企微', true], ['飞书', true]]);
    expect(calls).toHaveLength(2);
    expect(o1.pushed).toBe(alerts.length);
    const o2 = await pushAlerts(cfg, alerts, o1.sent, deps);
    expect(o2.pushed).toBe(0);
    expect(o2.held).toBe(alerts.length);
    expect(calls).toHaveLength(2);
    expect((await pushAlerts(cfg, alerts, o1.sent, { ...deps, force: true })).pushed).toBe(alerts.length);
  });
  it('所有渠道都失败时不进入冷却；地址不对的渠道不发请求', async () => {
    const cfg = await config();
    cfg.channels[1].on = false;
    const { alerts } = await runCheck(cfg, readFile, NOW);
    const bad: FetchLike = async () => ({ status: 200, text: async () => '{"errcode":93000,"errmsg":"invalid webhook url"}' });
    const o = await pushAlerts(cfg, alerts, {}, { fetch: bad, now: () => NOW.getTime(), trigger: '定时' });
    expect(o.entries[0]).toMatchObject({ ok: false, code: '93000' });
    expect(o.sent).toEqual({});
    cfg.channels[0].url = 'https://example.com/x';
    const { f, calls } = okFetch();
    const o2 = await pushAlerts(cfg, alerts, {}, { fetch: f, now: () => NOW.getTime(), trigger: '定时' });
    expect(o2.entries[0].ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('记录里不出现 Webhook 地址和 key', async () => {
    const cfg = await config();
    const { alerts } = await runCheck(cfg, readFile, NOW);
    const f: FetchLike = async () => { throw new Error('boom'); };
    const o = await pushAlerts(cfg, alerts, {}, { fetch: f, now: () => NOW.getTime(), trigger: '手动' });
    const s = JSON.stringify(o.entries);
    expect(s).not.toContain('EXAMPLE-KEY');
    expect(s).not.toContain('example-hook');
  });
  it('测试推送与历史上限', async () => {
    const cfg = await config();
    const { f } = okFetch();
    const e = await testPush(cfg.channels[0], f, () => NOW.getTime());
    expect(e).toMatchObject({ trigger: '测试', ok: true });
    expect(addHistory(Array(200).fill(e), [e, e])).toHaveLength(200);
  });
});
