import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mergeCanvasDocuments, mergeCanvasHistory } from '../src/app/canvas/canvas-document-merge.ts';
import { canvasAgentHistoryChanges, canvasAgentHistorySummaries } from '../src/app/canvas/agent/canvas-agent-history.ts';
const doc = () => ({id:'c',revision:1,title:'Canvas',nodes:[{id:'n',x:0,y:0,prompt:'original',generation_status:'loading'}],connections:[],viewport:{x:0,y:0,zoom:1},agent_run:{id:'run',status:'running'},agent_sessions:[{id:'s',messages:[]}]});

const summary = (id, hash = 'original') => ({ id, title: id, message_count: 1, content_hash: hash });
const historyDoc = () => ({ ...doc(), agent_run: undefined, agent_history_partial: true, agent_session_summaries: [summary('s'), summary('unloaded')], agent_sessions: [{ id: 's', title: 's', messages: [{ text: 'original' }] }] });
test('rebasing against the unchanged server snapshot preserves staged conversation edits without reading transcript bodies', () => {
 for (const partial of [false, true]) {
  const base = { ...conversationDoc(), agent_history_partial: partial };
  const local = structuredClone(base);
  local.nodes[0].prompt = 'Edited node';
  local.agent_sessions[0].title = 'Edited conversation';
  local.agent_sessions[0].messages[0].text = 'Keep this edited request';
  local.agent_sessions[0].messageQueue = { paused: true, messages: [] };
  let reads = 0;
  const message = local.agent_sessions[0].messages[0], text = message.text;
  Object.defineProperty(message, 'text', { enumerable: true, get() { reads++; return text; } });
  const merged = mergeCanvasDocuments(base, local, base);
  assert.equal(reads, 0, 'an unchanged remote version needs no transcript comparison');
  assert.equal(merged.agent_sessions[0], local.agent_sessions[0]);
  assert.equal(merged.agent_sessions[0].messages[0].text, 'Keep this edited request');
  assert.equal(merged.agent_sessions[0].messageQueue.paused, true);
  assert.equal(merged.nodes[0].prompt, 'Edited node');
  assert.equal(base.agent_sessions[0].messages.length, 1);
  assert.equal(base.nodes[0].prompt, 'original');
 }
});
test('acknowledged unchanged content retains local history references while merging remote metadata', () => {
 const base = conversationDoc(), local = structuredClone(base), remote = structuredClone(base);
 remote.revision++; remote.agent_sessions[0].title = 'Remote rename';
 const original = structuredClone({base, local, remote});
 const merged = mergeCanvasDocuments(base, local, remote).agent_sessions[0];
 assert.equal(merged.title, 'Remote rename');
 assert.equal(merged.messages, local.agent_sessions[0].messages);
 assert.equal(merged.protocolMessages, local.agent_sessions[0].protocolMessages);
 assert.equal(merged.agentState, local.agent_sessions[0].agentState);
 assert.deepEqual({base, local, remote}, original);
 remote.agent_sessions[0].protocolMessages.push({role: 'assistant', content: 'New server reply'});
 assert.deepEqual(mergeCanvasDocuments(base, local, remote).agent_sessions[0].protocolMessages, remote.agent_sessions[0].protocolMessages);
});
test('a partial snapshot omits bodies without deleting directory entries or cached conversations', () => {
 const base = historyDoc(), local = structuredClone(base), remote = structuredClone(base);
 remote.agent_sessions = []; remote.revision++;
 const merged = mergeCanvasDocuments(base, local, remote);
 assert.deepEqual(merged.agent_sessions, base.agent_sessions);
 assert.deepEqual(merged.agent_session_summaries, base.agent_session_summaries);
 assert.deepEqual(merged.deleted_agent_session_ids, []);
});
test('dirty cached bodies retain their original hash until a fresh body is available for rebasing', () => {
 const base = historyDoc(), local = structuredClone(base), remote = structuredClone(base);
 local.agent_sessions[0].title = 'local rename';
 remote.agent_sessions = []; remote.agent_session_summaries[0].content_hash = 'changed'; remote.revision++;
 const merged = mergeCanvasDocuments(base, local, remote);
 assert.equal(merged.agent_sessions[0].title, 'local rename');
 assert.equal(merged.agent_session_summaries[0].content_hash, 'original');
 const fresh = structuredClone(remote); fresh.agent_sessions = [{ id: 's', title: 's', messages: [{ text: 'new remote reply' }] }];
 const rebased = mergeCanvasDocuments(base, local, fresh);
 assert.equal(rebased.agent_sessions[0].title, 'local rename');
 assert.equal(rebased.agent_sessions[0].messages[0].text, 'new remote reply');
 assert.equal(rebased.agent_session_summaries[0].content_hash, 'changed');
 const unchanged = mergeCanvasDocuments(base, base, remote);
 assert.deepEqual(unchanged.agent_sessions, [], 'stale clean cache must be fetched again');
});
test('explicit deletions retain expected hashes until acknowledged and do not delete unloaded neighbours', () => {
 const base = historyDoc(), local = structuredClone(base), remote = structuredClone(base);
 local.deleted_agent_session_ids = ['unloaded'];
 const merged = mergeCanvasDocuments(base, local, remote);
 assert.deepEqual(merged.deleted_agent_session_ids, ['unloaded']);
 assert.equal(merged.agent_session_summaries.length, 2, 'retain the deletion version for the save request');
 assert.deepEqual(canvasAgentHistorySummaries({ ...merged, agent_sessions: [] }).map(item => item.id), ['s']);
 remote.agent_session_summaries = [summary('s')];
 assert.deepEqual(mergeCanvasDocuments(base, local, remote).deleted_agent_session_ids, []);
});
test('partial saves send changed bodies only while retaining the complete expected directory', () => {
 const session = { id: 's', title: 's', createdAt: 'now', updatedAt: 'now', messages: [], protocolMessages: [], agentState: { phase: 'intake', approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] } };
 const base = { ...historyDoc(), agent_sessions: [session] };
 assert.deepEqual(canvasAgentHistoryChanges(base, base).agent_sessions, []);
 const local = structuredClone(base); local.agent_sessions[0].title = 'renamed';
 const changes = canvasAgentHistoryChanges(local, base);
 assert.deepEqual(changes.agent_sessions, []);
 assert.deepEqual(changes.agent_session_updates, [{id:'s',changes:{title:'renamed'}}]);
 assert.deepEqual(changes.agent_session_summaries, base.agent_session_summaries);
 local.agent_sessions[0].messages.push({id:'u',role:'user',text:'A real transcript edit'});
 assert.deepEqual(canvasAgentHistoryChanges(local,base).agent_sessions,local.agent_sessions);
});
test('Agent video model switches survive concurrent edits to other canvas preferences', () => {
 const base=doc();base.agent_config={videoModel:'old',autoGenerateMedia:true};
 const local=structuredClone(base),remote=structuredClone(base);
 local.agent_config.autoGenerateMedia=false;remote.agent_config.videoModel='new';remote.revision=2;
 const merged=mergeCanvasDocuments(base,local,remote);
 assert.deepEqual(merged.agent_config,{videoModel:'new',autoGenerateMedia:false});
 local.agent_config.videoModel='user-choice';
 assert.equal(mergeCanvasDocuments(base,local,remote).agent_config.videoModel,'user-choice');
});
test('polling preserves local edits and merges generated output and newly created nodes', () => {
 const base=doc(), local=structuredClone(base),remote=structuredClone(base);
 local.nodes[0].x=200;local.nodes[0].prompt='user edit';local.viewport.x=90;
 remote.revision=2;remote.nodes[0].url='/result.png';remote.nodes[0].generation_status='success';remote.nodes.push({id:'new',x:400});remote.agent_sessions[0].messages.push({text:'done'});
 const result=mergeCanvasDocuments(base,local,remote);
 assert.equal(result.nodes[0].x,200);assert.equal(result.nodes[0].prompt,'user edit');assert.equal(result.nodes[0].url,'/result.png');assert.equal(result.nodes[0].generation_status,'success');assert.equal(result.nodes.length,2);assert.equal(result.viewport.x,90);assert.deepEqual(result.agent_sessions,remote.agent_sessions);assert.equal(result.revision,2);
});
test('local and remote deletions are not resurrected and dangling connections are removed', () => {
 const base=doc(),local=structuredClone(base),remote=structuredClone(base);local.nodes=[];remote.nodes.push({id:'new'});remote.connections=[{id:'e',from_node_id:'n',to_node_id:'new'}];
 assert.deepEqual(mergeCanvasDocuments(base,local,remote).nodes,[{id:'new'}]);assert.deepEqual(mergeCanvasDocuments(base,local,remote).connections,[]);
 local.nodes=base.nodes;remote.nodes=[];assert.deepEqual(mergeCanvasDocuments(base,local,remote).nodes,[]);
});
test('acknowledging a save preserves typing that occurred while it was in flight', () => {
 const base=doc(),sent=structuredClone(base),local=structuredClone(base);sent.revision=2;sent.nodes[0].prompt='first';local.nodes[0].prompt='first second';
 const result=mergeCanvasDocuments(base,local,sent);assert.equal(result.nodes[0].prompt,'first second');
});

