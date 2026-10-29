import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { canvasAgentOperationGroups, canvasAgentOperationCategory } from '../src/app/canvas/agent/canvas-agent-operation-groups.ts';
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
test('consecutive actions share a collapsible batch without reordering text or questions',()=>{
 const entries=[operation('a','create'),operation('b','generate'),operation('c','read'),operation('d','read'),{id:'text',type:'text',text:'下一步'},operation('e','read'),{id:'q',type:'question',question:'继续？'},operation('f','plan'),operation('g','workflow')];
 const groups=canvasAgentOperationGroups(entries);
 assert.deepEqual(groups.map(g=>g.type==='operations'?[g.category,g.entries.map(e=>e.id)]:g.id),[['nodes',['a','b']],['tools',['c','d']],'text',['tools',['e']],'q',['plan',['f']],['workflow',['g']]]);
});
