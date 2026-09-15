const state = { data: null, section: 'requests' };
const ui = {
  login: document.getElementById('admin-login'), app: document.getElementById('admin-app'), loginForm: document.getElementById('login-form'),
  loginMessage: document.getElementById('login-message'), message: document.getElementById('admin-message'), title: document.getElementById('admin-section-title'),
  requestsBody: document.getElementById('requests-body'), codesBody: document.getElementById('codes-body'), resultsBody: document.getElementById('results-body'), usersBody: document.getElementById('users-body'),
  pendingCount: document.getElementById('pending-count'), activeCount: document.getElementById('active-count'), resultCount: document.getElementById('result-count'),
  drawer: document.getElementById('admin-drawer'), drawerTitle: document.getElementById('drawer-title'), drawerContent: document.getElementById('drawer-content')
};

initialize();

async function initialize() {
  try { await api('/api/admin/me'); showApp(); await loadOverview(); }
  catch { ui.login.classList.remove('hidden'); }
}

ui.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = ui.loginForm.querySelector('button'); button.disabled = true;
  try {
    await api('/api/admin/login', { method: 'POST', body: { email: document.getElementById('admin-email').value, password: document.getElementById('admin-password').value } });
    showApp(); await loadOverview();
  } catch (error) { show(ui.loginMessage, error.message, 'error'); }
  finally { button.disabled = false; }
});

