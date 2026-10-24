// 订单 / 库存告警推到微信：选库存表 / 订单表 → 设规则 → 配群机器人 → 检查并推送（可定时）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, BellRing, Boxes, Check, ClipboardList, FileSpreadsheet, History, Loader2, Plus, RefreshCw, Send, Trash2, X, Zap } from 'lucide-react';
import type { RunContext } from '../kit/types';
import { httpFetch, pickFiles, settingsStore } from '../kit/platform';
import {
  DEFAULT_RULES, INV_FIELDS, KIND_TITLE, applyCooldown, buildMessages, type RuleKind, ORDER_FIELDS, RULE_KINDS, describeRule, missingFields, type InvMap, type OrderMap, type Rule, type Table,
} from './core';
import { MAX_MESSAGES, MIN_MINUTES, addHistory, loadSource, pushAlerts, runCheck, testPush, type CheckResult, type Config, type HistoryEntry, type Source } from './engine';
import { PLATFORMS, checkUrl, platformOf, type Channel, type FetchLike, type Platform } from './platforms';
import './tool.css';

type Ctx = Pick<RunContext, 'readFile'>;
type Tab = 'source' | 'bots' | 'check' | 'log';
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
  const [tab, setTab] = useState<Tab>('check');
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
  const addCh = () => save({ ...cfg, channels: [...cfg.channels, { id: uid(), name: `群机器人${cfg.channels.length + 1}`, platform: 'wecom', url: '', secret: '', keyword: '', on: true }] });

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
      <div className={`al-src${src ? ' on' : ''}`}>
        <div className="al-src-hd">
          <span className="al-src-ic">{kind === 'inventory' ? <Boxes size={18} /> : <ClipboardList size={18} />}</span>
          <div className="al-src-tt"><b>{kind === 'inventory' ? '库存表' : '订单表'}</b>{src ? <span className="k-ellipsis k-muted" title={src.name}>{src.name}</span> : <span className="k-muted">.xlsx 或 .csv，可不选（只做另一种告警）</span>}</div>
          <button className="k-btn" disabled={busy} onClick={() => void choose(kind)}><FileSpreadsheet size={15} />{src ? '换一个文件' : '选择文件'}</button>
        </div>
        {src && (
          <div className="al-map">
            {fields.map(([k, label]) => (
              <label key={k} className="al-lbl"><span>{label}</span>
                <select className="k-input" aria-label={label} value={(src.map as Record<string, number | undefined>)[k] ?? ''} onChange={(e) => setMap(kind, k, e.target.value)}>
                  <option value="">未对应</option>
                  {header(kind).map((h, i) => <option key={i} value={i}>{h || `第 ${i + 1} 列`}</option>)}
                </select>
              </label>
            ))}
          </div>
        )}
        {src && miss(src).length > 0 && <span className="al-bad">还差：{miss(src).join('、')}</span>}
      </div>
    );
  };

  // 群里会收到什么：按第一个启用的渠道的格式，拼出这一次要推的消息
  const firstCh = cfg.channels.find((c) => c.on);
  const { fresh, held } = useMemo(() => applyCooldown(alerts, sent, cfg.cooldownHours, Date.now()), [alerts, sent, cfg.cooldownHours]);
  const msgs = useMemo(
    () => buildMessages(fresh, { keyword: firstCh?.keyword, maxBytes: platformOf(firstCh?.platform ?? 'wecom').maxBytes, maxMessages: MAX_MESSAGES, now: new Date() }),
    [fresh, firstCh?.keyword, firstCh?.platform],
  );
  const warnN = alerts.length - urgent;
  const srcDone = !!(cfg.inventory || cfg.orders) && !miss(cfg.inventory).length && !miss(cfg.orders).length;
  const botDone = cfg.channels.some((c) => c.on);
  useEffect(() => { if (loaded && !preview) setTab(!srcDone ? 'source' : !botDone ? 'bots' : 'check'); }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const tabs: [Tab, string, typeof Boxes, boolean | null][] = [
    ['source', '数据与规则', Boxes, srcDone],
    ['bots', '群机器人', Bot, botDone],
    ['check', '检查与推送', BellRing, null],
    ['log', '推送记录', History, null],
  ];
  const bubble = (t: string) => t.split('\n').map((ln, i) => {
    const m = ln.match(/^(\d+\. )(🔴|🟠)(.*)$/);
    return <div key={i} className="al-ln">{m ? <><span>{m[1]}</span><i className={`al-dot ${m[2] === '🔴' ? 'urgent' : 'warn'}`} aria-label={m[2] === '🔴' ? '紧急' : '注意'} /><span>{m[3]}</span></> : ln || ' '}</div>;
  });

  return (
    <div className="al-root">
      <nav className="al-steps" role="tablist" aria-label="步骤">
        {tabs.map(([k, label, I, done], i) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`al-step${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>
            <span className={`al-no${done ? ' done' : ''}`}>{done ? <Check size={13} /> : i + 1}</span>
            <I size={15} aria-hidden />{label}
            {k === 'check' && alerts.length > 0 && <span className={`al-badge${urgent ? ' urgent' : ''}`}>{alerts.length}</span>}
          </button>
        ))}
      </nav>
      {notice && <div className={`k-notice ${notice.kind}`} role="status">{notice.text}</div>}
      {check?.errors.map((e, i) => <div key={i} className="k-notice err" role="status">{e}</div>)}

      {tab === 'source' && (
        <div className="al-pane">
          <section className="al-sec-box">
            <div className="al-hd"><h2>数据来源</h2><span className="k-help">表格只在本机读取；每次检查都会重新读文件，改了表直接重新检查即可</span></div>
            <div className="al-srcs">{mapRow('inventory')}{mapRow('orders')}</div>
          </section>
          <section className="al-sec-box">
            <div className="al-hd"><h2>告警规则</h2><span className="al-grow" />
              <label className="al-check">同一条告警<input className="k-input al-n" type="number" min={0} aria-label="冷却小时" value={cfg.cooldownHours} onChange={(e) => save({ ...cfg, cooldownHours: Math.max(0, Number(e.target.value) || 0) })} />小时内不重复推（0 = 不去重）</label>
            </div>
            <div className="al-rules">
              {cfg.rules.map((r) => (
                <div key={r.id} className={`al-rule${r.on ? ' on' : ''}`}>
                  <label className="al-check al-rule-tt"><input type="checkbox" checked={r.on} aria-label="启用规则" onChange={(e) => patchRule(r.id, { on: e.target.checked })} />{kindName(r.kind)}</label>
                  <div className="al-rule-ctl">
                    {r.kind !== 'zeroStock' && <input className="k-input al-n" type="number" min={0} aria-label="数值" value={r.n} onChange={(e) => patchRule(r.id, { n: Number(e.target.value) || 0 })} />}
                    {(r.kind === 'unshipped' || r.kind === 'statusCount') && <input className="k-input al-st" aria-label="状态" value={r.statuses ?? ''} placeholder="状态，逗号隔开" onChange={(e) => patchRule(r.id, { statuses: e.target.value })} />}
                    {r.kind === 'lowStock' && <label className="al-check"><input type="checkbox" checked={!!r.useSafe} onChange={(e) => patchRule(r.id, { useSafe: e.target.checked })} />优先用表里的安全库存</label>}
                  </div>
                  <span className="al-rule-desc">{r.on ? describeRule(r) : '已关闭'}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === 'bots' && (
        <div className="al-pane">
          <section className="al-sec-box">
            <div className="al-hd"><h2>群机器人</h2><span className="k-help">机器人地址和密钥只保存在本机，界面里以密码形式显示</span><span className="al-grow" />
              <button className="k-btn" onClick={addCh}><Plus size={15} />添加渠道</button></div>
            {cfg.channels.length === 0 && <p className="al-none">还没有渠道。在企业微信 / 钉钉 / 飞书群里添加自定义机器人，把它的机器人地址粘贴到这里。</p>}
            <div className="al-chs">
              {cfg.channels.map((c) => {
                const bad = c.url ? checkUrl(c.platform, c.url) : null;
                return (
                  <div key={c.id} className={`al-ch ${c.platform}${c.on ? ' on' : ''}`}>
                    <div className="al-ch-hd">
                      <label className="al-check"><input type="checkbox" checked={c.on} aria-label="启用渠道" onChange={(e) => patchCh(c.id, { on: e.target.checked })} /></label>
                      <input className="k-input al-chname" aria-label="渠道名" value={c.name} onChange={(e) => patchCh(c.id, { name: e.target.value })} />
                      <select className="k-input al-plat" aria-label="平台" value={c.platform} onChange={(e) => patchCh(c.id, { platform: e.target.value as Platform })}>{PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
                      <button className="k-btn" disabled={busy} onClick={() => void test(c)}><Zap size={15} />测试</button>
                      <button className="k-btn ghost" aria-label="删除渠道" title="删除渠道" onClick={() => save({ ...cfg, channels: cfg.channels.filter((x) => x.id !== c.id) })}><Trash2 size={15} /></button>
                    </div>
                    <div className="al-ch-bd">
                      <input className="k-input al-url" type="password" autoComplete="off" aria-label="机器人地址" value={c.url} placeholder={platformOf(c.platform).hint} onChange={(e) => patchCh(c.id, { url: e.target.value })} />
                      {c.platform !== 'wecom' && <input className="k-input al-sec" type="password" autoComplete="off" aria-label="加签密钥" value={c.secret} placeholder="加签密钥（可选）" onChange={(e) => patchCh(c.id, { secret: e.target.value })} />}
                      {c.platform !== 'wecom' && <input className="k-input al-kw" aria-label="关键词" value={c.keyword} placeholder="关键词" onChange={(e) => patchCh(c.id, { keyword: e.target.value })} />}
                    </div>
                    {bad && <span className="al-bad">{bad}</span>}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {tab === 'check' && (
        <div className="al-pane">
          <div className="al-tiles">
            <div className="al-tile"><small>告警总数</small><b className="k-num">{alerts.length}</b><span>{check ? '刚刚检查的结果' : '还没检查'}</span></div>
            <div className="al-tile urgent"><small>紧急</small><b className="k-num">{urgent}</b><span>已售罄、超时未发货</span></div>
            <div className="al-tile warn"><small>注意</small><b className="k-num">{warnN}</b><span>库存不足、订单偏多</span></div>
            <div className="al-tile"><small>冷却中</small><b className="k-num">{held.length}</b><span>{cfg.cooldownHours} 小时内推过，不重复</span></div>
          </div>

          <div className="al-main">
            <section className="al-feed">
              <div className="al-hd"><h2>异常清单</h2><span className="al-grow" />
                <button className="k-btn" disabled={busy || (!cfg.inventory && !cfg.orders)} onClick={() => void doCheck().catch(fail)}>{busy ? <Loader2 size={15} className="k-spin" /> : <RefreshCw size={15} />}只检查，不发送</button>
              </div>
              {!check && <p className="al-none">{cfg.inventory || cfg.orders ? '点「只检查，不发送」先看看会推什么。' : '还没有数据。先到「数据与规则」选好库存表或订单表。'}</p>}
              {check && alerts.length === 0 && <p className="al-none ok"><Check size={16} />当前没有告警，一切正常。</p>}
              {(Object.keys(KIND_TITLE) as RuleKind[]).map((kind) => {
                const list = alerts.filter((a) => a.kind === kind);
                if (!list.length) return null;
                return (
                  <div key={kind} className="al-grp">
                    <h3>{KIND_TITLE[kind]}<span className="k-num">{list.length}</span></h3>
                    <ul>
                      {list.slice(0, 100).map((a) => {
                        const last = sent[a.key];
                        const isHeld = last !== undefined && cfg.cooldownHours > 0 && Date.now() - last < cfg.cooldownHours * 3600000;
                        return (
                          <li key={a.key} className={a.level}>
                            <span className={`al-lv ${a.level}`}>{a.level === 'urgent' ? '紧急' : '注意'}</span>
                            <span className="al-tx">{a.text.replace(/^[^：]+：/, '')}</span>
                            {isHeld && <span className="al-cool">冷却中</span>}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </section>

            <aside className="al-side">
              <div className="al-hd"><h2>群里会收到</h2></div>
              <div className="al-act">
                {!confirm && <button className="k-btn primary big" disabled={busy || !ready || !alerts.length} onClick={() => setConfirm(true)}><Send size={16} />推送告警</button>}
                {confirm && (
                  <div className="al-confirm">
                    <span>将向 {cfg.channels.filter((c) => c.on).length} 个启用的群发送告警（冷却期内已推过的不重复）。</span>
                    <div className="al-confirm-btns">
                      <button className="k-btn" onClick={() => setConfirm(false)}>取消</button>
                      <button className="k-btn primary" onClick={() => void pushNow(false)}>确认发送</button>
                      <button className="k-btn" title="忽略冷却，全部重发" onClick={() => void pushNow(true)}>全部重发</button>
                    </div>
                  </div>
                )}
                {!ready && <span className="k-help">需要先选好表格、对应好列，并启用一个群机器人</span>}
              </div>
              <div className="al-chat">
                {msgs.length ? (
                  <>
                    <span className="al-bot"><Bot size={14} />{firstCh ? `${firstCh.name} · ${platformOf(firstCh.platform).label}` : '还没有启用的群机器人'}</span>
                    <div className="al-bubble">{bubble(msgs[0])}</div>
                    <span className="al-chat-hint">{msgs.length > 1 ? `共 ${msgs.length} 条消息，这里只显示第一条` : '共 1 条消息'}</span>
                  </>
                ) : <span className="al-chat-hint">{alerts.length ? '这些告警都在冷却期内，不会重复发送' : '有告警时，这里会显示群里收到的消息'}</span>}
              </div>
              <label className="al-check al-auto"><input type="checkbox" checked={cfg.auto} onChange={(e) => save({ ...cfg, auto: e.target.checked })} />每<input className="k-input al-n" type="number" min={MIN_MINUTES} aria-label="间隔分钟" value={cfg.minutes} onChange={(e) => save({ ...cfg, minutes: Math.max(MIN_MINUTES, Number(e.target.value) || MIN_MINUTES) })} />分钟自动检查并推送（窗口开着才有效）</label>
              {lastAuto && <span className="k-help">{lastAuto}</span>}
            </aside>
          </div>
        </div>
      )}

      {tab === 'log' && (
        <div className="al-pane">
          <section className="al-sec-box">
            <div className="al-hd"><h2>推送记录</h2><span className="k-help">只记结果，不记机器人地址</span></div>
            {history.length === 0 ? <p className="al-none">还没有推送过。</p> : (
              <ol className="al-log">
                {history.slice(0, 50).map((h, i) => (
                  <li key={i} className={h.ok ? 'ok' : 'err'}>
                    <i className="al-pt" aria-hidden>{h.ok ? <Check size={12} /> : <X size={12} />}</i>
                    <div className="al-log-bd">
                      <div className="al-log-top"><b>{h.channel}</b><span className="k-muted">{platformOf(h.platform).label} · {h.trigger}</span><span className="al-grow" /><span className="k-num k-muted">{fmt(h.at)}</span></div>
                      <div className={h.ok ? 'al-ok' : 'al-err'}>{h.ok ? '成功' : '失败'}：{h.msg}{h.alerts ? <span className="k-muted">　告警 {h.alerts} 条</span> : null}</div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
