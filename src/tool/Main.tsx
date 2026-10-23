// 订单 / 库存告警推到微信：选库存表 / 订单表 → 设规则 → 配群机器人 → 检查并推送（可定时）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, FileSpreadsheet, Loader2, Plus, Send, Trash2, Zap } from 'lucide-react';
import type { RunContext } from '../kit/types';
import { httpFetch, pickFiles, settingsStore } from '../kit/platform';
import {
  DEFAULT_RULES, INV_FIELDS, ORDER_FIELDS, RULE_KINDS, describeRule, missingFields, type InvMap, type OrderMap, type Rule, type Table,
} from './core';
import { MIN_MINUTES, addHistory, loadSource, pushAlerts, runCheck, testPush, type CheckResult, type Config, type HistoryEntry, type Source } from './engine';
import { PLATFORMS, checkUrl, platformOf, type Channel, type FetchLike, type Platform } from './platforms';
import './tool.css';

type Ctx = Pick<RunContext, 'readFile'>;
type Notice = { kind: 'ok' | 'err'; text: string } | null;
export interface DemoState { cfg: Config; check: CheckResult; history: HistoryEntry[]; notice?: Notice }

const KEY = 'wechat-alert-push.config';
const SENT_KEY = 'wechat-alert-push.sent';
const HIST_KEY = 'wechat-alert-push.history';
const EMPTY: Config = { channels: [], rules: DEFAULT_RULES, inventory: null, orders: null, cooldownHours: 6, auto: false, minutes: 30 };
let seq = 0;
const uid = () => `x${Date.now().toString(36)}${seq++}`;
const fmt = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

/** 真实发送：Tauri HTTP 插件，30 秒超时 */
const realFetch: FetchLike = async (url, init) => {
  const res = await httpFetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, text: () => res.text() };
};
/** 预览模式的假发送：不联网 */
const fakeFetch: FetchLike = async (url) => ({ status: 200, text: async () => (url.includes('feishu') ? '{"code":0,"msg":"success"}' : '{"errcode":0,"errmsg":"ok"}') });