document.querySelectorAll('[data-section]').forEach((button) => button.addEventListener('click', () => setSection(button.dataset.section)));
document.getElementById('refresh-admin').addEventListener('click', loadOverview);
document.getElementById('logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); window.location.reload(); });
document.getElementById('new-code').addEventListener('click', createManualCode);
document.getElementById('add-supervisor').addEventListener('click', createSupervisor);
document.getElementById('close-drawer').addEventListener('click', closeDrawer);
ui.drawer.addEventListener('click', (event) => { if (event.target === ui.drawer) closeDrawer(); });
document.addEventListener('click', handleAction);

function showApp() { ui.login.classList.add('hidden'); ui.app.classList.remove('hidden'); }

async function loadOverview() {
  try { state.data = await api('/api/admin/overview'); render(); }
  catch (error) { if (error.status === 401) window.location.reload(); else show(ui.message, error.message, 'error'); }
}

function render() {
  const { requests, codes, results, users, currentUser } = state.data;
  const owner = currentUser.role === 'owner';
  document.querySelectorAll('[data-section="requests"], [data-section="codes"], [data-section="users"]').forEach((button) => button.classList.toggle('hidden', !owner));
  document.getElementById('new-code').classList.toggle('hidden', !owner);
  document.getElementById('add-supervisor').classList.toggle('hidden', !owner);
  if (!owner && state.section !== 'results') setSection('results');
  ui.pendingCount.textContent = number(requests.filter((row) => row.status === 'pending').length);
  ui.activeCount.textContent = number(codes.filter((row) => row.status === 'active').length);
  ui.resultCount.textContent = number(results.length);
  ui.requestsBody.innerHTML = requests.length ? requests.map(requestRow).join('') : emptyRow(6, 'لا توجد طلبات بعد.');
  ui.codesBody.innerHTML = codes.length ? codes.map(codeRow).join('') : emptyRow(6, 'لا توجد رموز دخول.');
  ui.resultsBody.innerHTML = results.length ? results.map(resultRow).join('') : emptyRow(5, 'لا توجد نتائج مكتملة.');
  ui.usersBody.innerHTML = users.length ? users.map(userRow).join('') : emptyRow(5, 'لا توجد حسابات إضافية.');
}

function requestRow(row) {
  return `<tr><td><strong>${escapeHtml(row.entity_name)}</strong>${row.notes ? `<br><span class="small muted">${escapeHtml(row.notes)}</span>` : ''}</td><td>${escapeHtml(row.assessor_name)}</td><td><span class="ltr">${escapeHtml(row.email)}</span>${row.phone ? `<br><span class="ltr small">${escapeHtml(row.phone)}</span>` : ''}</td><td>${status(row.status)}</td><td>${date(row.created_at)}</td><td><div class="table-actions">${row.status !== 'approved' ? `<button class="button button-small button-primary" data-action="approve" data-id="${row.id}">اعتماد وإصدار رمز</button>` : ''}${row.status !== 'rejected' ? `<button class="button button-small button-danger" data-action="reject" data-id="${row.id}">رفض</button>` : `<button class="button button-small button-outline" data-action="pending" data-id="${row.id}">إعادة للمراجعة</button>`}</div></td></tr>`;
}

function codeRow(row) {
  const nextStatus = row.status === 'active' ? 'stopped' : 'active';
  const button = row.status === 'used' ? '' : `<button class="button button-small ${row.status === 'active' ? 'button-danger' : 'button-outline'}" data-action="code-status" data-id="${row.id}" data-status="${nextStatus}">${row.status === 'active' ? 'إيقاف' : 'تفعيل'}</button>`;
  return `<tr><td>${escapeHtml(row.entity_name || row.label || 'رمز مستقل')}<br><span class="small muted ltr">${escapeHtml(row.email || '')}</span></td><td class="ltr">•••• ${escapeHtml(row.code_last4)}</td><td>${status(row.status)}</td><td>${row.expires_at ? date(row.expires_at) : '-'}</td><td>${date(row.created_at)}</td><td><div class="table-actions">${button}</div></td></tr>`;
}

function resultRow(row) {
  return `<tr><td><strong>${escapeHtml(row.entity.entityName)}</strong><br><span class="small muted">${escapeHtml(row.entity.assessorName)}</span></td><td>${number(row.result.overallPercent)}٪<br><span class="small muted">${number(row.result.rawPoints)} / ${number(row.result.maxPoints)}</span></td><td>${escapeHtml(row.result.maturity)}</td><td>${date(row.submitted_at)}</td><td><div class="table-actions"><button class="button button-small button-outline" data-action="result-details" data-id="${row.id}">التوصيات والمشاركة</button><a class="button button-small button-light" href="/api/admin/results/${row.id}/export.xlsx">Excel</a></div></td></tr>`;
}

function userRow(row) {
  const active = Boolean(row.active);
  const action = row.role === 'owner' ? '' : `<button class="button button-small ${active ? 'button-danger' : 'button-outline'}" data-action="user-status" data-id="${row.id}" data-active="${active ? 'false' : 'true'}">${active ? 'تعطيل' : 'تفعيل'}</button>`;
  return `<tr><td class="ltr">${escapeHtml(row.email)}</td><td>${row.role === 'owner' ? 'المالك' : 'مشرف التقارير'}</td><td><span class="status ${active ? 'active' : 'stopped'}">${active ? 'فعال' : 'معطل'}</span></td><td>${date(row.created_at)}</td><td>${action}</td></tr>`;
}

async function handleAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const id = Number(button.dataset.id); const action = button.dataset.action;
  button.disabled = true;
  try {
    if (action === 'approve') {
      const result = await api(`/api/admin/requests/${id}/approve`, { method: 'POST', body: { sendEmail: true, expiresInDays: 14 } });
      const emailNote = result.emailDelivery?.sent ? ' وتم إرساله بالبريد.' : ' لم يُرسل بالبريد لأن خدمة الإرسال غير مهيأة أو تعذر الإرسال.';
      show(ui.message, `رمز الدخول: ${result.accessCode}.${emailNote} انسخه الآن؛ لن يظهر كاملًا مرة أخرى.`, 'success'); await loadOverview();
    }
    if (action === 'reject' && window.confirm('هل تريد رفض هذا الطلب؟')) { await api(`/api/admin/requests/${id}/status`, { method: 'POST', body: { status: 'rejected' } }); await loadOverview(); }
    if (action === 'pending') { await api(`/api/admin/requests/${id}/status`, { method: 'POST', body: { status: 'pending' } }); await loadOverview(); }
    if (action === 'code-status') { await api(`/api/admin/codes/${id}/status`, { method: 'POST', body: { status: button.dataset.status } }); await loadOverview(); }
    if (action === 'user-status') { await api(`/api/admin/users/${id}/status`, { method: 'POST', body: { active: button.dataset.active === 'true' } }); await loadOverview(); }
    if (action === 'result-details') openResult(id);
  } catch (error) { show(ui.message, error.message, 'error'); }
  finally { button.disabled = false; }
}

function openResult(id) {
  const row = state.data.results.find((item) => item.id === id);
  if (!row) return;
  ui.drawerTitle.textContent = `تقرير ${row.entity.entityName}`;
  ui.drawerContent.innerHTML = `<div class="grid-2"><div class="card"><span class="muted small">النتيجة</span><h3>${number(row.result.overallPercent)}٪</h3></div><div class="card"><span class="muted small">النضج</span><h3>${escapeHtml(row.result.maturity)}</h3></div></div>
    <form id="advisory-form" data-result-id="${row.id}"><div class="field"><label for="recommendations">توصيات المشرف</label><textarea id="recommendations" maxlength="8000">${escapeHtml(row.recommendations || '')}</textarea></div><div class="field"><label for="improvement-plan">خطة التحسين</label><textarea id="improvement-plan" maxlength="8000">${escapeHtml(row.improvement_plan || '')}</textarea></div><button class="button button-dark" type="submit">حفظ دون تغيير الإجابات</button></form>
    <div class="card"><h3>رابط التقرير الخاص</h3><p>إنشاء رابط جديد يلغي الرابط السابق. يمكن نسخه أو إرساله إلى بريد الجهة.</p><label class="confirm-box"><input id="send-report-email" type="checkbox" ${row.email ? '' : 'disabled'}><span>إرسال الرابط الجديد إلى ${escapeHtml(row.email || 'لا يوجد بريد مرتبط')}</span></label><button class="button button-primary" id="create-report-link" data-result-id="${row.id}" type="button">إنشاء رابط مشاركة جديد</button><div class="notice hidden" id="share-result"></div></div>`;
  ui.drawer.classList.remove('hidden');
  document.getElementById('advisory-form').addEventListener('submit', saveAdvisory);
  document.getElementById('create-report-link').addEventListener('click', createShareLink);
}

