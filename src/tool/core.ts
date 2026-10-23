// 纯函数：表头识别、读表、告警规则、冷却去重、消息拼装与分条。不依赖界面和本机能力，便于单元测试。

export type Cell = string | number | null;

// ---------- 表头识别 ----------

export type InvField = 'sku' | 'name' | 'stock' | 'safe';
export type OrderField = 'id' | 'status' | 'time' | 'product';
export type TableKind = 'inventory' | 'orders';

export const INV_FIELDS: [InvField, string][] = [['sku', '商品编码'], ['name', '商品名称'], ['stock', '库存'], ['safe', '安全库存（可选）']];
export const ORDER_FIELDS: [OrderField, string][] = [['id', '订单号'], ['status', '订单状态'], ['time', '下单时间'], ['product', '商品（可选）']];

// 识别顺序有讲究：先认「安全库存」，再认「库存」，免得把安全库存当成库存
const INV_GUESS: [InvField, RegExp[]][] = [
  ['safe', [/安全库存|预警值|预警库存|最低库存|警戒/]],
  ['sku', [/^sku(编码|编号|id)?$/i, /商品编码|商品编号|商家编码|规格编码|货号|sku/i, /^(编码|编号)$/]],
  ['stock', [/^(可用|可售|当前|实际|剩余|现有)?库存(数量|数)?$/, /库存/, /^(在库|结存|现存)(数量)?$/]],
  ['name', [/^(商品|产品|宝贝)?名称$/, /商品名|品名|产品名|宝贝名/, /名称|标题/, /^(商品|产品|宝贝)$/]],
];
const ORDER_GUESS: [OrderField, RegExp[]][] = [
  ['id', [/^(订单|主订单|子订单)(号|编号|id)$/i, /订单号|订单编号|单号/]],
  ['status', [/^(订单)?状态$/, /状态/]],
  ['time', [/^(下单|创建|付款|支付|成交)时间$/, /下单时间|付款时间|支付时间|创建时间|下单日期/, /时间|日期/]],
  ['product', [/^(商品|产品|宝贝)(名称)?$/, /商品|宝贝|产品|品名/]],
];

const norm = (s: string) => s.replace(/\s+/g, '').trim();

function guess<F extends string>(header: string[], rules: [F, RegExp[]][]): Partial<Record<F, number>> {
  const out: Partial<Record<F, number>> = {};
  const used = new Set<number>();
  for (const [field, pats] of rules) {
    for (const re of pats) {
      const i = header.findIndex((h, j) => !used.has(j) && re.test(norm(h)));
      if (i >= 0) { out[field] = i; used.add(i); break; }
    }
  }
  return out;
}

export type InvMap = Partial<Record<InvField, number>>;
export type OrderMap = Partial<Record<OrderField, number>>;

export const guessInventory = (header: string[]): InvMap => guess(header, INV_GUESS);
export const guessOrders = (header: string[]): OrderMap => guess(header, ORDER_GUESS);

/** 判断一张表是订单表还是库存表；都不像返回 null */
export function detectKind(header: string[]): TableKind | null {
  const o = guessOrders(header);
  if (o.id !== undefined && (o.status !== undefined || o.time !== undefined)) return 'orders';
  const inv = guessInventory(header);
  if (inv.stock !== undefined && (inv.sku !== undefined || inv.name !== undefined)) return 'inventory';
  return null;
}

/** 必填列是否都已对应上，缺哪些 */
export function missingFields(kind: TableKind, map: InvMap | OrderMap): string[] {
  const need = kind === 'inventory' ? (['stock'] as const) : (['id', 'status'] as const);
  const labels = Object.fromEntries([...INV_FIELDS, ...ORDER_FIELDS]) as Record<string, string>;
  const miss: string[] = need.filter((k) => (map as Record<string, number | undefined>)[k] === undefined).map((k) => labels[k]);
  if (kind === 'inventory' && (map as InvMap).sku === undefined && (map as InvMap).name === undefined) miss.push('商品编码或商品名称');
  return miss;
}

