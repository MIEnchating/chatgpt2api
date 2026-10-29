import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mergeCanvasDocuments, mergeCanvasHistory } from '../src/app/canvas/canvas-document-merge.ts';
const doc = () => ({id:'c',revision:1,title:'Canvas',nodes:[{id:'n',x:0,y:0,prompt:'original',generation_status:'loading'}],connections:[],viewport:{x:0,y:0,zoom:1},agent_run:{id:'run',status:'running'},agent_sessions:[{id:'s',messages:[]}]});
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
