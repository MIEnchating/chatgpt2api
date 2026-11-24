import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInputFilter, estimateTokens, visualWindow } from '../memory.mjs';
import { contextTokenBudget, DEFAULT_CONTEXT_WINDOW_TOKENS } from '../context-policy.mjs';
import { importProtocol, modelMessages, modelOutput } from '../history.mjs';

const filterArgs = input => ({ modelData: { input, instructions: 'Follow the business rules.' } });
test('prunes rereadable historical node text before summarizing and preserves the original tool result', async () => {
  const node = { id: 'script-1', taskId: 'paid-1', status: 'success', text: `开头${'😀镜头'.repeat(4200)}结尾` };
  const original = JSON.stringify({ ok: true, node });
  const call = { type: 'function_call', name: 'get_node', callId: 'read', arguments: '{"nodeId":"script-1"}' };
  const result = { type: 'function_call_result', name: 'get_node', callId: 'read', output: [{ type: 'text', text: original }, { type: 'image', image: '/old.png' }] };
  const source = [{ role: 'user', content: '读取旧剧本' }, call, result, { role: 'user', content: '继续写下一幕' }];
  const unusedModel = async () => assert.fail('pruning should avoid a summary request');
  const normal = await createInputFilter(unusedModel, 128000)(filterArgs(source));
  assert.deepEqual(normal.input, source);

  const filter = createInputFilter(unusedModel, 8500);
  const args = filterArgs(source);
  Object.assign(args.modelData, { origins: [0, 1, 2, 3], through: 4, trigger: 'pressure' });
  const pruned = await filter(args);
  assert.equal(pruned.compacted, true);
  const [record] = pruned.compactions;
  assert.deepEqual(record.sourceRanges, [[2, 3]]);
  assert.equal(record.through, 4);
  assert.equal(record.trigger, 'pressure');
  assert.equal(record.kind, 'pruned');
  assert.ok(record.savedTokens > 0);
  assert.deepEqual(pruned.origins, [0, 1, 2, 3]);
  const projected = JSON.parse(modelMessages(pruned.input).find(message => message.role === 'tool').content).node;
  assert.match(projected.text, /^开头.*省略.*结尾$/su);
  assert(projected.text.isWellFormed());
  assert(projected.text.length < node.text.length);
  assert.deepEqual({ ...projected, text: node.text }, node);
  assert.deepEqual(pruned.input[2].output[1], result.output[1]);
  assert.deepEqual(pruned.input[1], call);
  assert.deepEqual(pruned.input[3], source[3]);
  assert.equal(result.output[0].text, original);
  assert.deepEqual((await filter(filterArgs(pruned.input))).input, pruned.input);

  const forced = await createInputFilter(unusedModel, 128000)({ ...filterArgs(source), force: true });
  assert.equal(forced.compacted, true);
  assert(estimateTokens(forced.input) < estimateTokens(source));
});
test('prunes oversized plain and unknown tool results with a Unicode-safe head and tail', async () => {
  const originalText = `开头${'😀中间内容'.repeat(5000)}结尾`;
  const source = [
    { role: 'user', content: '读取旧工具结果' },
    { type: 'function_call', name: 'custom_lookup', callId: 'custom', arguments: '{}' },
    { type: 'function_call_result', name: 'custom_lookup', callId: 'custom', output: originalText },
    { role: 'user', content: '继续处理当前请求' },
  ];
  const filter = await createInputFilter(async () => assert.fail('generic pruning should avoid a summary request'), 10000)(filterArgs(source));
  const output = filter.input[2].output;
  assert.equal(typeof output, 'string');
  assert.match(output, /^开头/);
  assert.match(output, /结尾$/);
  assert.match(output, /tool result middle pruned/);
  assert.equal(output.isWellFormed(), true);
  assert(output.length < originalText.length);
  assert.equal(source[2].output, originalText);
});
test('prunes historical templates and documents while preserving references, errors and the active results', async () => {
  const content = '例'.repeat(12000);
  const workflow = { id: 'workflow-1', revision: 8, config: { prompt_template: content }, template_references: [{ id: 'reference-1' }] };
  const documents = [{ id: 2, title: '正文', content, cached: true }];
  const errors = [{ id: 3, error: '读取失败' }];
  const output = (name, id, data) => [
    { type: 'function_call', name, callId: id, arguments: '{}' },
    { type: 'function_call_result', name, callId: id, output: JSON.stringify({ ok: true, ...data }) },
  ];
  const active = output('read_documents', 'current-read', { documents: [{ id: 4, content }] });
  const input = [
    { role: 'user', content: '查询旧资料' },
    ...output('get_workflow', 'workflow', { workflow }),
    ...output('read_documents', 'docs', { documents, errors }),
    { role: 'user', content: '分析新文档' },
    ...active,
  ];
  const result = await createInputFilter(async () => assert.fail('pruning should avoid summarizing'), 30000)(filterArgs(input));
  const template = JSON.parse(result.input[2].output).workflow;
  assert.match(template.config.prompt_template, /get_workflow/);
  assert.deepEqual({ ...template, config: workflow.config }, workflow);
  const pages = JSON.parse(result.input[4].output);
  assert.match(pages.documents[0].content, /read_documents/);
  assert.deepEqual({ ...pages.documents[0], content }, documents[0]);
  assert.deepEqual(pages.errors, errors);
  assert.deepEqual(result.input.slice(-2), active);
});
test('video analysis keeps its complete latest frame batch alongside ordinary references', async () => {
  const frames = Array.from({ length: 90 }, (_, i) => [{ type: 'text', text: `frame ${i}` }, { type: 'image', image: `/frame-${i}.jpg` }]).flat();
  const video = { type: 'function_call_result', callId: 'analyze', name: 'analyze_video', output: frames };
  const input = [{ role: 'user', content: 'Read the whole clip.' }, { type: 'function_call', callId: 'analyze', name: 'analyze_video', arguments: '{}' }, video];
  const filtered = await createInputFilter(async () => assert.fail('no summary needed'), 457000)(filterArgs(input));
  assert.equal(filtered.input.at(-1).output.filter(part => part.type === 'image').length, 90);
  const projected = visualWindow([video, { ...video, callId: 'newer', output: frames.slice(0, 20) }]);
  assert.equal(projected[0].output.filter(part => part.type === 'image').length, 0);
  assert.deepEqual(projected[0].output.filter(part => part.text?.includes('省略')), [
    { type: 'text', text: '［90 张视频抽帧已从模型上下文省略。需要核对画面时，可用 analyze_video 重新读取对应时段。］' },
  ]);
  assert.equal(projected[1].output.filter(part => part.type === 'image').length, 10);
  assert.deepEqual(projected[1].output, frames.slice(0, 20));
  const nextRequest = visualWindow([video, { role: 'user', content: 'A new task.' }]);
  assert.equal(nextRequest[0].output.filter(part => part.type === 'image').length, 0);
});
test('compaction preserves unobserved video frames and their paired call', async () => {
  const input = [{ role: 'user', content: 'Old task '.repeat(10000) }, { role: 'assistant', content: 'Done' }, { role: 'user', content: 'Analyze this clip.' }, { type: 'function_call', callId: 'video', name: 'analyze_video', arguments: '{}' }, { type: 'function_call_result', callId: 'video', name: 'analyze_video', output: [{ type: 'text', text: 'frame at 1000ms' }, { type: 'image', image: '/unobserved.jpg' }] }];
  const result = await createInputFilter(async (method, params) => {
    if (method === 'memory') return {};
    assert.doesNotMatch(JSON.stringify(params.messages), /unobserved.jpg|Analyze this clip/);
    return { text_response: 'Old task finished.' };
  }, 10000)(filterArgs(input));
  assert.deepEqual(result.input.slice(-3), input.slice(-3));
});
test('forced compaction reduces misestimated histories and subdivides rejected summary chunks', async () => {
  const parts = [];
  const input = [{ role: 'user', content: '😀'.repeat(7000) }, { role: 'assistant', content: 'Done' }, { role: 'user', content: 'Continue.' }];
  const result = await createInputFilter(async (method, params) => {
    if (method === 'memory') return {};
    const content = params.messages.at(-1).content;
    if (content.length > 9000) throw new Error('context_length_exceeded');
    parts.push(content);
    return { text_response: 'History saved.' };
  }, 457000)({ ...filterArgs(input), force: true });
  assert.equal(result.compacted, true);
  assert(parts.length > 1);
  assert(parts.every(part => part.isWellFormed()));
  assert.deepEqual(result.input.at(-1), input.at(-1));
});
test('context filter preserves current input, reference labels and omits old pixels and opaque reasoning from summaries', async () => {
  const current = { role: 'user', content: [{ type: 'input_text', text: '本轮要求，不得改写。ID=photo' }, { type: 'input_image', image: 'data:image/png;base64,current-original' }] };
  let summaries = 0;
  const filter = createInputFilter(async (method, params) => {
    if (method === 'memory') return { ok: true };
    assert.equal(method, 'model'); assert.equal(params.summary, true); summaries++;
    assert.doesNotMatch(JSON.stringify(params.messages), /base64,|encrypted-private/);
    return { text_response: '旧节点已完成，保持品牌约束。任务 task-1 不重复提交。' };
  }, 70000);
  const source = [{ role: 'user', content: [{ type: 'input_text', text: '历史资料'.repeat(16000) }, { type: 'input_image', image: 'data:image/png;base64,old-original' }] }, { type: 'reasoning', content: [], providerData: { encrypted_content: 'encrypted-private' } }, { role: 'assistant', content: [{ type: 'output_text', text: '已完成' }] }, current];
  const before = structuredClone(source);
  const result = await filter(filterArgs(source));
  assert.ok(summaries); assert.deepEqual(source, before);
  assert.deepEqual(result.input.at(-1), current);
  assert.match(JSON.stringify(result.input), /task-1/);
  assert.doesNotMatch(JSON.stringify(result.input), /old-original/);
});
test('context summary failure leaves original input unchanged', async () => {
  let calls = 0;
  const source = [{ role: 'user', content: '历史'.repeat(60000) }, { role: 'assistant', content: [{ type: 'output_text', text: '已完成' }] }, { role: 'user', content: '继续制作' }];
  const before = structuredClone(source);
  const filter = createInputFilter(async () => { if (++calls === 1) return { text_response: '第一段摘要' }; throw new Error('summary failed'); }, 70000);
  await assert.rejects(filter(filterArgs(source)), /summary failed/);
  assert.deepEqual(source, before);
});
test('summary chunks never split a Unicode surrogate pair', async () => {
  const chunks = [];
  const filter = createInputFilter(async (method, params) => {
    if (method === 'memory') return {};
    chunks.push(params.messages.at(-1).content);
    return { text_response: '已保留历史。' };
  }, 1000);
  await filter(filterArgs([{ role: 'user', content: '😀'.repeat(16000) }, { role: 'user', content: '继续' }]));
  assert(chunks.length > 1);
  for (const chunk of chunks) assert.equal(chunk.isWellFormed(), true);
});
test('context compaction never summarizes an oversized current request or incomplete tool work', async () => {
  const filter = createInputFilter(async () => { assert.fail('must not call model'); }, 70000);
  const current = { role: 'user', content: '创作资料'.repeat(16000) + '最终品牌约束' };
  await assert.rejects(filter(filterArgs([current])), /本轮输入/);
  for (const orphan of [false, true]) {
    const incomplete = orphan ? { type: 'function_call_result', callId: 'unknown', name: 'get_node', status: 'completed', output: '工具输出'.repeat(16000) } : { type: 'function_call', callId: 'pending', name: 'get_node', arguments: JSON.stringify({ text: '处理进度'.repeat(16000) }) };
    const source = [{ role: 'user', content: '继续制作' }, incomplete];
    const before = structuredClone(source);
    await assert.rejects(filter(filterArgs(source)), /配对/); assert.deepEqual(source, before);
  }
});
test('context filter summarizes completed tool pairs while keeping current request', async () => {
  const current = { role: 'user', content: [{ type: 'input_text', text: '根据图和节点资料制作' }, { type: 'input_image', image: '/original.png' }] };
  const source = [current, { type: 'function_call', callId: 'read', name: 'get_node', arguments: '{"nodeId":"n"}', status: 'completed' }, { type: 'function_call_result', callId: 'read', name: 'get_node', status: 'completed', output: '节点资料'.repeat(16000) }];
  const filter = createInputFilter(async (method, params) => {
    if (method === 'memory') return {};
    assert.doesNotMatch(JSON.stringify(params.messages), /original.png/);
    return { text_response: '节点 n 已读取，未提交生成。' };
  }, 70000);
  const result = await filter(filterArgs(source));
  assert.equal(result.input.length, 2); assert.deepEqual(result.input[1], current);
});
test('images use a bounded token estimate, and visual windows retain all labels without mutating source', () => {
  assert.equal(estimateTokens({ type: 'input_image', image: 'data:image/png;base64,AA==' }), estimateTokens({ type: 'input_image', image: 'data:image/png;base64,' + 'A'.repeat(2 << 20) }));
  const source = [{ role: 'user', content: [{ type: 'input_text', text: 'ID=old, ID=new' }, { type: 'input_image', image: '/old.png' }, { type: 'input_image', image: '/new.png' }] }];
  const before = structuredClone(source); const result = visualWindow(source, 1);
  assert.deepEqual(source, before); assert.match(JSON.stringify(result), /ID=old/); assert.doesNotMatch(JSON.stringify(result), /\/old.png/);
  assert.deepEqual(result[0].content, [source[0].content[0], { type: 'input_text', text: '［此处图片已从模型上下文省略。］' }, source[0].content[2]]);
  assert.deepEqual(visualWindow(result, 1), result);
});
test('legacy transcript imports paired SDK items without repeating an unknown write', () => {
  const source = [{ role: 'user', content: '制作海报' }, { role: 'assistant', toolCalls: [{ id: 'created', name: 'create_text_node', arguments: { title: '已有' } }] }];
  const result = importProtocol(source);
  assert.equal(result.at(-1).type, 'function_call_result'); assert.equal(result.at(-1).status, 'completed');
  assert.match(JSON.stringify(result.at(-1)), /execution_unknown/);
  assert.equal(result.filter(item => item.type === 'function_call').length, 1);
});
test('transport adapter preserves reasoning, tool pairs and multimodal reference outputs', () => {
  const items = [...modelOutput({ reasoning_content: 'opaque', text_response: '查看参考图', tool_calls: [{ id: 'read', function: { name: 'get_node', arguments: '{"nodeId":"photo"}' } }] }), { type: 'function_call_result', callId: 'read', name: 'get_node', status: 'completed', output: [{ type: 'input_text', text: 'ID=photo' }, { type: 'input_image', image: '/photo.png' }] }];
  const messages = modelMessages(items, 'system');
  assert.equal(messages[1].reasoning_content, 'opaque'); assert.equal(messages[1].tool_calls[0].id, 'read');
  assert.equal(messages[2].tool_call_id, 'read'); assert.match(JSON.stringify(messages[3]), /photo.png/);
});

