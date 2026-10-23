// 流程：读表 → 按规则出告警 → 冷却去重 → 拼消息 → 推到各渠道 → 记录。本机能力（读文件、发请求）由调用方传入，便于测试。
import {
  applyCooldown, buildMessages, detectKind, evaluate, guessInventory, guessOrders, markSent, missingFields, readInventory, readOrders, toTable,
  type Alert, type InvItem, type InvMap, type Order, type OrderMap, type Rule, type Table, type TableKind,
} from './core';
import { checkUrl, platformOf, sendAll, type Channel, type FetchLike, type Platform } from './platforms';
import { readGrid } from './xlsx';

export interface Source {
  path: string;
  name: string;
  kind: TableKind;
  map: InvMap | OrderMap;
}

export interface Config {
  channels: Channel[];
  rules: Rule[];
  inventory: Source | null;
  orders: Source | null;
  /** 同一条告警多少小时内不重复推 */
  cooldownHours: number;
  /** 定时检查（界面打开期间有效） */
  auto: boolean;
  minutes: number;
}

export type Trigger = '手动' | '定时' | '测试';
export interface HistoryEntry {
  at: string;
  trigger: Trigger;
  channel: string;
  platform: Platform;
  alerts: number;
  messages: number;
  ok: boolean;
  code: string;
  msg: string;
  sample?: boolean;
}

export const MAX_MESSAGES = 5; // 每次每个渠道最多发 5 条，远低于企微每分钟 20 条（已核实）、飞书每分钟 100 条 / 每秒 5 条（已核实）的上限
export const MIN_MINUTES = 5;

/** 读一个表格，识别是库存表还是订单表并猜列；wanted 指定时按指定类型读 */
export async function loadSource(readFile: (p: string) => Promise<Uint8Array>, path: string, wanted?: TableKind): Promise<{ source: Source; table: Table }> {
  const name = path.split(/[\\/]/).pop() || path;
  const table = toTable(await readGrid(await readFile(path), name));
  if (!table.header.length) throw new Error(`「${name}」是空表`);
  const kind = wanted ?? detectKind(table.header);
  if (!kind) throw new Error(`认不出「${name}」是库存表还是订单表。表头是：${table.header.slice(0, 10).join('、')}`);
  const map = kind === 'inventory' ? guessInventory(table.header) : guessOrders(table.header);
  return { source: { path, name, kind, map }, table };
}

export interface CheckResult {
  inv: InvItem[];
  orders: Order[];
  alerts: Alert[];
  errors: string[];
  tables: { inventory?: Table; orders?: Table };
}

/** 重新读取配置里的表格并检查（列对应关系沿用已保存的） */
export async function runCheck(cfg: Config, readFile: (p: string) => Promise<Uint8Array>, now: Date): Promise<CheckResult> {
  const r: CheckResult = { inv: [], orders: [], alerts: [], errors: [], tables: {} };
  for (const src of [cfg.inventory, cfg.orders]) {
    if (!src) continue;
    try {
      const table = toTable(await readGrid(await readFile(src.path), src.name));
      const miss = missingFields(src.kind, src.map);
      if (miss.length) throw new Error(`「${src.name}」还没对应上：${miss.join('、')}`);
      const bad = Object.values(src.map).find((i) => i !== undefined && i >= table.header.length);
      if (bad !== undefined) throw new Error(`「${src.name}」的列变了，请重新选择列`);
      if (src.kind === 'inventory') { r.inv = readInventory(table, src.map as InvMap); r.tables.inventory = table; }
      else { r.orders = readOrders(table, src.map as OrderMap); r.tables.orders = table; }
    } catch (e) {
      r.errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  r.alerts = evaluate(cfg.rules, r.inv, r.orders, now);
  return r;
}

export interface PushOutcome {
  entries: HistoryEntry[];
  sent: Record<string, number>;
  /** 冷却期内没推的条数 */
  held: number;
  /** 实际要推的条数 */
  pushed: number;
}

/** 把告警推到所有启用的渠道。force=true 时忽略冷却 */
export async function pushAlerts(
  cfg: Config, alerts: Alert[], sent: Record<string, number>,
  deps: { fetch: FetchLike; now: () => number; trigger: Trigger; force?: boolean },
): Promise<PushOutcome> {
  const nowMs = deps.now();
  const { fresh, held } = deps.force ? { fresh: alerts, held: [] } : applyCooldown(alerts, sent, cfg.cooldownHours, nowMs);
  const channels = cfg.channels.filter((c) => c.on);
  const entries: HistoryEntry[] = [];
  if (!fresh.length || !channels.length) return { entries, sent, held: held.length, pushed: 0 };
  let anyOk = false;
  for (const ch of channels) {
    const base = { at: new Date(nowMs).toISOString(), trigger: deps.trigger, channel: ch.name, platform: ch.platform, alerts: fresh.length };
    const bad = checkUrl(ch.platform, ch.url);
    if (bad) { entries.push({ ...base, messages: 0, ok: false, code: '', msg: bad }); continue; }
    const msgs = buildMessages(fresh, { keyword: ch.keyword, maxBytes: platformOf(ch.platform).maxBytes, maxMessages: MAX_MESSAGES, now: new Date(nowMs) });
    const { sent: n, result } = await sendAll(ch, msgs, deps.fetch, deps.now);
    anyOk ||= result.ok;
    entries.push({ ...base, messages: n, ok: result.ok, code: result.code, msg: result.ok ? `已发 ${n} 条消息` : result.msg });
  }
  // 至少一个渠道推成功，才算推过（进入冷却）
  return { entries, sent: anyOk ? markSent(sent, fresh.map((a) => a.key), nowMs) : sent, held: held.length, pushed: fresh.length };
}

/** 测试推送：发一条固定的测试消息 */
export async function testPush(ch: Channel, fetchFn: FetchLike, now: () => number): Promise<HistoryEntry> {
  const nowMs = now();
  const base = { at: new Date(nowMs).toISOString(), trigger: '测试' as const, channel: ch.name, platform: ch.platform, alerts: 0 };
  const bad = checkUrl(ch.platform, ch.url);
  if (bad) return { ...base, messages: 0, ok: false, code: '', msg: bad };
  const kw = ch.keyword.trim() ? `${ch.keyword.trim()} ` : '';
  const { sent, result } = await sendAll(ch, [`${kw}【测试】这是一条测试消息，来自「订单 / 库存告警推到微信」。收到说明机器人配置正确。`], fetchFn, now);
  return { ...base, messages: sent, ok: result.ok, code: result.code, msg: result.ok ? '测试消息已送达' : result.msg };
}

export const addHistory = (list: HistoryEntry[], add: HistoryEntry[]) => [...add.slice().reverse(), ...list].slice(0, 200);