test('undo preserves Agent additions but reverses local additions and deletions', () => {
 const base=doc(),local=structuredClone(base),remote=structuredClone(base),previous=structuredClone(base);
 local.nodes.push({id:'user-new'});remote.nodes.push({id:'user-new'},{id:'agent-new'});
 assert.deepEqual(mergeCanvasHistory(base,local,previous,remote).nodes.map(n=>n.id),['n','agent-new']);
 assert.deepEqual(mergeCanvasHistory(base,local,local,remote).nodes.map(n=>n.id),['n','agent-new','user-new']);
 local.nodes=[];remote.nodes=base.nodes;
 assert.deepEqual(mergeCanvasHistory(base,local,local,remote).nodes,[]);
 assert.equal(mergeCanvasHistory(base,local,previous,remote).nodes[0].id,'n');
});

test('acknowledged movement stays undoable without losing generated output', () => {
 const base=doc(),local=structuredClone(base),remote=structuredClone(base);
 local.nodes[0].x=200;remote.nodes[0].x=200;remote.nodes[0].url='/generated.png';
 const undo=mergeCanvasHistory(base,local,base,remote);
 assert.equal(undo.nodes[0].x,0);assert.equal(undo.nodes[0].url,'/generated.png');
 local.nodes=[];remote.nodes=[];
 assert.equal(mergeCanvasHistory(base,local,base,remote).nodes[0].id,'n');
});