test('transport adapter separates multiple tool text parts with a newline', () => {
  const messages = modelMessages([{ type: 'function_call_result', callId: 'read', name: 'get_node', output: [{ type: 'input_text', text: 'first' }, { type: 'text', text: 'second' }] }]);
  assert.equal(messages[0].content, 'first\nsecond');
});

test('SDK reference outputs retain identifiers while bounding the current visual window', () => {
  const items = [];
  for (let i = 0; i < 12; i++) items.push({ type: 'function_call_result', callId: `lookup-${i}`, name: 'get_reference', status: 'completed', output: [{ type: 'input_text', text: `ID=ref-${i}，` }, { type: 'input_image', image: `/ref-${i}.png` }] });
  const projected = visualWindow(items);
  const images = projected.flatMap(item => item.output.filter(part => part.type === 'input_image').map(part => part.image));
  assert.deepEqual(images, Array.from({ length: 8 }, (_, i) => `/ref-${i + 4}.png`));
  for (let i = 0; i < 12; i++) assert.match(JSON.stringify(projected), new RegExp(`ID=ref-${i}，`));
  assert.match(modelMessages(projected)[0].content, /ID=ref-0，\n［此处图片已从模型上下文省略。需要核对原图时，可用 get_reference 重新读取。］/);
});