// ---------- 表格内容 ----------

export interface Table {
  header: string[];
  rows: Cell[][];
}

/** 二维数组转成表：跳过前面的空行，第一行非空行当表头 */
export function toTable(grid: Cell[][]): Table {
  const start = grid.findIndex((r) => r.some((c) => text(c) !== ''));
  if (start < 0) return { header: [], rows: [] };
  const header = grid[start].map((c) => text(c));
  const rows = grid.slice(start + 1).filter((r) => r.some((c) => text(c) !== ''));
  return { header, rows };
}

export const text = (c: Cell | undefined) => (c == null ? '' : String(c).trim());

/** 数字：兼容「1,200」「12 件」这类写法；读不出返回 null */
export function num(c: Cell | undefined): number | null {
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  const m = text(c).replace(/,/g, '').match(/^-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/**
 * 时间：支持「2026-10-21 14:30(:00)」「2026/10/21」「2026年10月21日 14:30」和 Excel 日期序号。
 * 按本机时区理解（表格里的时间一般就是本地时间）。
 */
export function parseTime(c: Cell | undefined): Date | null {
  if (typeof c === 'number') {
    if (c > 20000 && c < 80000) {
      // Excel 序号：1899-12-30 起的天数
      const ms = Math.round((c - 25569) * 86400000);
      const u = new Date(ms);
      return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds());
    }
    return null;
  }
  const m = text(c).match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})日?(?:[\sT]+(\d{1,2})[:时](\d{1,2})(?:[:分](\d{1,2}))?)?/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return Number.isNaN(d.getTime()) || d.getMonth() !== +m[2] - 1 ? null : d;
}

export interface InvItem { line: number; sku: string; name: string; stock: number | null; safe: number | null }
export interface Order { line: number; id: string; status: string; time: Date | null; product: string }

const at = (r: Cell[], i: number | undefined) => (i === undefined ? undefined : r[i]);

export function readInventory(t: Table, map: InvMap): InvItem[] {
  return t.rows.map((r, i) => ({
    line: i + 2,
    sku: text(at(r, map.sku)),
    name: text(at(r, map.name)),
    stock: num(at(r, map.stock)),
    safe: map.safe === undefined ? null : num(at(r, map.safe)),
  })).filter((x) => x.sku || x.name);
}

export function readOrders(t: Table, map: OrderMap): Order[] {
  return t.rows.map((r, i) => ({
    line: i + 2,
    id: text(at(r, map.id)),
    status: text(at(r, map.status)),
    time: parseTime(at(r, map.time)),
    product: text(at(r, map.product)),
  })).filter((x) => x.id);
}

// ---------- 告警规则 ----------

export type RuleKind = 'zeroStock' | 'lowStock' | 'unshipped' | 'statusCount';
export interface Rule {
  id: string;
  kind: RuleKind;
  on: boolean;
  /** lowStock：低于几件；unshipped：超过几小时；statusCount：达到几单 */
  n: number;
  /** unshipped / statusCount：哪些状态，逗号分隔，包含即算 */
  statuses?: string;
  /** lowStock：表里有「安全库存」列时，优先按每个商品自己的安全库存判断 */
  useSafe?: boolean;
}

export const RULE_KINDS: [RuleKind, string][] = [
  ['zeroStock', '已售罄（库存 ≤ 0）'],
  ['lowStock', '库存不足'],
  ['unshipped', '超时未发货'],
  ['statusCount', '某状态订单过多'],
];

export const DEFAULT_RULES: Rule[] = [
  { id: 'r1', kind: 'zeroStock', on: true, n: 0 },
  { id: 'r2', kind: 'lowStock', on: true, n: 10, useSafe: true },
  { id: 'r3', kind: 'unshipped', on: true, n: 24, statuses: '待发货,已付款' },
  { id: 'r4', kind: 'statusCount', on: true, n: 3, statuses: '退款中,售后中' },
];

