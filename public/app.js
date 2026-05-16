'use strict';

/* ─────────────────────────────────────────────────────────
   CONFIG
   ───────────────────────────────────────────────────────── */
const SUPABASE_URL    = 'https://nmutzzsfsmewcmnpjabh.supabase.co';
const SUPABASE_KEY    = 'sb_publishable_4nQqCttz-mF1MtVmq_fMAA_FBBVdDOB';
const TREATMENT_START = new Date('2026-05-16T00:00:00');

/* ─────────────────────────────────────────────────────────
   CATEGORIA DE COR POR REMÉDIO
   red   = injetável
   amber = curto prazo
   blue  = médio prazo
   green = contínuo / longo prazo
   ───────────────────────────────────────────────────────── */
const MED_CAT = {
  'Meropenem 50mg': 'red',
  'Dipirona':       'amber',
  'Up Flora':       'amber',
  'Lactulose 2ml':  'amber',
  'Anlodipino 5mg': 'amber',
  'Becordil 5mg':   'blue',
  'Cist Control':   'blue',
  'Pronefa':        'blue',
  'Kalium Vet':     'blue',
  'Manipulado 1':   'blue',
  'Manipulado 2':   'blue',
  'Ograx Plus 15':  'green',
};

/* ─────────────────────────────────────────────────────────
   ESTADO
   ───────────────────────────────────────────────────────── */
let db, caregiver = '', doses = [], channel = null, toastTimer = null;

/* ─────────────────────────────────────────────────────────
   HELPERS
   ───────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');

function escH(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowHHMM() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function treatmentDay() {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return Math.max(1, Math.round((t - TREATMENT_START) / 86_400_000) + 1);
}

function catOf(name) {
  if (!name) return 'blue';
  if (MED_CAT[name]) return MED_CAT[name];
  const k = Object.keys(MED_CAT).find(k =>
    name.toLowerCase().includes(k.toLowerCase()) ||
    k.toLowerCase().includes(name.toLowerCase())
  );
  return MED_CAT[k] || 'blue';
}

function calcNextHour(doses) {
  const now = nowHHMM();
  const upcoming = doses
    .filter(d => d.status !== 'confirmado')
    .map(d => (d.horario_previsto || '').slice(0, 5))
    .filter(t => t >= now)
    .sort();
  if (!upcoming.length) return null;
  const h = parseInt(upcoming[0]);
  return isNaN(h) ? upcoming[0] : `${h}h`;
}

/* ─────────────────────────────────────────────────────────
   INICIALIZAÇÃO
   ───────────────────────────────────────────────────────── */
