import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, seedOwner } from './db.js';
import { calculateAssessment, getStructure, maturityLabels } from './assessment.js';
import { createAccessCode, hashPassword, hashToken, normalizeCode, randomToken, safeMultilineValue, safePublicValue, verifyPassword } from './security.js';
import { emailReady, sendAccessCode, sendReportLink } from './email.js';
import { createXlsxBuffer } from './xlsx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const vendorDir = path.join(__dirname, '..', 'node_modules');

const requestSchema = z.object({
  entityName: z.string().trim().min(2).max(160),
  assessorName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(180),
  phone: z.string().trim().max(32).optional().default(''),
  notes: z.string().trim().max(1200).optional().default('')
});

const loginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(300) });
const accessSchema = z.object({ code: z.string().trim().min(8).max(40) });
const draftSchema = z.object({
  entity: z.object({ entityName: z.string().trim().min(2).max(160), assessorName: z.string().trim().min(2).max(120), evaluationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => { const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }) }),
  answers: z.record(z.string(), z.number().int().min(1).max(5))
});
const advisorySchema = z.object({ recommendations: z.string().trim().max(8000), improvementPlan: z.string().trim().max(8000) });
const userSchema = z.object({ email: z.string().trim().email().max(180), password: z.string().min(12).max(300), role: z.enum(['supervisor']).default('supervisor') });