test('Agent polling and save acknowledgement preserve pending queue edits without replacing model history', () => {
 const base=doc(),local=structuredClone(base),remote=structuredClone(base);
 const first={paused:false,messages:[{id:'q1',text:'new direction',createdAt:'now',references:[]}]};
 local.agent_sessions[0].messageQueue=first;
 remote.agent_sessions[0].messages=[{role:'assistant',text:'new progress'}];remote.revision=2;
 const merged=mergeCanvasDocuments(base,local,remote);
 assert.deepEqual(merged.agent_sessions[0].messageQueue,first);
 assert.deepEqual(merged.agent_sessions[0].messages,remote.agent_sessions[0].messages);
 const sent=structuredClone(merged),typing=structuredClone(merged);
 typing.agent_sessions[0].messageQueue.messages.push({id:'q2',text:'second direction',createdAt:'now',references:[]});
 const ack=mergeCanvasDocuments(base,typing,sent);
 assert.equal(ack.agent_sessions[0].messageQueue.messages.length,2);
 const clean=mergeCanvasDocuments(sent,sent,remote);
 assert.equal(clean.agent_sessions[0].messageQueue,undefined,'another client can update an acknowledged queue');
});

test('Agent polling keeps the active conversation visible if a snapshot omits it', () => {
 const base=doc(),local=structuredClone(base),remote=structuredClone(base);
 base.agent_run={id:'run',sessionId:'s',status:'running'};
 local.agent_run=structuredClone(base.agent_run);local.agent_sessions[0].messages.push({role:'assistant',text:'working'});
 remote.agent_run={...base.agent_run,updatedAt:'later'};remote.agent_sessions=[];remote.active_agent_session_id=undefined;
 const merged=mergeCanvasDocuments(base,local,remote);
 assert.equal(merged.agent_sessions[0].id,'s');
 assert.deepEqual(merged.agent_sessions[0].messages,local.agent_sessions[0].messages);
 assert.equal(merged.active_agent_session_id,'s');
});

test('idle save rebases session edits without discarding concurrent conversations or updates', () => {
 const base=doc();delete base.agent_run;base.agent_sessions=[{id:'s',title:'original',messages:[{text:'first'}]}];
 const local=structuredClone(base),remote=structuredClone(base);
 local.agent_sessions=[];
 remote.agent_sessions[0].messages.push({text:'new reply'});
 remote.agent_sessions.push({id:'new',messages:[{text:'other conversation'}]});
 assert.deepEqual(mergeCanvasDocuments(base,local,remote).agent_sessions,remote.agent_sessions);
 remote.agent_sessions[0]=structuredClone(base.agent_sessions[0]);
 assert.deepEqual(mergeCanvasDocuments(base,local,remote).agent_sessions,[remote.agent_sessions[1]]);
 local.agent_sessions=[{...base.agent_sessions[0],title:'renamed'}];
 remote.agent_sessions[0].messages.push({text:'new reply'});
 const merged=mergeCanvasDocuments(base,local,remote);
 assert.equal(merged.agent_sessions[0].title,'renamed');
 assert.deepEqual(merged.agent_sessions[0].messages,remote.agent_sessions[0].messages);
 assert.equal(merged.agent_sessions[1].id,'new');
});

