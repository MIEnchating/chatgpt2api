import assert from 'node:assert/strict';
import test from 'node:test';
import {videoPluginDefaults} from '../src/lib/video-plugin-defaults.ts';

const contract={name:'供应商视频',models:['MiniMax H3'],driver:'custom-video',transport:{create_path:'/v1/videos',query_path:'/v1/videos/{task_id}'},artifact:{mode:'task_content',content_path:'/v1/videos/{task_id}/content',auth:'relay'},polling:{result_fields:[]}};
test('document provider and content protocol populate plugin options',()=>{
 const value=videoPluginDefaults({...contract,provider:{base_url:'https://api.example.com',auth_mode:'header',auth_header:'X-Api-Key'}});
 assert.equal(value.baseURL,'https://api.example.com');assert.equal(value.authMode,'header');assert.equal(value.authHeader,'X-Api-Key');
 assert.equal(value.downloadMode,'task_content');assert.equal(value.models,'MiniMax H3');assert.equal(value.version,'1.0.0');assert.equal(value.resultFields,'');
});
test('unknown provider remains unset and documented no-auth remains explicit',()=>{
 const unknown=videoPluginDefaults(contract);assert.equal(unknown.baseURL,'');assert.equal(unknown.authMode,'');assert.equal(unknown.authHeader,'');
 assert.equal(videoPluginDefaults({...contract,provider:{base_url:'',auth_mode:'none',auth_header:''}}).authMode,'none');
});
test('result URL mode follows artifact authentication and requires a result field',()=>{
 const response={...contract,artifact:{mode:'response_url',auth:'none'},polling:{result_fields:['data.url']}};
 assert.equal(videoPluginDefaults(response).downloadMode,'signed_url');
 assert.equal(videoPluginDefaults({...response,artifact:{...response.artifact,auth:'relay'}}).downloadMode,'authenticated_url');
 assert.equal(videoPluginDefaults({...response,polling:{result_fields:[]}}).downloadMode,'');
 assert.equal(videoPluginDefaults({...contract,artifact:{mode:'task_content',content_path:''}}).downloadMode,'');
});
test('plugin identity remains stable after saving and differs across contracts',()=>{
 const first=videoPluginDefaults(contract).key;
 assert.match(first,/^[a-z0-9][a-z0-9_-]{0,29}$/);
 assert.equal(videoPluginDefaults(structuredClone(contract)).key,first);
 assert.equal(videoPluginDefaults({...contract,name:'改名',provider:{auth_mode:'bearer'}}).key,first);
 assert.notEqual(videoPluginDefaults({...contract,models:['MiniMax H3 Official']}).key,first);
 const multiple={...contract,models:['provider/video-very-long-name-two','provider/video-very-long-name-one']};
 assert.equal(videoPluginDefaults(multiple).key,videoPluginDefaults({...multiple,models:[...multiple.models].reverse()}).key);
 assert.ok(videoPluginDefaults(multiple).key.length<=30);
});
