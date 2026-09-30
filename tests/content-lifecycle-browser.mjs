import {chromium} from 'playwright-core';
import {build} from 'esbuild';
import {mkdtemp,readFile,writeFile,cp,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
let browser;const requests=[],errors=[],checks=[];
const server=createServer(async(req,res)=>{
 if(req.method==='POST'){let raw='';for await(const p of req)raw+=p;requests.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'A graph connects nodes and relationships.'},finish_reason:'stop'}]}));return;}
 res.setHeader('content-type','text/html');res.end('<style>body{margin:90px;font:48px Georgia}p{max-width:800px}iframe{width:600px;height:160px;margin-top:80px}</style><p>Knowledge <span id="word">graphs</span> for predicting effects</p>'+(req.url==='/frame'?'':'<iframe src="/frame"></iframe>'));
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const dir=await mkdtemp(join(tmpdir(),'plainly-lifecycle-')),ext=join(dir,'extension');await cp('dist',ext,{recursive:true});
const manifest=JSON.parse(await readFile(join(ext,'manifest.json'),'utf8'));manifest.content_scripts=[];await writeFile(join(ext,'manifest.json'),JSON.stringify(manifest));
await build({entryPoints:['tests/fixtures/legacy-content.ts'],outfile:join(ext,'legacy.js'),bundle:true,format:'iife',loader:{'.css':'text','.svg':'text'}});
const current=await readFile(join(ext,'content.js'),'utf8');assert.ok(current.includes('__plainly_content_v2__'));
await writeFile(join(ext,'next-world.js'),current.replaceAll('__plainly_content_v2__','__plainly_content_v2_next_world__'));
try{
 browser=await chromium.launchPersistentContext(join(dir,'profile'),{channel:'chromium',headless:true,viewport:{width:1280,height:800},args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});browser.setDefaultTimeout(15000);
 const worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker'),id=new URL(worker.url()).host;
 const options=await browser.newPage();await options.goto(`chrome-extension://${id}/options.html`);await options.waitForFunction(()=>document.querySelector('#enabled-actions')?.children.length===4);
 const logo='data:image/png;base64,'+(await readFile('dist/icons/48.png')).toString('base64');
 await options.evaluate(async({origin,logo})=>{const {value:s}=await chrome.runtime.sendMessage({type:'getSettings'});s.profiles[0].baseUrl=origin+'/v1';s.profiles[0].apiKey='';s.profiles[0].model='fixture';s.triggerIcon=logo;s.triggerSize=40;await chrome.runtime.sendMessage({type:'saveSettings',value:s});},{origin,logo});
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
 const tabId=await worker.evaluate(async origin=>(await chrome.tabs.query({})).find(t=>t.url===origin+'/').id,origin);
 const inject=(file,allFrames=false)=>worker.evaluate(({tabId,file,allFrames})=>chrome.scripting.executeScript({target:{tabId,allFrames},files:[file]}),{tabId,file,allFrames});
 for(let i=0;i<3;i++)await inject('legacy.js');await page.waitForTimeout(100);await page.locator('#word').dblclick();await page.waitForFunction(()=>document.querySelectorAll('plainly-reader').length===3);
 await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/trigger-duplicate-before.png'});checks.push('Reproduced three overlapping readers from surviving legacy listeners');
 await inject('content.js');await page.waitForFunction(()=>document.querySelectorAll('plainly-reader').length===0);
 for(let i=0;i<3;i++){await page.locator('#word').dblclick();await page.waitForTimeout(220);assert.equal(await page.locator('plainly-reader').count(),1);assert.equal(await page.locator('plainly-reader .trigger:visible').count(),1);}
 checks.push('New controller removes legacy UI, including delayed legacy re-mounts after selection');
 const own=`plainly-reader[data-plainly-owner="${id}"]`;
 await page.locator(own+' .trigger').click();await page.locator(own+' .stop').waitFor({state:'hidden'});assert.equal(requests.length,1);await page.locator(own+' .pin').click();
 const token=await page.evaluate(id=>document.documentElement.getAttribute('data-plainly-session-'+id),id);
 for(let i=0;i<4;i++)await inject('content.js');
 assert.equal(await page.evaluate(id=>document.documentElement.getAttribute('data-plainly-session-'+id),id),token);assert.equal(await page.locator(own+' .card:visible').count(),1);assert.equal(requests.length,1);
 checks.push('Repeated same-version injection is a no-op and preserves a pinned answer without duplicate API calls');
 await inject('next-world.js');await page.waitForTimeout(100);assert.notEqual(await page.evaluate(id=>document.documentElement.getAttribute('data-plainly-session-'+id),id),token);
 await page.locator('#word').dblclick();await page.waitForTimeout(220);assert.equal(await page.locator(own).count(),1);await page.locator(own+' .trigger').click();await page.locator(own+' .stop').waitFor({state:'hidden'});
 checks.push('Replacement controller disposes old handlers and observers; only the replacement renders');
 await page.keyboard.press('Escape');await page.evaluate(id=>{document.documentElement.removeAttribute('data-plainly-session-'+id);document.dispatchEvent(new Event('visibilitychange'));},id);assert.equal(await page.locator(own).count(),0);
 await inject('content.js',true);await page.locator('#word').dblclick();await page.waitForTimeout(220);assert.equal(await page.locator(own).count(),1);
 const frame=page.frames().find(f=>f.url()===origin+'/frame');await frame.locator('#word').dblclick();await frame.locator('plainly-reader .trigger').waitFor({state:'visible'});assert.equal(await frame.locator('plainly-reader').count(),1);
 checks.push('Invalidated lease disposes safely; parent and iframe initialize independently');
 await page.evaluate(()=>{const h=document.createElement('plainly-reader');h.dataset.plainlyOwner='another-extension';h.attachShadow({mode:'open'}).innerHTML='<button class="trigger">Other instance</button><div class="card"></div>';document.documentElement.append(h);});await page.waitForTimeout(50);assert.equal(await page.locator('[data-plainly-owner="another-extension"]').count(),1);await page.locator('[data-plainly-owner="another-extension"]').evaluate(el=>el.remove());
 checks.push('A tagged reader owned by another installed extension is not removed');
 await page.locator('#word').dblclick();await page.waitForTimeout(220);assert.equal(await page.locator(own).count(),1);await page.screenshot({path:'test-results/trigger-duplicate-after.png'});
 assert.deepEqual(errors,[]);await writeFile('test-results/content-lifecycle-report.json',JSON.stringify({version:JSON.parse(await readFile('public/manifest.json','utf8')).version,passed:checks.length,checks,requests:requests.length,errors},null,2));console.log(JSON.stringify({passed:checks.length,checks},null,2));
}finally{await browser?.close();server.closeAllConnections();server.close();}