function init() {
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  $('day-badge').textContent = `Dia ${treatmentDay()} de tratamento`;

  const saved = localStorage.getItem('nina_caregiver');
  if (saved?.trim()) openApp(saved.trim());

  $('enter-btn').addEventListener('click', handleLogin);
  $('caregiver-name').addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
  $('change-user-btn').addEventListener('click', logout);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* ─────────────────────────────────────────────────────────
   LOGIN / LOGOUT
   ───────────────────────────────────────────────────────── */
function handleLogin() {
  const name = $('caregiver-name').value.trim();
  if (!name) {
    const inp = $('caregiver-name');
    inp.focus();
    inp.style.borderColor = '#DC2626';
    inp.style.boxShadow   = '0 0 0 3px rgba(220,38,38,.12)';
    setTimeout(() => { inp.style.borderColor = ''; inp.style.boxShadow = ''; }, 1600);
    return;
  }
  localStorage.setItem('nina_caregiver', name);
  openApp(name);
}

function openApp(name) {
  caregiver = name;
  $('login-screen').classList.remove('active');
  $('app-screen').classList.add('active');
  $('ftr-name').textContent = name;
  setConn('connecting');
  loadDoses();
  subscribeRealtime();
}

function logout() {
  localStorage.removeItem('nina_caregiver');
  if (channel) { db.removeChannel(channel); channel = null; }
  doses = []; caregiver = '';
  $('app-screen').classList.remove('active');
  $('login-screen').classList.add('active');
  $('caregiver-name').value = '';
  setTimeout(() => $('caregiver-name').focus(), 80);
}

/* ─────────────────────────────────────────────────────────
   STATUS DE CONEXÃO
   ───────────────────────────────────────────────────────── */
function setConn(s) {
  $('conn-dot').className = `conn-dot ${s}`;
}

/* ─────────────────────────────────────────────────────────
   CARREGAR DOSES DO DIA
   ───────────────────────────────────────────────────────── */
async function loadDoses() {
  $('checklist').innerHTML = `
    <div class="st-loading"><div class="spinner"></div><p>Carregando doses…</p></div>`;

  const { data, error } = await db
    .from('nina_doses')
    .select('*')
    .eq('data_dose', todayStr())
    .order('horario_previsto', { ascending: true });

  if (error) {
    $('checklist').innerHTML =
      `<div class="st-empty">⚠️ Erro ao carregar:<br><small>${escH(error.message)}</small></div>`;
    setConn('offline');
    return;
  }

  doses = data || [];
  renderAll();
  setConn('online');
}

/* ─────────────────────────────────────────────────────────
   CONFIRMAR DOSE
   ───────────────────────────────────────────────────────── */
async function confirmDose(id) {
  // Proteção: não deixa confirmar o que já foi confirmado
  const local = doses.find(d => d.id === id);
  if (local?.status === 'confirmado') {
    toast(`Já dada por ${local.cuidadora || '?'}`);
    return;
  }

  // Feedback imediato
  const btn = document.querySelector(`.check-btn[data-id="${id}"]`);
  if (btn) { btn.textContent = '…'; btn.disabled = true; }

  const now = new Date().toISOString();
  const { error } = await db
    .from('nina_doses')
    .update({ status: 'confirmado', cuidadora: caregiver, confirmado_em: now })
    .eq('id', id);

  if (error) {
    toast('Erro ao confirmar. Tente novamente.');
    renderAll(); // restaura o botão
    return;
  }

  // Atualiza estado local
  const idx = doses.findIndex(d => d.id === id);
  if (idx !== -1) {
    doses[idx] = { ...doses[idx], status: 'confirmado', cuidadora: caregiver, confirmado_em: now };
  }

  renderAll();
  toast(`✅ ${doses.find(d => d.id === id)?.remedio || 'Dose'} confirmada!`);
}

/* ─────────────────────────────────────────────────────────
   REALTIME SUPABASE
   ───────────────────────────────────────────────────────── */
function subscribeRealtime() {
  if (channel) db.removeChannel(channel);

  channel = db.channel('nina_rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'nina_doses' }, handleRT)
    .subscribe(s => {
      if (s === 'SUBSCRIBED')    setConn('online');
      if (s === 'CHANNEL_ERROR') setConn('offline');
    });
}

function handleRT({ eventType, new: rec, old }) {
  const today = todayStr();

  if (eventType === 'UPDATE') {
    if (rec.data_dose !== today) return;
    const i = doses.findIndex(d => d.id === rec.id);
    if (i !== -1) doses[i] = rec; else doses.push(rec);
    renderAll();
    if (rec.cuidadora && rec.cuidadora !== caregiver)
      toast(`✅ ${rec.cuidadora} confirmou: ${rec.remedio}`);

  } else if (eventType === 'INSERT') {
    if (rec.data_dose !== today) return;
    if (!doses.find(d => d.id === rec.id)) {
      doses.push(rec);
      doses.sort((a, b) => (a.horario_previsto || '').localeCompare(b.horario_previsto || ''));
    }
    renderAll();

  } else if (eventType === 'DELETE') {
    doses = doses.filter(d => d.id !== old.id);
    renderAll();
  }
}

/* ─────────────────────────────────────────────────────────
   RENDER
   ───────────────────────────────────────────────────────── */
function renderAll() {
  updateChips();
  renderChecklist();
}

function updateChips() {
  const done  = doses.filter(d => d.status === 'confirmado').length;
  const pend  = doses.length - done;
  const total = doses.length;
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
  const nxt   = calcNextHour(doses);

  $('c-done').textContent = done;
  $('c-pend').textContent = pend;
  $('c-pct').textContent  = `${pct}%`;
  $('c-next').textContent = nxt ?? (pend === 0 && total > 0 ? '✓' : '—');

  $('prog-fill').style.width    = `${pct}%`;
  $('prog-label').textContent   = total > 0 ? `${done} de ${total} doses confirmadas` : '';
}

/* ─────────────────────────────────────────────────────────
   RENDERIZA CHECKLIST POR HORÁRIO
   ───────────────────────────────────────────────────────── */
function renderChecklist() {
  const el  = $('checklist');
  const now = nowHHMM();

  if (!doses.length) {
    el.innerHTML = `
      <div class="st-empty">
        Nenhuma dose registrada para hoje.<br>
        Abra <strong>seed.html</strong> para popular o banco.
      </div>`;
    return;
  }

  // Agrupar por horário exato HH:MM
  const groups = {};
  doses.forEach(d => {
    const key = (d.horario_previsto || '??:??').slice(0, 5);
    if (!groups[key]) groups[key] = [];
    groups[key].push(d);
  });

  let html = '';

  Object.keys(groups).sort().forEach(time => {
    const list    = groups[time];
    const h       = parseInt(time.split(':')[0]);
    const label   = isNaN(h) ? time : `${h}h`;
    const allDone = list.every(d => d.status === 'confirmado');
    const noun    = list.length === 1 ? 'remédio' : 'remédios';

    html += `
      <div class="time-group">
        <div class="tg-hdr ${allDone ? 'done' : ''}">
          <span class="tg-dot"></span>
          <span class="tg-hour">${label}</span>
          <span class="tg-dash">—</span>
          <span class="tg-count">${list.length} ${noun}</span>
        </div>
        ${list.map(d => cardHTML(d, now)).join('')}
      </div>`;
  });

  if (doses.every(d => d.status === 'confirmado')) {
    html += `
      <div class="all-done-card">
        <p>🎉 Todas as doses do dia confirmadas!<br>A Nega agradece! 🐶</p>
      </div>`;
  }

  el.innerHTML = html;

  // Eventos dos botões confirmar
  el.querySelectorAll('.check-btn').forEach(btn => {
    btn.addEventListener('click', () => confirmDose(btn.dataset.id));
  });
}

/* ─────────────────────────────────────────────────────────
   GERA HTML DE UM CARD DE DOSE
   Estados: st-pending / st-mine / st-other
   ───────────────────────────────────────────────────────── */
function cardHTML(dose, now) {
  const confirmed = dose.status === 'confirmado';
  const time      = (dose.horario_previsto || '').slice(0, 5);
  const isLate    = !confirmed && time && time < now;
  const cat       = catOf(dose.remedio);
  const at        = fmtTime(dose.confirmado_em);
  const by        = dose.cuidadora || '?';
  const isMine    = by === caregiver;

  // Texto de status (só aparece quando confirmado)
  const confMsg = confirmed
    ? `<p class="dose-conf ${isMine ? 'mine' : 'other'}">
         ${isMine ? '✅ Dado por' : '⚠️ Já dado por'} <strong>${escH(by)}</strong> às ${at}
       </p>`
    : '';

  // Lado direito: botão ou nada
  const rightHTML = confirmed
    ? ''
    : `<button class="check-btn" data-id="${dose.id}">✓ Confirmar</button>`;

  const cardClass = confirmed ? (isMine ? 'st-mine' : 'st-other') : 'st-pending';

  return `
    <div class="dose-card ${cardClass}" data-id="${dose.id}">
      <div class="dose-left">
        <span class="cat-dot ${cat}"></span>
        <div class="dose-body">
          <div class="dose-name">
            ${escH(dose.remedio)}${isLate ? '<span class="late-tag">Atrasada</span>' : ''}
          </div>
          ${confMsg}
        </div>
      </div>
      ${rightHTML}
    </div>`;
}

/* ─────────────────────────────────────────────────────────
   TOAST
   ───────────────────────────────────────────────────────── */
function toast(msg) {
  clearTimeout(toastTimer);
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

/* ─────────────────────────────────────────────────────────
   START
   ───────────────────────────────────────────────────────── */
init();
