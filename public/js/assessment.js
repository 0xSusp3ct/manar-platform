const ui = {
  loading: document.getElementById('loading'), content: document.getElementById('assessment-content'),
  metaStep: document.getElementById('meta-step'), axisStep: document.getElementById('axis-step'), reviewStep: document.getElementById('review-step'),
  entityName: document.getElementById('entityName'), assessorName: document.getElementById('assessorName'), evaluationDate: document.getElementById('evaluationDate'),
  domainTitle: document.getElementById('domain-title'), axisTitle: document.getElementById('axis-title'), questionList: document.getElementById('question-list'),
  previous: document.getElementById('previous-step'), next: document.getElementById('next-step'), progress: document.getElementById('progress-fill'),
  progressLabel: document.getElementById('progress-label'), saveStatus: document.getElementById('save-status'), stepCounter: document.getElementById('step-counter'),
  message: document.getElementById('assessment-message'), reviewSummary: document.getElementById('review-summary'), confirm: document.getElementById('confirm-submit')
};

let meta;
let axes = [];
let answers = {};
let currentStep = 0;
let savePromise;
let revision = 0;
let savedRevision = 0;
let saveTimer;
let navigating = false;
let submitting = false;

initialize();

async function initialize() {
  try {
    meta = await api('/api/assessment');
    axes = meta.structure.flatMap((domain) => domain.axes.map((axis) => ({ ...axis, domainTitle: domain.title })));
    answers = meta.draft?.answers || {};
    ui.entityName.value = meta.draft?.entity?.entityName || '';
    ui.assessorName.value = meta.draft?.entity?.assessorName || '';
    ui.evaluationDate.value = meta.draft?.entity?.evaluationDate || today();
    if (meta.draft) {
      const firstIncomplete = axes.findIndex((axis) => axis.indicators.some((item) => !answers[item.id]));
      currentStep = firstIncomplete < 0 ? axes.length + 1 : firstIncomplete + 1;
      ui.saveStatus.textContent = 'تم استرجاع التقييم المحفوظ';
    }
    ui.loading.classList.add('hidden');
    ui.content.classList.remove('hidden');
    render();
  } catch (error) {
    if (error.status === 401) window.location.replace('/enter.html');
    else ui.loading.textContent = error.message;
  }
}

ui.previous.addEventListener('click', async () => {
  if (navigating || submitting) return;
  clearMessage();
  await navigate(-1);
});

ui.next.addEventListener('click', async () => {
  if (navigating || submitting) return;
  clearMessage();
  if (currentStep === 0 && !validateEntity()) return;
  if (currentStep > 0 && currentStep <= axes.length && !validateAxis(axes[currentStep - 1])) return;
  if (currentStep === axes.length + 1) return submitAssessment();
  await navigate(1);
});

async function navigate(direction) {
  navigating = true; ui.next.disabled = true; ui.previous.disabled = true;
  clearTimeout(saveTimer);
  try {
    await saveDraft();
    currentStep = Math.max(0, Math.min(axes.length + 1, currentStep + direction));
    render(); window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch { /* saveDraft has already shown the recoverable error. Stay on this step. */ }
  finally { navigating = false; ui.next.disabled = false; ui.previous.disabled = currentStep === 0; }
}

function changed() {
  revision += 1; ui.saveStatus.textContent = 'تغييرات غير محفوظة'; clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!navigating && !submitting && validEntity()) saveDraft().catch(() => {});
  }, 600);
}
[ui.entityName, ui.assessorName, ui.evaluationDate].forEach((input) => input.addEventListener('input', changed));
window.addEventListener('beforeunload', (event) => {
  if (revision !== savedRevision && !submitting) { event.preventDefault(); event.returnValue = ''; }
});

function render() {
  const totalSteps = axes.length + 2;
  const percent = Math.round((currentStep / (totalSteps - 1)) * 100);
  ui.progress.style.width = `${percent}%`;
  ui.progressLabel.textContent = currentStep === 0 ? 'بيانات التقرير' : currentStep <= axes.length ? `المحور ${currentStep} من ${axes.length}` : 'المراجعة النهائية';
  ui.stepCounter.textContent = `الخطوة ${currentStep + 1} من ${totalSteps}`;
  ui.previous.disabled = currentStep === 0;
  ui.metaStep.classList.toggle('hidden', currentStep !== 0);
  ui.axisStep.classList.toggle('hidden', currentStep === 0 || currentStep > axes.length);
  ui.reviewStep.classList.toggle('hidden', currentStep !== axes.length + 1);
  ui.next.textContent = currentStep === axes.length + 1 ? 'إرسال التقييم وإنشاء التقرير' : 'حفظ ومتابعة';
  ui.next.className = `button ${currentStep === axes.length + 1 ? 'button-primary' : 'button-dark'}`;
  if (currentStep > 0 && currentStep <= axes.length) renderAxis(axes[currentStep - 1]);
  if (currentStep === axes.length + 1) {
    const count = Object.keys(answers).length;
    ui.reviewSummary.textContent = `تمت الإجابة عن ${formatNumber(count)} مؤشرًا. ملف الاحتساب المستخدم: ${meta.profile === 'guide48' ? 'نسخة الدليل - ٤٨ مؤشرًا' : 'نسخة الموقع الحالية - ٥٠ مؤشرًا'}.`;
  }
}

