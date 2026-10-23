// 三个平台的请求体、签名、返回解析。返回内容是按官方文档格式录制的样例；不访问网络。
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildRequest, checkUrl, dingtalkSign, feishuSign, parseReply, sendAll, type Channel, type FetchLike } from './platforms';

const ch = (p: Partial<Channel>): Channel => ({ id: 'c', name: '测试', platform: 'wecom', url: '', secret: '', keyword: '', on: true, ...p });
const WECOM = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=EXAMPLE-KEY';
const DING = 'https://oapi.dingtalk.com/robot/send?access_token=EXAMPLE';
const FEISHU = 'https://open.feishu.cn/open-apis/bot/v2/hook/example-hook';

describe('地址检查', () => {
  it('正确地址通过，错平台 / 非 https / 空地址有中文说明', () => {
    expect(checkUrl('wecom', WECOM)).toBeNull();
    expect(checkUrl('dingtalk', DING)).toBeNull();
    expect(checkUrl('feishu', FEISHU)).toBeNull();
    expect(checkUrl('wecom', DING)).toContain('企业微信');
    expect(checkUrl('wecom', '')).toContain('还没有填');
    expect(checkUrl('feishu', 'http://open.feishu.cn/open-apis/bot/v2/hook/x')).toContain('https');
    expect(checkUrl('wecom', 'https://evil.example.com/cgi-bin/webhook/send?key=1')).not.toBeNull();
  });
});

describe('签名（与 node:crypto 独立算一遍对照）', () => {
  it('钉钉：HmacSHA256(密钥, 时间戳\\n密钥) → Base64 → urlEncode', async () => {
    const want = encodeURIComponent(createHmac('sha256', 'SECx').update('1700000000000\nSECx').digest('base64'));
    expect(await dingtalkSign('SECx', 1700000000000)).toBe(want);
  });
  it('飞书：key = 时间戳\\n密钥，对空串 HmacSHA256 → Base64', async () => {
    const want = createHmac('sha256', '1700000000\nsec').update('').digest('base64');
    expect(await feishuSign('sec', 1700000000)).toBe(want);
  });
});

describe('请求体', () => {
  it('企微：msgtype=text', async () => {
    const r = await buildRequest(ch({ url: WECOM }), '你好', 0);
    expect(JSON.parse(r.body)).toEqual({ msgtype: 'text', text: { content: '你好' } });
    expect(r.url).toBe(WECOM);
  });
  it('钉钉：有密钥时地址带 timestamp 和 sign，无密钥保持原样', async () => {
    const signed = await buildRequest(ch({ platform: 'dingtalk', url: DING, secret: 'SECx' }), 'a', 1700000000000);
    expect(signed.url).toContain('&timestamp=1700000000000&sign=');
    expect((await buildRequest(ch({ platform: 'dingtalk', url: DING }), 'a', 1)).url).toBe(DING);
  });
  it('飞书：msg_type=text；有密钥时 body 带 timestamp（秒）和 sign', async () => {
    const b = JSON.parse((await buildRequest(ch({ platform: 'feishu', url: FEISHU, secret: 'sec' }), 'a', 1700000000999)).body);
    expect(b).toMatchObject({ msg_type: 'text', content: { text: 'a' }, timestamp: '1700000000' });
    expect(b.sign).toBe(await feishuSign('sec', 1700000000));
    expect(JSON.parse((await buildRequest(ch({ platform: 'feishu', url: FEISHU }), 'a', 1)).body).sign).toBeUndefined();
  });
});

describe('解析返回', () => {
  it('成功', () => {
    expect(parseReply('wecom', 200, '{"errcode":0,"errmsg":"ok"}').ok).toBe(true);
    expect(parseReply('feishu', 200, '{"code":0,"msg":"success","data":{}}').ok).toBe(true);
  });
  it('飞书错误码 19021 / 19024 带中文说明', () => {
    const r = parseReply('feishu', 200, '{"code":19021,"msg":"sign match fail or timestamp is not within one hour from current time"}');
    expect(r).toMatchObject({ ok: false, code: '19021' });
    expect(r.msg).toContain('签名不对');
    expect(parseReply('feishu', 200, '{"code":19024,"msg":"Key Words Not Found"}').msg).toContain('关键词');
  });
  it('未核实的错误码原样显示平台说明；非 JSON 返回按 HTTP 状态报错', () => {
    const r = parseReply('wecom', 200, '{"errcode":93000,"errmsg":"invalid webhook url"}');
    expect(r).toMatchObject({ ok: false, code: '93000', msg: 'invalid webhook url' });
    expect(parseReply('dingtalk', 502, '<html>Bad Gateway</html>')).toMatchObject({ ok: false, code: '502' });
  });
});

describe('sendAll', () => {
  const fake = (replies: { status: number; body: string }[]) => {
    const calls: { url: string; body: string }[] = [];
    const f: FetchLike = async (url, init) => {
      calls.push({ url, body: init.body });
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      return { status: r.status, text: async () => r.body };
    };
    return { f, calls };
  };
  it('逐条发送，全部成功', async () => {
    const { f, calls } = fake([{ status: 200, body: '{"errcode":0,"errmsg":"ok"}' }]);
    const r = await sendAll(ch({ url: WECOM }), ['a', 'b'], f, () => 0);
    expect(r).toMatchObject({ sent: 2, result: { ok: true } });
    expect(calls).toHaveLength(2);
  });
  it('第二条失败就停，不再继续发', async () => {
    const { f, calls } = fake([{ status: 200, body: '{"errcode":0}' }, { status: 200, body: '{"errcode":45009,"errmsg":"api freq out of limit"}' }, { status: 200, body: '{"errcode":0}' }]);
    const r = await sendAll(ch({ url: WECOM }), ['a', 'b', 'c'], f, () => 0);
    expect(r.sent).toBe(1);
    expect(r.result.ok).toBe(false);
    expect(calls).toHaveLength(2);
  });
  it('网络异常变成中文错误，且错误信息里不含 Webhook 地址', async () => {
    const f: FetchLike = async () => { throw new Error('connect refused'); };
    const r = await sendAll(ch({ url: WECOM }), ['a'], f, () => 0);
    expect(r.result.msg).toContain('网络请求失败');
    expect(r.result.msg).not.toContain('EXAMPLE-KEY');
  });
});