export async function createApp(options = {}) {
  const app = express();
  const db = options.db || openDatabase(options.databasePath);
  await seedOwner(db);
  app.locals.db = db;

  if (String(process.env.TRUST_PROXY || '') === '1') app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Exact pseudo-element stylesheet injected by pinned html2canvas 1.4.1.
        // Allow this one stylesheet without enabling arbitrary inline styles.
        styleSrc: ["'self'", "'sha256-UP0QZg7irvSMvOBz9mH2PIIE28+57UiavRfeVea0l3g='"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' }
  }));
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  app.use(originGuard);

  const publicRequestLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false });
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false });
  const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 6, standardHeaders: 'draft-8', legacyHeaders: false });
  const reportLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'طلبات كثيرة للتقارير. يرجى الانتظار دقيقة ثم المحاولة.' } });
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(['/api/reports', '/r'], reportLimiter);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/config', (_req, res) => res.json({
    profile: scoringProfile(),
    emailReady: emailReady(),
    brand: 'مقياس منار للتميز التربوي المؤسسي'
  }));

  app.post('/api/requests', publicRequestLimiter, (req, res) => {
    const data = parse(requestSchema, req.body);
    const now = new Date().toISOString();
    const result = db.prepare(`INSERT INTO requests (entity_name, assessor_name, email, phone, notes, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(
      safePublicValue(data.entityName, 160), safePublicValue(data.assessorName, 120), data.email.toLowerCase(),
      safePublicValue(data.phone, 32), safePublicValue(data.notes, 1200), now
    );
    res.status(201).json({ ok: true, requestId: Number(result.lastInsertRowid), message: 'تم استلام الطلب وسيصل رمز الدخول بعد اعتماده.' });
  });

  app.post('/api/admin/login', loginLimiter, async (req, res) => {
    const data = parse(loginSchema, req.body);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(data.email.toLowerCase());
    if (!user || !user.active || !(await verifyPassword(data.password, user.password_hash))) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة.' });
    const rawToken = randomToken();
    const now = new Date();
    const expires = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
    db.prepare('INSERT INTO sessions (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(user.id, hashToken('admin-session', rawToken), expires.toISOString(), now.toISOString());
    setCookie(res, 'manar_admin', rawToken, 8 * 60 * 60 * 1000);
    res.json({ ok: true, user: { email: user.email, role: user.role } });
  });

  app.post('/api/admin/logout', requireAdmin(db), (req, res) => {
    if (req.cookies.manar_admin) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken('admin-session', req.cookies.manar_admin));
    clearCookie(res, 'manar_admin');
    res.json({ ok: true });
  });

  app.get('/api/admin/me', requireAdmin(db), (req, res) => res.json({ user: req.admin }));

  app.get('/api/admin/overview', requireAdmin(db), (req, res) => {
    const owner = req.admin.role === 'owner';
    const requests = owner ? db.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT 200').all() : [];
    const codes = owner ? db.prepare(`SELECT c.id, c.request_id, c.label, c.code_last4, c.status, c.expires_at, c.claimed_at, c.used_at, c.created_at,
      r.entity_name, r.email FROM access_codes c LEFT JOIN requests r ON r.id = c.request_id ORDER BY c.created_at DESC LIMIT 200`).all() : [];
    const results = db.prepare(`SELECT x.id, x.access_code_id, x.profile, x.entity_json, x.result_json, x.recommendations, x.improvement_plan,
      x.submitted_at, x.updated_at, r.email FROM results x JOIN access_codes c ON c.id = x.access_code_id
      LEFT JOIN requests r ON r.id = c.request_id ORDER BY x.submitted_at DESC LIMIT 200`).all().map((row) => ({
        ...row, entity: JSON.parse(row.entity_json), result: JSON.parse(row.result_json), entity_json: undefined, result_json: undefined
      }));
    const users = owner ? db.prepare('SELECT id, email, role, active, created_at FROM users ORDER BY created_at ASC').all() : [];
    res.json({ requests, codes, results, users, currentUser: req.admin, emailReady: emailReady(), profile: scoringProfile() });
  });

  app.post('/api/admin/requests/:id/approve', requireAdmin(db), requireOwner, async (req, res) => {
    const requestRow = db.prepare('SELECT * FROM requests WHERE id = ?').get(numericId(req.params.id));
    if (!requestRow) return res.status(404).json({ error: 'الطلب غير موجود.' });
    if (requestRow.status === 'rejected') return res.status(409).json({ error: 'الطلب مرفوض. غيّر حالته أولًا.' });
    const created = createCodeRecord(db, { requestId: requestRow.id, label: requestRow.entity_name, expiresInDays: Number(req.body?.expiresInDays || 14) });
    db.prepare("UPDATE requests SET status = 'approved', decided_at = ? WHERE id = ?").run(new Date().toISOString(), requestRow.id);
    let delivery = { sent: false, reason: 'not_requested' };
    if (req.body?.sendEmail !== false) {
      delivery = await sendAccessCode({
        to: requestRow.email, entityName: requestRow.entity_name, code: created.rawCode,
        expiresAt: created.expiresAt, baseUrl: baseUrl(req)
      }).catch((error) => ({ sent: false, reason: error.message }));
    }
    res.status(201).json({ ok: true, accessCode: created.rawCode, expiresAt: created.expiresAt, emailDelivery: delivery });
  });

  app.post('/api/admin/requests/:id/status', requireAdmin(db), requireOwner, (req, res) => {
    const status = z.enum(['pending', 'approved', 'rejected']).parse(req.body?.status);
    const changed = db.prepare('UPDATE requests SET status = ?, decided_at = ? WHERE id = ?').run(status, new Date().toISOString(), numericId(req.params.id));
    if (!changed.changes) return res.status(404).json({ error: 'الطلب غير موجود.' });
    res.json({ ok: true });
  });

  app.post('/api/admin/codes', requireAdmin(db), requireOwner, (req, res) => {
    const label = safePublicValue(req.body?.label || 'رمز مستقل', 160);
    const created = createCodeRecord(db, { label, expiresInDays: Number(req.body?.expiresInDays || 14) });
    res.status(201).json({ ok: true, accessCode: created.rawCode, expiresAt: created.expiresAt });
  });

  app.post('/api/admin/codes/:id/status', requireAdmin(db), requireOwner, (req, res) => {
    const status = z.enum(['active', 'stopped']).parse(req.body?.status);
    const current = db.prepare('SELECT status FROM access_codes WHERE id = ?').get(numericId(req.params.id));
    if (!current) return res.status(404).json({ error: 'الرمز غير موجود.' });
    if (current.status === 'used') return res.status(409).json({ error: 'لا يمكن إعادة تفعيل رمز مستخدم.' });
    db.prepare('UPDATE access_codes SET status = ? WHERE id = ?').run(status, numericId(req.params.id));
    res.json({ ok: true });
  });

  app.patch('/api/admin/results/:id/advisory', requireAdmin(db), (req, res) => {
    const data = parse(advisorySchema, req.body);
    const changed = db.prepare('UPDATE results SET recommendations = ?, improvement_plan = ?, updated_at = ? WHERE id = ?')
      .run(safeMultilineValue(data.recommendations, 8000), safeMultilineValue(data.improvementPlan, 8000), new Date().toISOString(), numericId(req.params.id));
    if (!changed.changes) return res.status(404).json({ error: 'النتيجة غير موجودة.' });
    res.json({ ok: true });
  });

  app.post('/api/admin/users', requireAdmin(db), requireOwner, async (req, res) => {
    const data = parse(userSchema, req.body);
    const email = data.email.toLowerCase();
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'يوجد حساب بهذا البريد.' });
    const passwordHash = await hashPassword(data.password);
    const created = db.prepare("INSERT INTO users (email, password_hash, role, active, created_at) VALUES (?, ?, 'supervisor', 1, ?)")
      .run(email, passwordHash, new Date().toISOString());
    res.status(201).json({ ok: true, userId: Number(created.lastInsertRowid) });
  });

  app.post('/api/admin/users/:id/status', requireAdmin(db), requireOwner, (req, res) => {
    const active = z.boolean().parse(req.body?.active);
    const id = numericId(req.params.id);
    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: 'الحساب غير موجود.' });
    if (target.role === 'owner') return res.status(409).json({ error: 'لا يمكن تعطيل حساب المالك من هذه الواجهة.' });
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    res.json({ ok: true });
  });

  app.post('/api/admin/results/:id/share-link', requireAdmin(db), async (req, res) => {
    const row = db.prepare(`SELECT x.*, r.email FROM results x JOIN access_codes c ON c.id = x.access_code_id
      LEFT JOIN requests r ON r.id = c.request_id WHERE x.id = ?`).get(numericId(req.params.id));
    if (!row) return res.status(404).json({ error: 'النتيجة غير موجودة.' });
    const rawToken = randomToken(32);
    db.prepare('UPDATE results SET report_token_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashToken('report', rawToken), new Date().toISOString(), row.id);
    const reportUrl = `${baseUrl(req)}/r/${rawToken}`;
    let delivery = { sent: false, reason: 'not_requested' };
    if (req.body?.sendEmail && row.email) {
      const entity = JSON.parse(row.entity_json);
      delivery = await sendReportLink({ to: row.email, entityName: entity.entityName, reportUrl })
        .catch((error) => ({ sent: false, reason: error.message }));
    }
    res.json({ ok: true, reportUrl, emailDelivery: delivery });
  });

  app.get('/api/admin/results/:id/export.xlsx', requireAdmin(db), async (req, res) => {
    const row = db.prepare('SELECT * FROM results WHERE id = ?').get(numericId(req.params.id));
    if (!row) return res.status(404).json({ error: 'النتيجة غير موجودة.' });
    const buffer = await createWorkbook(row);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="manar-result-${row.id}.xlsx"`);
    res.send(buffer);
  });

  app.post('/api/access', codeLimiter, (req, res) => {
    const data = parse(accessSchema, req.body);
    const normalized = normalizeCode(data.code);
    const row = db.prepare('SELECT * FROM access_codes WHERE code_hash = ?').get(hashToken('access-code', normalized));
    const now = new Date();
    if (!row || row.status !== 'active' || row.claimed_at || (row.expires_at && new Date(row.expires_at) < now)) {
      return res.status(401).json({ error: 'الرمز غير صالح أو سبق استخدامه.' });
    }
    const rawSession = randomToken();
    const expires = new Date(Math.min(now.getTime() + 48 * 60 * 60 * 1000, row.expires_at ? new Date(row.expires_at).getTime() : Infinity));
    const transaction = () => withTransaction(db, () => {
      const claimed = db.prepare('UPDATE access_codes SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL').run(now.toISOString(), row.id);
      if (claimed.changes !== 1) throw new Error('CODE_ALREADY_CLAIMED');
      db.prepare('INSERT INTO assessment_sessions (access_code_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run(row.id, hashToken('assessment-session', rawSession), expires.toISOString(), now.toISOString());
    });
    try { transaction(); } catch (error) {
      if (error.message === 'CODE_ALREADY_CLAIMED') return res.status(409).json({ error: 'سبق فتح جلسة بهذا الرمز.' });
      throw error;
    }
    setCookie(res, 'manar_assessment', rawSession, expires.getTime() - now.getTime());
    res.json({ ok: true, redirect: '/assessment.html' });
  });

  app.get('/api/assessment', requireAssessment(db), (req, res) => {
    const draft = db.prepare('SELECT * FROM assessment_drafts WHERE session_id = ?').get(req.assessment.sessionId);
    res.json({
      profile: scoringProfile(),
      structure: getStructure(scoringProfile()),
      maturityLabels,
      draft: draft ? { entity: JSON.parse(draft.entity_json), answers: JSON.parse(draft.answers_json), updatedAt: draft.updated_at } : null
    });
  });

  app.put('/api/assessment/draft', requireAssessment(db), (req, res) => {
    const data = parse(draftSchema, req.body);
    const validIds = new Set(getStructure(scoringProfile()).flatMap((domain) => domain.axes.flatMap((axis) => axis.indicators.map((item) => String(item.id)))));
    if (Object.keys(data.answers).some((id) => !validIds.has(id))) return res.status(400).json({ error: 'توجد مؤشرات غير صالحة ضمن الإجابات.' });
    const now = new Date().toISOString();
    const entity = sanitizeEntity(data.entity);
    db.prepare(`INSERT INTO assessment_drafts (session_id, profile, entity_json, answers_json, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET profile = excluded.profile, entity_json = excluded.entity_json,
      answers_json = excluded.answers_json, updated_at = excluded.updated_at`)
      .run(req.assessment.sessionId, scoringProfile(), JSON.stringify(entity), JSON.stringify(data.answers), now);
    res.json({ ok: true, updatedAt: now });
  });

  app.post('/api/assessment/submit', requireAssessment(db), async (req, res) => {
    const data = parse(draftSchema, req.body);
    const entity = sanitizeEntity(data.entity);
    const profile = scoringProfile();
    let calculated;
    try { calculated = calculateAssessment(data.answers, profile); }
    catch (error) {
      if (String(error.message).startsWith('INVALID_ANSWER_')) return res.status(400).json({ error: 'أكمل إجابات جميع المؤشرات قبل إرسال التقييم.' });
      throw error;
    }
    const rawReportToken = randomToken(32);
    const now = new Date().toISOString();
    const transaction = () => withTransaction(db, () => {
      const code = db.prepare('SELECT status FROM access_codes WHERE id = ?').get(req.assessment.accessCodeId);
      if (!code || code.status !== 'active') throw new Error('CODE_NOT_ACTIVE');
      const inserted = db.prepare(`INSERT INTO results
        (access_code_id, profile, entity_json, answers_json, result_json, report_token_hash, submitted_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          req.assessment.accessCodeId, profile, JSON.stringify(entity), JSON.stringify(calculated.answers),
          JSON.stringify(calculated), hashToken('report', rawReportToken), now, now
        );
      db.prepare("UPDATE access_codes SET status = 'used', used_at = ? WHERE id = ?").run(now, req.assessment.accessCodeId);
      db.prepare('DELETE FROM assessment_sessions WHERE id = ?').run(req.assessment.sessionId);
      return Number(inserted.lastInsertRowid);
    });
    let resultId;
    try { resultId = transaction(); } catch (error) {
      if (String(error.message).includes('UNIQUE') || error.message === 'CODE_NOT_ACTIVE') return res.status(409).json({ error: 'تم إرسال هذا التقييم مسبقًا.' });
      throw error;
    }
    clearCookie(res, 'manar_assessment');
    const reportUrl = `${baseUrl(req)}/r/${rawReportToken}`;
    const requestRow = db.prepare(`SELECT r.email FROM requests r JOIN access_codes c ON c.request_id = r.id WHERE c.id = ?`).get(req.assessment.accessCodeId);
    let delivery = { sent: false, reason: 'not_configured' };
    if (requestRow?.email) {
      delivery = await sendReportLink({ to: requestRow.email, entityName: entity.entityName, reportUrl })
        .catch((error) => ({ sent: false, reason: error.message }));
    }
    res.status(201).json({ ok: true, resultId, reportUrl, emailDelivery: delivery });
  });

  app.get('/api/reports/:token', (req, res) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(req.params.token)) return res.status(404).json({ error: 'رابط التقرير غير صالح.' });
    const row = db.prepare('SELECT * FROM results WHERE report_token_hash = ?').get(hashToken('report', req.params.token));
    if (!row) return res.status(404).json({ error: 'التقرير غير موجود أو أن رابطه تم استبداله.' });
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.json({
      id: row.id,
      profile: row.profile,
      entity: JSON.parse(row.entity_json),
      result: JSON.parse(row.result_json),
      recommendations: row.recommendations,
      improvementPlan: row.improvement_plan,
      submittedAt: row.submitted_at,
      updatedAt: row.updated_at
    });
  });

  app.get('/r/:token', (_req, res) => { res.setHeader('Cache-Control', 'private, no-store'); res.sendFile(path.join(publicDir, 'report.html')); });
  app.use('/vendor/html2canvas', express.static(path.join(vendorDir, 'html2canvas', 'dist'), { fallthrough: false }));
  app.use('/vendor/jspdf', express.static(path.join(vendorDir, 'jspdf', 'dist'), { fallthrough: false }));
  app.use(express.static(publicDir, { extensions: ['html'], maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'المسار المطلوب غير موجود.' }));
  app.use((error, _req, res, _next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'تحقق من اكتمال البيانات وصحتها.', details: error.issues.map((item) => item.path.join('.')) });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'صيغة البيانات غير صالحة.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'حجم البيانات أكبر من المسموح.' });
    if (error.status === 404) return res.status(404).json({ error: 'الملف غير موجود.' });
    console.error(error);
    res.status(500).json({ error: 'حدث خطأ غير متوقع. حاول مرة أخرى لاحقًا.' });
  });
  return app;
}

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw result.error;
  return result.data;
}

function scoringProfile() {
  return process.env.SCORING_PROFILE === 'guide48' ? 'guide48' : 'current50';
}

function numericId(value) {
  return z.coerce.number().int().positive().parse(value);
}

function baseUrl(req) {
  const configured = String(process.env.BASE_URL || '').replace(/\/$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}

function cookieOptions(maxAge) {
  return { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production', path: '/', maxAge };
}

function setCookie(res, name, value, maxAge) { res.cookie(name, value, cookieOptions(maxAge)); }
function clearCookie(res, name) { res.clearCookie(name, { ...cookieOptions(0), maxAge: undefined }); }

function originGuard(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'تم رفض الطلب لعدم تطابق المصدر.' });
  } catch { return res.status(403).json({ error: 'تم رفض مصدر الطلب.' }); }
  next();
}

function requireAdmin(db) {
  return (req, res, next) => {
    const raw = req.cookies.manar_admin;
    if (!raw) return res.status(401).json({ error: 'يلزم تسجيل الدخول.' });
    const row = db.prepare(`SELECT u.id, u.email, u.role, s.id session_id, s.expires_at FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hashToken('admin-session', raw));
    if (!row || new Date(row.expires_at) < new Date()) {
      clearCookie(res, 'manar_admin');
      return res.status(401).json({ error: 'انتهت جلسة الدخول.' });
    }
    req.admin = { id: row.id, email: row.email, role: row.role };
    next();
  };
}

function requireAssessment(db) {
  return (req, res, next) => {
    const raw = req.cookies.manar_assessment;
    if (!raw) return res.status(401).json({ error: 'أدخل رمز الدعوة أولًا.' });
    const row = db.prepare(`SELECT s.id session_id, s.access_code_id, s.expires_at, c.status
      FROM assessment_sessions s JOIN access_codes c ON c.id = s.access_code_id WHERE s.token_hash = ?`)
      .get(hashToken('assessment-session', raw));
    if (!row || row.status !== 'active' || new Date(row.expires_at) < new Date()) {
      clearCookie(res, 'manar_assessment');
      return res.status(401).json({ error: 'انتهت جلسة التقييم أو لم تعد صالحة.' });
    }
    req.assessment = { sessionId: row.session_id, accessCodeId: row.access_code_id };
    next();
  };
}

function requireOwner(req, res, next) {
  if (req.admin?.role !== 'owner') return res.status(403).json({ error: 'هذه العملية متاحة للمالك فقط.' });
  next();
}

function createCodeRecord(db, { requestId = null, label, expiresInDays = 14 }) {
  const days = Math.max(1, Math.min(90, Number.isFinite(expiresInDays) ? expiresInDays : 14));
  const rawCode = createAccessCode();
  const normalized = normalizeCode(rawCode);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO access_codes (request_id, label, code_hash, code_last4, status, expires_at, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)`).run(requestId, label, hashToken('access-code', normalized), normalized.slice(-4), expiresAt, now.toISOString());
  return { rawCode, expiresAt };
}

function sanitizeEntity(entity) {
  return {
    entityName: safePublicValue(entity.entityName, 160),
    assessorName: safePublicValue(entity.assessorName, 120),
    evaluationDate: safePublicValue(entity.evaluationDate, 32)
  };
}

function withTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function createWorkbook(row) {
  const entity = JSON.parse(row.entity_json);
  const calculated = JSON.parse(row.result_json);
  const summaryRows = [
    ['الجهة', entity.entityName], ['المقيّم', entity.assessorName], ['تاريخ التقييم', entity.evaluationDate],
    ['تاريخ الإرسال', row.submitted_at], ['ملف الاحتساب', row.profile], ['عدد المؤشرات', calculated.indicatorCount],
    ['النتيجة', `${calculated.overallPercent}%`], ['النقاط', `${calculated.rawPoints} / ${calculated.maxPoints}`],
    ['مستوى النضج', calculated.maturity], ['توصية النظام', calculated.systemRecommendation],
    ['توصيات المشرف', row.recommendations], ['خطة التحسين', row.improvement_plan]
  ];
  const detailRows = [['الرقم', 'المجال', 'المحور', 'المؤشر', 'الوصف', 'الدرجة']];
  const rowsById = [...calculated.strengths, ...calculated.opportunities];
  const structure = getStructure(row.profile);
  for (const domain of structure) for (const axis of domain.axes) for (const indicator of axis.indicators) {
    const match = rowsById.find((item) => item.id === indicator.id);
    detailRows.push([indicator.id, domain.shortTitle, axis.title, indicator.title, indicator.description, calculated.answers[indicator.id] ?? match?.score]);
  }
  return createXlsxBuffer([
    { name: 'الملخص', rows: summaryRows, headerRows: [0], widths: [30, 70] },
    { name: 'التفاصيل', rows: detailRows, headerRows: [0], widths: [10, 28, 32, 32, 75, 12] }
  ]);
}
