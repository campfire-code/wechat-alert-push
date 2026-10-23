// 示例数据：第一次打开时界面上显示的示例，以及 samples/ 里示例表格的内容。商品都是虚构的通用品类。
import { DEFAULT_RULES, toTable, type Cell, type Table } from './core';
import type { Config, HistoryEntry } from './engine';

export const INV_HEADER = ['商品编码', '商品名称', '可用库存', '安全库存'];
export const INV_ROWS: Cell[][] = [
  ['SKU-1001', '保温杯 500ml 白色', 0, 20],
  ['SKU-1002', '保温杯 500ml 黑色', 8, 20],
  ['SKU-1003', '帆布托特包 米色', 56, 15],
  ['SKU-1004', '香薰蜡烛 雪松味', 3, null],
  ['SKU-1005', '陶瓷马克杯 350ml', 120, 30],
  ['SKU-1006', '编织数据线 1 米', 0, 50],
  ['SKU-1007', '桌面收纳盒 三格', 14, 10],
  ['SKU-1008', '棉麻抱枕套 45cm', 9, null],
];

export const ORDER_HEADER = ['订单编号', '商品', '订单状态', '下单时间', '实付金额'];
/** [订单号, 商品, 状态, 示例文件里的下单时间, 界面示例里距现在几小时, 金额] */
const ORDERS: [string, string, string, string, number, number][] = [
  ['D20261020001', '保温杯 500ml 白色', '已发货', '2026-10-20 09:12:00', 80, 89],
  ['D20261020002', '帆布托特包 米色', '待发货', '2026-10-20 15:40:00', 70, 59],
  ['D20261021003', '香薰蜡烛 雪松味', '退款中', '2026-10-21 10:05:00', 52, 39.9],
  ['D20261021004', '陶瓷马克杯 350ml', '待发货', '2026-10-21 20:30:00', 45, 29],
  ['D20261022005', '编织数据线 1 米', '已发货', '2026-10-22 08:16:00', 34, 19.9],
  ['D20261022006', '桌面收纳盒 三格', '退款中', '2026-10-22 09:02:00', 33, 35],
  ['D20261022007', '棉麻抱枕套 45cm', '售后中', '2026-10-22 09:20:00', 32, 25],
  ['D20261022008', '保温杯 500ml 黑色', '已付款', '2026-10-22 09:30:00', 31, 89],
  ['D20261023009', '陶瓷马克杯 350ml', '待发货', '2026-10-23 08:00:00', 3, 29],
];
export const orderRowsFixed = (): Cell[][] => ORDERS.map(([id, p, s, t, , m]) => [id, p, s, t, m]);

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

/** 界面示例里的两张表：订单时间按「现在」往前推，保证任何时候打开都有超时订单 */
export function sampleTables(now = new Date()): { inventory: Table; orders: Table } {
  return {
    inventory: toTable([INV_HEADER, ...INV_ROWS]),
    orders: toTable([ORDER_HEADER, ...ORDERS.map(([id, p, s, , h, m]) => [id, p, s, stamp(new Date(now.getTime() - h * 3600000)), m])]),
  };
}

export const sampleConfig = (): Config => ({
  channels: [
    { id: 'c1', name: '仓库群（示例）', platform: 'wecom', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=EXAMPLE-0000-0000-示例占位', secret: '', keyword: '', on: true },
    { id: 'c2', name: '运营群（示例）', platform: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/example-0000-示例占位', secret: 'example-secret', keyword: '', on: true },
    { id: 'c3', name: '老板钉钉（示例）', platform: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=example0000示例占位', secret: 'SECexample', keyword: '告警', on: false },
  ],
  rules: DEFAULT_RULES.map((r) => ({ ...r })),
  inventory: { path: '示例', name: '库存表-示例.xlsx', kind: 'inventory', map: { sku: 0, name: 1, stock: 2, safe: 3 } },
  orders: { path: '示例', name: '订单表-示例.xlsx', kind: 'orders', map: { id: 0, product: 1, status: 2, time: 3 } },
  cooldownHours: 6,
  auto: true,
  minutes: 30,
});

export function sampleHistory(now = new Date()): HistoryEntry[] {
  const t = (h: number) => new Date(now.getTime() - h * 3600000).toISOString();
  return [
    { at: t(0.5), trigger: '定时', channel: '仓库群（示例）', platform: 'wecom', alerts: 9, messages: 1, ok: true, code: '0', msg: '已发 1 条消息', sample: true },
    { at: t(0.5), trigger: '定时', channel: '运营群（示例）', platform: 'feishu', alerts: 9, messages: 1, ok: true, code: '0', msg: '已发 1 条消息', sample: true },
    { at: t(6.5), trigger: '手动', channel: '运营群（示例）', platform: 'feishu', alerts: 4, messages: 0, ok: false, code: '19021', msg: 'sign match fail or timestamp is not within one hour from current time（签名不对，或时间戳与当前时间相差超过 1 小时）', sample: true },
    { at: t(26), trigger: '测试', channel: '仓库群（示例）', platform: 'wecom', alerts: 0, messages: 1, ok: true, code: '0', msg: '测试消息已送达', sample: true },
  ];
}
