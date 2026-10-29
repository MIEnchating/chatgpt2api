import { test, expect } from 'bun:test';
import { WorkbenchPreferenceSaver, workbenchPreferenceSignature } from '../src/lib/workbench-preferences.ts';
import { DEFAULT_CREATION_WORKBENCH_PREFERENCES as defaults } from '../src/lib/use-image-generation-preferences.ts';
const snapshot = (model, seconds='5') => ({...defaults, composer_mode:'video', video_model:model, video_seconds:seconds, video_task_count:3, video_parameters:{seed:42,audio:false}});
const deferred = () => {let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('slow writes cannot overtake newer settings and switching models keeps both edits',async()=>{
 const gate=deferred(),calls=[];
 const saver=new WorkbenchPreferenceSaver(async value=>{calls.push(value);if(calls.length===1)await gate.promise;},()=>{});
 saver.enqueue(snapshot('a'));const running=saver.flush();
 saver.enqueue(snapshot('a','8'));saver.enqueue(snapshot('b','9'));saver.enqueue(snapshot('a','10'));
 await saver.flush();expect(calls).toHaveLength(1);
 gate.resolve();await running;
 expect(calls.map(v=>[v.video_model,v.video_seconds])).toEqual([['a','5'],['b','9'],['a','10']]);
 expect(saver.unsaved).toBe(false);saver.stop();
});

test('failed settings are retained and retry saves the latest edit instead of stale values',async()=>{
 const calls=[],errors=[];let fail=true;
 const saver=new WorkbenchPreferenceSaver(async value=>{if(fail)throw Error('offline');calls.push(value);},e=>errors.push(e));
 saver.enqueue(snapshot('a'));await saver.flush();expect(errors).toHaveLength(1);expect(saver.unsaved).toBe(true);
 saver.enqueue(snapshot('a','12'));saver.enqueue(snapshot('b'));
 fail=false;await saver.retry();expect(calls.map(v=>[v.video_model,v.video_seconds])).toEqual([['a','12'],['b','5']]);saver.stop();
});

test('leaving an account discards pending writes',async()=>{
 const calls=[];const saver=new WorkbenchPreferenceSaver(async v=>{calls.push(v);},()=>{});
 saver.enqueue(snapshot('a'));saver.stop();await saver.flush();expect(calls).toHaveLength(0);
});

test('active model signature ignores inactive settings but includes count and custom parameters',()=>{
 const a=snapshot('a');expect(workbenchPreferenceSignature({...a,image_count:6})).toBe(workbenchPreferenceSignature(a));
 expect(workbenchPreferenceSignature({...a,video_task_count:4})).not.toBe(workbenchPreferenceSignature(a));
 expect(workbenchPreferenceSignature({...a,video_parameters:{seed:99}})).not.toBe(workbenchPreferenceSignature(a));
});
