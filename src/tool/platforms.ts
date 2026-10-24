// 三个平台的群机器人：地址校验、签名、请求体、返回解析。格式以各平台官方文档为准（见 README「核实来源」）。
// 签名用 Web Crypto（crypto.subtle），桌面应用和测试环境里都有。

export type Platform = 'wecom' | 'dingtalk' | 'feishu';

export interface Channel {
  id: string;
  name: string;
  platform: Platform;
  /** 机器人地址（含 key / access_token，属于敏感信息，只存本机） */
  url: string;
  /** 钉钉「加签」或飞书「签名校验」的密钥，不用就留空 */
  secret: string;
  /** 钉钉「自定义关键词」：每条消息开头都带上 */
  keyword: string;
  on: boolean;
}

export const PLATFORMS: { id: Platform; label: string; hint: string; maxBytes: number }[] = [
  // 企业微信：text 的 content 最长 2048 字节（官方文档「消息推送配置说明」）
  { id: 'wecom', label: '企业微信', hint: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…', maxBytes: 2048 },
  // 钉钉：长度上限未核实，这里按 2048 字节保守分条
  { id: 'dingtalk', label: '钉钉', hint: 'https://oapi.dingtalk.com/robot/send?access_token=…', maxBytes: 2048 },
  // 飞书：请求体不超过 20 KB（官方文档），这里按 4000 字节分条，便于阅读
  { id: 'feishu', label: '飞书', hint: 'https://open.feishu.cn/open-apis/bot/v2/hook/…', maxBytes: 4000 },
];
export const platformOf = (p: Platform) => PLATFORMS.find((x) => x.id === p)!;

/** 地址检查：返回问题说明，没问题返回 null */
export function checkUrl(p: Platform, url: string): string | null {
  const u = url.trim();
  if (!u) return '还没有填机器人地址';
  let parsed: URL;
  try { parsed = new URL(u); } catch { return '地址格式不对，请从机器人设置里完整复制'; }
  if (parsed.protocol !== 'https:') return '地址应以 https:// 开头';
  // check-zh: 忽略（提示里的示例地址格式，用户要照着填）
  if (p === 'wecom' && !(parsed.host === 'qyapi.weixin.qq.com' && parsed.pathname === '/cgi-bin/webhook/send' && parsed.searchParams.get('key'))) return '这不像企业微信群机器人地址，应形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…';
  // check-zh: 忽略（提示里的示例地址格式，用户要照着填）
  if (p === 'dingtalk' && !(/^oapi\.dingtalk\.(com|io)$/.test(parsed.host) && parsed.pathname === '/robot/send' && parsed.searchParams.get('access_token'))) return '这不像钉钉自定义机器人地址，应形如 https://oapi.dingtalk.com/robot/send?access_token=…';
  // check-zh: 忽略（提示里的示例地址格式，用户要照着填）
  if (p === 'feishu' && !(/^open\.(feishu\.cn|larksuite\.com)$/.test(parsed.host) && parsed.pathname.startsWith('/open-apis/bot/v2/hook/'))) return '这不像飞书自定义机器人地址，应形如 https://open.feishu.cn/open-apis/bot/v2/hook/…';
  return null;
}

const enc = new TextEncoder();
async function hmacBase64(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 钉钉加签：以密钥为 key，对「毫秒时间戳 + \n + 密钥」做 HmacSHA256，Base64 后再 urlEncode */
export async function dingtalkSign(secret: string, timestampMs: number): Promise<string> {
  return encodeURIComponent(await hmacBase64(secret, `${timestampMs}\n${secret}`));
}

/** 飞书签名：以「秒级时间戳 + \n + 密钥」为 key，对空字符串做 HmacSHA256，再 Base64 */
export async function feishuSign(secret: string, timestampSec: number): Promise<string> {
  return hmacBase64(`${timestampSec}\n${secret}`, '');
}

/** 拼一条纯文本消息的请求 */
export async function buildRequest(ch: Channel, content: string, nowMs: number): Promise<{ url: string; body: string }> {
  const url = ch.url.trim();
  const secret = ch.secret.trim();
  if (ch.platform === 'wecom') return { url, body: JSON.stringify({ msgtype: 'text', text: { content } }) };
  if (ch.platform === 'dingtalk') {
    const signed = secret ? `${url}${url.includes('?') ? '&' : '?'}timestamp=${nowMs}&sign=${await dingtalkSign(secret, nowMs)}` : url;
    return { url: signed, body: JSON.stringify({ msgtype: 'text', text: { content } }) };
  }
  const ts = Math.floor(nowMs / 1000);
  const sign = secret ? { timestamp: String(ts), sign: await feishuSign(secret, ts) } : {};
  return { url, body: JSON.stringify({ ...sign, msg_type: 'text', content: { text: content } }) };
}

export interface SendResult {
  ok: boolean;
  /** 平台返回的错误码（企微、钉钉是 errcode，飞书是 code），网络错误时为 HTTP 状态或空 */
  code: string;
  /** 平台原始说明 + 常见错误的中文解释 */
  msg: string;
}

// 只收录核实过的错误码：飞书 19021 / 19024 / 11232 见官方「自定义机器人使用指南」。
// 企业微信、钉钉的错误码说明未核实（企微文档页没列错误码，钉钉文档页正文在本次核实时取不到），一律原样显示平台返回的说明。
const HINTS: Record<Platform, Record<string, string>> = {
  wecom: {},
  dingtalk: {},
  feishu: {
    '19021': '签名不对，或时间戳与当前时间相差超过 1 小时',
    '19024': '消息里没有设置的关键词',
    '11232': '触发了频率限制，官方建议避开整点和半点发送',
  },
};

/** 解析平台返回 */
export function parseReply(p: Platform, status: number, body: string): SendResult {
  let data: Record<string, unknown> | null = null;
  try { data = JSON.parse(body); } catch { /* 不是 JSON */ }
  if (!data) return { ok: false, code: String(status), msg: `HTTP ${status}${body ? '：' + body.slice(0, 120) : ''}` };
  const raw = p === 'feishu' ? (data.code ?? data.StatusCode) : data.errcode;
  const code = raw === undefined || raw === null ? '' : String(raw);
  const origin = String((p === 'feishu' ? data.msg ?? data.StatusMessage : data.errmsg) ?? '');
  if (code === '0' && status < 400) return { ok: true, code, msg: origin || 'ok' };
  const hint = HINTS[p][code];
  return { ok: false, code: code || String(status), msg: `${origin}${hint ? `（${hint}）` : ''}` || `HTTP ${status}` };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text(): Promise<string> }>;

/** 发一组消息到一个渠道，遇到失败就停（避免一错到底刷屏） */
export async function sendAll(ch: Channel, messages: string[], fetchFn: FetchLike, now: () => number = Date.now): Promise<{ sent: number; result: SendResult }> {
  let sent = 0;
  let result: SendResult = { ok: true, code: '0', msg: 'ok' };
  for (const m of messages) {
    const req = await buildRequest(ch, m, now());
    try {
      const res = await fetchFn(req.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: req.body });
      result = parseReply(ch.platform, res.status, await res.text());
    } catch (e) {
      result = { ok: false, code: '', msg: `网络请求失败：${e instanceof Error ? e.message : String(e)}` };
    }
    if (!result.ok) break;
    sent++;
  }
  return { sent, result };
}
