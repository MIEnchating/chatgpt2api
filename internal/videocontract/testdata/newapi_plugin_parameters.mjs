process.on("uncaughtException", error => { console.error(error.message); process.exit(1); });
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runNewAPIVideoPluginDryRun} from '../../../web/src/lib/newapi-video-plugin-checks.ts';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const plugin = await import(`data:text/javascript;base64,${Buffer.from(input.source).toString('base64')}`);
const model = input.options.models[0];
const ctx = body => ({requestBody:{model,prompt:'sample',...body},upstreamModel:model,model,baseUrl:'https://channel.example.com',apiKey:'fixture',files:[]});
const submit = body => plugin.buildSubmitRequest(ctx(body)).body;
assert.throws(()=>submit({}), /Expansion/);
const out = submit({prompt_expansion_mode:'quality',seed:0,prompt_enhance:false,duration:3600});
assert.equal(out.seed,0);
assert.equal(out.prompt_enhance,false);
assert.equal(out.duration,3600);
assert.throws(()=>submit({prompt_expansion_mode:'quality',duration:3601}),/3600/);
assert.throws(()=>plugin.extractUsage(ctx({prompt_expansion_mode:'quality',duration:5000})),/3600/);
assert.equal(out.aigc_watermark,undefined);
assert.equal(out.generate_audio,undefined);
assert.equal(out.callback_url,undefined);
for (const bad of [{seed:0.5},{seed:'0'},{prompt_enhance:0},{callback_url:'file:///secret'},{prompt_expansion_mode:'unknown'}]) {
  assert.throws(()=>submit({prompt_expansion_mode:'quality',...bad}));
}
assert.equal(submit({prompt_expansion_mode:'balanced',input_reference:'https://dry-run.invalid/ref.mp4'}).input_reference,'https://dry-run.invalid/ref.mp4');
assert.throws(()=>submit({prompt_expansion_mode:'balanced',input_reference:['https://dry-run.invalid/ref.mp4']}));
assert.equal(submit({prompt_expansion_mode:'balanced',prompt:undefined}).prompt,undefined);
assert.throws(()=>submit({prompt_expansion_mode:'balanced',prompt:'x'.repeat(41)}));
assert.ok(runNewAPIVideoPluginDryRun(plugin,input).length > 2);
assert.throws(()=>runNewAPIVideoPluginDryRun({...plugin,buildSubmitRequest(ctx){return {...plugin.buildSubmitRequest(ctx),body:{}};}},input),/实际出站请求/);
assert.throws(()=>runNewAPIVideoPluginDryRun({...plugin,buildSubmitRequest(ctx){const out=plugin.buildSubmitRequest(ctx); delete out.body.seed;return out;}},input),/实际出站请求/);
console.log('typed parameters, scalar references, open duration, prompt limits and actual outbound dry-run checks passed');
