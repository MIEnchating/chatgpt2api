process.on("uncaughtException", error => { console.error(error.message); process.exit(1); });
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runNewAPIVideoPluginDryRun} from '../../../web/src/lib/newapi-video-plugin-checks.ts';

const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
const plugin=await import(`data:text/javascript;base64,${Buffer.from(input.source).toString('base64')}`);
const model=input.options.models[0];
function submit(files, extraFields={}) {
  const fields={model:[model],prompt:['sample'],prompt_expansion_mode:['balanced'],...extraFields};
  const intent=plugin.protocols.openai_video.decodeRequest({model,body:{kind:'multipart',fields,files}});
  return plugin.buildSubmitRequest({requestBody:intent.requestBody,model,upstreamModel:model,files,apiKey:'fixture',baseUrl:input.options.base_url});
}
const file=(field,index=0)=>({field,ref:`opaque:${field}:${index}`,filename:`${index}.png`,mimeType:'image/png',size:10});
const frames=[file('image_url'),file('end_image_url')];
const frameRequest=submit(frames);
assert.deepEqual(frameRequest.parts.filter(part=>part.fileRef).map(part=>[part.name,part.fileRef]),frames.map(file=>[file.field,file.ref]));
assert.ok(!frameRequest.parts.some(part=>part.name==='frames'));
const references=[file('images[]'),file('images[]',1),{...file('videos'),mimeType:'video/mp4'}];
const refRequest=submit(references);
assert.deepEqual(refRequest.parts.filter(part=>part.fileRef).map(part=>[part.name,part.fileRef]),references.map(file=>[file.field,file.ref]));
assert.ok(!refRequest.parts.some(part=>part.name==='media'));
assert.throws(()=>submit([file('images[]')],{media:[JSON.stringify({videos:['https://dry-run.invalid/video.mp4']})]}),/混传/);
assert.ok(runNewAPIVideoPluginDryRun(plugin,input).filter(item=>item.includes('文件上传')).length===2);
console.log('first/last frame, repeated reference files, nested paths and mixed URL rejection passed');