test('concurrent edits to different script shots preserve both edits and completed bindings', () => {
 const base=doc();base.nodes[0].script_project={step:2,confirmed:true,assets:[],shots:[{id:'s1',description:'one',seconds:5,dialogue:[],asset_ids:[],image_prompt:'frame1',video_prompt:'video1'},{id:'s2',description:'two',seconds:5,dialogue:[],asset_ids:[],image_prompt:'frame2',video_prompt:'video2'}]};
 const local=structuredClone(base),remote=structuredClone(base);
 local.nodes[0].script_project.shots[0].description='local edit';
 remote.nodes[0].script_project.shots[1].description='remote edit';
 remote.nodes[0].script_project.shots[1].video_node_id='completed';
 const project=mergeCanvasDocuments(base,local,remote).nodes[0].script_project;
 assert.equal(project.shots[0].description,'local edit');
 assert.equal(project.shots[1].description,'remote edit');
 assert.equal(project.shots[1].video_node_id,'completed');
 assert.equal(project.confirmed,false);
 assert.equal(project.shots[0].video_prompt,'video1');
 assert.equal(project.shots[0].video_prompt_outdated,true);
});

const conversationDoc = () => ({ ...historyDoc(), agent_sessions: [{
 id: 's', title: 'Original', createdAt: '2026-01-01', updatedAt: '2026-01-01',
 messages: [{ id: 'u1', role: 'user', text: 'original' }],
 protocolMessages: [{ role: 'user', messageID: 'u1', content: 'original' }],
 agentState: { phase: 'intake', approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] },
}] });

test('reordered conversation properties do not create conflicts with a new remote reply', () => {
 const base = conversationDoc(), local = structuredClone(base), remote = structuredClone(base);
 local.nodes[0].x = 200;
 local.agent_sessions[0].messages[0] = { text: 'original', role: 'user', id: 'u1' };
 local.agent_sessions[0].protocolMessages[0] = { content: 'original', messageID: 'u1', role: 'user' };
 remote.agent_sessions[0].messages.push({ id: 'a1', role: 'assistant', text: 'remote reply' });
 remote.agent_sessions[0].protocolMessages.push({ role: 'assistant', content: 'remote reply' });
 const merged = mergeCanvasDocuments(base, local, remote);
 assert.equal(merged.nodes[0].x, 200);
 assert.deepEqual(merged.agent_sessions, remote.agent_sessions);
 assert.deepEqual(canvasAgentHistoryChanges(merged, remote).agent_sessions, []);
});

test('partial saves omit reordered unchanged history but include deep tool argument changes', () => {
 const base = conversationDoc(), local = structuredClone(base);
 const toolCall = { id: 'call', name: 'get_node', arguments: { nodeId: 'n', options: { fields: ['title', 'prompt'] } } };
 base.agent_sessions[0].protocolMessages.push({ role: 'assistant', toolCalls: [toolCall] });
 local.agent_sessions[0].protocolMessages.push({ toolCalls: [{ name: 'get_node', arguments: { options: { fields: ['title', 'prompt'] }, nodeId: 'n' }, id: 'call' }], role: 'assistant' });
 assert.deepEqual(canvasAgentHistoryChanges(local, base).agent_sessions, []);
 local.agent_sessions[0].protocolMessages[1].toolCalls[0].arguments.options.fields[1] = 'description';
 assert.deepEqual(canvasAgentHistoryChanges(local, base).agent_sessions, local.agent_sessions);
 assert.deepEqual(base.agent_sessions[0].protocolMessages[1].toolCalls[0].arguments.options.fields, ['title', 'prompt']);
});

