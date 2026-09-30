import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaults, normalizeSettings, makeMessages, publicSettings, resolveModePrompt} from '../src/core.ts';
import {builtinPrompts, promptLocale, resolvePrompts, DEFAULT_PROMPTS} from '../src/prompts.ts';
import {buildJevBody} from '../src/search-core.ts';
const input={text:'内卷',context:'这家公司很内卷。',modeId:'smart'};
test('all built-in English requests include English instructions, modes, length and language names',()=>{
 const s=defaults();s.uiLanguage='en';const original=structuredClone(s);
 for(const m of s.modes)for(const length of ['short','standard','detailed','custom'] as const){s.length=length;const {system,turns}=makeMessages(s,{...input,modeId:m.id});assert.doesNotMatch(system,/[\u4e00-\u9fff]/);assert.match(system,/Respond in English\./);assert.equal(JSON.parse(turns[0].content.split('\n')[1]).selectedText,input.text);}
 for(const action of ['translate','learn'] as const){const {system,turns}=makeMessages(s,{...input,action});assert.doesNotMatch(system,/[\u4e00-\u9fff]/);assert.equal(JSON.parse(turns[0].content).selectedText,input.text);}
 assert.deepEqual(s.prompts,original.prompts);assert.deepEqual(s.modes,original.modes);
 assert.doesNotMatch(publicSettings(s).prompts.followExample,/[\u4e00-\u9fff]/);
});
test('explicit prompt language is independent of UI and output language; old custom values survive',()=>{
 const legacy:any=defaults();delete legacy.promptLanguage;legacy.profiles[0].apiKey='fake-preserved';legacy.prompts.learn='CUSTOM {{learningLanguage}}';
 const s=normalizeSettings(legacy);assert.equal(s.promptLanguage,'system');assert.equal(s.prompts.learn,legacy.prompts.learn);assert.equal(s.profiles[0].apiKey,'fake-preserved');
 s.uiLanguage='en';s.promptLanguage='zh-CN';assert.match(makeMessages(s,input).system,/默认用English回答/);
 s.uiLanguage='zh-CN';s.promptLanguage='en';assert.match(makeMessages(s,input).system,/Respond in Simplified Chinese/);
 s.translation.learningLanguage='auto';assert.match(makeMessages(s,{...input,action:'learn'}).system,/Chinese input requires Chinese/);
 s.translation.learningLanguage='ja';assert.match(makeMessages(s,{...input,action:'learn'}).system,/selected Japanese as the learning output language/);
 s.modes[0].prompt='自定义：用中文简洁回答';assert.equal(resolveModePrompt(s.modes[0],'en'),s.modes[0].prompt);assert.ok(makeMessages(s,input).system.includes(s.modes[0].prompt));
 s.prompts.explanation='CUSTOM {{modePrompt}} {{language}}';assert.match(makeMessages(s,input).system,/^CUSTOM 自定义/);
});
test('Jev and quick follow-ups resolve built-in variants while custom prompts stay verbatim',()=>{
 const s=defaults();s.uiLanguage='en';s.prompts.jevTrue='我的标准';const resolved=resolvePrompts(s.prompts,promptLocale(s));
 const body=buildJevBody('test','query',[{id:'S0',text:'原文',heading:'',context:''}],resolved);
 assert.equal(body.questions.exists.criteria.true,'我的标准');assert.match(body.questions.where.instructions.task,/^Choose/);
 s.uiLanguage='zh-CN';const chinese=resolvePrompts(s.prompts,promptLocale(s));assert.match(chinese.jevRank,/^选择/);assert.equal(chinese.jevTrue,'我的标准');
 const en=builtinPrompts('en');assert.equal(resolvePrompts(en,'zh-CN').explanation,DEFAULT_PROMPTS.explanation);assert.equal(resolvePrompts(DEFAULT_PROMPTS,'en').followSimpler,en.followSimpler);
});

test('output language constraints override conflicting modes, custom templates and follow-up history',()=>{
 const s=defaults();s.uiLanguage='en';s.modes[0].prompt='只用中文';s.prompts.explanation='只用中文 {{modePrompt}}';s.prompts.translate='只用中文';
 for(const action of ['explain','translate','learn'] as const){s.translation.learningLanguage='en';const m=makeMessages(s,{...input,action,history:[{role:'assistant',content:'中文旧回答'}],question:'用中文继续'});assert.match(m.system,/OUTPUT LANGUAGE REQUIREMENT — English only/);assert.ok(m.system.lastIndexOf('OUTPUT LANGUAGE REQUIREMENT')>m.system.indexOf('只用中文'));assert.match(m.system,/conversation history and follow-ups/);}
});

test('legacy built-in learning and explanation prompts migrate without modifying custom variants',async()=>{
 const {LEGACY_LEARNING_PROMPTS,LEGACY_EXPLANATION_PROMPTS}=await import('../src/legacy-learning-prompts.ts');
 for(const [key,texts]of [['learn',LEGACY_LEARNING_PROMPTS],['explanation',LEGACY_EXPLANATION_PROMPTS]] as const)for(const text of texts){const s=defaults();s.prompts[key]=text;assert.equal(resolvePrompts(s.prompts,'en')[key],builtinPrompts('en')[key]);s.prompts[key]=text+'\nCUSTOM';assert.equal(resolvePrompts(s.prompts,'en')[key],text+'\nCUSTOM');}
});

test('built-in mode names and descriptions follow UI independently; custom fields remain literal',async()=>{
 const {localizedModeField}=await import('../src/core.ts');const s=defaults();const m=s.modes[0];
 assert.equal(localizedModeField(m,'name','en'),'Smart explanation');assert.equal(localizedModeField(m,'description','en'),'Choose the right explanation for the context.');
 m.name='My custom title';assert.equal(localizedModeField(m,'name','zh-CN'),'My custom title');assert.equal(localizedModeField(m,'description','en'),'Choose the right explanation for the context.');
 m.name='Smart explanation';assert.equal(localizedModeField(m,'name','zh-CN'),'智能解释');m.description='自定义保留';assert.equal(localizedModeField(m,'description','en'),'自定义保留');
});