async function saveAdvisory(event) {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true;
  try {
    await api(`/api/admin/results/${form.dataset.resultId}/advisory`, { method: 'PATCH', body: { recommendations: document.getElementById('recommendations').value, improvementPlan: document.getElementById('improvement-plan').value } });
    show(ui.message, 'حُفظت التوصيات وخطة التحسين.', 'success'); closeDrawer(); await loadOverview();
  } catch (error) { show(ui.message, error.message, 'error'); }
  finally { button.disabled = false; }
}

async function createShareLink(event) {
  const button = event.currentTarget; const target = document.getElementById('share-result');
  if (!window.confirm('سيتم إلغاء أي رابط مشاركة سابق لهذا التقرير. هل تريد المتابعة؟')) return;
  button.disabled = true;
  try {
    const result = await api(`/api/admin/results/${button.dataset.resultId}/share-link`, { method: 'POST', body: { sendEmail: document.getElementById('send-report-email').checked } });
    target.className = 'notice notice-success'; target.replaceChildren();
    const label = document.createElement('p'); label.textContent = result.emailDelivery?.sent ? 'أُنشئ الرابط وأُرسل بالبريد:' : 'أُنشئ الرابط الخاص:';
    const link = document.createElement('a'); link.href = result.reportUrl; link.textContent = result.reportUrl; link.className = 'ltr'; link.target = '_blank'; link.rel = 'noopener';
    target.append(label, link); await loadOverview();
  } catch (error) { show(target, error.message, 'error'); }
  finally { button.disabled = false; }
}

async function createManualCode() {
  const label = window.prompt('اكتب اسم الجهة أو وصف الرمز:');
  if (!label?.trim()) return;
  try {
    const result = await api('/api/admin/codes', { method: 'POST', body: { label: label.trim(), expiresInDays: 14 } });
    show(ui.message, `الرمز الجديد: ${result.accessCode}. انسخه الآن؛ لن يظهر كاملًا مرة أخرى.`, 'success'); await loadOverview(); setSection('codes');
  } catch (error) { show(ui.message, error.message, 'error'); }
}

async function createSupervisor() {
  const email = window.prompt('البريد الإلكتروني للمشرف:');
  if (!email?.trim()) return;
  const password = window.prompt('كلمة مرور مؤقتة قوية (١٢ حرفًا على الأقل):');
  if (!password) return;
  try {
    await api('/api/admin/users', { method: 'POST', body: { email: email.trim(), password, role: 'supervisor' } });
    show(ui.message, 'تم إنشاء حساب المشرف. شارك بياناته معه عبر قناة آمنة.', 'success'); await loadOverview(); setSection('users');
  } catch (error) { show(ui.message, error.message, 'error'); }
}

function setSection(section) {
  state.section = section;
  const titles = { requests: 'الطلبات', codes: 'رموز الدخول', results: 'النتائج', users: 'المستخدمون' };
  ui.title.textContent = titles[section];
  document.querySelectorAll('[data-section]').forEach((button) => button.classList.toggle('active', button.dataset.section === section));
  document.querySelectorAll('.admin-section').forEach((element) => element.classList.add('hidden'));
  document.getElementById(`${section}-section`).classList.remove('hidden');
}

function closeDrawer() { ui.drawer.classList.add('hidden'); ui.drawerContent.replaceChildren(); }
function status(value) { const labels = { pending: 'قيد المراجعة', approved: 'معتمد', rejected: 'مرفوض', active: 'فعال', used: 'مستخدم', stopped: 'موقوف' }; return `<span class="status ${value}">${labels[value] || escapeHtml(value)}</span>`; }
function emptyRow(columns, text) { return `<tr><td colspan="${columns}"><div class="empty-state">${text}</div></td></tr>`; }
function date(value) { return value ? new Intl.DateTimeFormat('ar-SA', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value)) : '-'; }
function number(value) { return new Intl.NumberFormat('ar-SA', { maximumFractionDigits: 1 }).format(value); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
function show(element, text, type) { element.textContent = text; element.className = `notice ${type === 'error' ? 'notice-error' : 'notice-success'}`; }

async function api(url, options = {}) {
  const response = await fetch(url, { method: options.method || 'GET', credentials: 'same-origin', headers: options.body ? { 'Content-Type': 'application/json' } : undefined, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || 'تعذر إكمال الطلب.'); error.status = response.status; throw error; }
  return data;
}