test('history comparison preserves explicit clears, array positions and false or zero tool parameters', () => {
 const base = conversationDoc();
 base.agent_sessions[0].protocolMessages.push({ role: 'assistant', toolCalls: [{ id: 'call', name: 'get_node', arguments: { enabled: false, offset: 0, optional: undefined, fields: ['title', null, 'prompt'] } }] });
 const unchanged = structuredClone(base);
 delete unchanged.agent_sessions[0].protocolMessages[1].toolCalls[0].arguments.optional;
 assert.deepEqual(canvasAgentHistoryChanges(unchanged, base).agent_sessions, []);
 for (const edit of [
  args => { args.enabled = true; },
  args => { args.offset = 1; },
  args => { args.optional = null; },
  args => { args.fields = ['title', 'prompt']; },
  args => { args.fields = ['prompt', null, 'title']; },
 ]) {
  const local = structuredClone(base);
  edit(local.agent_sessions[0].protocolMessages[1].toolCalls[0].arguments);
  assert.deepEqual(canvasAgentHistoryChanges(local, base).agent_sessions, local.agent_sessions);
 }
});

test('concurrent changes to one conversation reject a save instead of overwriting remote replies with its current hash', () => {
 for (const partial of [true, false]) {
  const base = conversationDoc(), local = structuredClone(base), remote = structuredClone(base);
  base.agent_history_partial = local.agent_history_partial = remote.agent_history_partial = partial;
  local.agent_sessions[0].messages.push({ id: 'u2', role: 'user', text: 'local request' });
  remote.agent_sessions[0].messages.push({ id: 'a1', role: 'assistant', text: 'remote reply' });
  remote.agent_sessions[0].protocolMessages.push({ role: 'assistant', content: 'remote reply' });
  remote.agent_session_summaries[0].content_hash = 'remote-hash'; remote.revision++;
  const unchanged = structuredClone({base, local, remote});
  assert.throws(() => canvasAgentHistoryChanges(mergeCanvasDocuments(base, local, remote), remote), error => {
   assert.equal(error.name, 'CanvasAgentSessionConflictError');
   assert.deepEqual(error.sessionIDs, ['s']);
   assert.deepEqual(error.remote, remote);
   return true;
  });
  assert.deepEqual({base, local, remote}, unchanged);
 }
});

test('conversation state is atomic across transcript, protocol and context changes', () => {
 const base = conversationDoc(), local = structuredClone(base), remote = structuredClone(base);
 local.agent_sessions[0].contextCheckpoint = 'local compressed history';
 local.agent_sessions[0].protocolMessages = [];
 remote.agent_sessions[0].messages[0].text = 'remote edited request';
 remote.agent_sessions[0].agentState.phase = 'script';
 assert.throws(() => mergeCanvasDocuments(base, local, remote), { name: 'CanvasAgentSessionConflictError' });
 const same = structuredClone(remote);
 same.agent_sessions[0].title = 'local title';
 const merged = mergeCanvasDocuments(base, same, remote);
 assert.equal(merged.agent_sessions[0].title, 'local title');
 assert.deepEqual(merged.agent_sessions[0].messages, remote.agent_sessions[0].messages);
});

test('single-sided conversation changes keep transcript, protocol and context from the same version', () => {
 const base = conversationDoc(), local = structuredClone(base), remote = structuredClone(base);
 local.agent_sessions[0].title = 'renamed locally';
 remote.agent_sessions[0].messages.push({id: 'a1', role: 'assistant', text: 'reply'});
 remote.agent_sessions[0].protocolMessages.push({role: 'assistant', content: 'reply'});
 remote.agent_sessions[0].contextCheckpoint = 'remote summary';
 const merged = mergeCanvasDocuments(base, local, remote);
 assert.equal(merged.agent_sessions[0].title, 'renamed locally');
 assert.deepEqual(merged.agent_sessions[0].protocolMessages, remote.agent_sessions[0].protocolMessages);
 assert.equal(merged.agent_sessions[0].contextCheckpoint, 'remote summary');
});

test('a causal append keeps the entire newer session rather than creating a false conflict', () => {
 const base = conversationDoc(), remote = structuredClone(base), local = structuredClone(base);
 remote.agent_sessions[0].messages.push({id: 'a1', role: 'assistant', text: 'saved reply'});
 local.agent_sessions[0].messages = [...structuredClone(remote.agent_sessions[0].messages), {id: 'u2', role: 'user', text: 'typed while saving'}];
 assert.deepEqual(mergeCanvasDocuments(base, local, remote).agent_sessions[0].messages, local.agent_sessions[0].messages);
});

