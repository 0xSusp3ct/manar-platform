import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { calculateAssessment, getStructure } from '../src/assessment.js';
process.env.NODE_ENV = 'test';
process.env.TOKEN_SECRET = 'quality-test-secret-only-never-use-in-production';
process.env.ADMIN_EMAIL = 'quality@example.test';
process.env.ADMIN_PASSWORD = 'Quality-test-password-2026';
process.env.COOKIE_SECURE = 'false';
process.env.RESEND_API_KEY = '';
process.env.SCORING_PROFILE = 'current50';
let checks = 0;
const check = (value, expected, label) => { assert.deepEqual(value, expected, label); checks++; };
for (const profile of ['current50','guide48']) {
  const items = getStructure(profile).flatMap(d => d.axes.flatMap(a => a.indicators));
  check(items.length, profile === 'current50' ? 50 : 48, `${profile} indicator count`);
  for (const score of [1,3,5]) {
    const result = calculateAssessment(Object.fromEntries(items.map(i => [i.id,score])), profile);
    check(result.rawPoints, items.length * score, 'raw score'); check(result.overallPercent, score * 20, 'percent');
    check(result.axes.length, 10, 'all axes');
    check(result.strengths.length, score === 5 ? items.length : 0, 'strengths');
    check(result.opportunities.length, score === 1 ? items.length : 0, 'opportunities');
  }
}
const app = await createApp({ databasePath: ':memory:' });
const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening',r));
const base = `http://127.0.0.1:${server.address().port}`; process.env.BASE_URL = base;
const admin = {}, user = {}, supervisor = {};
async function call(url, method='GET', body, jar, extra = {}) {
  const headers = {Origin:base, ...extra};
  if (body !== undefined) headers['Content-Type']='application/json';
  if (jar) headers.Cookie = Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; ');
  const response = await fetch(base+url,{method,headers,body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
  if (jar) for(const cookie of response.headers.getSetCookie()) { const [pair]=cookie.split(';'); const at=pair.indexOf('='); jar[pair.slice(0,at)]=pair.slice(at+1); }
  return {response,data:await response.json().catch(()=>({}))};
}
try {
  check((await call('/api/admin/overview')).response.status,401,'private administration');
  check((await call('/api/admin/results/1/export.xlsx')).response.status,401,'private Excel');
  check((await call('/api/requests','POST',{entityName:'x'})).response.status,400,'invalid request');
  check((await call('/api/access','POST','{bad')).response.status,400,'malformed JSON');
  check((await call('/api/admin/login','POST',{email:process.env.ADMIN_EMAIL,password:'bad'})).response.status,401,'bad password');
  check((await call('/api/admin/login','POST',{email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD},admin)).response.status,200,'owner login');
  check((await call('/api/admin/codes','POST',{label:'not allowed'},admin,{Origin:'https://untrusted.example'})).response.status,403,'cross origin blocked');
  const code = await call('/api/admin/codes','POST',{label:'اختبار الجودة'},admin);
  check((await call('/api/access','POST',{code:code.data.accessCode},user)).response.status,200,'code starts assessment');
  check((await call('/api/access','POST',{code:code.data.accessCode},{})).response.status,401,'code cannot be reclaimed');
  const structure = (await call('/api/assessment','GET',undefined,user)).data.structure;
  const answers = Object.fromEntries(structure.flatMap(d=>d.axes.flatMap(a=>a.indicators)).map(i=>[i.id,4]));
  const entity = {entityName:'اختبار الجودة',assessorName:'فريق التقييم',evaluationDate:'2026-09-13'};
  check((await call('/api/assessment/submit','POST',{entity,answers:{}},user)).response.status,400,'incomplete answers');
  check((await call('/api/assessment/draft','PUT',{entity:{...entity,evaluationDate:'2026-02-30'},answers},user)).response.status,400,'invalid calendar date');
  check((await call('/api/assessment/draft','PUT',{entity,answers:{999:2}},user)).response.status,400,'unknown indicator');
  check((await call('/api/assessment/draft','PUT',{entity,answers:{1:6}},user)).response.status,400,'invalid score');
  check((await call('/api/assessment/draft','PUT',{entity,answers},user)).response.status,200,'save draft');
  check((await call('/api/assessment','GET',undefined,user)).data.draft.answers,answers,'restore all answers');
  const submitted=await call('/api/assessment/submit','POST',{entity,answers},user);
  check(submitted.response.status,201,'submit');
  check((await call('/api/assessment/submit','POST',{entity,answers},user)).response.status,401,'immutable submission');
  const token = new URL(submitted.data.reportUrl).pathname.split('/').pop();
  const report=await call('/api/reports/'+token);
  check(report.data.result.overallPercent,80,'server calculated score');
  check(report.response.headers.get('cache-control').includes('no-store'),true,'report no cache');
  check(report.response.headers.get('referrer-policy'),'no-referrer','private URL no referrer');
  const replacement=await call(`/api/admin/results/${submitted.data.resultId}/share-link`,'POST',{sendEmail:false},admin);
  check((await call('/api/reports/'+token)).response.status,404,'revoked report link');
  const newToken=new URL(replacement.data.reportUrl).pathname.split('/').pop();
  check((await call('/api/reports/'+newToken)).response.status,200,'new report link');
  const created = await call('/api/admin/users','POST',{email:'supervisor@example.test',password:'Supervisor-test-2026',role:'supervisor'},admin);
  await call('/api/admin/login','POST',{email:'supervisor@example.test',password:'Supervisor-test-2026'},supervisor);
  check((await call('/api/admin/codes','POST',{label:'forbidden'},supervisor)).response.status,403,'supervisor cannot issue codes');
  await call(`/api/admin/users/${created.data.userId}/status`,'POST',{active:false},admin);
  check((await call('/api/admin/me','GET',undefined,supervisor)).response.status,401,'disabled sessions revoked');
  for (let i=0;i<60;i++) await call('/api/reports/invalid');
  check((await call('/api/reports/invalid')).response.status,429,'report rate limit');
  console.log(`Quality tests passed: ${checks} assertions (scoring, validation, persistence, permissions, links, and rate limits).`);
} finally { await new Promise(r=>server.close(r)); app.locals.db.close(); }
