import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { calculateAssessment, getStructure } from '../src/assessment.js';
import { decryptAccessCode, encryptAccessCode } from '../src/security.js';
process.env.NODE_ENV = 'test';
process.env.TOKEN_SECRET = 'quality-test-secret-only-never-use-in-production';
process.env.ADMIN_EMAIL = 'quality@example.test';
process.env.ADMIN_PASSWORD = 'Quality-test-password-2026';
process.env.COOKIE_SECURE = 'false';
process.env.RESEND_API_KEY = '';
process.env.RESEND_FROM = '';
process.env.SCORING_PROFILE = 'current50';
let checks = 0;
const check = (value, expected, label) => { assert.deepEqual(value, expected, label); checks++; };
const fixtureCode = 'MNR-FIXTURE-CODE-2026';
const fixtureIv = Buffer.from('000102030405060708090a0b', 'hex');
const fixtureKey = crypto.createHash('sha256').update(`manar-access-code-v1:${process.env.TOKEN_SECRET}`, 'utf8').digest();
const fixtureCipher = crypto.createCipheriv('aes-256-gcm', fixtureKey, fixtureIv);
const fixtureEncrypted = Buffer.concat([fixtureCipher.update(fixtureCode, 'utf8'), fixtureCipher.final(), fixtureCipher.getAuthTag()]);
const workerFixture = `v1.${fixtureIv.toString('base64url')}.${fixtureEncrypted.toString('base64url')}`;
check(decryptAccessCode(workerFixture), fixtureCode, 'Node decrypts canonical Worker AES fixture');
const nodeCiphertext = encryptAccessCode(fixtureCode);
const [cipherVersion, cipherIv, cipherPayload, ...cipherExtra] = nodeCiphertext.split('.');
check(cipherVersion, 'v1', 'encrypted code uses v1');
check(cipherExtra.length, 0, 'encrypted code uses canonical three-part format');
const workerKey = await crypto.webcrypto.subtle.importKey('raw', fixtureKey, 'AES-GCM', false, ['decrypt']);
const workerDecrypted = await crypto.webcrypto.subtle.decrypt(
  { name: 'AES-GCM', iv: Buffer.from(cipherIv, 'base64url') },
  workerKey,
  Buffer.from(cipherPayload, 'base64url')
);
check(Buffer.from(workerDecrypted).toString('utf8'), fixtureCode, 'Worker WebCrypto decrypts Node AES payload');
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
let accessDelivery = 'success';
const accessEmails = [];
const reportEmails = [];
const pausedAccessDeliveries = [];
const emailService = {
  emailReady: () => true,
  async sendAccessCode(payload) {
    accessEmails.push(payload);
    if (accessDelivery === 'paused') return new Promise((resolve) => pausedAccessDeliveries.push(resolve));
    return accessDelivery === 'success' ? { sent: true } : { sent: false, reason: 'delivery_failed' };
  },
  async sendReportLink(payload) {
    reportEmails.push(payload);
    return { sent: true };
  }
};
async function waitFor(condition, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}
const app = await createApp({ databasePath: ':memory:', emailService });
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
  accessDelivery = 'paused';
  const autoRequestPromise = call('/api/requests','POST',{entityName:'جهة الإصدار الفوري',assessorName:'فريق الجودة',email:'instant@example.test',phone:'',notes:''});
  await waitFor(() => accessEmails.length === 1 && pausedAccessDeliveries.length === 1, 'paused immediate email');
  const autoCode = accessEmails[0].code;
  const pendingAutoRequest = app.locals.db.prepare('SELECT id, status FROM requests WHERE email = ?').get('instant@example.test');
  const pendingAutoCode = app.locals.db.prepare('SELECT id, status FROM access_codes WHERE request_id = ?').get(pendingAutoRequest.id);
  check(pendingAutoRequest.status,'pending','request remains pending while provider is paused');
  check(pendingAutoCode.status,'stopped','code remains stopped while provider is paused');
  const earlyClaim = await call('/api/access','POST',{code:autoCode});
  check(earlyClaim.response.status,401,'stopped code cannot be claimed before provider acceptance');
  check(earlyClaim.data.error.includes('MNR-'),true,'stopped code failure uses generic guidance');
  pausedAccessDeliveries.shift()({ sent: true });
  const autoRequest = await autoRequestPromise;
  check(autoRequest.response.status,201,'immediate request accepted');
  check(autoRequest.data.status,'approved','immediate request approved after delivery');
  check(autoRequest.data.emailDelivery.sent,true,'access code delivered immediately');
  check(accessEmails.length,1,'access delivery called once');
  accessDelivery = 'failure';
  const fallbackRequest = await call('/api/requests','POST',{entityName:'جهة تعذر بريدها',assessorName:'فريق بديل',email:'fallback@example.test',phone:'',notes:''});
  check(fallbackRequest.response.status,201,'failed email keeps request accepted');
  check(fallbackRequest.data.status,'pending','failed email falls back to pending');
  check(app.locals.db.prepare('SELECT status FROM requests WHERE id = ?').get(fallbackRequest.data.requestId).status,'pending','fallback persisted pending');
  check(app.locals.db.prepare('SELECT COUNT(*) count FROM access_codes WHERE request_id = ?').get(fallbackRequest.data.requestId).count,0,'failed-delivery code removed');
  accessDelivery = 'success';
  check((await call('/api/admin/login','POST',{email:process.env.ADMIN_EMAIL,password:'bad'})).response.status,401,'bad password');
  check((await call('/api/admin/login','POST',{email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD},admin)).response.status,200,'owner login');
  check((await call('/api/admin/codes','POST',{label:'not allowed'},admin,{Origin:'https://untrusted.example'})).response.status,403,'cross origin blocked');
  accessDelivery = 'paused';
  const concurrentRequestPromise = call('/api/requests','POST',{entityName:'جهة الاعتماد المتزامن',assessorName:'فريق الجودة',email:'concurrent@example.test',phone:'',notes:''});
  await waitFor(() => accessEmails.length === 3 && pausedAccessDeliveries.length === 1, 'concurrent paused email');
  const concurrentCode = accessEmails[2].code;
  const concurrentRequestRow = app.locals.db.prepare('SELECT id, status FROM requests WHERE email = ?').get('concurrent@example.test');
  const concurrentCodeRow = app.locals.db.prepare('SELECT id, status FROM access_codes WHERE request_id = ?').get(concurrentRequestRow.id);
  check(concurrentRequestRow.status,'pending','concurrent request is pending during delivery');
  check(concurrentCodeRow.status,'stopped','concurrent code is stopped during delivery');
  check((await call(`/api/admin/codes/${concurrentCodeRow.id}/status`,'POST',{status:'active'},admin)).response.status,409,'owner cannot activate a staged code before approving its request');
  const concurrentApproval = await call(`/api/admin/requests/${concurrentRequestRow.id}/approve`,'POST',{sendEmail:false},admin);
  check(concurrentApproval.response.status,201,'owner safely approves paused request');
  check(concurrentApproval.data.accessCode,concurrentCode,'owner reuses the exact pending encrypted code');
  check(app.locals.db.prepare('SELECT COUNT(*) count FROM access_codes WHERE request_id = ?').get(concurrentRequestRow.id).count,1,'concurrent approval does not duplicate code');
  pausedAccessDeliveries.shift()({ sent: true });
  const concurrentRequest = await concurrentRequestPromise;
  check(concurrentRequest.data.status,'approved','public completion tolerates concurrent owner approval');
  check(app.locals.db.prepare('SELECT status FROM access_codes WHERE id = ?').get(concurrentCodeRow.id).status,'active','recovered pending code remains active');
  accessDelivery = 'success';
  const ownerOverview = await call('/api/admin/overview','GET',undefined,admin);
  const autoRow = ownerOverview.data.codes.find(row => row.request_id === autoRequest.data.requestId);
  check(Boolean(autoRow),true,'issued code listed for owner');
  check('accessCode' in autoRow,false,'overview omits plaintext code');
  check('access_code' in autoRow,false,'overview omits alternate plaintext field');
  check('code_ciphertext' in autoRow,false,'overview omits ciphertext');
  const encryptedRow = app.locals.db.prepare('SELECT code_ciphertext FROM access_codes WHERE id = ?').get(autoRow.id);
  check(Boolean(encryptedRow.code_ciphertext),true,'new code encrypted at rest');
  check(encryptedRow.code_ciphertext.includes(autoCode),false,'ciphertext does not contain plaintext');
  check((await call(`/api/admin/codes/${autoRow.id}/reveal`,'POST',undefined,admin)).data.accessCode,autoCode,'owner can explicitly reveal code');
  const legacy = app.locals.db.prepare(`INSERT INTO access_codes (label, code_hash, code_last4, status, created_at) VALUES (?, ?, ?, 'active', ?)`).run('رمز قديم','legacy-hash','LEGC',new Date().toISOString());
  check((await call(`/api/admin/codes/${Number(legacy.lastInsertRowid)}/reveal`,'POST',undefined,admin)).response.status,409,'legacy code cannot be revealed');
  const tampered = await call('/api/admin/codes','POST',{label:'رمز مشفر متلاعب به'},admin);
  const tamperedId = app.locals.db.prepare('SELECT id FROM access_codes WHERE code_last4 = ?').get(tampered.data.accessCode.replace(/[^A-Z0-9]/g,'').slice(-4)).id;
  const originalCiphertext = app.locals.db.prepare('SELECT code_ciphertext FROM access_codes WHERE id = ?').get(tamperedId).code_ciphertext;
  app.locals.db.prepare("UPDATE access_codes SET code_ciphertext = code_ciphertext || '.x' WHERE id = ?").run(tamperedId);
  check((await call(`/api/admin/codes/${tamperedId}/reveal`,'POST',undefined,admin)).response.status,409,'tampered ciphertext cannot be revealed');
  app.locals.db.prepare('UPDATE access_codes SET code_ciphertext = ?, code_hash = ? WHERE id = ?').run(originalCiphertext,'mismatched-code-hash',tamperedId);
  check((await call(`/api/admin/codes/${tamperedId}/reveal`,'POST',undefined,admin)).response.status,409,'ciphertext hash mismatch cannot be revealed');
  for (const [body, label] of [[{},'missing'],[{code:''},'empty'],[{code:'X'.repeat(81)},'oversize']]) {
    const invalid = await call('/api/access','POST',body);
    check(invalid.response.status,401,`${label} code is unauthorized`);
    check(invalid.data.error.includes('MNR-'),true,`${label} code uses generic MNR guidance`);
  }
  const compactLowercaseCode = autoCode.replaceAll('-','').toLowerCase();
  check((await call('/api/access','POST',{code:compactLowercaseCode},user)).response.status,200,'compact lowercase emailed code starts assessment');
  const reclaimed = await call('/api/access','POST',{code:autoCode},{});
  check(reclaimed.response.status,401,'code cannot be reclaimed');
  check(reclaimed.data.error.includes('MNR-'),true,'invalid code response gives safe complete-code guidance');
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
  check(reportEmails.length,1,'completed assessment triggers report email');
  check(reportEmails[0].to,'instant@example.test','report email uses request recipient');
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
  check((await call(`/api/admin/codes/${autoRow.id}/reveal`,'POST',undefined,supervisor)).response.status,403,'supervisor cannot reveal codes');
  check((await call(`/api/admin/results/${submitted.data.resultId}`,'DELETE',undefined,supervisor)).response.status,403,'supervisor cannot archive result');
  check((await call(`/api/admin/results/${submitted.data.resultId}/restore`,'POST',undefined,supervisor)).response.status,403,'supervisor cannot restore result');
  check((await call(`/api/admin/results/${submitted.data.resultId}`,'DELETE',undefined,admin)).response.status,200,'owner archives result');
  const archivedOverview = await call('/api/admin/overview','GET',undefined,admin);
  check(archivedOverview.data.results.length,0,'archived result excluded from active overview');
  check(archivedOverview.data.archivedResults.length,1,'archived result available to owner');
  const supervisorArchivedOverview = await call('/api/admin/overview','GET',undefined,supervisor);
  check(supervisorArchivedOverview.data.results.length,0,'archived result hidden from supervisor results');
  check(supervisorArchivedOverview.data.archivedResults.length,0,'archive hidden from supervisor');
  check((await call('/api/reports/'+newToken)).response.status,404,'archived report is private');
  check((await call(`/api/admin/results/${submitted.data.resultId}/advisory`,'PATCH',{recommendations:'x',improvementPlan:'x'},admin)).response.status,404,'archived advisory blocked');
  check((await call(`/api/admin/results/${submitted.data.resultId}/share-link`,'POST',{sendEmail:false},admin)).response.status,404,'archived sharing blocked');
  check((await call(`/api/admin/results/${submitted.data.resultId}/export.xlsx`,'GET',undefined,admin)).response.status,404,'archived export blocked');
  check((await call(`/api/admin/results/${submitted.data.resultId}/restore`,'POST',undefined,admin)).response.status,200,'owner restores result');
  check((await call('/api/reports/'+newToken)).response.status,200,'restored report works again');
  check((await call(`/api/admin/users/${created.data.userId}/status`,'POST',{active:false},admin)).response.status,200,'owner disables supervisor');
  check(app.locals.db.prepare('SELECT COUNT(*) count FROM sessions WHERE user_id = ?').get(created.data.userId).count,0,'deactivation atomically revokes sessions');
  check((await call('/api/admin/me','GET',undefined,supervisor)).response.status,401,'disabled sessions revoked');
  await call(`/api/admin/users/${created.data.userId}/status`,'POST',{active:true},admin);
  const inactiveSupervisor = {};
  check((await call('/api/admin/login','POST',{email:'supervisor@example.test',password:'Supervisor-test-2026'},inactiveSupervisor)).response.status,200,'reactivated supervisor logs in');
  app.locals.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(created.data.userId);
  check((await call('/api/admin/me','GET',undefined,inactiveSupervisor)).response.status,401,'admin middleware rejects inactive user with residual session');
  check(app.locals.db.prepare('SELECT COUNT(*) count FROM sessions WHERE user_id = ?').get(created.data.userId).count,0,'inactive residual session is revoked');
  for (let i=0;i<60;i++) await call('/api/reports/invalid');
  check((await call('/api/reports/invalid')).response.status,429,'report rate limit');
  console.log(`Quality tests passed: ${checks} assertions (scoring, validation, encrypted code reveal, immediate delivery fallback, archive controls, persistence, permissions, links, and rate limits).`);
} finally { await new Promise(r=>server.close(r)); app.locals.db.close(); }
