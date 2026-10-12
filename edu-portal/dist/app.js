'use strict';

const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const TYPES = {school:'Школа', garden:'Детский сад', extra:'Дополнительное образование'};
const ROLES = {student:'Ученик', teacher:'Учитель', admin:'Администратор'};
const DISTRICTS = ['Центральный','Северный','Южный','Восточный','Западный'];
const main = document.getElementById('main');
const state = {user:null, csrf:'', organizations:[], news:[], users:[], loginRole:'student', query:'', type:'all', district:'all', page:1, view:'grid', cabinetTab:'profile', cabinetOrg:null, newsCategory:'all', ticket:0, authEpoch:0, ready:false, largeText:false};
try { state.largeText = localStorage.getItem('edu-text-size') === 'large'; } catch {}
let toastTimer;
const accountChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('edu-account') : null;
function signalAccountChange() {
  accountChannel?.postMessage('changed');
}
if (accountChannel) accountChannel.onmessage = () => {
  clearAccount();
  updateShell();
  main.innerHTML = '<div class="container page-wrap"><p role="status">Открываем ваш аккаунт…</p></div>';
  initialize(true);
};

function toast(message) {
  const element = document.getElementById('toast');
  clearTimeout(toastTimer);
  element.textContent = message;
  element.hidden = false;
  toastTimer = setTimeout(() => element.hidden = true, 4200);
}
function clearAccount() {
  state.ticket++;
  state.authEpoch++;
  Object.assign(state, {user:null, csrf:'', organizations:[], news:[], users:[], cabinetOrg:null, query:'', type:'all', district:'all', page:1, cabinetTab:'profile', ready:false});
}
async function api(path, options = {}) {
  const headers = {'Content-Type':'application/json', ...options.headers};
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = options.csrf ?? state.csrf;
  let response;
  try {
    response = await fetch('/api' + path, {method:options.method ?? 'GET', headers, credentials:'same-origin', cache:'no-store', ...(options.body ? {body:JSON.stringify(options.body)} : {})});
  } catch {
    throw new Error('Нет связи с сервером. Проверьте, запущен ли портал.');
  }
  const result = await response.json().catch(() => ({error:'Не удалось прочитать ответ сервера.'}));
  if (!response.ok) {
    if (response.status === 401 && state.user && path !== '/login') {
      clearAccount();
      navigate('#login', true);
    }
    const error = new Error(result.error || 'Не удалось выполнить действие.');
    error.status = response.status;
    throw error;
  }
  return result;
}
async function loadData() {
  const epoch = state.authEpoch;
  const data = await api('/bootstrap');
  if (epoch !== state.authEpoch) throw new Error('Аккаунт изменён. Повторите действие.');
  const users = data.user.role === 'admin' ? (await api('/users')).users : [];
  if (epoch !== state.authEpoch) throw new Error('Аккаунт изменён. Повторите действие.');
  Object.assign(state, data, {users});
  state.ready = true;
}
function isAdmin() { return state.user?.role === 'admin'; }
function canEdit() { return ['admin','teacher'].includes(state.user?.role); }
function canRead(id) { return isAdmin() || state.user?.orgId === id; }
function homeHash() { return isAdmin() ? '#catalog' : state.user ? '#org/' + state.user.orgId : '#login'; }
function orgIcon(type) { return type === 'school' ? 'school' : type === 'garden' ? 'flower' : 'spark'; }
function dateLabel(value) { return new Date(value + 'T12:00:00').toLocaleDateString('ru-RU', {day:'numeric',month:'long',year:'numeric'}); }
function navigate(hash, replace = false) {
  if (replace) { history.replaceState(null, '', hash); route(); }
  else if (location.hash === hash) route();
  else location.hash = hash;
}
function breadcrumbs(items) {
  return `<div class="breadcrumbs"><a href="${homeHash()}">${isAdmin() ? 'Организации' : 'Моя организация'}</a>${items.map(item => `${icon('chevron')}${item.href ? `<a href="${esc(item.href)}">${esc(item.label)}</a>` : `<span>${esc(item.label)}</span>`}`).join('')}</div>`;
}
function updateShell() {
  document.body.classList.toggle('large-text', state.largeText);
  document.getElementById('accessibility').setAttribute('aria-pressed', String(state.largeText));
  document.getElementById('accessibility').setAttribute('aria-label', state.largeText ? 'Вернуть обычный размер текста' : 'Увеличить размер текста');
  const own = '#org/' + state.user?.orgId;
  const links = !state.user ? [] : isAdmin() ? [['#catalog','Организации'],['#all-news','Новости'],['#users','Пользователи']] : [[own,'Моя организация'],[own + '/news','Новости'],[state.user.role === 'teacher' ? '#cabinet' : own + '/documents', state.user.role === 'teacher' ? 'Управление' : 'Документы']];
  const nav = links.map(([href,label]) => `<a href="${href}" ${location.hash === href ? 'class="active"' : ''}>${label}</a>`).join('');
  document.getElementById('main-nav').innerHTML = nav;
  document.getElementById('mobile-nav').innerHTML = nav;
  document.getElementById('footer-links').innerHTML = nav;
  document.getElementById('mobile-toggle').hidden = !state.user;
  document.getElementById('account-actions').innerHTML = state.user ? `<span class="account-pill">${icon('user')}<span><strong>${ROLES[state.user.role]}</strong><small>${esc(state.user.username)}</small></span></span><button class="button button-outline logout-button" data-logout aria-label="Выйти из аккаунта">Выйти</button>` : '<span class="demo-badge">MVP · ТЕСТОВЫЙ ДОСТУП</span>';
}
function renderLogin() {
  document.title = 'Вход — Образование рядом';
  const demo = {student:'student24',teacher:'teacher24',admin:'admin'}[state.loginRole];
  main.innerHTML = `<div class="container login-layout"><section class="login-intro"><span class="hero-label"><span class="status-dot"></span>ВАШЕ ПРОСТРАНСТВО ОБРАЗОВАНИЯ</span><h1>Своя школа.<br>Свои открытия.<br> <em>Всё рядом.</em></h1><p>Учитесь, делитесь новостями и управляйте страницей своей организации — каждый в своём кабинете.</p><div class="login-illustration"><img src="./campus.svg" alt="Школа, дети и родители среди деревьев" width="600" height="420"></div><div class="login-trust">${icon('check')}Организация откроется автоматически после входа.</div></section><section class="login-card" aria-labelledby="login-title"><span class="eyebrow">ДОБРО ПОЖАЛОВАТЬ</span><h2 id="login-title">Войти в портал</h2><p class="login-subtitle">Выберите, как вы будете пользоваться порталом.</p><div class="role-options" aria-label="Роль при входе">${[['student','Ученик','book'],['teacher','Учитель','user'],['admin','Админ','grid']].map(([role,label,symbol]) => `<button class="role-option" data-login-role="${role}" aria-pressed="${state.loginRole === role}">${icon(symbol)}<span>${label}</span></button>`).join('')}</div><div class="role-description">${state.loginRole === 'student' ? 'Страница вашей школы, её новости и документы.' : state.loginRole === 'teacher' ? 'Ваша организация и управление её страницей.' : 'Все организации области и управление пользователями.'}</div><form id="login-form"><label class="field">Логин<input name="username" required maxlength="40" autocomplete="username" placeholder="Введите логин"></label><label class="field">Пароль<input name="password" type="password" required maxlength="128" autocomplete="current-password" placeholder="Введите пароль"></label><p class="form-error" id="login-error" role="alert" hidden></p><button class="button button-primary login-submit" type="submit">Войти как ${state.loginRole === 'admin' ? 'администратор' : state.loginRole === 'teacher' ? 'учитель' : 'ученик'} ${icon('arrow')}</button></form><div class="demo-login-box"><strong>Попробовать демоверсию</strong><p>Логин: <code>${demo}</code><br>Пароль: <code>Demo2026!</code></p><button class="text-button" data-fill-demo="${demo}">Заполнить тестовый аккаунт ${icon('arrow')}</button></div><p class="login-footnote">Школа закреплена за аккаунтом администратором. При входе выбирать её не нужно.</p></section></div>`;
  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    document.querySelectorAll('[data-login-role]').forEach(roleButton => roleButton.disabled = true);
    const errorBox = document.getElementById('login-error');
    errorBox.hidden = true;
    try {
      const credentials = Object.fromEntries(new FormData(form));
      const session = await api('/login', {method:'POST', body:{...credentials,role:state.loginRole}});
      clearAccount();
      Object.assign(state, session);
      signalAccountChange();
      await loadData();
      state.cabinetOrg = state.user.orgId || state.organizations[0]?.id;
      navigate(homeHash(), true);
    } catch (error) {
      if (errorBox.isConnected) { errorBox.textContent = error.message; errorBox.hidden = false; }
    } finally { button.disabled = false; document.querySelectorAll('[data-login-role]').forEach(roleButton => roleButton.disabled = false); }
  });
}
function orgCard(org) {
  return `<article class="org-card"><div class="org-card-top"><span class="org-symbol ${esc(org.type)}">${icon(orgIcon(org.type))}</span><a class="icon-button mini-edit" href="#cabinet/${esc(org.id)}" aria-label="Редактировать: ${esc(org.name)}">${icon('file')}</a></div><div class="org-content"><div class="org-kind">${TYPES[org.type]}</div><h3><a href="#org/${esc(org.id)}">${esc(org.name)}</a></h3><p class="org-location">${icon('pin')}${esc(org.district)} район</p></div><div class="org-card-bottom"><span class="tag">${esc(org.tag)}</span><span class="card-arrow">Открыть страницу ${icon('arrow')}</span></div></article>`;
}
function normalize(value) { return value.toLowerCase().replace(/ё/g,'е').replace(/№/g,'').replace(/\s+/g,' ').trim(); }
function renderAdmin() {
  document.title = 'Организации — Образование рядом';
  main.innerHTML = `<div class="container page-wrap admin-page"><section class="admin-welcome"><div><span class="eyebrow">АДМИНИСТРАТОР ОБЛАСТИ</span><h1>Вся область —<br>в одном кабинете.</h1><p>Управляйте организациями и доступом к ним.</p></div><a class="button button-primary" href="#new-org">${icon('plus')}Добавить организацию</a></section><div class="admin-stats">${[[state.organizations.length,'Организаций','school'],[state.organizations.filter(o => o.type === 'school').length,'Школ','book'],[state.organizations.filter(o => o.type === 'garden').length,'Детских садов','flower'],[state.users.length,'Аккаунтов','users']].map(([count,label,symbol]) => `<div class="admin-stat"><span>${icon(symbol)}</span><div><strong>${count}</strong><small>${label}</small></div></div>`).join('')}</div><section class="section" id="catalog-section"><div class="section-heading"><div><h2>Организации области</h2><p>Все школы, детские сады и центры образования</p></div><a href="#users" class="text-button">Управление доступом ${icon('arrow')}</a></div><div class="filter-top"><div class="type-filters">${[['all','Все'],['school','Школы'],['garden','Детские сады'],['extra','Кружки и секции']].map(([type,label]) => `<button class="filter-chip" data-type="${type}" aria-pressed="${state.type === type}">${label}<span>${type === 'all' ? state.organizations.length : state.organizations.filter(o => o.type === type).length}</span></button>`).join('')}</div><label><span class="sr-only">Район области</span><select class="district-select" id="district-filter" aria-label="Район области"><option value="all">Все районы</option>${DISTRICTS.map(d => `<option ${state.district === d ? 'selected' : ''}>${d}</option>`).join('')}</select></label></div><div class="catalog-tools"><label class="catalog-query">${icon('search')}<span class="sr-only">Поиск по каталогу</span><input id="catalog-query" placeholder="Название, номер или район" value="${esc(state.query)}"></label><span class="catalog-result" id="catalog-result" role="status"></span><div class="view-toggle"><button data-view="grid" aria-pressed="${state.view === 'grid'}" aria-label="Карточки">${icon('grid')}</button><button data-view="list" aria-pressed="${state.view === 'list'}" aria-label="Список">${icon('list')}</button></div></div><div id="org-grid" class="org-grid"></div><div id="pagination" class="pagination"></div></section></div>`;
  renderCatalog();
  document.getElementById('catalog-query').addEventListener('input', event => { state.query = event.target.value; state.page = 1; renderCatalog(); });
  document.getElementById('district-filter').addEventListener('change', event => { state.district = event.target.value; state.page = 1; renderCatalog(); });
}
function renderCatalog() {
  if (!isAdmin()) return;
  const query = normalize(state.query);
  const organizations = state.organizations.filter(o => (state.type === 'all' || o.type === state.type) && (state.district === 'all' || o.district === state.district) && (!query || normalize([o.name,o.district,o.address].join(' ')).includes(query)));
  const pages = Math.ceil(organizations.length / 6);
  state.page = Math.max(1, Math.min(state.page, pages || 1));
  const grid = document.getElementById('org-grid');
  grid.className = 'org-grid' + (state.view === 'list' ? ' list' : '');
  grid.innerHTML = organizations.length ? organizations.slice((state.page - 1) * 6, state.page * 6).map(orgCard).join('') : `<div class="empty-state">${icon('search')}<h3>Организации не найдены</h3><p>Попробуйте другое название или район.</p><button class="button button-outline" data-reset-filters>Сбросить фильтры</button></div>`;
  document.getElementById('catalog-result').textContent = 'Найдено: ' + organizations.length;
  document.getElementById('pagination').innerHTML = pages > 1 ? Array.from({length:pages}, (_,i) => `<button data-page="${i+1}" ${state.page === i+1 ? 'aria-current="page"' : ''} aria-label="Страница ${i+1}">${i+1}</button>`).join('') : '';
  document.querySelectorAll('[data-type]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.type === state.type)));
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === state.view)));
}
function newsArt(news) {
  const type = ['school','creative','parents'].includes(news.art) ? news.art : 'school';
  return `<div class="news-art poster-${type}"><span class="poster-label">${type === 'school' ? 'ВМЕСТЕ К НОВЫМ ОТКРЫТИЯМ' : type === 'creative' ? 'ВРЕМЯ ПОПРОБОВАТЬ НОВОЕ' : 'РАСТЁМ ВМЕСТЕ'}</span>${icon(type === 'school' ? 'school' : type === 'creative' ? 'spark' : 'users','art-icon')}</div>`;
}
function newsCard(news) { return `<article class="news-card">${newsArt(news)}<div class="news-meta"><span class="category">${esc(news.category)}</span><span>·</span><time datetime="${esc(news.date)}">${dateLabel(news.date)}</time></div><h3><a href="#article/${esc(news.id)}">${esc(news.title)}</a></h3><p>${esc(news.summary)}</p></article>`; }
function renderOrganization(org, tab = 'overview') {
  document.title = org.name + ' — Образование рядом';
  const tabNames = {overview:'Об организации',news:'Новости',documents:'Документы'};
  if (!tabNames[tab]) tab = 'overview';
  main.innerHTML = `<div class="container page-wrap">${breadcrumbs([{label:isAdmin() ? org.name : 'Моя страница'}])}<div class="school-account-line"><span class="role-badge">${icon('user')}${ROLES[state.user.role]}</span><span>${isAdmin() ? 'Просмотр организации' : 'Организация закреплена за вашим аккаунтом'}</span></div><div class="detail-hero"><span class="org-symbol ${esc(org.type)}">${icon(orgIcon(org.type))}</span><div class="detail-main"><span class="org-kind">${TYPES[org.type]} · Демонстрационная карточка</span><h1>${esc(org.name)}</h1><p class="org-location">${icon('pin')}${esc(org.district)} район · ${esc(org.address)}</p></div>${canEdit() ? `<a class="button button-outline detail-favorite" href="#cabinet/${esc(org.id)}">${icon('file')}<span>Управлять страницей</span></a>` : ''}</div><nav class="tabs" aria-label="Разделы организации">${Object.entries(tabNames).map(([key,label]) => `<a class="org-tab ${tab === key ? 'selected' : ''}" href="#org/${esc(org.id)}/${key}" ${tab === key ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav><div id="detail-content">${organizationContent(org,tab)}</div></div>`;
}
function organizationContent(org, tab) {
  if (tab === 'news') {
    const news = state.news.filter(n => n.orgId === org.id);
    return news.length ? `<div class="news-grid">${news.map(newsCard).join('')}</div>` : `<div class="empty-state">${icon('book')}<h3>Новости появятся здесь</h3><p>Следите за объявлениями вашей организации.</p>${canEdit() ? `<a class="button button-outline" href="#cabinet/${esc(org.id)}/news">Добавить новость</a>` : ''}</div>`;
  }
  if (tab === 'documents') return `<div class="note-box" style="margin:0 0 23px">${icon('info')}<span>В MVP представлены демонстрационные документы вашей организации.</span></div><div class="document-list">${[['about','Сведения об организации'],['admission','Памятка по поступлению'],['schedule','Режим работы']].map(([kind,title]) => `<div class="document-row">${icon('file')}<div><strong>${title}</strong><small>Демонстрационный документ · TXT</small></div><button class="text-button" data-download="${kind}" data-org="${esc(org.id)}" aria-label="Скачать: ${title}">Скачать ${icon('download')}</button></div>`).join('')}</div>`;
  const news = state.news.filter(n => n.orgId === org.id);
  return `<div class="detail-columns"><div><section class="content-box"><h2>${state.user.role === 'student' ? 'Добро пожаловать в свою школу' : 'Здесь растут и открывают новое'}</h2><p>${esc(org.description)}</p><div class="detail-features">${org.features.map(feature => `<span class="tag">${icon('check')}${esc(feature)}</span>`).join('')}</div><h2 style="margin-top:27px">Всё важное для вас</h2><p>Здесь собраны новости, документы и контакты вашей организации. Заглядывайте, чтобы быть в курсе событий.</p><a class="text-button" href="#org/${esc(org.id)}/news">Новости организации ${icon('arrow')}</a></section><div class="note-box">${icon('check')}<span>Вы видите пространство своей организации. Привязкой аккаунта управляет администратор.</span></div></div><aside class="content-box"><h2>Полезная информация</h2>${[['pin','Адрес',org.district + ' район, ' + org.address],['clock','Время работы',org.hours],['mail','Электронная почта',org.email || 'Контакт пока не добавлен'],['users','Возраст или классы',org.tag]].map(([symbol,label,value]) => `<div class="info-row">${icon(symbol)}<div><span>${label}</span><strong>${esc(value)}</strong></div></div>`).join('')}<a class="button button-soft" style="width:100%;margin-top:23px" href="#org/${esc(org.id)}/documents">Документы ${icon('arrow')}</a></aside></div>${news.length ? `<section class="section news-section" style="margin-top:40px"><div class="section-heading"><div><h2>Новости вашей организации</h2><p>Объявления и ближайшие события</p></div></div><div class="news-grid">${news.slice(0,3).map(newsCard).join('')}</div></section>` : ''}`;
}
function profileFields(org = {}) {
  return `<div class="form-grid"><label class="field full">Название организации<input name="name" required maxlength="100" value="${esc(org.name)}"></label><label class="field">Тип организации<select name="type">${Object.entries(TYPES).map(([type,label]) => `<option value="${type}" ${org.type === type ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="field">Район<select name="district">${DISTRICTS.map(d => `<option ${org.district === d ? 'selected' : ''}>${d}</option>`).join('')}</select></label><label class="field full">Адрес<input name="address" required maxlength="140" value="${esc(org.address)}"></label><label class="field">Время работы<input name="hours" required maxlength="80" value="${esc(org.hours || 'Пн–пт · 08:00–18:00')}"></label><label class="field">Возраст или классы<input name="tag" required maxlength="40" value="${esc(org.tag || '1–11 классы')}"></label><label class="field full">Электронная почта<input name="email" type="email" maxlength="120" value="${esc(org.email)}" placeholder="Необязательное поле"></label><label class="field full">Описание<textarea name="description" required maxlength="1200">${esc(org.description)}</textarea></label><label class="field full">Направления и возможности<input name="features" required maxlength="240" value="${esc((org.features || ['Учебные программы']).join(', '))}"><small>Перечислите через запятую.</small></label></div>`;
}
function bindProfileForm(org, creating = false) {
  document.getElementById('profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(form));
      data.features = data.features.split(',').map(s => s.trim()).filter(Boolean);
      const result = await api(creating ? '/organizations' : '/organizations/' + org.id, {method:creating ? 'POST' : 'PUT',body:data});
      await loadData();
      toast(creating ? 'Организация добавлена' : 'Изменения сохранены на сервере');
      navigate(creating ? '#org/' + result.organization.id : location.hash, creating);
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });
}
function renderNewOrg() {
  document.title = 'Добавить организацию — Образование рядом';
  main.innerHTML = `<div class="container page-wrap narrow-page">${breadcrumbs([{label:'Новая организация'}])}<h1 class="page-heading">Добавить организацию</h1><p class="page-lead">Создайте страницу, затем привяжите к ней учеников и учителей в разделе пользователей.</p><section class="content-box"><form id="profile-form">${profileFields()}<div class="form-actions"><button class="button button-primary" type="submit">${icon('plus')}Добавить организацию</button><a class="text-button" href="#catalog">Отмена</a></div></form></section></div>`;
  bindProfileForm(null, true);
}
function renderCabinet(org, tab) {
  state.cabinetOrg = org.id;
  if (tab) state.cabinetTab = tab === 'news' ? 'news' : 'profile';
  document.title = 'Управление страницей — Образование рядом';
  main.innerHTML = `<div class="container page-wrap">${breadcrumbs([{label:'Управление страницей'}])}<div class="cabinet-heading"><h1 class="page-heading">Управление страницей</h1><span class="role-badge">${icon('user')}${ROLES[state.user.role]}</span></div><p class="page-lead">${isAdmin() ? 'Обновляйте страницы организаций области.' : 'Обновляйте информацию и публикуйте новости своей организации.'}</p><div class="cabinet-layout"><aside class="cabinet-sidebar"><span class="eyebrow">${isAdmin() ? 'ОРГАНИЗАЦИЯ' : 'ВАША ОРГАНИЗАЦИЯ'}</span>${isAdmin() ? `<label for="cabinet-org">Выберите организацию</label><select id="cabinet-org">${state.organizations.map(o => `<option value="${esc(o.id)}" ${o.id === org.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>` : `<strong class="own-organization-name">${esc(org.name)}</strong>`}<div class="cabinet-menu"><button data-cabinet-tab="profile" aria-pressed="${state.cabinetTab === 'profile'}">${icon('school')}Моя страница</button><button data-cabinet-tab="news" aria-pressed="${state.cabinetTab === 'news'}">${icon('book')}Новости</button></div><a class="text-button" href="#org/${esc(org.id)}" style="margin-top:18px">Открыть страницу ${icon('arrow')}</a></aside><section class="content-box" id="cabinet-content"></section></div></div>`;
  if (isAdmin()) document.getElementById('cabinet-org').addEventListener('change', event => navigate('#cabinet/' + event.target.value + '/' + state.cabinetTab));
  renderCabinetContent(org);
}
function renderCabinetContent(org) {
  const content = document.getElementById('cabinet-content');
  if (state.cabinetTab === 'profile') {
    content.innerHTML = `<h2>Информация об организации</h2><form id="profile-form">${profileFields(org)}<div class="form-actions"><button class="button button-primary" type="submit">${icon('check')}Сохранить изменения</button><span class="local-save-note">Изменения будут видны аккаунтам этой организации</span></div></form>`;
    bindProfileForm(org);
    return;
  }
  const news = state.news.filter(n => n.orgId === org.id);
  content.innerHTML = `<h2>Добавить новость</h2><form id="news-form"><div class="form-grid"><label class="field full">Заголовок<input name="title" required maxlength="120" placeholder="Например, день открытых дверей"></label><label class="field">Категория<select name="category"><option>События</option><option>Кружки</option><option>Родителям</option></select></label><label class="field">Дата публикации<input type="date" name="date" value="2026-10-11" min="2020-01-01" max="2030-12-31" required></label><label class="field full">Короткое описание<input name="summary" maxlength="180" required></label><label class="field full">Текст новости<textarea name="body" maxlength="5000" required></textarea></label></div><div class="form-actions"><button class="button button-primary" type="submit">${icon('plus')}Опубликовать новость</button></div></form><div class="cabinet-news-list"><h2 style="font-size:1.05rem;margin-bottom:0">Публикации организации · ${news.length}</h2>${news.length ? news.map(n => `<div class="cabinet-news-row"><div><a href="#article/${esc(n.id)}"><strong>${esc(n.title)}</strong></a><small>${dateLabel(n.date)}</small></div><button class="icon-button" data-delete-news="${esc(n.id)}" aria-label="Удалить новость: ${esc(n.title)}">${icon('close')}</button></div>`).join('') : '<p>Опубликуйте первую новость вашей организации.</p>'}</div>`;
  document.getElementById('news-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      await api('/news', {method:'POST',body:{...Object.fromEntries(new FormData(form)),orgId:org.id}});
      await loadData();
      renderCabinetContent(state.organizations.find(o => o.id === org.id));
      toast('Новость опубликована для вашей организации');
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });
}
function renderUsers() {
  document.title = 'Пользователи — Образование рядом';
  main.innerHTML = `<div class="container page-wrap">${breadcrumbs([{label:'Пользователи'}])}<div class="section-heading"><div><h1 class="page-heading">Пользователи и доступ</h1><p>Каждый ученик и учитель привязан к одной организации.</p></div><a class="button button-primary" href="#new-user">${icon('plus')}Добавить аккаунт</a></div><div class="users-table"><div class="users-table-head"><span>Пользователь</span><span>Роль</span><span>Организация</span><span></span></div>${state.users.map(user => `<div class="user-row"><div><strong>${esc(user.name)}</strong><small>${esc(user.username)}</small></div><span class="role-badge">${ROLES[user.role]}</span><span class="user-org-name">${esc(user.role === 'admin' ? 'Все организации области' : state.organizations.find(o => o.id === user.orgId)?.name || 'Организация не найдена')}</span>${user.role === 'admin' ? '<span class="user-admin-label">Администратор</span>' : `<a class="text-button" href="#user/${esc(user.id)}">Изменить привязку ${icon('arrow')}</a>`}</div>`).join('')}</div></div>`;
}
function renderUserForm(user = null) {
  document.title = (user ? 'Привязка аккаунта' : 'Добавить аккаунт') + ' — Образование рядом';
  main.innerHTML = `<div class="container page-wrap narrow-page">${breadcrumbs([{label:'Пользователи',href:'#users'},{label:user ? 'Привязка аккаунта' : 'Новый аккаунт'}])}<h1 class="page-heading">${user ? 'Привязка аккаунта' : 'Добавить аккаунт'}</h1><p class="page-lead">${user ? 'При смене организации текущие сеансы пользователя завершатся. После нового входа откроется назначенная организация.' : 'Укажите роль и организацию. После входа пользователь сразу попадёт на её страницу.'}</p><section class="content-box"><form id="user-form"><div class="form-grid"><label class="field full">Отображаемое имя<input name="name" required maxlength="80" value="${esc(user?.name)}"></label><label class="field">Роль пользователя<select name="role"><option value="student" ${user?.role === 'student' ? 'selected' : ''}>Ученик</option><option value="teacher" ${user?.role === 'teacher' ? 'selected' : ''}>Учитель</option></select></label><label class="field">Организация пользователя<select name="orgId" required>${state.organizations.map(o => `<option value="${esc(o.id)}" ${user?.orgId === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>${user ? `<div class="field full">Логин<strong>${esc(user.username)}</strong></div>` : '<label class="field">Логин нового аккаунта<input name="username" required minlength="3" maxlength="40" pattern="[a-zA-Z][a-zA-Z0-9_.-]{2,39}" autocomplete="off"><small>Латинские буквы, цифры, точка, дефис или подчёркивание.</small></label><label class="field">Пароль нового аккаунта<input name="password" type="password" required minlength="8" maxlength="128" autocomplete="new-password"><small>Минимум 8 символов.</small></label>'}</div><div class="form-actions"><button class="button button-primary" type="submit">${icon(user ? 'check' : 'plus')}${user ? 'Сохранить привязку' : 'Создать аккаунт'}</button><a class="text-button" href="#users">Отмена</a></div></form></section></div>`;
  document.getElementById('user-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      await api('/users' + (user ? '/' + user.id : ''), {method:user ? 'PUT' : 'POST',body:Object.fromEntries(new FormData(form))});
      await loadData();
      toast(user ? 'Привязка аккаунта обновлена' : 'Аккаунт создан');
      navigate('#users');
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });
}
function renderAllNews() {
  document.title = 'Новости — Образование рядом';
  const news = state.news.filter(n => state.newsCategory === 'all' || n.category === state.newsCategory);
  main.innerHTML = `<div class="container page-wrap">${breadcrumbs([{label:'Новости'}])}<h1 class="page-heading">Новости организаций</h1><p class="page-lead">События и объявления области.</p><div class="type-filters news-filters">${[['all','Все новости'],['События','События'],['Кружки','Кружки'],['Родителям','Родителям']].map(([category,label]) => `<button class="filter-chip" data-news-category="${category}" aria-pressed="${state.newsCategory === category}">${label}</button>`).join('')}</div><div class="news-grid">${news.length ? news.map(newsCard).join('') : '<div class="empty-state"><h3>В этой категории пока нет новостей</h3></div>'}</div></div>`;
}
function renderArticle(news) {
  const org = state.organizations.find(o => o.id === news.orgId);
  document.title = news.title + ' — Образование рядом';
  main.innerHTML = `<div class="container page-wrap">${breadcrumbs([{label:'Новости',href:isAdmin() ? '#all-news' : '#org/' + state.user.orgId + '/news'},{label:news.title}])}<article class="article"><div class="news-meta"><span class="category">${esc(news.category)}</span><time datetime="${esc(news.date)}">${dateLabel(news.date)}</time></div><h1 class="page-heading">${esc(news.title)}</h1><p class="page-lead">${esc(news.summary)}</p>${org ? `<a class="text-button" href="#org/${esc(org.id)}">${esc(org.name)} ${icon('arrow')}</a>` : ''}${newsArt(news)}<div class="article-body">${news.body.split('\n').filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('')}</div></article></div>`;
}
function renderDenied(message = 'Этот раздел недоступен вашему аккаунту.') {
  document.title = 'Доступ ограничен — Образование рядом';
  main.innerHTML = `<div class="container page-wrap access-denied"><div class="empty-state">${icon('user')}<h1 class="page-heading">У каждого — своё пространство</h1><p>${esc(message)}</p><a class="button button-primary" href="${homeHash()}">${isAdmin() ? 'К организациям' : 'В свою организацию'} ${icon('arrow')}</a></div></div>`;
}
function renderError(message) {
  main.innerHTML = `<div class="container page-wrap access-denied"><div class="empty-state">${icon('info')}<h1 class="page-heading">Не удалось открыть портал</h1><p>${esc(message)}</p><button class="button button-primary" data-retry>Попробовать ещё раз</button></div></div>`;
}
async function route() {
  const ticket = ++state.ticket;
  document.getElementById('mobile-nav').hidden = true;
  document.getElementById('mobile-toggle').setAttribute('aria-expanded', 'false');
  window.scrollTo(0,0);
  if (!state.user) { renderLogin(); updateShell(); return; }
  const [page,id,tab] = (location.hash.slice(1) || 'home').split('/');
  if (['home','login','catalog','news','all-news'].includes(page) && !isAdmin()) {
    history.replaceState(null, '', homeHash() + (['news','all-news'].includes(page) ? '/news' : ''));
    return route();
  }
  try {
    if (['home','login','catalog'].includes(page)) renderAdmin();
    else if (page === 'org') {
      if (!canRead(id)) { renderDenied('Вы можете открывать только организацию, к которой привязан ваш аккаунт.'); }
      else {
        const data = await api('/organizations/' + encodeURIComponent(id));
        if (ticket !== state.ticket) return;
        renderOrganization(data.organization, tab);
      }
    } else if (page === 'article') {
      const data = await api('/news/' + encodeURIComponent(id));
      if (ticket !== state.ticket) return;
      renderArticle(data.news);
    } else if (page === 'all-news' || page === 'news') renderAllNews();
    else if (page === 'cabinet') {
      const orgId = id || state.user.orgId || state.cabinetOrg || state.organizations[0]?.id;
      if (!canEdit() || !canRead(orgId)) renderDenied('У вас нет права управлять этой организацией.');
      else {
        const data = await api('/organizations/' + encodeURIComponent(orgId));
        if (ticket !== state.ticket) return;
        renderCabinet(data.organization, tab);
      }
    } else if (!isAdmin()) renderDenied();
    else if (page === 'new-org') renderNewOrg();
    else if (page === 'users') renderUsers();
    else if (page === 'new-user') renderUserForm();
    else if (page === 'user') {
      const user = state.users.find(u => u.id === id && u.role !== 'admin');
      if (user) renderUserForm(user); else renderDenied('Аккаунт не найден или недоступен для изменения.');
    } else renderDenied('Такой страницы пока нет.');
  } catch (error) {
    if (ticket !== state.ticket) return;
    if (error.status === 403 || error.status === 404) renderDenied(error.message);
    else renderError(error.message);
  }
  updateShell();
}
async function downloadDocument(kind, orgId) {
  if (!canRead(orgId)) return;
  try {
    const response = await fetch('/api/organizations/' + encodeURIComponent(orgId) + '/documents/' + kind, {credentials:'same-origin',cache:'no-store'});
    if (!response.ok) {
      const result = await response.json();
      if (response.status === 401) { clearAccount(); navigate('#login', true); }
      throw new Error(result.error);
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = orgId + '-' + kind + '-demo.txt';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { toast(error.message); }
}
main.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.loginRole) { state.loginRole = button.dataset.loginRole; renderLogin(); }
  else if (button.dataset.fillDemo) {
    const form = document.getElementById('login-form');
    form.elements.username.value = button.dataset.fillDemo;
    form.elements.password.value = 'Demo2026!';
    form.elements.username.focus();
  } else if (button.dataset.type && isAdmin()) { state.type = button.dataset.type; state.page = 1; renderCatalog(); }
  else if (button.dataset.view && isAdmin()) { state.view = button.dataset.view; renderCatalog(); }
  else if (button.dataset.page && isAdmin()) { state.page = Number(button.dataset.page); renderCatalog(); }
  else if (button.hasAttribute('data-reset-filters') && isAdmin()) { Object.assign(state,{query:'',type:'all',district:'all',page:1}); renderAdmin(); }
  else if (button.dataset.cabinetTab && canEdit()) { state.cabinetTab = button.dataset.cabinetTab; navigate('#cabinet/' + state.cabinetOrg + '/' + state.cabinetTab); }
  else if (button.dataset.newsCategory && isAdmin()) { state.newsCategory = button.dataset.newsCategory; renderAllNews(); }
  else if (button.dataset.deleteNews && canEdit()) {
    button.disabled = true;
    try { await api('/news/' + button.dataset.deleteNews,{method:'DELETE',body:{}}); await loadData(); await route(); toast('Новость удалена'); }
    catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  } else if (button.dataset.download) await downloadDocument(button.dataset.download, button.dataset.org);
  else if (button.hasAttribute('data-retry')) await initialize();
});
document.getElementById('account-actions').addEventListener('click', async event => {
  const button = event.target.closest('[data-logout]');
  if (!button) return;
  button.disabled = true;
  try { await api('/logout',{method:'POST',body:{}}); clearAccount(); signalAccountChange(); navigate('#login',true); }
  catch (error) { toast(error.message); button.disabled = false; }
});
document.getElementById('accessibility').addEventListener('click', () => {
  state.largeText = !state.largeText;
  try { localStorage.setItem('edu-text-size', state.largeText ? 'large' : 'normal'); } catch {}
  updateShell();
});
document.getElementById('mobile-toggle').addEventListener('click', () => {
  const menu = document.getElementById('mobile-nav');
  menu.hidden = !menu.hidden;
  document.getElementById('mobile-toggle').setAttribute('aria-expanded',String(!menu.hidden));
});
document.querySelector('.skip-link').addEventListener('click', event => { event.preventDefault(); main.focus(); main.scrollIntoView({block:'start'}); });
const dialog = document.getElementById('info-dialog');
document.getElementById('demo-info').addEventListener('click', () => dialog.showModal());
document.getElementById('close-dialog').addEventListener('click', () => dialog.close());
document.getElementById('dialog-done').addEventListener('click', () => dialog.close());
window.addEventListener('hashchange', route);
async function initialize(goHome = false) {
  const epoch = state.authEpoch;
  try {
    const session = await api('/session');
    if (epoch !== state.authEpoch) return;
    Object.assign(state, session);
    if (state.user) await loadData();
    if (epoch !== state.authEpoch) return;
    if (goHome) history.replaceState(null, '', homeHash());
    await route();
  } catch (error) {
    if (epoch !== state.authEpoch) return;
    clearAccount(); renderError(error.message); updateShell();
  }
}
initialize();
