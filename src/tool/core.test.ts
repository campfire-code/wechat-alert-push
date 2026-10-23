import { describe, expect, it } from 'vitest';
import {
  applyCooldown, buildMessages, bytes, cutBytes, detectKind, evaluate, guessInventory, guessOrders, maskSecret, maskUrl, markSent,
  missingFields, num, parseTime, readInventory, readOrders, toTable, DEFAULT_RULES, type Rule,
} from './core';
import { INV_HEADER, INV_ROWS, ORDER_HEADER, orderRowsFixed } from './samples';

const NOW = new Date(2026, 9, 23, 10, 0, 0);
const inv = () => readInventory(toTable([INV_HEADER, ...INV_ROWS]), guessInventory(INV_HEADER));
const orders = () => readOrders(toTable([ORDER_HEADER, ...orderRowsFixed()]), guessOrders(ORDER_HEADER));

describe('表头识别与读表', () => {
  it('库存表：安全库存不会被当成库存', () => {
    expect(guessInventory(INV_HEADER)).toEqual({ safe: 3, sku: 0, stock: 2, name: 1 });
    expect(detectKind(INV_HEADER)).toBe('inventory');
  });
  it('订单表识别，缺必填列会指出缺什么', () => {
    expect(detectKind(ORDER_HEADER)).toBe('orders');
    expect(detectKind(['姓名', '电话'])).toBeNull();
    expect(missingFields('orders', { id: 0 })).toEqual(['订单状态']);
    expect(missingFields('inventory', { stock: 1 })).toEqual(['商品编码或商品名称']);
  });
  it('数字与时间的多种写法', () => {
    expect(num('1,200')).toBe(1200);
    expect(num('12 件')).toBe(12);
    expect(num('abc')).toBeNull();
    expect(parseTime('2026-10-21 14:30')?.getHours()).toBe(14);
    expect(parseTime('2026年10月21日 14:30')?.getDate()).toBe(21);
    expect(parseTime('2026-02-31')).toBeNull();
    expect(parseTime(46000)).not.toBeNull(); // Excel 序号
    expect(parseTime('昨天')).toBeNull();
  });
  it('跳过表前空行，空行不算数据', () => {
    const t = toTable([[], [null, null], ['商品编码', '库存'], ['A', 1], [null, null], ['B', 2]]);
    expect(t.header).toEqual(['商品编码', '库存']);
    expect(t.rows).toHaveLength(2);
  });
});

describe('告警规则', () => {
  it('示例库存：售罄 2 个；低库存按安全库存，已售罄的不重复报低库存', () => {
    const a = evaluate(DEFAULT_RULES, inv(), [], NOW);
    expect(a.filter((x) => x.kind === 'zeroStock').map((x) => x.key)).toEqual(['zero:SKU-1001', 'zero:SKU-1006']);
    const low = a.filter((x) => x.kind === 'lowStock').map((x) => x.key);
    expect(low).toEqual(['low:SKU-1002', 'low:SKU-1004', 'low:SKU-1008']); // 1007 库存 14 ≥ 安全 10；1004/1008 无安全库存按 10
    expect(a.find((x) => x.key === 'low:SKU-1002')!.text).toContain('低于 20');
  });
  it('超时未发货：超过阈值才报，超过两倍标 urgent', () => {
    const a = evaluate(DEFAULT_RULES, [], orders(), NOW).filter((x) => x.kind === 'unshipped');
    const byId = Object.fromEntries(a.map((x) => [x.key, x.level]));
    expect(byId['ship:D20261020002']).toBe('urgent'); // 约 66 小时
    expect(byId['ship:D20261022008']).toBe('warn'); // 约 24.5 小时
    expect(byId['ship:D20261023009']).toBeUndefined(); // 才 2 小时
    expect(byId['ship:D20261020001']).toBeUndefined(); // 已发货
  });
  it('状态订单过多：达到数量才报', () => {
    const rule: Rule = { id: 'x', kind: 'statusCount', on: true, n: 3, statuses: '退款中，售后中' };
    const a = evaluate([rule], [], orders(), NOW);
    expect(a).toHaveLength(1);
    expect(a[0].text).toContain('3 单');
    expect(evaluate([{ ...rule, n: 4 }], [], orders(), NOW)).toHaveLength(0);
  });
  it('关闭的规则、没填状态的规则不出告警', () => {
    expect(evaluate(DEFAULT_RULES.map((r) => ({ ...r, on: false })), inv(), orders(), NOW)).toEqual([]);
    expect(evaluate([{ id: 'u', kind: 'unshipped', on: true, n: 1, statuses: '' }], [], orders(), NOW)).toEqual([]);
  });
});

describe('冷却去重', () => {
  const alerts = evaluate(DEFAULT_RULES, inv(), [], NOW);
  it('冷却内不重复推，过期后再推', () => {
    const sent = markSent({}, [alerts[0].key], NOW.getTime());
    const r1 = applyCooldown(alerts, sent, 6, NOW.getTime() + 3600000);
    expect(r1.held).toHaveLength(1);
    expect(r1.fresh).toHaveLength(alerts.length - 1);
    expect(applyCooldown(alerts, sent, 6, NOW.getTime() + 7 * 3600000).held).toHaveLength(0);
    expect(applyCooldown(alerts, sent, 0, NOW.getTime() + 1).held).toHaveLength(0); // 冷却 0 = 不去重
  });
  it('markSent 清掉 7 天前的记录', () => {
    const next = markSent({ old: NOW.getTime() - 8 * 86400000, recent: NOW.getTime() - 86400000 }, ['k'], NOW.getTime());
    expect(Object.keys(next).sort()).toEqual(['k', 'recent']);
  });
});

describe('消息拼装', () => {
  const alerts = evaluate(DEFAULT_RULES, inv(), orders(), NOW);
  it('按类型分组，带关键词前缀', () => {
    const [m] = buildMessages(alerts, { keyword: '告警', maxBytes: 2048, maxMessages: 5, now: NOW });
    expect(m.startsWith('告警 【库存 / 订单告警】10月23日 10:00')).toBe(true);
    expect(m).toContain('【已售罄 2】');
    expect(m).toContain('【超时未发货');
  });
  it('超长自动分条，每条不超过字节上限，条数不超过上限，并说明另有多少条', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ key: `z${i}`, kind: 'zeroStock' as const, level: 'urgent' as const, text: `已售罄：商品名称很长很长的测试商品 ${i}（SKU-${i}），库存 0` }));
    const msgs = buildMessages(many, { maxBytes: 600, maxMessages: 3, now: NOW });
    expect(msgs).toHaveLength(3);
    for (const m of msgs) expect(bytes(m)).toBeLessThanOrEqual(600);
    expect(msgs[2]).toMatch(/另有 \d+ 条未列出/);
  });
  it('没有告警不出消息；截断不会截半个字', () => {
    expect(buildMessages([], { maxBytes: 2048, maxMessages: 5, now: NOW })).toEqual([]);
    const c = cutBytes('你好世界你好世界', 10);
    expect(bytes(c)).toBeLessThanOrEqual(10);
    expect(c.endsWith('…')).toBe(true);
  });
});

describe('打码', () => {
  it('Webhook 地址和密钥打码后不含完整 key', () => {
    const u = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd1234-5678-90ef';
    expect(maskUrl(u)).not.toContain('1234-5678');
    expect(maskUrl(u)).toContain('****90ef');
    expect(maskSecret('SECabcdefghij')).toBe('SEC******ij');
    expect(maskSecret('')).toBe('');
  });
});