test('SDK context counters measure the same input, instructions and tools used by the compression budget', async () => {
  const tools = [{name:'get_node',description:'Read a canvas node.'}], reported=[];
  const args=filterArgs([{role:'user',content:'检查画布'}]);
  const filter=createInputFilter(async()=>assert.fail('short input must not summarize'),70000,tools,usage=>reported.push(usage));
  await filter(args);
  assert.deepEqual(reported,[{usedTokens:Math.ceil(estimateTokens(args.modelData.input)+estimateTokens(args.modelData.instructions)+estimateTokens(tools)),maxTokens:56000,compacting:false}]);
});

test('SDK context counters report compression before summary and publish the reduced input afterwards', async () => {
  const reported=[];
  const filter=createInputFilter(async(method,params)=>{
    if(method==='memory')return{ok:true};
    assert.equal(params.contextUsage.compacting,true);
    assert.equal(params.contextUsage.maxTokens,56000);
    return{text_response:'原有任务已完成，保持人物和场景约束。'};
  },70000,[],usage=>reported.push(usage));
  await filter(filterArgs([{role:'user',content:'历史资料'.repeat(16000)},{role:'assistant',content:'已完成'},{role:'user',content:'继续'}]));
  assert.equal(reported[0].compacting,false);assert(reported[0].usedTokens>56000);
  assert.equal(reported[1].compacting,true);
  assert.equal(reported.at(-1).compacting,false);assert(reported.at(-1).usedTokens<56000);
});


