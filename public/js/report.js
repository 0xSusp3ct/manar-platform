const $ = (id) => document.getElementById(id);
const ui = { loading: $('report-loading'), pages: $('report-pages'), message: $('report-message'), screen: $('screen-report'), download: $('download-pdf'), print: $('print-report'), copy: $('copy-summary'), link: $('copy-link') };
let reportData;
let ready = false;
let messageTimer;
ui.print.addEventListener('click', () => { if (ready) window.print(); });
ui.download.addEventListener('click', downloadPdf);
ui.copy.addEventListener('click', () => copyText(summaryText(), 'تم نسخ ملخص التقرير.'));
ui.link.addEventListener('click', () => copyText(new URL(window.location.pathname, window.location.origin).href, 'تم نسخ رابط التقرير الخاص.'));
loadReport();

async function loadReport() {
  const token = window.location.pathname.match(/^\/r\/([A-Za-z0-9_-]{43})\/?$/)?.[1];
  if (!token) return fail('رابط التقرير غير مكتمل أو غير صالح.');
  try {
    const response = await fetch(`/api/reports/${token}`, { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل التقرير.');
    reportData = data;
    renderScreen(data);
    ui.loading.classList.add('hidden'); ui.screen.classList.remove('hidden');
    await document.fonts.ready;
    buildPrintDocument(data);
    ready = true;
    [ui.download, ui.print, ui.copy, ui.link].forEach((button) => { button.disabled = false; });
    document.documentElement.dataset.reportReady = 'true';
  } catch (error) { fail(error.message); }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderScreen({ entity, result, submittedAt, recommendations, improvementPlan }) {
  document.title = `تقرير ${entity.entityName} | مقياس منار`;
  $('report-entity-title').textContent = entity.entityName;
  $('report-date').textContent = `تاريخ التقييم: ${formatDate(entity.evaluationDate)} • إصدار التقرير: ${formatDate(submittedAt)}`;
  const kpis = [
    ['النتيجة النهائية', `${number(result.overallPercent)}٪`, `${number(result.rawPoints)} من ${number(result.maxPoints)} درجة`],
    ['مستوى النضج', result.maturity, 'وفق نتيجة التقييم', 'maturity'],
    ['نقاط القوة', number(result.strengths.length), 'مؤشرات بدرجة ٤ أو ٥'],
    ['فرص التحسين', number(result.opportunities.length), 'مؤشرات بدرجة ١ أو ٢']
  ];
  $('result-kpis').replaceChildren(...kpis.map(([label, value, hint, cls = '']) => {
    const card = element('article', `result-kpi ${cls}`);
    card.append(element('span', '', label), element('strong', '', value), element('small', '', hint)); return card;
  }));
  renderBars($('domain-bars'), result.domains);
  renderBars($('axis-bars'), result.axes);
  $('maturity-level').textContent = `مرحلة ${result.maturity}`;
  $('system-recommendation').textContent = result.systemRecommendation;
  $('result-metadata').replaceChildren(...[['فريق التقييم', entity.assessorName], ['عدد المؤشرات', number(result.indicatorCount)]].map(([label, value]) => {
    const row = element('div'); row.append(element('span', 'muted', label), element('strong', '', value)); return row;
  }));
  renderScreenFindings($('screen-strengths'), result.strengths, 'strength');
  renderScreenFindings($('screen-opportunities'), result.opportunities, 'opportunity');
  $('supervisor-recommendations').textContent = recommendations || 'لم يضف المشرف توصيات مخصصة بعد.';
  $('improvement-plan').textContent = improvementPlan || 'لم تضف خطة تحسين مخصصة بعد.';
}

function renderBars(target, rows, print = false) {
  const prefix = print ? 'print-bar' : 'bar';
  target.replaceChildren(...rows.map((row) => {
    const wrapper = element('div', print ? 'print-bar' : 'bar-row');
    const label = element('span', '', row.title);
    const track = element('div', `${prefix}-track`);
    const value = element('div', `${prefix}-value`); value.style.width = `${row.percent}%`; track.append(value);
    wrapper.append(label, track, element('span', print ? 'print-bar-score' : 'bar-score', `${number(row.percent)}٪`)); return wrapper;
  }));
}

function renderScreenFindings(target, rows, type) {
  target.replaceChildren();
  if (!rows.length) return target.append(element('p', 'muted', 'لا توجد مؤشرات ضمن هذا التصنيف.'));
  rows.forEach((item) => target.append(finding(item, false, type)));
}

function finding(item, print = false, type = '') {
  const row = element('article', print ? 'print-finding' : `finding ${type}`);
  const copy = element('div');
  copy.append(element('h3', '', item.title), element('p', '', item.description), element('small', '', `${item.domain} • ${item.axis}`));
  row.append(element('span', 'finding-score', number(item.score)), copy); return row;
}

function makePrintPage(title, cover = false) {
  const page = element('section', `print-page${cover ? ' print-cover' : ''}`);
  if (cover) page.append(element('div', 'cover-art outer'), element('div', 'cover-art middle'), element('div', 'cover-art'), element('div', 'cover-tint'));
  const header = element('header', 'print-header');
  header.append(element('span', 'print-brand', 'مقياس منار'), element('span', 'print-heading-meta', title));
  const body = element('div', 'print-body');
  const footer = element('footer', 'print-footer');
  footer.append(element('span', '', 'شركة ركائز المدينة للاستشارات التعليمية والتربوية'), element('span', 'print-page-number'));
  page.append(header, body, footer); ui.pages.append(page);
  return { page, body };
}

// Each block is measured in its real A4 box. Long advisory paragraphs are split
// at word boundaries, so a complete result is preserved on phone and desktop.
function paginate(title, blocks) {
  let current;
  const start = () => {
    current = makePrintPage(title);
    current.body.append(element('h2', 'print-title', title));
  };
  start();
  const fits = () => current.body.scrollHeight <= current.body.clientHeight + 1;
  for (let block of blocks) {
    current.body.append(block);
    if (fits()) continue;
    block.remove();
    // Text can use the remaining space before continuing on a new page.
    if (!block.classList.contains('print-copy') && current.body.children.length > 1) start();
    current.body.append(block);
    if (fits()) continue;
    if (!block.classList.contains('print-copy')) throw new Error('تعذر توزيع أحد أقسام التقرير للطباعة.');
    const fullText = Array.from(block.textContent);
    let remaining = fullText;
    while (remaining.length) {
      let low = 0, high = remaining.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        block.textContent = remaining.slice(0, middle).join('');
        if (fits()) low = middle; else high = middle - 1;
      }
      if (!low) {
        block.remove();
        const heading = current.body.lastElementChild?.classList.contains('print-subtitle') ? current.body.lastElementChild : null;
        if (heading) heading.remove();
        if (current.body.children.length <= 1) throw new Error('تعذر توزيع النص على صفحات التقرير.');
        start();
        if (heading) current.body.append(heading);
        current.body.append(block);
        continue;
      }
      let end = low;
      if (low < remaining.length) {
        for (let i = low - 1; i > low * .7; i--) if (/\s/.test(remaining[i])) { end = i + 1; break; }
      }
      block.textContent = remaining.slice(0, end).join('');
      remaining = remaining.slice(end);
      if (remaining.length) { start(); block = element('p', 'print-copy'); current.body.append(block); }
    }
  }
}

function buildPrintDocument(data) {
  ui.pages.replaceChildren();
  const { entity, result } = data;
  const cover = makePrintPage('للتميز التربوي المؤسسي', true);
  cover.body.append(element('h1', 'cover-title', 'تقرير نتائج\nالتقييم المؤسسي'), element('p', 'cover-subtitle', 'قراءة متكاملة للنتائج وأولويات التحسين'), element('h2', 'cover-entity', entity.entityName), element('p', 'cover-detail', `المقيم / فريق التقييم: ${entity.assessorName}`), element('p', 'cover-detail', `تاريخ التقييم: ${formatDate(entity.evaluationDate)}`), element('p', 'cover-detail', `تاريخ الإصدار: ${formatDate(data.submittedAt)}`), element('p', 'cover-note', 'تقرير خاص بالجهة المعنية • للعرض والمشاركة المخصصة'));
  const score = element('div', 'print-score'); score.append(scoreGraphic(result.overallPercent));
  const scoreCopy = element('div'); scoreCopy.append(element('h3', '', `مرحلة ${result.maturity}`), element('p', '', result.systemRecommendation)); score.append(scoreCopy);
  const metadata = element('div', 'print-metadata');
  [['النتيجة النهائية', `${number(result.overallPercent)}٪`], ['الدرجات', `${number(result.rawPoints)} من ${number(result.maxPoints)}`], ['عدد المؤشرات', number(result.indicatorCount)], ['الجهة', entity.entityName]].forEach(([label, value]) => {
    const cell = element('div', 'print-meta'); cell.append(element('span', '', label), element('strong', '', value)); metadata.append(cell);
  });
  const domains = element('div', 'print-bars'); renderBars(domains, result.domains, true);
  const axes = element('div', 'print-bars'); renderBars(axes, result.axes, true);
  paginate('ملخص نتائج التقييم', [score, metadata, element('h3', 'print-subtitle', 'نتائج المجالات'), domains]);
  paginate('نتائج المحاور', [element('p', 'print-copy', 'تعرض النسب مستوى تحقق مؤشرات كل محور من الدرجة القصوى.'), axes]);
  for (const [title, items, explanation] of [['نقاط القوة', result.strengths, 'المؤشرات الحاصلة على ٤ أو ٥ من ٥.'], ['فرص التحسين', result.opportunities, 'المؤشرات الحاصلة على ١ أو ٢ من ٥.']]) {
    paginate(title, [element('p', 'print-copy', explanation), ...(items.length ? items.map((item) => finding(item, true)) : [element('p', 'print-copy', 'لا توجد مؤشرات ضمن هذا التصنيف.')])]);
  }
  const advisory = [element('h3', 'print-subtitle', 'توصيات المشرف'), element('p', 'print-copy', data.recommendations || 'لم يضف المشرف توصيات مخصصة بعد.'), element('h3', 'print-subtitle', 'خطة التحسين'), element('p', 'print-copy', data.improvementPlan || 'لم تضف خطة تحسين مخصصة بعد.'), element('p', 'print-copy print-callout', 'تظهر توصيات المشرف وخطة التحسين منفصلتين عن الإجابات الأصلية ولا تغيّران الدرجات أو مستوى النضج.')];
  paginate('التوصيات وخطة التحسين', advisory);
  const pages = [...ui.pages.children];
  pages.forEach((page, index) => { page.querySelector('.print-page-number').textContent = `صفحة ${number(index + 1)} من ${number(pages.length)}`; });
  if (pages.some((page) => { const b = page.querySelector('.print-body'); return b.scrollHeight > b.clientHeight + 1; })) throw new Error('تعذر ضبط صفحات التقرير للطباعة.');
}

function scoreGraphic(percent) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 180 180'); svg.setAttribute('aria-label', `${number(percent)}٪`);
  for (const [color, dash] of [['#e5ecf1', null], ['#6f91a2', `${percent * 4.65} 465`]]) {
    const circle = document.createElementNS(ns, 'circle');
    for (const [key,value] of Object.entries({ cx:90, cy:90, r:74, fill:'none', stroke:color, 'stroke-width':10 })) circle.setAttribute(key,String(value));
    if (dash) { circle.setAttribute('stroke-dasharray', dash); circle.setAttribute('transform', 'rotate(-90 90 90)'); }
    svg.append(circle);
  }
  const text = document.createElementNS(ns, 'text'); text.setAttribute('x','90'); text.setAttribute('y','101'); text.setAttribute('text-anchor','middle'); text.setAttribute('fill','#344a5c'); text.setAttribute('font-size','30'); text.setAttribute('font-family','Tahoma'); text.textContent = `${number(percent)}٪`; svg.append(text); return svg;
}

async function downloadPdf() {
  if (!ready || ui.download.disabled) return;
  if (!window.html2canvas || !window.jspdf) return showMessage('تعذر تجهيز مكتبة PDF. أعد تحميل الصفحة أو استخدم زر الطباعة.', true);
  ui.download.disabled = true; ui.print.disabled = true;
  try {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4', compress:true });
    pdf.setProperties({ title:`تقرير مقياس منار - ${reportData.entity.entityName}`, subject:'نتائج التقييم المؤسسي', author:'مقياس منار' });
    const sheets = [...ui.pages.children];
    for (let i = 0; i < sheets.length; i++) {
      ui.download.textContent = `تجهيز الصفحة ${number(i + 1)} من ${number(sheets.length)}`;
      const canvas = await window.html2canvas(sheets[i], {
        scale:2, backgroundColor:'#ffffff', logging:false, windowWidth:1200, windowHeight:1300, scrollX:0, scrollY:0,
        onclone: (doc) => { const root = doc.getElementById('report-pages'); root.style.position = 'absolute'; root.style.left = '0'; root.style.top = '0'; }
      });
      if (i) pdf.addPage('a4', 'portrait');
      pdf.addImage(canvas.toDataURL('image/jpeg', .97), 'JPEG', 0, 0, 210, 297);
      canvas.width = 0; canvas.height = 0;
    }
    const name = reportData.entity.entityName.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'manar';
    pdf.save(`تقرير-منار-${name}.pdf`);
    showMessage('تم تنزيل التقرير كاملًا. للطباعة اختر A4 وقياس ١٠٠٪.');
  } catch (error) { showMessage('تعذر تنزيل PDF. استخدم زر الطباعة، أو حاول مجددًا.', true); }
  finally { ui.download.disabled = false; ui.print.disabled = false; ui.download.textContent = 'تنزيل PDF'; }
}

function summaryText() {
  if (!reportData) return '';
  const { entity, result } = reportData;
  return ['تقرير مقياس منار', `الجهة: ${entity.entityName}`, `المقيم: ${entity.assessorName}`, `التاريخ: ${formatDate(entity.evaluationDate)}`, `النتيجة: ${number(result.overallPercent)}٪`, `النضج: ${result.maturity}`, `نقاط القوة: ${number(result.strengths.length)}`, `فرص التحسين: ${number(result.opportunities.length)}`, `التوصية: ${result.systemRecommendation}`].join('\n');
}
async function copyText(text, success) {
  try { await navigator.clipboard.writeText(text); showMessage(success); }
  catch {
    // Keep manual copying available when clipboard access is denied by the browser.
    ui.message.replaceChildren(element('p', '', 'حدد النص التالي وانسخه:'));
    const area = element('textarea'); area.readOnly = true; area.value = text; area.setAttribute('aria-label', 'النص المطلوب نسخه'); ui.message.append(area);
    ui.message.className = 'container notice no-print'; clearTimeout(messageTimer); area.focus(); area.select();
  }
}
function number(value) { return new Intl.NumberFormat('ar-SA', { maximumFractionDigits:1 }).format(value); }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('ar-SA-u-ca-gregory', { year:'numeric', month:'long', day:'numeric', timeZone:'Asia/Riyadh' }).format(date); }
function fail(text) { ui.loading.classList.remove('hidden'); ui.loading.textContent = text; }
function showMessage(text, error = false) { clearTimeout(messageTimer); ui.message.textContent = text; ui.message.className = `container notice no-print ${error ? 'notice-error' : 'notice-success'}`; messageTimer = setTimeout(() => ui.message.classList.add('hidden'), 7000); }
