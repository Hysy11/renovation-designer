// AI 对话层的单元测试（方案第 14 节 M4 行）：
// 厂商回包解析与错误表、请求体格式、历史裁剪（工具成对、以用户消息开头、图片占位）、
// 对话流程（重试上限、试看结束本轮、结果回传）、提示词与设计快照。
// 网络请求一律用录制的回包模拟，不真实调用厂商、不消耗额度。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatCompletion, extractErrorText, mapHttpError, parseReply, testConnection, chatUrl, VENDORS } from '../src/ai/vendors';
import { buildWireHistory, MAX_ROUNDS } from '../src/ai/history';
import { designSnapshot } from '../src/ai/snapshot';
import { buildSystemPrompt, TOOL_PROPOSE, TOOL_VIEW, toolDefinitions } from '../src/ai/prompt';
import { ChatController, MAX_MODEL_CALLS, type ChatHost, type ProposeResult } from '../src/ai/agent';
import type { CallResult, ChatImage, ChatMessage, WireMsg } from '../src/ai/types';
import { design, door, furn, room, twoRooms, windowOf } from './fixtures';

const CFG = { vendor: 'deepseek' as const, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'sk-test', supportsImages: false };

// ---------- 厂商回包解析 ----------

const okBody = (message: Record<string, unknown>) => JSON.stringify({ id: 'x', choices: [{ index: 0, message, finish_reason: 'stop' }] });

describe('回包解析 parseReply', () => {
  it('文字 + 工具调用（DeepSeek/OpenAI 格式，arguments 是字符串）', () => {
    const r = parseReply(JSON.parse(okBody({
      content: '我来调整',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'propose_design_changes', arguments: '{"summary":"x","ops":[]}' } }],
    })));
    expect(r).toEqual({
      text: '我来调整',
      toolCalls: [{ id: 'c1', name: 'propose_design_changes', argsJson: '{"summary":"x","ops":[]}' }],
    });
  });

  it('GLM 风格：arguments 是对象、content 为 null', () => {
    const r = parseReply(JSON.parse(okBody({
      content: null,
      tool_calls: [{ id: 'c2', type: 'function', function: { name: 'view_action', arguments: { action: 'top_view' } } }],
    })));
    expect(r?.text).toBe('');
    expect(r?.toolCalls[0]?.argsJson).toBe('{"action":"top_view"}');
  });

  it('没有 choices 或没有内容时返回 null', () => {
    expect(parseReply({})).toBeNull();
    expect(parseReply({ choices: [{ message: { content: '' } }] })).toBeNull();
    expect(parseReply('not json')).toBeNull();
  });
});

describe('错误读取与错误表 mapHttpError', () => {
  it('按 error.message → message → 原文读取（兼容 GLM）', () => {
    expect(extractErrorText('{"error":{"message":"密钥不对"}}')).toBe('密钥不对');
    expect(extractErrorText('{"message":"模型不存在"}')).toBe('模型不存在');
    expect(extractErrorText('纯文本错误')).toBe('纯文本错误');
  });

  it.each([
    [401, '{"error":{"message":"bad key"}}', 'auth', '密钥无效或已过期，请检查'],
    [403, '{}', 'auth', '密钥无效或已过期，请检查'],
    [404, '{"error":{"code":"model_not_found","message":"Model Not Exist"}}', 'model', '模型名称不对'],
    [404, '', 'model', '模型名称不对'],
    [400, '{"error":{"message":"This model does not support tools/function calling"}}', 'tools', '该模型不支持工具调用'],
    [400, '{"error":{"message":"image input is not supported for multimodal vision"}}', 'image', '该模型不支持图片输入'],
    [429, '{"error":{"code":"insufficient_quota","message":"quota exceeded"}}', 'quota', '额度不足'],
    [429, '{"error":{"message":"rate limited"}}', 'quota', '请求太频繁'],
    [500, 'oops', 'server', '服务暂时不可用'],
    [418, 'tea', 'http', '请求失败（418）'],
  ])('%s → %s', (status, body, kind, messagePart) => {
    const e = mapHttpError(status as number, body as string);
    expect(e.kind).toBe(kind);
    expect(e.message).toContain(messagePart as string);
  });
});