export function Main({ ctx }: { ctx: Ctx }) {
  const preview = location.pathname.endsWith('preview.html');
  const [cfg, setCfg] = useState<Config>(EMPTY);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [sent, setSent] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirm, setConfirm] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [lastAuto, setLastAuto] = useState('');
  const latest = useRef({ cfg, sent, busy });
  latest.current = { cfg, sent, busy };

  useEffect(() => {
    if (preview) {
      import('./preview').then(({ demo }) => { setCfg(demo.cfg); setCheck(demo.check); setHistory(demo.history); setNotice(demo.notice ?? null); setLoaded(true); });
      return;
    }
    settingsStore().then(async (s) => {
      const c = await s.get<Config>(KEY);
      if (c) setCfg({ ...EMPTY, ...c });
      setSent((await s.get<Record<string, number>>(SENT_KEY)) ?? {});
      setHistory((await s.get<HistoryEntry[]>(HIST_KEY)) ?? []);
    }).catch(() => {}).finally(() => setLoaded(true));
  }, [preview]);

  const save = (c: Config) => { setCfg(c); setConfirm(false); if (!preview) settingsStore().then((s) => s.set(KEY, c)).catch(() => {}); };
  const keep = (h: HistoryEntry[], s: Record<string, number>) => {
    setHistory(h); setSent(s);
    if (!preview) settingsStore().then(async (st) => { await st.set(HIST_KEY, h); await st.set(SENT_KEY, s); }).catch(() => {});
  };
  const fail = (e: unknown) => setNotice({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  const net = preview ? fakeFetch : realFetch;
  const read = (p: string) => ctx.readFile(p);

  const doCheck = async (c = cfg): Promise<CheckResult | null> => {
    if (preview) return check;
    const r = await runCheck(c, read, new Date());
    setCheck(r);
    return r;
  };

  const choose = async (kind: 'inventory' | 'orders') => {
    try {
      const [p] = await pickFiles(['xlsx', 'csv'], '表格');
      if (!p) return;
      const { source } = await loadSource(read, p, kind);
      const next = { ...cfg, [kind]: source };
      save(next); setNotice(null);
      await doCheck(next);
    } catch (e) { fail(e); }
  };
  const setMap = (kind: 'inventory' | 'orders', key: string, v: string) => {
    const src = cfg[kind]; if (!src) return;
    const map = { ...src.map, [key]: v === '' ? undefined : Number(v) } as InvMap | OrderMap;
    const next = { ...cfg, [kind]: { ...src, map } as Source };
    save(next); void doCheck(next).catch(fail);
  };

  const pushNow = async (force: boolean) => {
    setBusy(true); setNotice(null); setConfirm(false);
    try {
      const r = await doCheck();
      if (!r) return;
      if (r.errors.length && !r.alerts.length) throw new Error(r.errors.join('；'));
      const out = await pushAlerts(cfg, r.alerts, sent, { fetch: net, now: Date.now, trigger: '手动', force });
      keep(addHistory(history, out.entries), out.sent);
      const okN = out.entries.filter((e) => e.ok).length;
      if (!cfg.channels.some((c) => c.on)) setNotice({ kind: 'err', text: '没有启用的渠道，请先添加并启用一个群机器人' });
      else if (!r.alerts.length) setNotice({ kind: 'ok', text: '检查完成，没有告警，未发送消息' });
      else if (!out.pushed) setNotice({ kind: 'ok', text: `${out.held} 条告警都在冷却期内，已推送过，未重复发送` });
      else setNotice({ kind: okN === out.entries.length ? 'ok' : 'err', text: `推送 ${out.pushed} 条告警：${okN} 个渠道成功，${out.entries.length - okN} 个失败${out.held ? `；另有 ${out.held} 条在冷却期内未重复推` : ''}` });
    } catch (e) { fail(e); }
    setBusy(false);
  };

  const test = async (ch: Channel) => {
    setBusy(true); setNotice(null);
    try {
      const e = await testPush(ch, net, Date.now);
      keep(addHistory(history, [e]), sent);
      setNotice({ kind: e.ok ? 'ok' : 'err', text: `「${ch.name}」${e.ok ? '测试消息已送达，去群里看一眼' : '测试失败：' + e.msg}` });
    } catch (e) { fail(e); }
    setBusy(false);
  };

  // 定时检查：窗口开着才有效。每次都取最新配置
  const autoOn = loaded && !preview && cfg.auto && cfg.minutes >= MIN_MINUTES;
  useEffect(() => {
    if (!autoOn) return;
    const t = setInterval(async () => {
      const { cfg: c, sent: s, busy: b } = latest.current;
      if (b) return;
      try {
        const r = await runCheck(c, read, new Date());
        setCheck(r);
        const out = await pushAlerts(c, r.alerts, s, { fetch: realFetch, now: Date.now, trigger: '定时' });
        if (out.entries.length) {
          setHistory((h) => { const n = addHistory(h, out.entries); settingsStore().then((st) => st.set(HIST_KEY, n)).catch(() => {}); return n; });
          setSent(out.sent);
          settingsStore().then((st) => st.set(SENT_KEY, out.sent)).catch(() => {});
        }
        setLastAuto(`${fmt(new Date().toISOString())} 定时检查：${r.alerts.length} 条告警，推送 ${out.pushed} 条`);
      } catch (e) { setLastAuto(`定时检查失败：${e instanceof Error ? e.message : String(e)}`); }
    }, cfg.minutes * 60_000);
    return () => clearInterval(t);
  }, [autoOn, cfg.minutes]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchRule = (id: string, p: Partial<Rule>) => save({ ...cfg, rules: cfg.rules.map((r) => (r.id === id ? { ...r, ...p } : r)) });
  const patchCh = (id: string, p: Partial<Channel>) => save({ ...cfg, channels: cfg.channels.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  const addCh = () => save({ ...cfg, channels: [...cfg.channels, { id: uid(), name: `群机器人 ${cfg.channels.length + 1}`, platform: 'wecom', url: '', secret: '', keyword: '', on: true }] });

  const alerts = check?.alerts ?? [];
  const miss = (s: Source | null) => (s ? missingFields(s.kind, s.map) : []);
  const ready = (cfg.inventory || cfg.orders) && !miss(cfg.inventory).length && !miss(cfg.orders).length && cfg.channels.some((c) => c.on);
  const header = (k: 'inventory' | 'orders'): Table['header'] => check?.tables[k]?.header ?? [];
  const urgent = useMemo(() => alerts.filter((a) => a.level === 'urgent').length, [alerts]);
  const kindName = (k: string) => RULE_KINDS.find(([x]) => x === k)?.[1] ?? k;

  const mapRow = (kind: 'inventory' | 'orders') => {
    const src = cfg[kind];
    const fields = kind === 'inventory' ? INV_FIELDS : ORDER_FIELDS;
    return (
      <div className="al-src">
        <b>{kind === 'inventory' ? '库存表' : '订单表'}</b>
        <button className="k-btn" disabled={busy} onClick={() => void choose(kind)}><FileSpreadsheet size={15} />{src ? '换一个文件' : '选择文件'}</button>
        {src ? <span className="k-muted">{src.name}</span> : <span className="k-muted">.xlsx 或 .csv，可不选（只做另一种告警）</span>}
        {src && fields.map(([k, label]) => (
          <label key={k} className="al-lbl">{label}{' '}
            <select className="k-input" aria-label={label} value={(src.map as Record<string, number | undefined>)[k] ?? ''} onChange={(e) => setMap(kind, k, e.target.value)}>
              <option value="">未对应</option>
              {header(kind).map((h, i) => <option key={i} value={i}>{h || `第 ${i + 1} 列`}</option>)}
            </select>
          </label>
        ))}
        {src && miss(src).length > 0 && <span className="al-bad">还差：{miss(src).join('、')}</span>}
      </div>
    );
  };

  return (
    <div className="al-root">
      {notice && <div className={`k-notice ${notice.kind}`} role="status">{notice.text}</div>}
      {check?.errors.map((e, i) => <div key={i} className="k-notice err" role="status">{e}</div>)}

      <section className="k-panel al-card">
        <div className="al-hd"><b>1. 数据来源</b><span className="k-help">表格只在本机读取；每次检查都会重新读文件，改了表直接重新检查即可</span></div>
        {mapRow('inventory')}
        {mapRow('orders')}
      </section>

      <section className="k-panel al-card">
        <div className="al-hd"><b>2. 告警规则</b>
          <span className="al-grow" />
          <label className="al-check">同一条告警<input className="k-input al-n" type="number" min={0} aria-label="冷却小时" value={cfg.cooldownHours} onChange={(e) => save({ ...cfg, cooldownHours: Math.max(0, Number(e.target.value) || 0) })} />小时内不重复推（0 = 不去重）</label>
        </div>
        {cfg.rules.map((r) => (
          <div key={r.id} className="al-rule">
            <label className="al-check"><input type="checkbox" checked={r.on} aria-label="启用规则" onChange={(e) => patchRule(r.id, { on: e.target.checked })} />{kindName(r.kind)}</label>
            {r.kind !== 'zeroStock' && <input className="k-input al-n" type="number" min={0} aria-label="数值" value={r.n} onChange={(e) => patchRule(r.id, { n: Number(e.target.value) || 0 })} />}
            {(r.kind === 'unshipped' || r.kind === 'statusCount') && <input className="k-input al-st" aria-label="状态" value={r.statuses ?? ''} placeholder="状态，逗号隔开" onChange={(e) => patchRule(r.id, { statuses: e.target.value })} />}
            {r.kind === 'lowStock' && <label className="al-check"><input type="checkbox" checked={!!r.useSafe} onChange={(e) => patchRule(r.id, { useSafe: e.target.checked })} />优先用表里的安全库存</label>}
            <span className="k-muted">{r.on ? describeRule(r) : '已关闭'}</span>
          </div>
        ))}
      </section>

      <section className="k-panel al-card">
        <div className="al-hd"><b>3. 群机器人</b><span className="k-help">Webhook 地址和密钥只保存在本机，界面里以密码形式显示</span><span className="al-grow" />
          <button className="k-btn" onClick={addCh}><Plus size={15} />添加渠道</button></div>
        {cfg.channels.length === 0 && <p className="k-muted">还没有渠道。在企业微信 / 钉钉 / 飞书群里添加自定义机器人，把它的 Webhook 地址粘贴到这里。</p>}
        {cfg.channels.map((c) => {
          const bad = c.url ? checkUrl(c.platform, c.url) : null;
          return (
            <div key={c.id} className="al-ch">
              <label className="al-check"><input type="checkbox" checked={c.on} aria-label="启用渠道" onChange={(e) => patchCh(c.id, { on: e.target.checked })} /></label>
              <input className="k-input al-chname" aria-label="渠道名" value={c.name} onChange={(e) => patchCh(c.id, { name: e.target.value })} />
              <select className="k-input" aria-label="平台" value={c.platform} onChange={(e) => patchCh(c.id, { platform: e.target.value as Platform })}>{PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
              <input className="k-input al-url" type="password" autoComplete="off" aria-label="Webhook 地址" value={c.url} placeholder={platformOf(c.platform).hint} onChange={(e) => patchCh(c.id, { url: e.target.value })} />
              {c.platform !== 'wecom' && <input className="k-input al-sec" type="password" autoComplete="off" aria-label="加签密钥" value={c.secret} placeholder="加签密钥（可选）" onChange={(e) => patchCh(c.id, { secret: e.target.value })} />}
              {c.platform !== 'wecom' && <input className="k-input al-kw" aria-label="关键词" value={c.keyword} placeholder="关键词" onChange={(e) => patchCh(c.id, { keyword: e.target.value })} />}
              <button className="k-btn" disabled={busy} onClick={() => void test(c)}><Zap size={15} />测试</button>
              <button className="k-btn ghost" aria-label="删除渠道" onClick={() => save({ ...cfg, channels: cfg.channels.filter((x) => x.id !== c.id) })}><Trash2 size={15} /></button>
              {bad && <span className="al-bad">{bad}</span>}
            </div>
          );
        })}
      </section>

      <section className="k-panel al-card">
        <div className="al-hd"><b>4. 检查并推送</b>
          <span className="al-stat">告警 <b className="k-num">{alerts.length}</b></span>
          {urgent > 0 && <span className="al-stat warn">紧急 {urgent}</span>}
          <span className="al-grow" />
          <label className="al-check"><input type="checkbox" checked={cfg.auto} onChange={(e) => save({ ...cfg, auto: e.target.checked })} />每<input className="k-input al-n" type="number" min={MIN_MINUTES} aria-label="间隔分钟" value={cfg.minutes} onChange={(e) => save({ ...cfg, minutes: Math.max(MIN_MINUTES, Number(e.target.value) || MIN_MINUTES) })} />分钟自动检查并推送（窗口开着才有效）</label>
        </div>
        {lastAuto && <span className="k-help">{lastAuto}</span>}
        <div className="al-hd">
          <button className="k-btn" disabled={busy || (!cfg.inventory && !cfg.orders)} onClick={() => void doCheck().catch(fail)}>{busy ? <Loader2 size={15} className="k-spin" /> : <BellRing size={15} />}只检查，不发送</button>
          {!confirm && <button className="k-btn primary" disabled={busy || !ready || !alerts.length} onClick={() => setConfirm(true)}><Send size={15} />推送告警</button>}
          {confirm && (
            <span className="al-confirm">
              将向 {cfg.channels.filter((c) => c.on).length} 个启用的群发送告警（冷却期内已推过的不重复）。
              <button className="k-btn" onClick={() => setConfirm(false)}>取消</button>
              <button className="k-btn primary" onClick={() => void pushNow(false)}>确认发送</button>
              <button className="k-btn" title="忽略冷却，全部重发" onClick={() => void pushNow(true)}>全部重发</button>
            </span>
          )}
        </div>
        {alerts.length > 0 && (
          <div className="k-scroll al-tablebox">
            <table className="k-table">
              <thead><tr><th>级别</th><th>类型</th><th>内容</th><th>冷却</th></tr></thead>
              <tbody>
                {alerts.slice(0, 200).map((a) => {
                  const last = sent[a.key];
                  const held = last !== undefined && cfg.cooldownHours > 0 && Date.now() - last < cfg.cooldownHours * 3600000;
                  return (
                    <tr key={a.key}>
                      <td><span className={`al-lv ${a.level}`}>{a.level === 'urgent' ? '紧急' : '注意'}</span></td>
                      <td>{kindName(a.kind)}</td>
                      <td>{a.text.replace(/^[^：]+：/, '')}</td>
                      <td className="k-muted">{held ? '冷却中' : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {check && alerts.length === 0 && <p className="k-muted">当前没有告警。</p>}
        {!check && <p className="k-muted">选好表格后会自动检查；也可以点「只检查，不发送」先看看会推什么。</p>}
      </section>

      {history.length > 0 && (
        <section className="k-panel al-card">
          <div className="al-hd"><b>推送记录</b><span className="k-help">只记结果，不记 Webhook 地址</span></div>
          <div className="k-scroll al-tablebox">
            <table className="k-table">
              <thead><tr><th>时间</th><th>触发</th><th>渠道</th><th>告警</th><th>结果</th></tr></thead>
              <tbody>
                {history.slice(0, 50).map((h, i) => (
                  <tr key={i}>
                    <td className="k-num">{fmt(h.at)}</td><td>{h.trigger}</td>
                    <td>{h.channel} <span className="k-muted">· {platformOf(h.platform).label}</span></td>
                    <td className="k-num">{h.alerts || '—'}</td>
                    <td><span className={h.ok ? 'al-ok' : 'al-err'}>{h.ok ? '成功' : '失败'}：{h.msg}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