function renderAxis(axis) {
  ui.domainTitle.textContent = axis.domainTitle;
  ui.axisTitle.textContent = `${axis.id} ${axis.title}`;
  ui.questionList.replaceChildren();
  for (const indicator of axis.indicators) {
    const card = document.createElement('article');
    card.className = `question${answers[indicator.id] ? ' answered' : ''}`;
    const head = document.createElement('div'); head.className = 'question-head';
    const number = document.createElement('span'); number.className = 'question-number'; number.textContent = formatNumber(indicator.id);
    const copy = document.createElement('div');
    const title = document.createElement('h3'); title.textContent = indicator.title;
    const description = document.createElement('p'); description.textContent = indicator.description;
    copy.append(title, description); head.append(number, copy); card.append(head);
    const rating = document.createElement('div'); rating.className = 'rating'; rating.setAttribute('role', 'radiogroup'); rating.setAttribute('aria-label', `تقييم ${indicator.title}`);
    for (let score = 1; score <= 5; score += 1) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = formatNumber(score);
      button.setAttribute('role', 'radio'); button.setAttribute('aria-checked', String(answers[indicator.id] === score));
      button.title = meta.maturityLabels[score].label;
      if (answers[indicator.id] === score) button.classList.add('selected');
      button.addEventListener('click', () => {
        answers[indicator.id] = score;
        card.classList.add('answered');
        [...rating.children].forEach((item, index) => { item.classList.toggle('selected', index + 1 === score); item.setAttribute('aria-checked', String(index + 1 === score)); });
        changed();
      });
      rating.append(button);
    }
    const legend = document.createElement('div'); legend.className = 'rating-legend'; legend.innerHTML = '<span>١ - غير مفعّل</span><span>٥ - متميز</span>';
    card.append(rating, legend); ui.questionList.append(card);
  }
}

function validateEntity() {
  if (!validEntity()) {
    showMessage('أكمل بيانات الجهة والتقييم قبل المتابعة.'); return false;
  }
  return true;
}

function validEntity() { return ui.entityName.value.trim().length >= 2 && ui.assessorName.value.trim().length >= 2 && ui.evaluationDate.validity.valid && /^\d{4}-\d{2}-\d{2}$/.test(ui.evaluationDate.value); }

function validateAxis(axis) {
  const missing = axis.indicators.filter((indicator) => !answers[indicator.id]);
  if (missing.length) { showMessage(`أجب عن جميع مؤشرات هذا المحور. المتبقي: ${formatNumber(missing.length)}.`); return false; }
  return true;
}

async function saveDraft() {
  if (savePromise) await savePromise;
  if (!validEntity()) throw new Error('بيانات الجهة غير مكتملة.');
  if (savedRevision === revision && meta.draft) return;
  savePromise = (async () => {
    do {
      const snapshot = revision;
      ui.saveStatus.textContent = 'جارٍ الحفظ...';
      await api('/api/assessment/draft', { method: 'PUT', body: payload() });
      savedRevision = snapshot; meta.draft = true;
    } while (savedRevision !== revision);
    ui.saveStatus.textContent = 'تم الحفظ';
  })();
  try { await savePromise; }
  catch (error) { showMessage('تعذر حفظ التغييرات. تحقق من الاتصال ثم اضغط حفظ ومتابعة.'); ui.saveStatus.textContent = 'تعذر الحفظ'; throw error; }
  finally { savePromise = null; }
}

async function submitAssessment() {
  if (submitting) return;
  if (!ui.confirm.checked) return showMessage('فعّل الإقرار قبل الإرسال النهائي.');
  submitting = true; clearTimeout(saveTimer);
  ui.next.disabled = true; ui.previous.disabled = true; ui.next.textContent = 'جارٍ إنشاء التقرير...';
  try {
    if (savePromise) await savePromise;
    const result = await api('/api/assessment/submit', { method: 'POST', body: payload() });
    window.location.assign(result.reportUrl);
  } catch (error) {
    submitting = false; showMessage(error.message); ui.next.disabled = false; ui.previous.disabled = false; ui.next.textContent = 'إرسال التقييم وإنشاء التقرير';
  }
}

function payload() {
  return { entity: { entityName: ui.entityName.value, assessorName: ui.assessorName.value, evaluationDate: ui.evaluationDate.value }, answers };
}

function showMessage(text) { ui.message.textContent = text; ui.message.classList.remove('hidden'); }
function clearMessage() { ui.message.classList.add('hidden'); ui.message.textContent = ''; }
function today() { const date = new Date(); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function formatNumber(value) { return new Intl.NumberFormat('ar-SA', { useGrouping: false }).format(value); }

async function api(url, options = {}) {
  const response = await fetch(url, { method: options.method || 'GET', credentials: 'same-origin', headers: options.body ? { 'Content-Type': 'application/json' } : undefined, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || 'تعذر إكمال الطلب.'); error.status = response.status; throw error; }
  return data;
}
