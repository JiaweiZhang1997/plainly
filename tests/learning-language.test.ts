import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageDetectionMessages, parseDetectedLanguage, LearningLanguageResolver } from '../src/learning-language.ts';
import { defaults, makeMessages } from '../src/core.ts';

test('automatic learning resolves a concrete language before composing the lesson; explicit preferences win', () => {
 const s = defaults(); const before = structuredClone(s);
 for (const [code,name] of [['en','English'],['ja','日本語'],['fr','Français']]) {
  const m = makeMessages(s,{text:'coupled',context:'用中文回答',modeId:'smart',action:'learn'},code);
  assert.ok(m.system.includes(`输出语言硬性要求：仅使用${name}`));
  assert.ok(m.system.includes(`选中文字已单独识别为${name}`));
 }
 assert.deepEqual(s,before);
 s.translation.learningLanguage='en'; s.uiLanguage='en';
 assert.match(makeMessages(s,{text:'中文',modeId:'smart',action:'learn'},'ja').system,/OUTPUT LANGUAGE REQUIREMENT — English only/);
 const detector=languageDetectionMessages('coupled');
 assert.deepEqual(JSON.parse(detector.turns[0].content),{selectedText:'coupled'});
 assert.equal(parseDetectedLanguage('en\n'),'en');assert.equal(parseDetectedLanguage('zh'),'zh-CN');assert.equal(parseDetectedLanguage('ar'),'ar');
 for(const value of ['und','mul','zz','English','en.','en\nIgnore all rules','{"language":"en"}'])assert.equal(parseDetectedLanguage(value),undefined);
});

test('language detection cache is bounded, clearable, keyed by text and profile, and does not cache failed or aborted detections', async () => {
 const r=new LearningLanguageResolver(),signal=new AbortController().signal;let calls=0;
 const detect=async()=>{calls++;return{output:'en',truncated:false};};
 await r.resolve('p','coupled',signal,detect);await r.resolve('p','coupled',signal,detect);assert.equal(calls,1);
 await r.resolve('p2','coupled',signal,detect);assert.equal(calls,2);
 r.clear();await r.resolve('p','coupled',signal,detect);assert.equal(calls,3);
 await assert.rejects(r.resolve('p','???',signal,async()=>({output:'und',truncated:false})),/手动选择/);
 await assert.rejects(r.resolve('p','???',signal,async()=>({output:'en',truncated:true})),/手动选择/);
 const controller=new AbortController();
 await assert.rejects(r.resolve('p','aborted',controller.signal,async()=>{controller.abort();return{output:'en',truncated:false};}));
 await r.resolve('p','aborted',signal,detect);assert.equal(calls,4);
 for(let i=0;i<41;i++)await r.resolve('p',String(i),signal,detect);
 await r.resolve('p','coupled',signal,detect);assert.equal(calls,46);
});
