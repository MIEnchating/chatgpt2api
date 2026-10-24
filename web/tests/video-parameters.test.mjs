import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeVideoParameters, videoDurationValue} from '../src/lib/video-parameters.ts';

const cap = {parameters:[
  {name:'seed',label:'种子',field:'seed',type:'integer',required:false},
  {name:'prompt_enhance',label:'增强',field:'prompt_enhance',type:'boolean',default:true},
  {name:'callback_url',label:'回调',field:'callback_url',type:'string',format:'uri'},
  {name:'prompt_expansion_mode',label:'策略',field:'prompt_expansion_mode',type:'string',required:true,enum:['balanced','quality']},
]};
test('declared parameters preserve zero and false, omit optional callback, require explicit expansion',()=>{
  assert.deepEqual(normalizeVideoParameters({capability:cap},'text',{seed:0,prompt_enhance:false,prompt_expansion_mode:'quality'}),{seed:0,prompt_enhance:false,prompt_expansion_mode:'quality'});
  assert.throws(()=>normalizeVideoParameters({capability:cap},'text',{}),/策略/);
  for(const extra of [{seed:'0'},{seed:1.5},{callback_url:'file:///private'},{unknown:1},{prompt_expansion_mode:'fast'}]) assert.throws(()=>normalizeVideoParameters({capability:cap},'text',{prompt_expansion_mode:'quality',...extra}));
});
test('open duration ranges do not silently snap to an example or truncate at 3600',()=>{
  const range = {seconds:[],default_seconds:8,seconds_range:{min:1,max:null,step:1}};
  assert.equal(videoDurationValue(range,5000),5000);
  assert.throws(()=>videoDurationValue(range,0));
  assert.throws(()=>videoDurationValue({...range,seconds_range:{min:4,max:15,step:2}},5));
});
test('explicit null parameters are rejected instead of silently omitted',()=>{
  for (const name of ['seed','prompt_enhance','callback_url']) {
    assert.throws(()=>normalizeVideoParameters({capability:cap},'text',{prompt_expansion_mode:'quality',[name]:null}));
  }
});