export function describeRule(r: Rule): string {
  switch (r.kind) {
    case 'zeroStock': return '库存 ≤ 0 的商品';
    case 'lowStock': return `库存低于 ${r.n} 件${r.useSafe ? '（表里填了安全库存的按安全库存）' : ''}`;
    case 'unshipped': return `「${splitStatuses(r.statuses).join('、') || '未填状态'}」超过 ${r.n} 小时`;
    case 'statusCount': return `「${splitStatuses(r.statuses).join('、') || '未填状态'}」达到 ${r.n} 单`;
  }
}

export const splitStatuses = (s = '') => s.split(/[,，、;；\s]+/).map((x) => x.trim()).filter(Boolean);
const statusHit = (status: string, list: string[]) => list.some((s) => status.includes(s));

export type Level = 'urgent' | 'warn';
export interface Alert {
  /** 冷却去重用的键：同一个商品 / 订单 / 规则 */
  key: string;
  kind: RuleKind;
  level: Level;
  text: string;
}

const label = (x: InvItem) => (x.name && x.sku ? `${x.name}（${x.sku}）` : x.name || x.sku);
const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** 按规则生成告警。now 用于计算「已等待多少小时」 */
export function evaluate(rules: Rule[], inv: InvItem[], orders: Order[], now: Date): Alert[] {
  const out: Alert[] = [];
  const zeroOn = rules.some((r) => r.on && r.kind === 'zeroStock');
  for (const r of rules.filter((x) => x.on)) {
    if (r.kind === 'zeroStock') {
      for (const x of inv) if (x.stock !== null && x.stock <= 0) out.push({ key: `zero:${x.sku || x.name}`, kind: r.kind, level: 'urgent', text: `已售罄：${label(x)}，库存 ${fmtNum(x.stock)}` });
    } else if (r.kind === 'lowStock') {
      for (const x of inv) {
        if (x.stock === null || (zeroOn && x.stock <= 0)) continue;
        const limit = r.useSafe && x.safe !== null ? x.safe : r.n;
        if (x.stock < limit) out.push({ key: `low:${x.sku || x.name}`, kind: r.kind, level: 'warn', text: `库存不足：${label(x)}，剩 ${fmtNum(x.stock)} 件，低于 ${fmtNum(limit)}` });
      }
    } else if (r.kind === 'unshipped') {
      const list = splitStatuses(r.statuses);
      if (!list.length) continue;
      for (const o of orders) {
        if (!o.time || !statusHit(o.status, list)) continue;
        const h = (now.getTime() - o.time.getTime()) / 3600000;
        if (h > r.n) out.push({ key: `ship:${o.id}`, kind: r.kind, level: h > r.n * 2 ? 'urgent' : 'warn', text: `超时未发货：订单 ${o.id}${o.product ? `（${o.product}）` : ''}，${o.status} 已 ${Math.floor(h)} 小时` });
      }
    } else if (r.kind === 'statusCount') {
      const list = splitStatuses(r.statuses);
      if (!list.length) continue;
      const hits = orders.filter((o) => statusHit(o.status, list));
      if (hits.length >= r.n && r.n > 0) out.push({ key: `count:${r.id}:${list.join('|')}`, kind: r.kind, level: 'warn', text: `「${list.join('、')}」订单有 ${hits.length} 单，达到 ${r.n} 单：${hits.slice(0, 5).map((o) => o.id).join('、')}${hits.length > 5 ? ' 等' : ''}` });
    }
  }
  return out;
}

/** 冷却：同一个键在冷却时间内推过的不再推。返回要推的和被压下的 */
export function applyCooldown(alerts: Alert[], sent: Record<string, number>, cooldownHours: number, nowMs: number) {
  const fresh: Alert[] = [];
  const held: Alert[] = [];
  for (const a of alerts) {
    const last = sent[a.key];
    if (last !== undefined && cooldownHours > 0 && nowMs - last < cooldownHours * 3600000) held.push(a);
    else fresh.push(a);
  }
  return { fresh, held };
}