test('context budgets follow the configured window and reject invalid limits', () => {
  assert.equal(DEFAULT_CONTEXT_WINDOW_TOKENS, 457000);
  assert.equal(contextTokenBudget(), 365600);
  assert.equal(contextTokenBudget(128000), 102400);
  assert.equal(contextTokenBudget(32001), 25600);
  for (const limit of [0, 1, -1, 100.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '457000', null]) assert.throws(() => contextTokenBudget(limit), /上下文上限/);
});

test('compaction triggers at 80 percent, preserving the active request and publishing reduced usage', async () => {
  for (const [window, expectedBudget] of [[457000,365600], [128000,102400]]) {
    const source=[{role:'user',content:'历史资料'.repeat(16000)}, {role:'assistant',content:'已完成'}, {role:'user',content:'继续创作'}];
    const before=structuredClone(source);
    const reports=[];
    const noSummary=createInputFilter(async()=>assert.fail('input above the old 56k limit must fit below 80 percent'),window,[],usage=>reports.push(usage));
    const unchanged=await noSummary(filterArgs(source));
    assert.deepEqual(unchanged.input,source);assert.deepEqual(source,before);
    assert.equal(reports[0].maxTokens,expectedBudget);
    assert(reports[0].usedTokens>56000);assert(reports[0].usedTokens<expectedBudget);
  }
  for (const target of [799,800,801]) {
    const args={modelData:{instructions:'',input:[{role:'user',content:''},{role:'assistant',content:'done'},{role:'user',content:'next'}]}};
    const base=Math.ceil(estimateTokens(args.modelData.input)+estimateTokens(args.modelData.instructions)+estimateTokens([]));
    args.modelData.input[0].content='文'.repeat(target-base);
    const original=structuredClone(args.modelData.input),reported=[];
    let summaries=0;
    const filter=createInputFilter(async(method,params)=>{
      if(method==='memory')return{ok:true};
      summaries++;
      assert.equal(params.contextUsage.maxTokens,800);
      assert.equal(params.contextUsage.compacting,true);
      return{text_response:'Keep original work.'};
    },1000,[],usage=>reported.push(usage));
    const result=await filter(args);
    assert.equal(reported[0].usedTokens,target);
    assert.equal(summaries,target>=800?1:0);
    assert.deepEqual(args.modelData.input,original);
    assert.deepEqual(result.input.at(-1),original.at(-1));
    assert.equal(reported.at(-1).compacting,false);
    assert(reported.at(-1).usedTokens<800);
  }
});

