'use strict';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const main = document.getElementById('main');
const TYPES = {school:'Школа',garden:'Детский сад',extra:'Дополнительное образование'};
const ROLES = {student:'Ученик / родитель',teacher:'Сотрудник организации',admin:'Администратор'};
const DISTRICTS = ['Центральный','Северный','Южный','Восточный','Западный'];
const STATUS = {draft:'Черновик',published:'Опубликовано',archived:'В архиве'};
const DICTIONARY = {
  ru:{brand:'Образование рядом',region:'Демонстрационный портал',catalog:'Организации',news:'Новости',login:'Войти',cabinet:'Кабинет',logout:'Выйти',all:'Все',schools:'Школы',gardens:'Детские сады',extra:'Кружки и секции',school:'Школа',garden:'Детский сад',title:'Школы и детские сады. Всё важное рядом.',intro:'Познакомьтесь с организациями, найдите контакты, новости и документы — без регистрации.',search:'Название, номер или район',allDistricts:'Все районы',found:'Найдено',open:'Открыть сайт',overview:'Об организации',parents:'Родителям',groups:'Группы и режим дня',program:'Обучение и программы',documents:'Документы',contacts:'Контакты',address:'Адрес',hours:'Время работы',phone:'Телефон',email:'Электронная почта',ages:'Возрастные группы',routine:'Режим дня',download:'Скачать',empty:'Информация пока не добавлена.',missing:'Перевод ещё не добавлен.',noResults:'Организации не найдены. Измените поиск.',noNews:'Опубликованных новостей пока нет.',noDocs:'Опубликованных документов пока нет.',demo:'Макет MVP · Данные демонстрационные',back:'К организациям',employee:'Для сотрудников',parentTitle:'Полезная информация для семьи',footer:'Сайт организации. Информация для семьи.',districts:['Центральный','Северный','Южный','Восточный','Западный']},
  kk:{brand:'Білім беру жақын',region:'Демонстрациялық портал',catalog:'Ұйымдар',news:'Жаңалықтар',login:'Кіру',cabinet:'Кабинет',logout:'Шығу',all:'Барлығы',schools:'Мектептер',gardens:'Балабақшалар',extra:'Үйірмелер мен секциялар',school:'Мектеп',garden:'Балабақша',title:'Мектептер мен балабақшалар. Маңызды ақпарат жақын.',intro:'Ұйымдармен танысып, байланыс деректерін, жаңалықтар мен құжаттарды тіркелусіз табыңыз.',search:'Атауы, нөмірі немесе ауданы',allDistricts:'Барлық аудандар',found:'Табылды',open:'Сайтты ашу',overview:'Ұйым туралы',parents:'Ата-аналарға',groups:'Топтар және күн тәртібі',program:'Оқу және бағдарламалар',documents:'Құжаттар',contacts:'Байланыс',address:'Мекенжай',hours:'Жұмыс уақыты',phone:'Телефон',email:'Электрондық пошта',ages:'Жас топтары',routine:'Күн тәртібі',download:'Жүктеу',empty:'Ақпарат әлі қосылмаған.',missing:'Аудармасы әлі қосылмаған.',noResults:'Ұйымдар табылмады. Іздеуді өзгертіңіз.',noNews:'Жарияланған жаңалықтар әзірге жоқ.',noDocs:'Жарияланған құжаттар әзірге жоқ.',demo:'MVP макеті · Демонстрациялық деректер',back:'Ұйымдарға оралу',employee:'Қызметкерлерге',parentTitle:'Отбасыға пайдалы ақпарат',footer:'Ұйым сайты. Отбасыға арналған ақпарат.',districts:['Орталық','Солтүстік','Оңтүстік','Шығыс','Батыс']}
};
const state = {user:null,csrf:'',public:{organizations:[],news:[],documents:[]},private:{organizations:[],news:[],documents:[],quality:[]},users:[],audit:[],lang:'ru',query:'',type:'all',district:'all',page:1,view:'grid',loginRole:'teacher',epoch:0,render:0,largeText:false};
try { state.lang = new URLSearchParams(location.search).get('lang') || localStorage.getItem('edu-language') || 'ru'; state.largeText = localStorage.getItem('edu-text-size') === 'large'; } catch {}
if (!['ru','kk'].includes(state.lang)) state.lang = 'ru';
const t = key => DICTIONARY[state.lang][key] ?? key;
const translated = (item,key) => state.lang === 'kk' ? (item[key + 'Kk'] || t('missing')) : (item[key] || t('empty'));
const typeLabel = type => t(type === 'extra' ? 'extra' : type);
const districtLabel = value => DICTIONARY[state.lang].districts[DISTRICTS.indexOf(value)] || value;
const orgIcon = type => type === 'garden' ? 'flower' : type === 'extra' ? 'spark' : 'school';
const paragraphs = text => String(text || '').split('\n').filter(Boolean).map(line => `<p>${esc(line)}</p>`).join('');
const dateLabel = value => new Date(value + 'T12:00:00').toLocaleDateString(state.lang === 'kk' ? 'kk-KZ' : 'ru-RU',{day:'numeric',month:'long',year:'numeric'});
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const isAdmin = () => state.user?.role === 'admin';
const isStaff = () => ['admin','teacher'].includes(state.user?.role);
const privateOrg = id => state.private.organizations.find(org => org.id === id);
let toastTimer;
function toast(message) { const element = document.getElementById('toast'); element.textContent = message; element.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => element.hidden = true,4500); }
function navigate(hash) { if (location.hash === hash) route(); else location.hash = hash; }
function clearPrivate() { state.epoch++; Object.assign(state,{user:null,csrf:'',private:{organizations:[],news:[],documents:[],quality:[]},users:[],audit:[]}); }
async function api(path,{method='GET',body}={}) {
  const response = await fetch('/api' + path,{method,credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json',...(method === 'GET' ? {} : {'X-CSRF-Token':state.csrf})},...(body === undefined ? {} : {body:JSON.stringify(body)})});
  const result = await response.json().catch(() => ({error:'Не удалось прочитать ответ сервера.'}));
  if (!response.ok) { if (response.status === 401 && path !== '/login') clearPrivate(); const error = new Error(result.error || 'Не удалось выполнить действие.'); error.status = response.status; throw error; }
  return result;
}
async function loadData() {
  const epoch = state.epoch;
  const [publicData,session] = await Promise.all([api('/public/bootstrap'),api('/session')]);
  if (epoch !== state.epoch) return;
  state.public = publicData; state.user = session.user; state.csrf = session.csrf || '';
  if (state.user) {
    const privateData = await api('/bootstrap');
    const users = isAdmin() ? (await api('/users')).users : [];
    const audit = isStaff() ? (await api('/audit')).audit : [];
    if (epoch !== state.epoch) return;
    Object.assign(state,{private:privateData,users,audit});
  }
}
const accountChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('edu-account') : null;
if (accountChannel) accountChannel.onmessage = async () => { clearPrivate(); await initialize(); };
function shell() {
  document.documentElement.lang = state.lang;
  document.body.classList.toggle('large-text',state.largeText);
  const brand = document.querySelector('header .brand'); brand.href = '#catalog'; brand.querySelector('strong').textContent = t('brand'); brand.querySelector('small').textContent = t('region'); brand.setAttribute('aria-label',t('brand'));
  const links = [['#catalog',t('catalog')],['#all-news',t('news')],...(state.user ? [[isAdmin() ? '#admin' : isStaff() ? '#cabinet/' + state.user.orgId : '#org/' + state.user.orgId,t('cabinet')]] : [])];
  const navigation = links.map(([href,label]) => `<a href="${href}" ${location.hash === href ? 'aria-current="page"' : ''}>${label}</a>`).join('');
  for (const id of ['main-nav','mobile-nav','footer-links']) document.getElementById(id).innerHTML = navigation;
  document.getElementById('mobile-toggle').hidden = false;
  document.getElementById('account-actions').innerHTML = `<div class="language-switch" aria-label="Language"><button data-language="ru" aria-pressed="${state.lang === 'ru'}">RU</button><button data-language="kk" aria-pressed="${state.lang === 'kk'}">ҚАЗ</button></div>${state.user ? `<button class="button button-outline logout-button" data-logout>${t('logout')}</button>` : `<a class="button button-outline logout-button" href="#login">${t('login')}</a>`}`;
  document.getElementById('accessibility').setAttribute('aria-pressed',String(state.largeText));
  document.querySelector('footer .brand strong').textContent = t('brand'); document.querySelector('footer .brand small').textContent = t('footer');
  document.querySelector('footer .brand').href = '#catalog'; document.querySelector('.footer-bottom>span:first-child').textContent = '© ' + new Date().getFullYear() + ' ' + t('brand');
  const publicText = state.lang === 'kk' ? {skip:'Мазмұнға өту',menu:'Мәзірді ашу',nav:'Негізгі мәзір',access:'Мәтінді үлкейту',about:'Демо туралы',close:'Жабу',done:'Түсінікті'} : {skip:'Перейти к содержимому',menu:'Открыть меню',nav:'Основное меню',access:'Увеличить размер текста',about:'О демоверсии',close:'Закрыть',done:'Понятно'};
  document.querySelector('.skip-link').textContent = publicText.skip; document.getElementById('mobile-toggle').setAttribute('aria-label',publicText.menu); document.getElementById('main-nav').setAttribute('aria-label',publicText.nav); document.getElementById('mobile-nav').setAttribute('aria-label',publicText.nav); document.getElementById('accessibility').setAttribute('aria-label',publicText.access); document.getElementById('demo-info').textContent = publicText.about; document.getElementById('close-dialog').setAttribute('aria-label',publicText.close); document.getElementById('dialog-done').textContent = publicText.done;
  const demoDialog = document.getElementById('info-dialog'); demoDialog.querySelector('h2').textContent = state.lang === 'kk' ? 'Отбасыға арналған сайттар, қызметкерлерге арналған кабинеттер' : 'Сайты для семьи, кабинеты для сотрудников';
  const demoParagraphs = demoDialog.querySelectorAll('p'); demoParagraphs[0].textContent = state.lang === 'kk' ? 'Жарияланған ақпарат, жаңалықтар мен құжаттар тіркелусіз қолжетімді. Қызметкер өз ұйымын жаңартады, әкімші желіні басқарады.' : 'Опубликованные сведения, новости и документы доступны без входа. Сотрудник обновляет свою организацию, администратор управляет сетью.'; demoParagraphs[1].textContent = state.lang === 'kk' ? 'Ұйымдар мен материалдар ойдан шығарылған. Кабинет әзірге орыс тілінде. PDF/TXT файлдары қабылданады, антивирустық тексеру жоқ. Серверлік пилот пен жүктемені тексеру әлі жүргізілмеген.' : 'Организации и материалы вымышленные. Кабинет пока на русском. Принимаются PDF/TXT без антивирусной проверки. Серверный пилот и проверка нагрузки ещё предстоят.';
  document.querySelector('.footer-bottom>span:last-of-type').textContent = t('demo');
}
function heading(title,description='') { return `<h1 class="page-heading">${esc(title)}</h1>${description ? `<p class="page-lead">${esc(description)}</p>` : ''}`; }
function empty(message) { return `<div class="empty-state"><p>${esc(message)}</p></div>`; }
function renderCatalogPage() {
  document.title = t('catalog') + ' — ' + t('brand');
  main.innerHTML = `<div class="container"><section class="hero public-hero"><div><span class="hero-label">${icon('check')} ${t('brand')}</span><h1>${t('title')}</h1><p class="hero-description">${t('intro')}</p><a class="button button-primary" href="#organizations-section">${t('catalog')} ${icon('arrow')}</a></div><div class="hero-art"><img src="./campus.svg" alt="" width="600" height="420"></div></section><section class="section" id="organizations-section"><div class="section-heading"><h2>${t('catalog')}</h2><span>${state.public.organizations.length} · RU / ҚАЗ</span></div><div class="type-filters">${[['all','all'],['school','schools'],['garden','gardens'],['extra','extra']].map(([key,label]) => `<button class="filter-chip" data-type="${key}" aria-pressed="${state.type === key}">${t(label)}</button>`).join('')}</div><div class="catalog-tools"><label class="catalog-query">${icon('search')}<span class="sr-only">${t('search')}</span><input id="catalog-query" type="search" placeholder="${t('search')}" value="${esc(state.query)}"></label><label class="sr-only" for="district-filter">${t('allDistricts')}</label><select class="district-select" id="district-filter"><option value="all">${t('allDistricts')}</option>${DISTRICTS.map(value => `<option value="${value}" ${state.district === value ? 'selected' : ''}>${districtLabel(value)}</option>`).join('')}</select><span class="catalog-result" id="catalog-result" role="status"></span></div><div class="org-grid" id="org-grid"></div><div class="pagination" id="pagination"></div></section></div>`;
  catalogResults();
  document.getElementById('catalog-query').addEventListener('input',event => { state.query = event.target.value; state.page = 1; catalogResults(); });
  document.getElementById('district-filter').addEventListener('change',event => { state.district = event.target.value; state.page = 1; catalogResults(); });
}
function catalogResults() {
  const normalized = value => String(value).toLowerCase().replace(/ё/g,'е').replace(/№/g,'').trim();
  const orgs = state.public.organizations.filter(org => (state.type === 'all' || org.type === state.type) && (state.district === 'all' || org.district === state.district) && normalized([org.name,org.nameKk,org.district].join(' ')).includes(normalized(state.query)));
  const pages = Math.ceil(orgs.length/6); state.page = Math.max(1,Math.min(state.page,pages || 1));
  document.getElementById('catalog-result').textContent = `${t('found')}: ${orgs.length}`;
  document.getElementById('org-grid').innerHTML = orgs.length ? orgs.slice((state.page-1)*6,state.page*6).map(org => `<article class="org-card"><div class="org-card-top"><span class="org-symbol ${esc(org.type)}">${icon(orgIcon(org.type))}</span><span class="org-kind">${typeLabel(org.type)}</span></div><div class="org-content"><h3><a href="#org/${esc(org.id)}">${esc(translated(org,'name'))}</a></h3><p class="org-location">${icon('pin')}${esc(districtLabel(org.district))}</p><p class="catalog-description">${esc(translated(org,'description'))}</p></div><div class="org-card-bottom"><span class="tag">${esc(translated(org,'tag'))}</span><a class="text-button" href="#org/${esc(org.id)}">${t('open')} ${icon('arrow')}</a></div></article>`).join('') : empty(t('noResults'));
  document.getElementById('pagination').innerHTML = pages > 1 ? Array.from({length:pages},(_,i) => `<button data-page="${i+1}" aria-label="${i+1}" ${state.page === i+1 ? 'aria-current="page"' : ''}>${i+1}</button>`).join('') : '';
}
function newsCard(news,preview=false) { return `<article class="news-card"><div class="news-art art-${esc(news.art || 'school')}"><span>${icon('book')}</span></div><div class="news-meta"><span>${esc(state.lang === 'kk' ? {'События':'Оқиғалар','Кружки':'Үйірмелер','Родителям':'Ата-аналарға'}[news.category] : news.category)}</span><time datetime="${esc(news.date)}">${dateLabel(news.date)}</time></div><h3><a href="${preview ? '#preview-article/' : '#article/'}${esc(news.id)}">${esc(translated(news,'title'))}</a></h3><p>${esc(translated(news,'summary'))}</p></article>`; }
function documentList(documents,preview=false) { return documents.length ? `<div class="document-list">${documents.map(doc => `<div class="document-row">${icon('file')}<div><strong>${esc(translated(doc,'title'))}</strong><small>${esc(doc.filename.split('.').pop().toUpperCase())} · ${Math.ceil(doc.size/1024)} KB</small></div><a class="text-button" href="/api/${preview ? '' : 'public/'}documents/${esc(doc.id)}" download>${t('download')} ${icon('download')}</a></div>`).join('')}</div>` : empty(t('noDocs')); }
function renderOrganization(org,tab='overview',preview=false) {
  document.title = translated(org,'name') + ' — ' + t('brand');
  const data = preview ? state.private : state.public;
  const tabs = {overview:t('overview'),parents:t('parents'),program:org.type === 'garden' ? t('groups') : t('program'),news:t('news'),documents:t('documents'),contacts:t('contacts')};
  if (!tabs[tab]) tab = 'overview';
  const base = preview ? '#preview/' : '#org/';
  let content;
  if (tab === 'news') { const news = data.news.filter(item => item.orgId === org.id && (preview || (item.status || 'published') === 'published')); content = news.length ? `<div class="news-grid">${news.map(item => newsCard(item,preview)).join('')}</div>` : empty(t('noNews')); }
  else if (tab === 'documents') content = documentList(data.documents.filter(doc => doc.orgId === org.id),preview);
  else if (tab === 'parents') content = `<section class="content-box"><h2>${t('parentTitle')}</h2>${paragraphs(translated(org,'parentInfo'))}</section>`;
  else if (tab === 'program') content = `<section class="content-box"><h2>${tabs.program}</h2>${org.type === 'garden' ? `<h3>${t('ages')}</h3><div class="detail-features">${(state.lang === 'kk' ? (org.ageGroupsKk || []) : (org.ageGroups || [])).map(group => `<span class="tag">${esc(group)}</span>`).join('') || `<p>${t('empty')}</p>`}</div><h3>${t('routine')}</h3>${paragraphs(translated(org,'routine'))}` : paragraphs(translated(org,'program'))}</section>`;
  else {
    const contacts = [['pin','address',translated(org,'address')],['clock','hours',translated(org,'hours')],['info','phone',org.phone || t('empty')],['mail','email',org.email || t('empty')]];
    const info = `<section class="content-box"><h2>${t('contacts')}</h2>${contacts.map(([symbol,label,value]) => `<div class="info-row">${icon(symbol)}<div><span>${t(label)}</span><strong>${esc(value)}</strong></div></div>`).join('')}</section>`;
    content = tab === 'contacts' ? info : `<div class="detail-columns"><section class="content-box"><h2>${t('overview')}</h2>${paragraphs(translated(org,'description'))}<div class="detail-features">${(state.lang === 'kk' ? (org.featuresKk || []) : org.features).map(value => `<span class="tag">${icon('check')}${esc(value)}</span>`).join('')}</div><a class="button button-soft" href="${base}${esc(org.id)}/parents">${t('parents')} ${icon('arrow')}</a></section>${info}</div>`;
  }
  main.innerHTML = `<div class="container page-wrap"><div class="breadcrumbs"><a href="#catalog">${t('back')}</a></div>${preview ? '<div class="note-box">Предпросмотр кабинета. Черновики видны только сотруднику.</div>' : ''}<div class="detail-hero"><span class="org-symbol ${esc(org.type)}">${icon(orgIcon(org.type))}</span><div class="detail-main"><span class="org-kind">${typeLabel(org.type)} · ${esc(districtLabel(org.district))}</span><h1>${esc(translated(org,'name'))}</h1><p class="org-location">${esc(translated(org,'address'))}</p></div></div><nav class="tabs organization-tabs" aria-label="${t('overview')}">${Object.entries(tabs).map(([key,label]) => `<a class="org-tab ${key === tab ? 'selected' : ''}" ${key === tab ? 'aria-current="page"' : ''} href="${base}${esc(org.id)}/${key}">${label}</a>`).join('')}</nav>${content}</div>`;
}
function renderAllNews() { document.title = t('news'); main.innerHTML = `<div class="container page-wrap">${heading(t('news'))}${state.public.news.length ? `<div class="news-grid">${state.public.news.map(item => newsCard(item)).join('')}</div>` : empty(t('noNews'))}</div>`; }
function renderArticle(news,preview=false) { main.innerHTML = `<div class="container page-wrap"><div class="breadcrumbs"><a href="${preview ? '#preview/' : '#org/'}${esc(news.orgId)}/news">${t('news')}</a></div><article class="article"><div class="news-meta"><time datetime="${esc(news.date)}">${dateLabel(news.date)}</time></div>${heading(translated(news,'title'),translated(news,'summary'))}<div class="article-body">${paragraphs(translated(news,'body'))}</div></article></div>`; document.title = translated(news,'title'); }

function renderLogin() {
  document.title = 'Вход в кабинет — ' + t('brand');
  const demo = {teacher:'teacher-garden',student:'student24',admin:'admin'}[state.loginRole];
  main.innerHTML = `<div class="container login-layout"><section class="login-intro"><span class="hero-label">${t('employee')}</span><h1>Свой сайт.<br>Актуальные новости.<br><em>Всё в порядке.</em></h1><p>Сотрудник управляет своей организацией. Посетителям не нужен аккаунт для чтения опубликованных материалов.</p><div class="login-illustration"><img src="./campus.svg" alt="" width="600" height="420"></div><a class="text-button" href="#catalog">${t('back')} ${icon('arrow')}</a></section><section class="login-card"><h2>Войти в кабинет</h2><div class="role-options">${[['student','Ученик / родитель','book'],['teacher','Сотрудник','user'],['admin','Админ','grid']].map(([key,label,symbol]) => `<button class="role-option" data-login-role="${key}" aria-pressed="${state.loginRole === key}">${icon(symbol)}<span>${label}</span></button>`).join('')}</div><form id="login-form"><label class="field">Логин<input name="username" autocomplete="username" required maxlength="40"></label><label class="field">Пароль<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label><p class="form-error" id="login-error" role="alert" hidden></p><button class="button button-primary login-submit" type="submit">Войти в кабинет ${icon('arrow')}</button></form>${state.public.demoPasswordDefault ? `<div class="demo-login-box"><strong>Тестовая демонстрация</strong><p>Логин: <code>${demo}</code><br>Пароль: <code>Demo2026!</code></p><button class="text-button" data-fill-demo="${demo}">Заполнить тестовый аккаунт</button></div>` : '<p>Для входа используйте учётную запись, выданную администратором.</p>'}<p class="login-footnote">Демоаккаунты предназначены для локального показа. Кабинет MVP на русском языке.</p></section></div>`;
  bindForm('login-form',async data => { await api('/login',{method:'POST',body:{...data,role:state.loginRole}}); state.epoch++; await loadData(); accountChannel?.postMessage('changed'); navigate(isAdmin() ? '#admin' : isStaff() ? '#cabinet/' + state.user.orgId : '#org/' + state.user.orgId); },true);
}
function field(name,label,value='',{type='text',max=4000,required=false,textarea=false,full=true}={}) {
  return `<label class="field ${full ? 'full' : ''}">${label}${textarea ? `<textarea name="${name}" rows="4" maxlength="${max}" ${required ? 'required' : ''}>${esc(value)}</textarea>` : `<input name="${name}" type="${type}" value="${esc(value)}" maxlength="${max}" ${required ? 'required' : ''}>`}</label>`;
}
function selectField(name,label,choices,value,full=false) { return `<label class="field ${full ? 'full' : ''}">${label}<select name="${name}">${Object.entries(choices).map(([key,text]) => `<option value="${esc(key)}" ${value === key ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`; }
function profileFields(org={}) {
  return `<div class="form-grid">${field('name','Название на русском',org.name,{max:100,required:true})}${field('nameKk','Қазақша атауы',org.nameKk,{max:100})}${selectField('type','Тип организации',TYPES,org.type || 'garden')}${selectField('district','Район',Object.fromEntries(DISTRICTS.map(value => [value,value])),org.district || 'Центральный')}${field('address','Адрес на русском',org.address,{max:140,required:true})}${field('addressKk','Қазақша мекенжай',org.addressKk,{max:140})}${field('phone','Телефон',org.phone,{type:'tel',max:40,full:false})}${field('email','Электронная почта',org.email,{type:'email',max:120,full:false})}${field('hours','Режим работы на русском',org.hours || 'Пн–пт · 08:00–18:00',{max:80,required:true})}${field('hoursKk','Қазақша жұмыс уақыты',org.hoursKk,{max:80})}${field('tag','Возраст или классы',org.tag || 'От 2 до 6 лет',{max:40,required:true})}${field('tagKk','Қазақша жас немесе сыныптар',org.tagKk,{max:40})}${field('features','Направления и возможности — через запятую',(org.features || ['Развивающие занятия']).join(', '),{max:960,required:true})}${field('featuresKk','Қазақша бағыттар — үтір арқылы',(org.featuresKk || []).join(', '),{max:960})}${field('description','Описание на русском',org.description,{max:1200,textarea:true,required:true})}${field('descriptionKk','Қазақша сипаттама',org.descriptionKk,{max:1200,textarea:true})}${selectField('visibility','Статус сайта',{draft:'Черновик — скрыт от посетителей',published:'Опубликован — доступен всем'},org.visibility || (org.id ? 'published' : 'draft'),true)}</div>`;
}
const qualityLabels = {name:'Название RU',nameKk:'Название ҚАЗ',description:'Описание RU',descriptionKk:'Описание ҚАЗ',address:'Адрес RU',addressKk:'Адрес ҚАЗ',phone:'Телефон',email:'Почта',parentInfo:'Родителям RU',parentInfoKk:'Родителям ҚАЗ',routine:'Режим дня RU',routineKk:'Режим дня ҚАЗ',ageGroups:'Возрастные группы RU',ageGroupsKk:'Возрастные группы ҚАЗ',program:'Программы RU',programKk:'Программы ҚАЗ',news:'Опубликованная новость',documents:'Опубликованный документ'};
function renderAdmin() {
  const orgs = state.private.organizations;
  const average = orgs.length ? Math.round(state.private.quality.reduce((sum,q) => sum+q.percent,0)/orgs.length) : 0;
  main.innerHTML = `<div class="container page-wrap admin-page"><section class="admin-welcome"><div><span class="eyebrow">АДМИНИСТРАТОР ОБЛАСТИ</span><h1>Сайты школ и садиков.<br>В одном кабинете.</h1><p>Следите за содержанием и назначайте сотрудников.</p></div><a class="button button-primary" href="#new-org">Добавить организацию ${icon('plus')}</a></section><div class="admin-stats">${[[orgs.length,'Организаций'],[orgs.filter(org => org.type === 'garden').length,'Детских садов'],[average+'%','Заполненность'],[state.users.length,'Аккаунтов']].map(([value,label]) => `<div class="admin-stat"><div><strong>${value}</strong><small>${label}</small></div></div>`).join('')}</div><div class="section-heading"><h2>Организации</h2><a class="text-button" href="#users">Пользователи и доступ ${icon('arrow')}</a></div><div class="organization-work-list">${orgs.map(org => { const q = state.private.quality.find(item => item.id === org.id); return `<article class="content-box workspace-org"><span class="org-symbol ${esc(org.type)}">${icon(orgIcon(org.type))}</span><div><h3>${esc(org.name)}</h3><p>${TYPES[org.type]} · ${org.visibility === 'draft' ? 'Черновик сайта' : 'Сайт опубликован'} · ${q?.percent || 0}% заполнено</p></div><a class="button button-outline" href="#cabinet/${esc(org.id)}">Кабинет ${icon('arrow')}</a></article>`; }).join('')}</div><p class="muted-note">Заполненность проверяет наличие сведений. Содержание и обязательные разделы согласуются с заказчиком.</p></div>`;
  document.title = 'Управление платформой';
}
function renderCabinet(org,tab='profile',editing='') {
  const tabs = {profile:'Профиль организации',parents:'Информация родителям',program:org.type === 'garden' ? 'Группы и режим дня' : 'Обучение и программы',news:'Новости',documents:'Документы',quality:'Заполненность',history:'История действий'};
  if (!tabs[tab]) tab = 'profile';
  main.innerHTML = `<div class="container page-wrap"><div class="breadcrumbs"><a href="${isAdmin() ? '#admin' : '#catalog'}">${isAdmin() ? 'Управление платформой' : 'Публичные сайты'}</a><span>${esc(org.name)}</span></div>${heading(tabs[tab],org.type === 'garden' ? 'Кабинет детского сада. Обновляйте сведения для родителей.' : 'Кабинет организации. Обновляйте сведения для семьи.')}<div class="cabinet-layout"><aside class="cabinet-sidebar"><span class="eyebrow">${org.type === 'garden' ? 'ДЕТСКИЙ САД' : 'ОРГАНИЗАЦИЯ'}</span><strong class="own-organization-name">${esc(org.name)}</strong><nav class="cabinet-menu">${Object.entries(tabs).map(([key,label]) => `<a class="cabinet-tab ${key === tab ? 'active' : ''}" href="#cabinet/${esc(org.id)}/${key}" ${key === tab ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav><a class="text-button" href="#preview/${esc(org.id)}">Предпросмотр ${icon('arrow')}</a></aside><section class="content-box" id="cabinet-content"></section></div></div>`;
  const content = document.getElementById('cabinet-content');
  if (tab === 'profile') {
    content.innerHTML = `<form id="profile-form">${profileFields(org)}<div class="form-actions"><button class="button button-primary" type="submit">Сохранить профиль</button></div></form>`;
    bindProfile(org);
  } else if (tab === 'parents' || tab === 'program') {
    const garden = org.type === 'garden'; const key = tab === 'parents' ? 'parentInfo' : garden ? 'routine' : 'program';
    content.innerHTML = `<form id="profile-form"><div class="form-grid">${tab === 'program' && garden ? field('ageGroups','Возрастные группы — через запятую',(org.ageGroups || []).join(', '),{max:480}) + field('ageGroupsKk','Қазақша жас топтары — үтір арқылы',(org.ageGroupsKk || []).join(', '),{max:480}) : ''}${field(key,tab === 'parents' ? 'Информация родителям на русском' : garden ? 'Режим дня на русском' : 'Программы на русском',org[key],{textarea:true})}${field(key+'Kk','Қазақша мәтін',org[key+'Kk'],{textarea:true})}</div><p class="muted-note">Публикуйте только утверждённые сведения для открытого доступа. Информация о конкретных детях в MVP не хранится.</p><button class="button button-primary" type="submit">Сохранить раздел</button></form>`;
    bindProfile(org);
  } else if (tab === 'news') renderNewsEditor(org,editing,content);
  else if (tab === 'documents') renderDocumentsEditor(org,editing,content);
  else if (tab === 'quality') {
    const q = state.private.quality.find(item => item.id === org.id);
    content.innerHTML = `<h2>Заполненность: ${q?.percent || 0}%</h2><p>Показатель наличия материалов, без проверки их достоверности.</p><div class="quality-checks">${Object.entries(q?.checks || {}).map(([key,value]) => `<div><span class="check-state ${value ? 'complete' : ''}">${value ? '✓' : '○'}</span><span>${qualityLabels[key]}</span><a class="text-button" href="#cabinet/${esc(org.id)}/${['news','documents'].includes(key) ? key : key.startsWith('parent') ? 'parents' : ['program','routine','ageGroups'].some(prefix => key.startsWith(prefix)) ? 'program' : 'profile'}">${value ? 'Посмотреть' : 'Заполнить'}</a></div>`).join('')}</div>`;
  } else {
    const labels = {organization_created:'Организация создана',organization_updated:'Сведения обновлены',news_draft:'Новость сохранена',news_published:'Новость опубликована',news_archived:'Новость в архиве',document_draft:'Документ сохранён',document_published:'Документ опубликован',document_archived:'Документ в архиве',user_created:'Аккаунт создан',user_assigned:'Привязка изменена'};
    content.innerHTML = `<h2>Последние действия</h2><p>Последние 100 событий, доступные вашему аккаунту.</p><div class="audit-list">${state.audit.filter(item => item.org_id === org.id).map(item => `<article><strong>${esc(labels[item.event] || item.event)}</strong><p>${esc(item.target)}</p><small>${esc(item.actor)} · ${esc(item.time.replace('T',' '))} UTC</small></article>`).join('') || empty('Действий пока нет.')}</div>`;
  }
  document.title = tabs[tab] + ' — ' + org.name;
}
function bindProfile(org) { bindForm('profile-form',async values => { const data = {...org,...values}; for (const key of ['features','featuresKk','ageGroups','ageGroupsKk']) if (typeof data[key] === 'string') data[key] = data[key].split(',').map(value => value.trim()).filter(Boolean); await api('/organizations/'+org.id,{method:'PUT',body:data}); await loadData(); await route(); toast('Изменения сохранены.'); }); }
function renderNewsEditor(org,id,content) {
  const news = state.private.news.filter(item => item.orgId === org.id);
  if (id) {
    const item = id === 'new' ? {} : news.find(entry => entry.id === id);
    if (!item) throw new Error('Материал не найден.');
    content.innerHTML = `<a class="text-button" href="#cabinet/${esc(org.id)}/news">← К списку</a><h2>${item.id ? 'Редактировать новость' : 'Добавить новость'}</h2><form id="news-form"><div class="form-grid">${field('title','Заголовок RU',item.title,{max:120,required:true})}${field('titleKk','Қазақша тақырып',item.titleKk,{max:120})}${field('summary','Короткое описание RU',item.summary,{max:180,required:true})}${field('summaryKk','Қазақша қысқаша сипаттама',item.summaryKk,{max:180})}${field('body','Текст RU',item.body,{max:5000,textarea:true,required:true})}${field('bodyKk','Қазақша мәтін',item.bodyKk,{max:5000,textarea:true})}${selectField('category','Категория',{'События':'События','Кружки':'Кружки','Родителям':'Родителям'},item.category)}${field('date','Дата новости',item.date || today(),{type:'date',max:10,required:true,full:false})}${selectField('status','Статус',STATUS,item.status || (item.id ? 'published' : 'draft'),true)}</div><p class="muted-note">Статус «Опубликовано» сразу открывает материал посетителям. Дата новости не задаёт отложенную публикацию.</p><button class="button button-primary" type="submit">Сохранить новость</button></form>`;
    bindForm('news-form',async values => { await api(item.id ? '/news/'+item.id : '/news',{method:item.id ? 'PUT' : 'POST',body:{...values,orgId:org.id}}); await loadData(); navigate('#cabinet/'+org.id+'/news'); toast('Новость сохранена.'); });
  } else content.innerHTML = `<div class="section-heading"><h2>Новости</h2><a class="button button-primary" href="#cabinet/${esc(org.id)}/news/new">Добавить новость ${icon('plus')}</a></div><div class="management-list">${news.map(item => `<article><div><strong>${esc(item.title)}</strong><small>${STATUS[item.status || 'published']} · ${dateLabel(item.date)}</small></div><a class="text-button" href="#cabinet/${esc(org.id)}/news/${esc(item.id)}">Редактировать</a>${item.status !== 'archived' ? `<button class="text-button" data-archive-news="${esc(item.id)}">В архив</button>` : ''}</article>`).join('') || empty('Новостей пока нет.')}</div>`;
}
function renderDocumentsEditor(org,id,content) {
  const documents = state.private.documents.filter(item => item.orgId === org.id);
  if (id) {
    const item = id === 'new' ? {} : documents.find(entry => entry.id === id);
    if (!item) throw new Error('Документ не найден.');
    content.innerHTML = `<a class="text-button" href="#cabinet/${esc(org.id)}/documents">← К списку</a><h2>${item.id ? 'Редактировать документ' : 'Загрузить документ'}</h2><form id="document-form"><div class="form-grid">${field('title','Название RU',item.title,{max:120,required:true})}${field('titleKk','Қазақша атауы',item.titleKk,{max:120})}${item.id ? `<p>Файл: ${esc(item.filename)}. Для другой версии загрузите новый документ.</p>` : '<label class="field full">Файл PDF или TXT<input name="file" type="file" accept=".pdf,.txt" required><small>До 8 МБ. TXT — UTF-8. Только документы для открытого доступа.</small></label>'}${selectField('status','Статус',STATUS,item.status || 'draft',true)}</div><p class="muted-note">Черновик доступен только сотрудникам организации. Публикация открывает файл всем посетителям. Архив скрывает его снова.</p><button class="button button-primary" type="submit">Сохранить документ</button></form>`;
    bindForm('document-form',async (values,form) => { const data = {...values,orgId:org.id}; delete data.file; if (!item.id) { const file = form.elements.file.files[0]; if (!file || file.size > 8*1024*1024) throw new Error('Выберите файл до 8 МБ.'); data.filename = file.name; data.fileBase64 = await new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Не удалось прочитать файл.')); reader.readAsDataURL(file); }); } await api(item.id ? '/documents/'+item.id : '/documents',{method:item.id ? 'PUT' : 'POST',body:data}); await loadData(); navigate('#cabinet/'+org.id+'/documents'); toast('Документ сохранён.'); });
  } else content.innerHTML = `<div class="section-heading"><h2>Документы</h2><a class="button button-primary" href="#cabinet/${esc(org.id)}/documents/new">Загрузить документ ${icon('plus')}</a></div><div class="management-list">${documents.map(item => `<article><div><strong>${esc(item.title)}</strong><small>${STATUS[item.status]} · ${esc(item.filename)}</small></div><a class="text-button" href="/api/documents/${esc(item.id)}" download>Скачать</a><a class="text-button" href="#cabinet/${esc(org.id)}/documents/${esc(item.id)}">Изменить</a>${item.status !== 'archived' ? `<button class="text-button" data-archive-document="${esc(item.id)}">В архив</button>` : ''}</article>`).join('')}</div>`;
}
function renderNewOrg() { main.innerHTML = `<div class="container page-wrap narrow-page">${heading('Добавить организацию','Новый сайт начинается с черновика. Заполните разделы и назначьте сотрудника.')}<section class="content-box"><form id="profile-form">${profileFields()}<button class="button button-primary" type="submit">Создать организацию</button></form></section></div>`; bindForm('profile-form',async values => { values.features = values.features.split(',').map(v => v.trim()).filter(Boolean); values.featuresKk = values.featuresKk.split(',').map(v => v.trim()).filter(Boolean); const result = await api('/organizations',{method:'POST',body:values}); await loadData(); navigate('#cabinet/'+result.organization.id); toast('Организация создана.'); }); }
function renderUsers() { main.innerHTML = `<div class="container page-wrap">${heading('Пользователи и доступ')}<a class="button button-primary" href="#new-user">Добавить аккаунт</a><div class="management-list users-management">${state.users.map(user => `<article><div><strong>${esc(user.name)}</strong><small>${esc(user.username)} · ${ROLES[user.role]}</small></div><span>${esc(privateOrg(user.orgId)?.name || 'Все организации')}</span>${user.role === 'admin' ? '' : `<a class="text-button" href="#user/${esc(user.id)}">Изменить привязку</a>`}</article>`).join('')}</div><p class="muted-note">Создание учётных записей детей для публичного чтения не требуется. В демо используются вымышленные аккаунты.</p></div>`; }
function renderUserForm(user) { main.innerHTML = `<div class="container page-wrap narrow-page">${heading(user ? 'Изменить привязку' : 'Добавить аккаунт','При изменении привязки действующие сеансы пользователя завершаются.')}<section class="content-box"><form id="user-form"><div class="form-grid">${field('name','Отображаемое имя',user?.name,{max:80,required:true})}${selectField('role','Роль',{teacher:'Сотрудник организации',student:'Ученик / родитель'},user?.role || 'teacher')}${selectField('orgId','Организация',Object.fromEntries(state.private.organizations.map(org => [org.id,org.name])),user?.orgId)}${user ? '' : field('username','Логин','',{max:40,required:true}) + field('password','Пароль','',{type:'password',max:128,required:true})}</div><button class="button button-primary" type="submit">Сохранить аккаунт</button></form></section></div>`; bindForm('user-form',async values => { await api(user ? '/users/'+user.id : '/users',{method:user ? 'PUT' : 'POST',body:values}); await loadData(); navigate('#users'); toast('Аккаунт сохранён.'); }); }
function bindForm(id,callback,login=false) {
  document.getElementById(id).addEventListener('submit',async event => { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type=submit]'); button.disabled = true; try { await callback(Object.fromEntries(new FormData(form)),form); } catch (error) { if (login && document.getElementById('login-error')) { const box = document.getElementById('login-error'); box.textContent = error.message; box.hidden = false; } else toast(error.message); } finally { button.disabled = false; } });
}
async function route() {
  const render = ++state.render;
  const [page='catalog',id,tab,editing] = location.hash.slice(1).split('/');
  document.getElementById('mobile-nav').hidden = true; document.getElementById('mobile-toggle').setAttribute('aria-expanded','false');
  shell(); window.scrollTo(0,0);
  try {
    if (['','home','catalog','organizations-section'].includes(page)) { renderCatalogPage(); if (page === 'organizations-section') document.getElementById('organizations-section').scrollIntoView(); }
    else if (page === 'org') { const data = await api('/public/organizations/'+encodeURIComponent(id)); if (render !== state.render) return; renderOrganization(data.organization,tab); }
    else if (page === 'article') { const data = await api('/public/news/'+encodeURIComponent(id)); if (render !== state.render) return; renderArticle(data.news); }
    else if (page === 'all-news') renderAllNews();
    else if (page === 'login' || !state.user) renderLogin();
    else if (page === 'preview-article') { if (!isStaff()) throw new Error('Предпросмотр доступен сотруднику.'); const data = await api('/news/'+encodeURIComponent(id)); if (render !== state.render) return; renderArticle(data.news,true); }
    else if (page === 'preview') { if (!isStaff() || !privateOrg(id)) throw new Error('Организация недоступна аккаунту.'); const data = await api('/organizations/'+encodeURIComponent(id)); if (render !== state.render) return; renderOrganization(data.organization,tab,true); }
    else if (page === 'cabinet') { const org = privateOrg(id || state.user.orgId); if (!isStaff() || !org) throw new Error('Кабинет доступен сотруднику своей организации.'); renderCabinet(org,tab,editing); }
    else if (!isAdmin()) throw new Error('Раздел доступен администратору.');
    else if (page === 'admin') renderAdmin();
    else if (page === 'new-org') renderNewOrg();
    else if (page === 'users') renderUsers();
    else if (page === 'new-user') renderUserForm();
    else if (page === 'user') { const user = state.users.find(item => item.id === id && item.role !== 'admin'); if (!user) throw new Error('Аккаунт не найден.'); renderUserForm(user); }
    else throw new Error('Страница не найдена.');
  } catch (error) { if (render === state.render) main.innerHTML = `<div class="container page-wrap">${heading('Не удалось открыть страницу',error.message)}<a class="button button-primary" href="#catalog">${t('back')}</a></div>`; }
}
main.addEventListener('click',async event => {
  const button = event.target.closest('button'); if (!button) return;
  try {
    if (button.dataset.loginRole) { state.loginRole = button.dataset.loginRole; renderLogin(); }
    else if (button.dataset.fillDemo) { const form = document.getElementById('login-form'); form.elements.username.value = button.dataset.fillDemo; form.elements.password.value = 'Demo2026!'; form.elements.username.focus(); }
    else if (button.dataset.type) { state.type = button.dataset.type; state.page = 1; renderCatalogPage(); }
    else if (button.dataset.page) { state.page = Number(button.dataset.page); catalogResults(); }
    else if (button.dataset.archiveNews || button.dataset.archiveDocument) { button.disabled = true; const news = Boolean(button.dataset.archiveNews); await api('/'+(news ? 'news/' : 'documents/')+(news ? button.dataset.archiveNews : button.dataset.archiveDocument),{method:'DELETE',body:{}}); await loadData(); await route(); toast('Материал перенесён в архив. Его можно восстановить через редактирование.'); }
  } catch (error) { toast(error.message); button.disabled = false; }
});
document.getElementById('account-actions').addEventListener('click',async event => {
  const language = event.target.closest('[data-language]'); if (language) { state.lang = language.dataset.language; try { localStorage.setItem('edu-language',state.lang); } catch {} const url = new URL(location.href); url.searchParams.set('lang',state.lang); history.replaceState(null,'',url); await route(); return; }
  const logout = event.target.closest('[data-logout]'); if (logout) { logout.disabled = true; try { await api('/logout',{method:'POST',body:{}}); clearPrivate(); await loadData(); accountChannel?.postMessage('changed'); navigate('#catalog'); } catch (error) { toast(error.message); logout.disabled = false; } }
});
document.getElementById('accessibility').addEventListener('click',() => { state.largeText = !state.largeText; try { localStorage.setItem('edu-text-size',state.largeText ? 'large' : 'normal'); } catch {} shell(); });
document.getElementById('mobile-toggle').addEventListener('click',() => { const nav = document.getElementById('mobile-nav'); nav.hidden = !nav.hidden; document.getElementById('mobile-toggle').setAttribute('aria-expanded',String(!nav.hidden)); });
document.querySelector('.skip-link').addEventListener('click',event => { event.preventDefault(); main.focus(); main.scrollIntoView({block:'start'}); });
const dialog = document.getElementById('info-dialog');
document.getElementById('demo-info').addEventListener('click',() => dialog.showModal());
document.getElementById('close-dialog').addEventListener('click',() => dialog.close());
document.getElementById('dialog-done').addEventListener('click',() => dialog.close());
window.addEventListener('hashchange',route);
async function initialize() { try { await loadData(); await route(); } catch { main.innerHTML = `<div class="container page-wrap">${heading('Нет связи с сервером','Запустите сервер проекта и обновите страницу.')}</div>`; } }
initialize();