/** 推送成功后记下时间；顺手清掉 7 天前的旧记录，避免越存越多 */
export function markSent(sent: Record<string, number>, keys: string[], nowMs: number): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(sent)) if (nowMs - v < 7 * 86400000) next[k] = v;
  for (const k of keys) next[k] = nowMs;
  return next;
}

// ---------- 消息拼装 ----------

export const bytes = (s: string) => new TextEncoder().encode(s).length;

/** 按 UTF-8 字节截断，不截断半个字 */
export function cutBytes(s: string, max: number): string {
  if (bytes(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (bytes(out + ch + '…') > max) break;
    out += ch;
  }
  return out + '…';
}

const pad = (n: number) => String(n).padStart(2, '0');
export const fmtTime = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;

const KIND_TITLE: Record<RuleKind, string> = { zeroStock: '已售罄', lowStock: '库存不足', unshipped: '超时未发货', statusCount: '订单状态' };

export interface BuildOptions {
  /** 每条消息开头都带上，用于钉钉「自定义关键词」安全设置 */
  keyword?: string;
  /** 单条消息的字节上限 */
  maxBytes: number;
  /** 一次最多发几条，多出的告警只给数量 */
  maxMessages: number;
  now: Date;
}

/** 把告警拼成若干条纯文本消息：按类型分组、超长自动分条、超过条数上限的只写「另有 N 条」 */
export function buildMessages(alerts: Alert[], o: BuildOptions): string[] {
  if (!alerts.length) return [];
  const kw = o.keyword?.trim() ? `${o.keyword.trim()} ` : '';
  const head = (part: number) => `${kw}【库存 / 订单告警】${fmtTime(o.now)}${part > 1 ? `（续 ${part}）` : ''}\n共 ${alerts.length} 条${part > 1 ? '，接上条' : ''}`;
  const lines: string[] = [];
  for (const kind of Object.keys(KIND_TITLE) as RuleKind[]) {
    const list = alerts.filter((a) => a.kind === kind);
    if (!list.length) continue;
    lines.push(`\n【${KIND_TITLE[kind]} ${list.length}】`);
    list.forEach((a, i) => lines.push(`${i + 1}. ${a.level === 'urgent' ? '🔴' : '🟠'}${a.text.replace(/^[^：]+：/, '')}`));
  }
  const tailRoom = 80; // 留给「另有 N 条未列出」
  const msgs: string[] = [];
  let cur = head(1);
  let listed = 0;
  const total = lines.filter((l) => !l.startsWith('\n')).length;
  for (const raw of lines) {
    const isLast = msgs.length === o.maxMessages - 1;
    const room = o.maxBytes - (isLast ? tailRoom : 0);
    const line = cutBytes(raw, Math.max(40, o.maxBytes - bytes(head(msgs.length + 2)) - tailRoom - 2));
    if (bytes(cur + '\n' + line) > room) {
      if (isLast) break;
      msgs.push(cur);
      cur = head(msgs.length + 1) + (line.startsWith('\n') ? '' : '\n');
    }
    cur += '\n' + line;
    if (!raw.startsWith('\n')) listed++;
  }
  if (listed < total) cur += `\n\n……另有 ${total - listed} 条未列出，请打开工具查看`;
  msgs.push(cur);
  return msgs;
}

/** Webhook 地址打码显示：保留开头和最后 4 位 */
export function maskUrl(url: string): string {
  const m = url.match(/^(https?:\/\/[^?#]+[?/](?:key=|access_token=|hook\/)?)(.*)$/);
  if (!m || m[2].length <= 6) return url ? url.replace(/.(?=.{4})/g, '*') : '';
  return `${m[1]}${m[2].slice(0, 2)}****${m[2].slice(-4)}`;
}

export const maskSecret = (s: string) => (s ? (s.length <= 6 ? '******' : `${s.slice(0, 3)}******${s.slice(-2)}`) : '');
