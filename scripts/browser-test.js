import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../src/app.js';
import { calculateAssessment, getStructure } from '../src/assessment.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || '../../qa-approved-b'); fs.mkdirSync(output,{recursive:true});
process.env.NODE_ENV='test'; process.env.COOKIE_SECURE='false'; process.env.SCORING_PROFILE='current50';
process.env.TOKEN_SECRET='browser-tests-secret-not-for-production-2026'; process.env.RESEND_API_KEY='';
process.env.ADMIN_EMAIL='browser@example.test'; process.env.ADMIN_PASSWORD='Browser-testing-only-2026';
const app=await createApp({databasePath:':memory:'}); const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}`; process.env.BASE_URL=base;
const browser=await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
const failures=[], checks=[];
const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']});
context.setDefaultTimeout(20000);
context.on('page',page=> { page.on('pageerror',e=>failures.push(e.message)); page.on('console',m=>{ if(m.type()==='error' && /Content Security Policy|Refused to|Uncaught/i.test(m.text())) failures.push(m.text()); }); });
async function check(label,work) { await work(); checks.push(label); console.log('PASS '+label); }
async function noOverflow(page,label) { assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,label); }
async function printFits(page) {
  const metrics=await page.locator('.print-page').evaluateAll(pages=>pages.map(p=>{const b=p.querySelector('.print-body');return {width:p.getBoundingClientRect().width,height:p.getBoundingClientRect().height,overflow:b.scrollHeight-b.clientHeight};}));
  assert(metrics.length>=6); assert(metrics.every(p=>p.overflow<=1 && Math.abs(p.width-793.7)<2 && Math.abs(p.height-1122.52)<2),JSON.stringify(metrics)); return metrics;
}
try {
  const page=await context.newPage(); await page.goto(base);
  await check('Request form and desktop home',async()=>{
    await noOverflow(page,'home desktop'); await page.screenshot({path:path.join(output,'home-desktop.png')});
    const form=page.locator('#request-form');
    await form.locator('[name=entityName]').fill('أكاديمية الإبداع - نموذج تجريبي');
    await form.locator('[name=assessorName]').fill('فريق الجودة التجريبي');
    await form.locator('[name=email]').fill('sample@example.test');
    await form.locator('button[type=submit]').click();
    await page.getByText('تم استلام الطلب وسيصل رمز الدخول بعد اعتماده.').waitFor();
  });
  const admin=await context.newPage(); await admin.goto(base+'/admin');
  await admin.locator('#admin-email').fill(process.env.ADMIN_EMAIL); await admin.locator('#admin-password').fill(process.env.ADMIN_PASSWORD);
  await admin.locator('#login-form button').click(); await admin.locator('#requests-body [data-action=approve]').waitFor();
  let code;
  await check('Owner approves request and issues code',async()=>{
    const response=admin.waitForResponse(r=>r.url().includes('/approve')&&r.request().method()==='POST');
    await admin.locator('[data-action=approve]').click(); code=(await (await response).json()).accessCode; assert.match(code,/^MNR-/);
  });
  await page.goto(base+'/enter.html'); await page.locator('#code').fill(code); await page.locator('button[type=submit]').click();
  await page.locator('#entityName').waitFor();
  await check('Metadata validation',async()=> { await page.locator('#next-step').click(); await page.getByText('أكمل بيانات الجهة والتقييم قبل المتابعة.').waitFor(); });
  await page.locator('#entityName').fill('أكاديمية الإبداع - نموذج تجريبي'); await page.locator('#assessorName').fill('فريق الجودة التجريبي'); await page.locator('#evaluationDate').fill('2026-09-13');
  await page.locator('#next-step').click(); await page.locator('#axis-title').waitFor();
  await check('Incomplete axis stays on current step',async()=>{ await page.locator('#next-step').click(); assert.match(await page.locator('#assessment-message').innerText(),/أجب عن جميع/); });
  let indicatorIndex=0;
  for(let axis=0;axis<10;axis++) {
    const ratings=page.locator('.rating'); const count=await ratings.count();
    for(let i=0;i<count;i++) { await ratings.nth(i).locator('button').nth(indicatorIndex++%5).click(); }
    if(axis===0) {
      await check('Autosave and refresh restore answers and step',async()=> {
        await page.waitForFunction(()=>document.getElementById('save-status').textContent==='تم الحفظ');
        await page.reload(); await page.locator('#axis-title').waitFor();
        // All first-axis answers are persisted; the next incomplete axis is opened.
        const saved=await page.evaluate(async()=> (await (await fetch('/api/assessment')).json()).draft);
        assert.equal(Object.keys(saved.answers).length,count);
        await page.locator('#previous-step').click(); assert.equal(await page.locator('.rating .selected').count(),count);
      });
      await check('Save failure is recoverable without skipping a step',async()=> {
        await page.locator('.rating').first().locator('button').nth(1).click();
        await page.route('**/api/assessment/draft',route=>route.abort());
        const title=await page.locator('#axis-title').textContent(); await page.locator('#next-step').click();
        await page.getByText('تعذر حفظ التغييرات. تحقق من الاتصال ثم اضغط حفظ ومتابعة.').waitFor();
        assert.equal(await page.locator('#axis-title').textContent(),title); await page.unroute('**/api/assessment/draft');
      });
      await page.setViewportSize({width:390,height:844}); await noOverflow(page,'assessment mobile'); await page.screenshot({path:path.join(output,'assessment-mobile.png')});
      await page.setViewportSize({width:1440,height:1000});
    }
    await page.locator('#next-step').click();
    await page.waitForFunction(expected=>document.getElementById('progress-label').textContent===expected,axis===9?'المراجعة النهائية':`المحور ${axis+2} من 10`);
    console.log(`Completed axis ${axis+1}`);
  }
  assert.equal(indicatorIndex,50); await page.locator('#confirm-submit').waitFor();
  await check('Final acknowledgement and complete submission',async()=>{
    await page.locator('#next-step').click(); await page.getByText('فعّل الإقرار قبل الإرسال النهائي.').waitFor();
    await page.locator('#confirm-submit').check(); await page.locator('#next-step').click();
    await page.waitForURL('**/r/**'); await page.waitForFunction(()=>document.documentElement.dataset.reportReady==='true');
  });
  const reportUrl=page.url();
  const reportPayload=await (await context.request.get(base+'/api/reports/'+reportUrl.split('/').pop())).json();
  await check('Owner advisory editing preserves scores',async()=>{
    await admin.locator('#refresh-admin').click(); await admin.locator('[data-section=results]').click(); await admin.locator('[data-action=result-details]').click();
    await admin.locator('#recommendations').fill('اعتماد مؤشرات أثر واضحة، ومراجعة الممارسات ذات الأولوية مع فريق الجودة.');
    await admin.locator('#improvement-plan').fill('خلال ٣٠ يومًا: توثيق فرص التحسين وتحديد المسؤوليات.\nخلال ٩٠ يومًا: تنفيذ دورة تحسين وقياس أثرها.');
    await admin.locator('#advisory-form button').click();
    await admin.getByText('حُفظت التوصيات وخطة التحسين.').waitFor();
    await page.reload(); await page.waitForFunction(()=>document.documentElement.dataset.reportReady==='true');
    assert.match(await page.locator('#supervisor-recommendations').innerText(),/مؤشرات أثر/);
  });
  await check('Responsive report: 1440, 768, 390 and 320 pixels',async()=>{
    for(const width of [1440,768,390,320]) {
      await page.setViewportSize({width,height:width===1440?1100:844}); await noOverflow(page,`report ${width}`); await printFits(page);
      if(width===1440 || width===390) await page.screenshot({path:path.join(output,`report-${width}.png`)});
    }
  });
  await check('Share link and summary copy',async()=>{
    await page.locator('#copy-link').click(); assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),reportUrl);
    await page.locator('#copy-summary').click(); assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/أكاديمية الإبداع/);
  });
  await check('Actual mobile PDF download and desktop A4 print',async()=>{
    const downloadEvent=page.waitForEvent('download',{timeout:120000}); await page.locator('#download-pdf').click();
    const download=await downloadEvent; await download.saveAs(path.join(output,'Manar-Approved-B-Sample.pdf'));
    assert(fs.statSync(path.join(output,'Manar-Approved-B-Sample.pdf')).size>50000);
    await page.waitForFunction(()=>!document.getElementById('download-pdf').disabled);
    await page.setViewportSize({width:1440,height:1000});
    await page.pdf({path:path.join(output,'native-print.pdf'),format:'A4',printBackground:true,preferCSSPageSize:true});
    await page.emulateMedia({media:'print'}); assert.equal(await page.locator('#screen-report').isVisible(),false); await page.emulateMedia({media:null});
  });
  await check('Long Arabic text, long names, 8000-character recommendations and all strengths fit A4',async()=>{
    const stress=structuredClone(reportPayload);
    stress.result=calculateAssessment(Object.fromEntries(getStructure().flatMap(d=>d.axes.flatMap(a=>a.indicators)).map(i=>[i.id,5])));
    stress.entity.entityName='اسم جهة تربوية طويلة لاختبار اكتمال التقرير '.repeat(4).slice(0,160);
    stress.entity.assessorName='فريق التقييم والمراجعة المؤسسية '.repeat(5).slice(0,120);
    stress.recommendations=('توصية تطويرية موثقة بأهداف ومؤشرات واضحة ومسؤوليات محددة.\n').repeat(180).slice(0,8000);
    stress.improvementPlan='خ'.repeat(8000);
    await page.route('**/api/reports/*',route=>route.fulfill({json:stress})); await page.reload();
    await page.waitForFunction(()=>document.documentElement.dataset.reportReady==='true'); await printFits(page);
    assert.equal(await page.locator('.print-body').evaluateAll(bodies=>bodies.some(body=>[...body.children].every(child=>/^H[1-6]$/.test(child.tagName)))),false,'No heading-only print pages');
    const content=(await page.locator('#report-pages .print-copy').allTextContents()).join('');
    assert(content.includes(stress.recommendations)); assert(content.includes(stress.improvementPlan));
    await page.pdf({path:path.join(output,'stress-print.pdf'),format:'A4',printBackground:true,preferCSSPageSize:true});
    await page.unroute('**/api/reports/*');
  });
  await check('Invalid report displays a useful error and disables downloads',async()=>{
    await page.goto(base+'/r/invalid'); await page.getByText('رابط التقرير غير مكتمل أو غير صالح.').waitFor(); assert(await page.locator('#download-pdf').isDisabled());
  });
  await check('Mobile home, navigation, access and administration',async()=>{
    await page.setViewportSize({width:320,height:844}); await page.goto(base); await noOverflow(page,'320 home');
    await page.locator('.nav-toggle').click(); assert.equal(await page.locator('.nav-toggle').getAttribute('aria-expanded'),'true');
    await page.goto(base+'/enter.html'); await noOverflow(page,'320 access');
    await admin.setViewportSize({width:390,height:844}); await noOverflow(admin,'390 admin');
  });
  assert.deepEqual(failures,[],'No browser JavaScript or CSP errors'); checks.push('No browser JavaScript or CSP errors');
  fs.writeFileSync(path.join(output,'browser-results.json'),JSON.stringify({checks,passed:checks.length,failures},null,2));
  console.log(`Browser checks passed: ${checks.length}. Artifacts: ${output}`);
} catch(error) {
  console.error(error);
  for(const [i,p] of context.pages().entries()) { console.error('PAGE',p.url(),(await p.locator('body').innerText()).slice(0,1200)); await p.screenshot({path:path.join(output,`failure-${i}.png`)}).catch(()=>{}); }
  throw error;
} finally { await browser.close(); await new Promise(r=>server.close(r)); app.locals.db.close(); }
