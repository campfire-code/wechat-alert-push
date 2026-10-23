// 截图与预览用的示例数据（不会进入正式运行）。商品、订单、群名、Webhook 地址均为虚构的「示例」。
import { evaluate, readInventory, readOrders } from './core';
import type { CheckResult } from './engine';
import { sampleConfig, sampleHistory, sampleTables } from './samples';
import type { DemoState } from './Main';

export const rows = () => [];
export const params = {};

const now = new Date();
const cfg = sampleConfig();
const tables = sampleTables(now);
const inv = readInventory(tables.inventory, cfg.inventory!.map as never);
const orders = readOrders(tables.orders, cfg.orders!.map as never);
const check: CheckResult = { inv, orders, alerts: evaluate(cfg.rules, inv, orders, now), errors: [], tables };
export const demo: DemoState = {
  cfg, check, history: sampleHistory(now),
  notice: { kind: 'ok', text: '示例：检查完成，共 ' + check.alerts.length + ' 条告警。这是虚构的示例数据，没有发送任何消息。' },
};