describe('chatCompletion 请求与网络错误', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('成功：请求网址、请求头与请求体（不带 tool_choice）', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => new Response(okBody({ content: '你好' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await chatCompletion(CFG, [{ role: 'user', content: '你好' }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reply.text).toBe('你好');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('deepseek-flash');
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.3);
    expect(body.tool_choice).toBeUndefined();
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools[0].function.name).toBe(TOOL_PROPOSE);
  });

  it('baseUrl 末尾的斜杠不会产生双斜杠', async () => {
    const fetchMock = vi.fn(async () => new Response(okBody({ content: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await chatCompletion({ ...CFG, baseUrl: 'https://api.openai.com/v1/' }, [{ role: 'user', content: 'hi' }]);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('缺密钥：直接返回 missingKey，不访问网络', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await chatCompletion({ ...CFG, apiKey: '' }, [{ role: 'user', content: 'hi' }]);
    expect(r).toMatchObject({ ok: false, error: { kind: 'missingKey', message: '请先在设置中填写 API Key' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('错误状态码：按 10.5 表映射（401）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Authentication Fails"}}', { status: 401 })));
    const r = await chatCompletion(CFG, [{ role: 'user', content: 'hi' }]);
    expect(r).toMatchObject({ ok: false, error: { kind: 'auth' } });
  });

  it('超时：到时自动取消', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
    })));
    const p = chatCompletion(CFG, [{ role: 'user', content: 'hi' }], { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(80);
    await expect(p).resolves.toMatchObject({ ok: false, error: { kind: 'timeout', message: '等待超时，可重试' } });
  });

  it('用户停止：报“已停止”', async () => {
    const stop = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
    })));
    const p = chatCompletion(CFG, [{ role: 'user', content: 'hi' }], { signal: stop.signal });
    stop.abort();
    await expect(p).resolves.toMatchObject({ ok: false, error: { kind: 'aborted', message: '已停止' } });
  });

  it('网络失败：无状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const r = await chatCompletion(CFG, [{ role: 'user', content: 'hi' }]);
    expect(r).toMatchObject({ ok: false, error: { kind: 'network', message: '网络不通或被拦截，请检查网络' } });
  });

  it('测试连接：成功与 401（词元上限 512，思考型模型先耗思考词元）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.max_tokens).toBe(512);
      expect(body.tools[0].function.name).toBe('connection_test_noop');
      return new Response(okBody({ content: 'ok' }), { status: 200 });
    }));
    expect(await testConnection(CFG)).toMatchObject({ ok: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    expect(await testConnection(CFG)).toMatchObject({ ok: false, message: '密钥无效或已过期，请检查' });
  });

  it('四家厂商都有默认地址与模型名设置（自定义除外）', () => {
    expect(VENDORS.deepseek.baseUrl).toBe('https://api.deepseek.com');
    expect(VENDORS.qwen.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(VENDORS.glm.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(VENDORS.openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(VENDORS.qwen.model).toBe(''); // 留空，提示用户到控制台查
  });
});

// ---------- 历史裁剪 ----------

const img = (n: number): ChatImage => ({ name: `p${n}.png`, dataUrl: `data:image/jpeg;base64,AAAA${n}` });
const uid = (text: string, images: ChatImage[] = []): ChatMessage => ({ id: `u_${text}`, role: 'user', text, images });
const aid = (text: string, toolCalls: { id: string; name: string; argsJson: string }[] = []): ChatMessage =>
  ({ id: `a_${text}`, role: 'assistant', text, toolCalls });
const tid = (callId: string, content: string): ChatMessage =>
  ({ id: `t_${callId}`, role: 'tool', toolCallId: callId, name: TOOL_PROPOSE, content });

describe('历史裁剪 buildWireHistory', () => {
  it('工具调用与工具结果成对保留，且以用户消息开头', () => {
    const msgs: ChatMessage[] = [
      uid('第一轮'),
      aid('我来改', [{ id: 'c1', name: TOOL_PROPOSE, argsJson: '{"summary":"","ops":[]}' }]),
      tid('c1', '修改未通过检查：房间超范围'),
      aid('解释原因'),
      uid('第二轮'),
      aid('好的'),
    ];
    const wire = buildWireHistory(msgs);
    expect(wire[0]?.role).toBe('user');
    const roles = wire.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant', 'user', 'assistant']);
    const tc = wire[1] as Extract<WireMsg, { role: 'assistant' }>;
    expect(tc.tool_calls?.[0]?.id).toBe('c1');
    expect((wire[2] as Extract<WireMsg, { role: 'tool' }>).tool_call_id).toBe('c1');
  });

  it(`只保留最近 ${MAX_ROUNDS} 轮`, () => {
    const msgs: ChatMessage[] = [];
    for (let i = 1; i <= 12; i++) { msgs.push(uid(`第${i}轮`)); msgs.push(aid(`答${i}`)); }
    const wire = buildWireHistory(msgs);
    expect(wire.filter((m) => m.role === 'user')).toHaveLength(10);
    expect((wire[0] as { content: unknown }).content).toContain('第3轮');
  });

  it('超出总字数时从最早一轮整轮删除（至少留一轮）', () => {
    const big = '长'.repeat(9000);
    const msgs = [uid(big), aid('答'), uid(big), aid('答'), uid(big), aid('答'), uid('最近'), aid('答')];
    const wire = buildWireHistory(msgs);
    const users = wire.filter((m) => m.role === 'user') as { content: unknown }[];
    // 四轮约 2.7 万字 > 2.4 万：删掉最早一轮后约 1.8 万，满足预算
    expect(users).toHaveLength(3);
    expect(users.at(-1)?.content).toBe('最近');
    expect(String(users[0]?.content).length).toBe(9000); // 剩下的大轮保留完整文本
  });

  it('图片只保留最近 6 张，更早的替换为占位', () => {
    const msgs: ChatMessage[] = [];
    for (let i = 1; i <= 4; i++) { msgs.push(uid(`第${i}轮`, [img(i * 2 - 1), img(i * 2)])); msgs.push(aid(`答${i}`)); }
    const wire = buildWireHistory(msgs);
    // 8 张图只留 6 张：第 1 轮的 2 张被省略，消息退回纯文本
    const first = wire[0] as { role: string; content: unknown };
    expect(first.role).toBe('user');
    expect(first.content).toBe('第1轮\n[图片已省略 2 张]');
    const lastUser = wire.at(-2) as { content: unknown }; // 最后一轮的用户消息
    const lastParts = lastUser.content as { type: string }[];
    expect(lastParts.filter((p) => p.type === 'image_url')).toHaveLength(2);
  });

  it('程序提示（status）不发给模型', () => {
    const msgs: ChatMessage[] = [uid('你好'), { id: 's1', role: 'status', text: '已应用：改动 1 处', level: 'info' as const }, aid('好的')];
    const wire = buildWireHistory(msgs);
    expect(wire).toHaveLength(2);
  });
});

// ---------- 设计快照与系统提示词 ----------

describe('设计快照 designSnapshot', () => {
  it('房间、净尺寸、墙段编号、门窗与家具（绝对坐标）', () => {
    const d = design({
      rooms: [room('r_a', 0, 0, 5000, 4000, '客厅'), room('r_b', 5000, 0, 3500, 4000, '卧室')],
      openings: [door('o_1', 'r_a', 'right', 500), windowOf('o_2', 'r_a', 'top', 1000)],
      furniture: [furn('f_1', 'r_a', 'sofa.3seat', 2500, 3200, 2200, 900)],
    });
    const s = designSnapshot(d, 'r_a');
    expect(s).toContain('客厅');
    expect(s).toContain('净');       // 室内净尺寸
    expect(s).toContain('shared:r_a|r_b'); // 共用墙编号
    expect(s).toContain('ext:r_a:top');
    expect(s).toContain('门');       // 门窗
    expect(s).toContain('sofa.3seat');
    expect(s).toContain('中心(2500,3200)');
    expect(s).toContain('（选中）');
  });
});

describe('系统提示词 buildSystemPrompt', () => {
  const base = { design: twoRooms() };

  it('包含坐标定义、指令说明、家具目录、风格预设与设计快照', () => {
    const p = buildSystemPrompt({ ...base, page: 'plan', mode: 'preview', selection: 'room:r_a' });
    expect(p).toContain('x 向右为正');
    expect(p).toContain('room.update');
    expect(p).toContain('sofa.3seat');
    expect(p).toContain('cozy-light-wood');
    expect(p).toContain('当前设计快照');
    expect(p).toContain('当前页面：平面图');
    expect(p).toContain('选中对象：room:r_a');
    expect(p).toContain('假装已经修改'); // AI-05 的角色规则
  });

  it('试看中的上下文：带上要保留的指令；上一份试看结果也带上', () => {
    const p = buildSystemPrompt({
      ...base, page: '3d', mode: 'edit',
      trial: { summary: '客厅加宽', opsJson: '[{"op":"room.update","id":"r_a","add":{"length":300}}]' },
      lastTrialOutcome: '已应用 1 项修改',
    });
    expect(p).toContain('当前正在试看一份修改方案「客厅加宽」');
    expect(p).toContain('整体替换');
    expect(p).toContain('上一份试看的结果：已应用 1 项修改');
  });
});

// ---------- 对话流程 ----------

interface HostOverrides {
  replies?: CallResult[];                                  // 依次返回的模型回包
  propose?: (n: number, ops: unknown[], summary: string) => ProposeResult;
  supportsImages?: boolean;
  viewResult?: { ok: boolean; message: string };
}

function makeHost(ov: HostOverrides = {}) {
  const replies = ov.replies ?? [];
  const calls: { messages: WireMsg[]; tools: 'default' | unknown[] | null }[] = [];
  const proposed: { n: number; ops: unknown[]; summary: string }[] = [];
  const viewed: { action: string; target?: string }[] = [];
  let proposeCount = 0;
  const host: ChatHost = {
    config: () => ({ ...CFG, supportsImages: ov.supportsImages ?? false }),
    promptContext: () => ({ design: twoRooms(), selection: 'room:r_a', page: 'plan', mode: 'preview', trial: null }),
    callModel: async (_cfg, messages, opts) => {
      calls.push({ messages: [...messages], tools: opts.tools === undefined ? 'default' : opts.tools });
      const r = replies.shift();
      return r ?? { ok: true, reply: { text: '（默认回复）', toolCalls: [] } };
    },
    propose: (ops, summary) => {
      proposeCount++;
      proposed.push({ n: proposeCount, ops, summary });
      return ov.propose
        ? ov.propose(proposeCount, ops, summary)
        : { ok: true, message: '试看中', changes: ['房间「客厅」长：5000 → 5300'] };
    },
    view: (action, target) => {
      viewed.push({ action, target });
      return ov.viewResult ?? { ok: true, message: `已${action}` };
    },
  };
  return { host, calls, proposed, viewed };
}

const proposeCall = (summary: string, ops: unknown[], id = 'c1') => ({
  ok: true as const,
  reply: {
    text: `我来${summary}`,
    toolCalls: [{ id, name: TOOL_PROPOSE, argsJson: JSON.stringify({ summary, ops }) }],
  },
});
const viewCall = (action: string, target?: string, id = 'v1') => ({
  ok: true as const,
  reply: { text: '', toolCalls: [{ id, name: TOOL_VIEW, argsJson: JSON.stringify({ action, target }) }] },
});
const textReply = (text: string) => ({ ok: true as const, reply: { text, toolCalls: [] } });

describe('ChatController 对话流程', () => {
  it('纯文字回答：一次调用，消息为 用户→助手', async () => {
    const { host, calls } = makeHost({ replies: [textReply('客厅是 5.00 × 4.00 m（轴线）')] });
    const c = new ChatController(host);
    await c.send('客厅多大？');
    expect(calls).toHaveLength(1);
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    // 发出去的第一条是系统消息，其后是用户消息
    expect(calls[0]?.messages[0]?.role).toBe('system');
    expect(calls[0]?.messages[1]?.role).toBe('user');
    expect((calls[0]?.messages[0] as { content: string }).content).toContain('当前设计快照');
  });

  it('view_action：立即执行并回传结果，模型再回答', async () => {
    const { host, calls, viewed } = makeHost({ replies: [viewCall('focus_room', 'r_a'), textReply('已聚焦客厅')] });
    const c = new ChatController(host);
    await c.send('看看客厅');
    expect(viewed).toEqual([{ action: 'focus_room', target: 'r_a' }]);
    expect(calls).toHaveLength(2);
    const toolMsg = c.messages.find((m) => m.role === 'tool');
    expect(toolMsg && toolMsg.role === 'tool' && toolMsg.content).toContain('已执行');
    // 第二次调用的历史里带着 assistant.tool_calls 与 tool 结果
    const hist = calls[1]?.messages ?? [];
    expect(hist.some((m) => m.role === 'tool')).toBe(true);
  });

  it('propose 成功：生成试看、差异列表由程序显示、不再调用模型', async () => {
    const { host, calls, proposed } = makeHost({ replies: [proposeCall('加宽客厅', [{ op: 'room.update', id: 'r_a', add: { length: 300 } }])] });
    const c = new ChatController(host);
    await c.send('客厅加宽 30 厘米');
    expect(proposed).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const status = c.messages.filter((m) => m.role === 'status');
    expect(status.at(-1)?.text).toContain('已生成试看');
    expect(status.at(-1)?.text).toContain('房间「客厅」长：5000 → 5300');
    const toolMsg = c.messages.find((m) => m.role === 'tool');
    expect(toolMsg && toolMsg.role === 'tool' && toolMsg.content).toContain('已进入试看');
  });

  it('试看结果带入下一轮请求（方案 17 节第 1 条）', async () => {
    const { host, calls } = makeHost({ replies: [proposeCall('加宽客厅', [{ op: 'room.update', id: 'r_a', add: { length: 300 } }]), textReply('好的')] });
    const c = new ChatController(host);
    await c.send('客厅加宽 30 厘米');
    c.noteTrialOutcome('已应用 1 项修改，可以撤销');
    await c.send('谢谢');
    const sys = (calls[1]?.messages[0] as { content: string }).content;
    expect(sys).toContain('上一份试看的结果：已应用 1 项修改');
  });

  it('propose 失败自动重试，最多 2 次，仍失败则不带工具再问一次', async () => {
    const replies: CallResult[] = [
      proposeCall('改', [{ op: 'room.update', id: 'nope', add: { length: 1 } }], 'c1'),
      proposeCall('改', [{ op: 'room.update', id: 'nope', add: { length: 2 } }], 'c2'),
      proposeCall('改', [{ op: 'room.update', id: 'nope', add: { length: 3 } }], 'c3'),
      textReply('这些修改没法通过检查，因为房间不存在'),
    ];
    const { host, calls, proposed } = makeHost({
      replies,
      propose: (n) => ({ ok: false, message: '房间不存在', errors: [`房间 nope 不存在`, `建议：用设计快照里的房间编号`] }),
    });
    const c = new ChatController(host);
    await c.send('随便改改');
    expect(proposed).toHaveLength(3);
    expect(calls).toHaveLength(4);
    expect(calls[3]?.tools).toBeNull(); // 最后一次不带工具
    // 第三次失败的回传里带“不要再提交修改”
    const lastTool = c.messages.filter((m) => m.role === 'tool').at(-1);
    expect(lastTool?.content).toContain('请不要再提交修改');
    expect(c.messages.at(-1)?.role).toBe('assistant');
  });

  it('第二次重试成功：3 次调用后正常进入试看', async () => {
    const replies: CallResult[] = [
      proposeCall('改', [{}], 'c1'),
      proposeCall('改', [{}], 'c2'),
      proposeCall('改', [{ op: 'room.update', id: 'r_a', add: { length: 300 } }], 'c3'),
    ];
    const { host, calls } = makeHost({
      replies,
      propose: (n, ops) => n < 3
        ? { ok: false, message: '家具超出房间范围：地毯太大', errors: ['地毯超出客厅的室内净范围'] }
        : { ok: true, message: '试看中', changes: ['房间「客厅」长：5000 → 5300'] },
    });
    const c = new ChatController(host);
    await c.send('改');
    expect(calls).toHaveLength(3);
    expect(c.messages.some((m) => m.role === 'status' && m.text.includes('已生成试看'))).toBe(true);
  });

  it('一次回复里多份提议：只执行第一份', async () => {
    const reply: CallResult = {
      ok: true,
      reply: {
        text: '两处修改',
        toolCalls: [
          { id: 'c1', name: TOOL_PROPOSE, argsJson: '{"summary":"A","ops":[{"op":"room.update","id":"r_a","add":{"length":300}}]}' },
          { id: 'c2', name: TOOL_PROPOSE, argsJson: '{"summary":"B","ops":[{"op":"room.update","id":"r_a","add":{"length":600}}]}' },
        ],
      },
    };
    const { host, proposed } = makeHost({ replies: [reply] });
    const c = new ChatController(host);
    await c.send('改两处');
    expect(proposed).toHaveLength(1);
    const tools = c.messages.filter((m) => m.role === 'tool');
    expect(tools[1]?.content).toContain('一次只能提交一份修改');
  });

  it('不支持的图片：不发请求，直接提示', async () => {
    const { host, calls } = makeHost({ supportsImages: false });
    const c = new ChatController(host);
    await c.send('按这张图改', [img(1)]);
    expect(calls).toHaveLength(0);
    const last = c.messages.at(-1);
    expect(last?.role === 'status' && last.level === 'error' && last.text).toContain('该模型不支持图片输入');
  });

  it('API 错误：显示中文说明并结束本轮', async () => {
    const { host, calls } = makeHost({ replies: [{ ok: false, error: { kind: 'auth', message: '密钥无效或已过期，请检查' } }] });
    const c = new ChatController(host);
    await c.send('你好');
    expect(calls).toHaveLength(1);
    const last = c.messages.at(-1);
    expect(last?.role === 'status' && last.level === 'error' && last.text).toBe('密钥无效或已过期，请检查');
  });

  it('停止：等待中可停止，显示“已停止”', async () => {
    const { host } = makeHost({});
    const c = new ChatController(host);
    let started = () => {};
    const startedPromise = new Promise<void>((res) => { started = res; });
    let resolveCall!: (r: CallResult) => void;
    const pending = new Promise<CallResult>((res) => { resolveCall = res; });
    host.callModel = async (_cfg, _msgs, opts) => {
      started();
      opts.signal?.addEventListener('abort', () => resolveCall({ ok: false, error: { kind: 'aborted', message: '已停止' } }));
      return pending;
    };
    const sending = c.send('你好');
    await startedPromise;
    c.stop();
    await sending;
    expect(c.messages.at(-1)).toMatchObject({ role: 'status', text: '已停止' });
    expect(c.busy).toBe(false);
  });

  it('等待期间不能重复发送（AI-01）', async () => {
    const { host } = makeHost({});
    const c = new ChatController(host);
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    host.callModel = async () => { await gate; return textReply('好'); };
    const first = c.send('第一条');
    expect(c.busy).toBe(true);
    await c.send('第二条'); // busy 时直接忽略
    release();
    await first;
    expect(c.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('未知工具：回传提示', async () => {
    const reply: CallResult = { ok: true, reply: { text: '', toolCalls: [{ id: 'x1', name: 'delete_everything', argsJson: '{}' }] } };
    const { host } = makeHost({ replies: [reply, textReply('抱歉')] });
    const c = new ChatController(host);
    await c.send('删了');
    expect(c.messages.find((m) => m.role === 'tool')?.content).toContain('未知工具');
  });

  it(`调用次数不超过 ${MAX_MODEL_CALLS} 次`, async () => {
    const replies: CallResult[] = Array.from({ length: 8 }, (_, i) => viewCall('top_view', undefined, `v${i}`));
    const { host, calls } = makeHost({ replies });
    const c = new ChatController(host);
    await c.send('一直俯视');
    expect(calls).toHaveLength(MAX_MODEL_CALLS);
    expect(c.messages.at(-1)?.role).toBe('status');
  });

  it('参数解析失败也计入重试预算', async () => {
    const bad: CallResult = { ok: true, reply: { text: '', toolCalls: [{ id: 'b1', name: TOOL_PROPOSE, argsJson: '不是json' }] } };
    const replies: CallResult[] = [bad, bad, bad, textReply('抱歉，我重新说明')];
    const { host, calls, proposed } = makeHost({ replies });
    const c = new ChatController(host);
    await c.send('改');
    expect(proposed).toHaveLength(0);
    expect(calls).toHaveLength(4);
    expect(calls[3]?.tools).toBeNull();
  });
});
