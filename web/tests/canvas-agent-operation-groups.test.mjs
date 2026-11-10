import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { canvasAgentOperationGroups, canvasAgentOperationCategory, canvasAgentSummarizeNodeOperations } from '../src/app/canvas/agent/canvas-agent-operation-groups.ts';
import { canvasAgentToolKind, canvasAgentActionTrace, canvasCodexItemTrace } from '../src/app/canvas/agent/canvas-agent-trace.ts';
const operation=(id,kind)=>({id,type:'operation',kind,label:id,status:'success',detail:''});
test('commands distinguish plans, workflows, node mutations, reads and files',()=>{
 for(const [name,category] of [['update_plan','plan'],['set_agent_state','plan'],['run_canvas_workflow','workflow'],['list_workflows','workflow'],['save_workflow','workflow'],['create_group','nodes'],['update_node','nodes'],['delete_connection','nodes'],['arrange_nodes','nodes'],['edit_image','nodes'],['get_node','tools'],['read_skill_file','files']]){
  assert.equal(canvasAgentOperationCategory(operation(name,canvasAgentToolKind(name))),category,name);
  assert.equal(canvasAgentOperationCategory(canvasAgentActionTrace({id:name,name,arguments:{}},{ok:true})),category,name);
 }
 const file=canvasCodexItemTrace({id:'file',type:'fileChange',changes:[{path:'app.ts',diff:'change'}]},true);
 assert.equal(canvasAgentOperationCategory(file),'files');
});
test('node steps use the latest state while retaining separate nodes and failures',()=>{
 const entries=[{...operation('a','create'),nodeId:'one',status:'waiting'}, {...operation('b','create'),nodeId:'two',status:'waiting'}, operation('plan','plan'), {...operation('c','generate'),nodeId:'one'}, {...operation('d','generate'),nodeId:'two',status:'error',detail:'失败原因'}, {...operation('e','generate'),nodeId:'two',status:'running'}];
 const result=canvasAgentSummarizeNodeOperations(entries);
 assert.deepEqual(result.map(e=>[e.id,e.nodeId,e.status]),[['a','one','success'],['b','two','running'],['plan',undefined,'success'],['d','two','error']]);
 assert.equal(result[3].detail,'失败原因');
});
test('consecutive actions share a collapsible batch without reordering text or questions',()=>{
 const entries=[operation('a','create'),operation('b','generate'),operation('c','read'),operation('d','read'),{id:'text',type:'text',text:'下一步'},operation('e','read'),{id:'q',type:'question',question:'继续？'},operation('f','plan'),operation('g','workflow')];
 const groups=canvasAgentOperationGroups(entries);
 assert.deepEqual(groups.map(g=>g.type==='operations'?g.entries.map(e=>e.id):g.id),[['a','b','c','d'],'text',['e'],'q',['f','g']]);
});