test('compaction preserves the real user request and latest canvas snapshot separately', async () => {
 const request={role:'user',content:'Keep the approved node and do not generate new media.'};
 const snapshot={role:'user',content:'Latest canvas: original-node completed.',contextSnapshot:true};
 const filter=createInputFilter(async(method,params)=>{
  if(method==='memory')return {};
  assert.doesNotMatch(JSON.stringify(params.messages),/outdated snapshot|Latest canvas/);
  return {text_response:'Retain original-node and paid-task.'};
 },2000);
 const result=await filter(filterArgs([request,{role:'user',content:'outdated snapshot',contextSnapshot:true},{type:'function_call',callId:'read',name:'get_node',arguments:'{}'},{type:'function_call_result',callId:'read',name:'get_node',output:'tool result '.repeat(1500)},snapshot]));
 assert.deepEqual(result.input.slice(1),[request,snapshot]);
});

test('repeated summaries map their sources back to the original history positions', async () => {
  const filter = createInputFilter(async (method) => method === 'model' ? { text_response: 'Retain the approved draft.' } : {});
  const request = { role: 'user', content: 'Review the new draft.' };
  const initial = await filter({
    force: true,
    modelData: {
      input: [{ role: 'system', content: 'Existing summary without source positions.' }, { role: 'user', content: 'Old brief' }, request],
      origins: [null, 4, 5], through: 6, trigger: 'manual', instructions: '',
    },
  });
  assert.deepEqual(initial.origins, [[[4, 5], null], 5]);
  const next = await filter({
    force: true,
    modelData: {
      ...initial,
      input: [...initial.input, { role: 'user', content: 'Prepare the final draft.' }],
      origins: [...initial.origins, 6], through: 7, trigger: 'overflow',
    },
  });
  assert.deepEqual(next.origins, [[[4, 6], null], 6]);
  assert.deepEqual(next.compactions.map(({ sourceRanges, hasUnmappedSource, trigger, through }) => [sourceRanges, hasUnmappedSource, trigger, through]), [
    [[[4, 5]], true, 'manual', 6],
    [[[4, 6]], true, 'overflow', 7],
  ]);
});
