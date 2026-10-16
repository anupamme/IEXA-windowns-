const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const browser=process.env.IEXA_TEST_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(x=>fs.existsSync(x));

/* Real rendering of the ask_user card fold: answered cards collapse to a one-line
   summary; the chevron (or the preview line) expands them again. Runs against the
   real renderer in headless Chrome and also captures screenshots for review. */
test('real browser: answered question cards fold to a summary and expand on click', {skip:!browser,timeout:90000},async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-qcard-browser-'));
  process.env.IEXA_WORKSPACE=path.join(dir,'workspace');
  const backend=require('../dist/main/server');const server=await backend.startServer(0,false);const port=server.address().port;
  const code=backend.getServerCredentials(server).loginCode;
  const proc=spawn(browser,['--headless=new','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${path.join(dir,'profile')}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let socket;const exited=once(proc,'exit');
  t.after(async()=>{if(socket){try{socket.close();}catch{}}if(proc.exitCode===null)proc.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,1500))]);server.closeAllConnections();await new Promise(r=>server.close(r));try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:200});}catch{}});

  const wsUrl=await new Promise((resolve,reject)=>{let log='';const timeout=setTimeout(()=>reject(new Error('browser startup timeout')),12000);proc.stderr.on('data',d=>{log+=d;const m=log.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timeout);resolve(m[1]);}});proc.once('error',reject);});
  const endpoint=new URL(wsUrl);const pages=await fetch(`http://${endpoint.host}/json`).then(r=>r.json());
  socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  let sequence=0;const waiting=new Map(),exceptions=[];
  socket.onmessage=event=>{const msg=JSON.parse(event.data);if(msg.method==='Runtime.exceptionThrown')exceptions.push(msg.params.exceptionDetails);const entry=waiting.get(msg.id);if(entry){clearTimeout(entry.timer);waiting.delete(msg.id);entry.resolve(msg);}};
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{waiting.delete(id);reject(new Error('cdp timeout: '+method));},10000);waiting.set(id,{resolve,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async(expression)=>{const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.result&&r.result.exceptionDetails)throw new Error('page eval: '+JSON.stringify(r.result.exceptionDetails).slice(0,900));return r.result&&r.result.result?r.result.result.value:undefined;};
  const wait=async(expression,timeout=20000)=>{const start=Date.now();while(Date.now()-start<timeout){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw new Error('browser wait timeout: '+expression);};
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const shotsDir=path.join(__dirname,'..','workspace','tmp','qcard-fold-shots');fs.mkdirSync(shotsDir,{recursive:true});
  const shot=async(name)=>{try{await evaluate("(() => { const c=document.querySelector('.question-card'); if(c) c.scrollIntoView({block:'center'}); return true; })()");}catch{}await sleep(120);const r=await cdp('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shotsDir,name),Buffer.from(r.result.data,'base64'));};

  await cdp('Page.enable');await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1180,height:860,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/#login=${code}`});
  await wait("typeof window.IexaQuestionCard !== 'undefined' && document.body.dataset.mobileClient === 'desktop'",30000);

  // Mount the real card component into a dedicated holder (the app resets its own
  // chat pane during boot, which would otherwise detach the test card mid-run).
  await sleep(600);
  await evaluate(`(() => {
    const holder=document.createElement('div');
    holder.id='fold-test-host';
    holder.style.cssText='position:fixed;left:18px;top:18px;width:780px;max-height:92vh;overflow:auto;z-index:2147483000';
    document.body.appendChild(holder);
    const orig=(window.IexaApi && typeof window.IexaApi.json==='function')?window.IexaApi.json.bind(window.IexaApi):null;
    window.IexaApi=window.IexaApi||{};
    window.IexaApi.json=async(url,init)=>{ if(String(url).indexOf('/api/questions/')!==-1) return {ok:true}; return orig?orig(url,init):{ok:true}; };
    window.__foldShow=function(extra){
      window.IexaQuestionCard.show(Object.assign({
        id:'browser-fold-'+Date.now(),sessionId:'s-fold',toolCallId:'tool-fold',title:'问答卡片折叠演示',
        questions:[
          {id:'q1',header:'环境',question:'部署到哪个环境？',options:[{label:'测试环境'},{label:'预发环境'},{label:'生产环境'}],multiSelect:false,allowFreeText:false,kind:'choice'},
          {id:'q2',header:'备注',question:'补充一句备注',options:[],multiSelect:false,allowFreeText:true,kind:'text'},
        ],
      },extra||{}),{apiBase:'',mount:function(el){holder.appendChild(el);},scrollToBottom:function(){}});
    };
    window.__foldShow();
    return true;
  })()`);
  await wait("document.querySelectorAll('.question-card').length === 1");
  await shot('fold-1-awaiting.png');

  // Answer q1 (third option), fill q2, submit through the real buttons.
  await evaluate("document.querySelectorAll('.question-option')[2].click()");
  await evaluate("document.querySelector('.question-next').click()");
  await sleep(60);
  await evaluate("(() => { const t=document.querySelector('.question-free-input'); t.value='周五下午发布'; t.dispatchEvent(new Event('input',{bubbles:true})); return true; })()");
  await evaluate("document.querySelector('.question-next').click()");
  await wait("document.querySelector('.question-card').dataset.state === 'submitted'",8000);
  await sleep(150);

  const read=async()=>await evaluate(`(() => {
    const card=document.querySelector('.question-card');
    const display=(sel)=>{const el=card.querySelector(sel);return el?getComputedStyle(el).display:'missing';};
    return {
      state:card.dataset.state,
      collapsed:card.classList.contains('is-collapsed'),
      body:display('.question-card-body'),
      actions:display('.question-card-actions'),
      dots:display('.question-card-dots'),
      note:display('.question-card-note'),
      preview:display('.question-card-preview'),
      toggle:display('.question-card-toggle'),
      qmore:display('.question-card-qmore'),
      qmoreText:(card.querySelector('.question-card-qmore')||{textContent:''}).textContent,
      previewText:(card.querySelector('.question-card-preview')||{textContent:''}).textContent,
      titleText:card.querySelector('.question-card-title').textContent,
      aria:card.querySelector('.question-card-toggle').getAttribute('aria-expanded'),
    };
  })()`);

  // Folded automatically: body/actions/dots/note hidden, one-line preview + chevron visible.
  const folded=await read();
  assert.equal(folded.state,'submitted');
  assert.equal(folded.collapsed,true);
  assert.equal(folded.body,'none');
  assert.equal(folded.actions,'none');
  assert.equal(folded.dots,'none');
  assert.equal(folded.note,'none');
  assert.equal(folded.preview,'block');
  // Chrome blockifies flex items, so the chevron (authored 'inline-flex') reports
  // 'flex' while inside the flex header — accept either spelling.
  assert.ok(folded.toggle==='flex'||folded.toggle==='inline-flex','chevron must become visible');
  assert.equal(folded.aria,'false');
  assert.match(folded.previewText,/生产环境/);
  assert.match(folded.previewText,/周五下午发布/);
  assert.equal(folded.titleText,'部署到哪个环境？');
  assert.equal(folded.qmoreText,'共 2 题');
  assert.notEqual(folded.qmore,'none');
  await shot('fold-2-collapsed.png');

  // Manual expand: full summary returns while the stale action row stays hidden.
  await evaluate("document.querySelector('.question-card-toggle').click()");
  await sleep(80);
  const expanded=await read();
  assert.equal(expanded.collapsed,false);
  assert.notEqual(expanded.body,'none');
  assert.equal(expanded.actions,'none');
  assert.equal(expanded.dots,'none');
  assert.notEqual(expanded.note,'none');
  assert.equal(expanded.preview,'none');
  assert.equal(expanded.aria,'true');
  assert.equal(expanded.titleText,'问答卡片折叠演示');
  assert.equal(expanded.qmore,'none');
  await shot('fold-3-expanded.png');

  // Fold again by chevron.
  await evaluate("document.querySelector('.question-card-toggle').click()");
  await sleep(80);
  assert.equal(await evaluate("document.querySelector('.question-card').classList.contains('is-collapsed')"),true);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.question-card-preview')).display"),'block');

  // A cancelled card folds the same way, showing the outcome note as its preview.
  // A cancelled card folds the same way, showing the outcome note as its preview.
  await evaluate("window.__foldShow({id:'browser-fold-cancel'})");
  await wait("document.querySelectorAll('.question-card').length === 2");
  // Cancelling asks for confirmation first — walk through the real in-document dialog.
  await evaluate("document.querySelectorAll('.question-card')[1].querySelector('.question-card-close').click()");
  await wait("!!document.querySelector('dialog.iexa-app-dialog')",6000);
  await evaluate("document.querySelector('dialog.iexa-app-dialog .btn-primary').click()");
  await wait("document.querySelectorAll('.question-card')[1].dataset.state === 'closed'",8000);
  await sleep(120);
  const closed=await evaluate(`(() => {
    const card=document.querySelectorAll('.question-card')[1];
    return {collapsed:card.classList.contains('is-collapsed'),preview:getComputedStyle(card.querySelector('.question-card-preview')).display,text:card.querySelector('.question-card-preview').textContent,titleText:card.querySelector('.question-card-title').textContent};
  })()`);
  assert.equal(closed.collapsed,true);
  assert.equal(closed.preview,'block');
  assert.match(closed.text,/已取消/);
  assert.equal(closed.titleText,'部署到哪个环境？');

  assert.deepEqual(exceptions,[]);await cdp('Browser.close').catch(()=>{});
});