test('conflict resolution preserves complete versions, keeps tool pairs and separates Codex continuation', async () => {
 const { forkCanvasAgentSessionConflicts } = await import('../src/app/canvas/canvas-document-merge.ts');
 for (const partial of [true, false]) {
  const base = conversationDoc(), local = structuredClone(base), remote = structuredClone(base);
  base.agent_history_partial = local.agent_history_partial = remote.agent_history_partial = partial;
  local.active_agent_session_id = 's';
  local.agent_sessions[0].messages[0].text = 'local edited request';
  local.agent_sessions[0].protocolMessages = [{role: 'user', messageID: 'u1', content: 'local edited request'}, {role: 'assistant', toolCalls: [{id: 'call', name: 'get_node', arguments: {nodeId: 'n'}}]}, {role: 'tool', content: 'result', toolCallId: 'call', name: 'get_node'}];
  local.agent_sessions[0].contextCheckpoint = 'local summary';
  local.agent_sessions[0].codexThreadId = 'external-thread'; local.agent_sessions[0].codexServiceId = 'service';
  local.agent_sessions[0].messageQueue = {messages: [{id: 'q', text: 'queued', references: [], createdAt: 'now'}], paused: false, steeringId: 'q'};
  remote.agent_sessions[0].messages.push({id: 'a1', role: 'assistant', text: 'remote reply'});
  remote.agent_sessions[0].protocolMessages.push({role: 'assistant', content: 'remote reply'});
  const originals = structuredClone({base, local, remote});
  const forked = forkCanvasAgentSessionConflicts(local, ['s'], () => 'local-branch');
  const merged = mergeCanvasDocuments(base, forked, remote);
  assert.equal(merged.active_agent_session_id, 'local-branch');
  assert.equal(merged.agent_sessions.length, 2);
  assert.deepEqual(merged.agent_sessions.find(s => s.id === 's'), remote.agent_sessions[0]);
  const branch = merged.agent_sessions.find(s => s.id === 'local-branch');
  assert.deepEqual(branch.messages, local.agent_sessions[0].messages);
  assert.deepEqual(branch.protocolMessages, local.agent_sessions[0].protocolMessages);
  assert.equal(branch.contextCheckpoint, 'local summary');
  assert.equal(branch.codexThreadId, undefined); assert.equal(branch.codexServiceId, undefined);
  assert.equal(branch.messageQueue.paused, true); assert.equal(branch.messageQueue.steeringId, undefined);
  assert.deepEqual({base, local, remote}, originals);
 }
});

test('a different page starting a run cannot discard a pending local request', () => {
 const base = conversationDoc(), local = structuredClone(base), remote = structuredClone(base);
 local.agent_sessions[0].messages.push({id: 'u2', role: 'user', text: 'pending local request'});
 remote.agent_run = {id: 'other-page-run', status: 'running', sessionId: 's'};
 assert.throws(() => mergeCanvasDocuments(base, local, remote), {name: 'CanvasAgentSessionConflictError'});
 const acknowledged = structuredClone(remote);
 acknowledged.agent_sessions = structuredClone(local.agent_sessions);
 assert.deepEqual(mergeCanvasDocuments(base, local, acknowledged).agent_sessions, local.agent_sessions);
});

test('all divergent sessions are reported together so resolution cannot oscillate between conflicts', () => {
 const base = conversationDoc(); base.agent_sessions.push({...structuredClone(base.agent_sessions[0]), id: 'second'});
 const local = structuredClone(base), remote = structuredClone(base);
 for (const session of local.agent_sessions) session.messages[0].text = 'local edit';
 for (const session of remote.agent_sessions) session.messages[0].text = 'remote edit';
 assert.throws(() => mergeCanvasDocuments(base, local, remote), error => {
  assert.deepEqual(error.sessionIDs, ['s', 'second']); return true;
 });
});

test('a saved conflict branch remains present beside an active remote worker in a complete snapshot', async () => {
 const {forkCanvasAgentSessionConflicts} = await import('../src/app/canvas/canvas-document-merge.ts');
 const base = conversationDoc(), local = structuredClone(base), remote = structuredClone(base);
 base.agent_history_partial = local.agent_history_partial = remote.agent_history_partial = false;
 local.agent_sessions[0].messages[0].text = 'local edit';
 remote.agent_run = {id: 'worker', status: 'running', sessionId: 's'};
 const forked = forkCanvasAgentSessionConflicts(local, ['s'], () => 'branch');
 const merged = mergeCanvasDocuments(base, forked, remote);
 assert.deepEqual(merged.agent_sessions.map(s => s.id), ['s', 'branch']);
 assert.deepEqual(merged.agent_sessions[0], remote.agent_sessions[0]);
});
