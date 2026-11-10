'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {createOwnedBrowserController}=require('./research-browser');

test('reading buttons and search controls work while transaction buttons stay outside controls',async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  await page.route('https://example.com/**',route=>route.fulfill({contentType:'text/html',body:
    '<button onclick="document.getElementById(\'result\').textContent=\'Expanded source\'">Show more</button><button>Buy TOKEN</button><input type="search" placeholder="Search" onkeydown="if(event.key===\'Enter\')document.getElementById(\'result\').textContent=this.value"><input type="password"><p id="result">Original source</p>'}));
  const controller=createOwnedBrowserController({acquirePage:async()=>({owned:true,page,release:async()=>{}}),lookup:async()=>[{address:'93.184.216.34'}]});
  const initial=await controller.perform({action:'navigate',url:'https://example.com/',reason:'Read fixture'});
  assert.equal(initial.status,'COLLECTED');assert.equal(initial.snapshot.controls.length,1);assert.equal(initial.snapshot.search_fields.length,1);
  const denied=await controller.perform({action:'click',snapshot_id:initial.snapshot.id,node_id:'button-1',reason:'Fixture denial'});
  assert.equal(denied.reason,'BROWSER_NODE_INVALID');
  const clicked=await controller.perform({action:'click',snapshot_id:initial.snapshot.id,node_id:'button-0',reason:'Expand public text'});
  assert.equal(clicked.status,'COLLECTED');assert(clicked.sources[0].blocks[0].text.includes('Expanded source'));
  const searched=await controller.perform({action:'fill',snapshot_id:clicked.snapshot.id,node_id:'search-0',text:'Public query',reason:'Search source'});
  assert.equal(searched.status,'COLLECTED');assert(searched.sources[0].blocks[0].text.includes('Public query'));
});

test('visible CAPTCHA returns an action request without clicking or claiming source evidence',async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  await page.route('https://example.com/**',route=>route.fulfill({contentType:'text/html',body:'<div class="cf-turnstile" style="width:100px;height:50px">Human verification</div>'}));
  const controller=createOwnedBrowserController({acquirePage:async()=>({owned:true,page,release:async()=>{}}),lookup:async()=>[{address:'93.184.216.34'}]});
  const result=await controller.perform({action:'navigate',url:'https://example.com/',reason:'Inspect fixture'});
  assert.equal(result.status,'ACTION_REQUIRED');assert.equal(result.reason,'CAPTCHA_CONFIRMATION_REQUIRED');assert.equal(result.sources.length,0);
});
