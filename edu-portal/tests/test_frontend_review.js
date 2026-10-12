'use strict';
// Run the actual client in an isolated browser-like context; no dependencies or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../dist/app.js'),'utf8');
const seed = JSON.parse(fs.readFileSync(path.join(__dirname,'../seed.json'),'utf8'));

function browser() {
  const elements = new Map(), documentListeners = {}, windowListeners = {}, stored = new Map();
  const element = key => {
    if (!elements.has(key)) elements.set(key,{listeners:{},attributes:{},style:{setProperty(name,value){this[name]=value;}},
      isConnected:true,innerHTML:'',textContent:'',value:'',files:[],hidden:false,
      addEventListener(name,callback){this.listeners[name]=callback;},
      setAttribute(name,value){this.attributes[name]=value;},
      querySelector(selector){return selector === 'form' ? this.form || null : element(key+':'+selector);},
      querySelectorAll(){return [element(key+':p1'),element(key+':p2')];},
      focus(){},scrollIntoView(){},showModal(){},close(){}});
    return elements.get(key);
  };
  let current = new URL('http://127.0.0.1:4173/#catalog');
  const location = {get href(){return current.href;},get hash(){return current.hash;},set hash(value){current.hash=value;},
                    get search(){return current.search;}};
  const context = vm.createContext({console,URL,URLSearchParams,location,
    document:{getElementById:element,querySelector:element,documentElement:element('html'),body:{classList:{toggle(){}}},
              addEventListener(name,callback){documentListeners[name]=callback;}},
    window:{confirm(){return false;},scrollTo(){},addEventListener(name,callback){windowListeners[name]=callback;}},
    history:{replaceState(_state,_title,url){current=new URL(String(url),current);}},
    localStorage:{getItem(key){return stored.get(key) || null;},setItem(key,value){stored.set(key,value);}},
    fetch:() => new Promise(() => {}),setTimeout:() => 1,clearTimeout:() => {},
    FormData:class {constructor(form){this.values=form.values || {};} *[Symbol.iterator](){yield* Object.entries(this.values);}}});
  vm.runInContext(source,context,{filename:'app.js'});
  const run = code => vm.runInContext(code,context);
  return {context,run,element,location,documentListeners,windowListeners,stored};
}
const jsonValue = (app,code) => JSON.parse(app.run(`JSON.stringify(${code})`));
const response = data => ({ok:true,status:200,json:async () => data});

test('district search accepts both language names regardless of the selected language',() => {
  const app = browser(); app.context.seed = seed;
  for (const language of ['ru','kk']) for (const [query,district] of [['Орталық','Центральный'],['Центральный','Центральный'],['Солтүстік','Северный']]) {
    app.context.language=language;app.context.query=query;
    app.run('state.lang=language;state.query=query;');
    const actual = jsonValue(app,'filterOrganizations(seed.organizations).map(org => org.id)');
    assert.deepEqual(actual,seed.organizations.filter(org => org.district === district).map(org => org.id));
    assert.ok(actual.length > 0);
  }
});

test('name, number, district and type filters work together',() => {
  const app = browser();app.context.seed=seed;
  app.run("state.lang='kk';state.query='№ 24';");
  assert.deepEqual(jsonValue(app,'filterOrganizations(seed.organizations).map(org => org.id)'),['school-24']);
  app.run("state.query='';state.type='garden';state.district='Центральный';");
  assert.deepEqual(jsonValue(app,'filterOrganizations(seed.organizations).map(org => org.id)'),seed.organizations.filter(org => org.type === 'garden' && org.district === 'Центральный').map(org => org.id));
});

test('Kazakh dates contain readable month names without depending on Intl locale data',() => {
  const app = browser();app.run("state.lang='kk';");
  assert.equal(app.run("dateLabel('2026-10-12')"),'12 қазан 2026');
  assert.equal(app.run("dateLabel('2026-01-03')"),'3 қаңтар 2026');
  assert.equal(app.run("dateLabel('not-a-date')"),app.run("t('empty')"));
});

test('switching language keeps an existing form, its text and selected file',async () => {
  const app=browser(), form=app.element('profile-form'), main=app.element('main');
  const file={name:'notice.txt'}, language={dataset:{language:'kk'}};
  form.value='Несохранённый текст';form.files=[file];main.form=form;
  app.run('let routeCalls=0,shellCalls=0;route=async()=>{routeCalls++;};shell=()=>{shellCalls++;};bindForm("profile-form",async()=>{});');
  form.listeners.input();
  await app.element('account-actions').listeners.click({target:{closest:selector => selector === '[data-language]' ? language : null}});
  assert.equal(app.run('state.lang'),'kk');assert.equal(app.run('routeCalls'),0);assert.equal(app.run('shellCalls'),1);
  assert.equal(form.value,'Несохранённый текст');assert.equal(form.files[0],file);assert.equal(app.run('formDirty'),true);
  assert.equal(app.stored.get('edu-language'),'kk');assert.equal(app.stored.size,1);
});

test('unsaved tab navigation asks before discarding and cancel preserves data',() => {
  const app=browser(), form=app.element('profile-form');
  form.value='Unsaved';app.run('bindForm("profile-form",async()=>{});');form.listeners.change();
  let prompts=0, prevented=false;app.context.window.confirm=() => {prompts++;return false;};
  app.documentListeners.click({button:0,defaultPrevented:false,target:{closest:() => ({getAttribute:() => '#cabinet/garden-sun/news'})},preventDefault(){prevented=true;}});
  assert.equal(prompts,1);assert.equal(prevented,true);assert.equal(form.value,'Unsaved');assert.equal(app.run('formDirty'),true);
  app.context.window.confirm=() => true;
  assert.equal(app.run('canLeaveForm()'),true);assert.equal(app.run('formDirty'),false);
});

test('browser back navigation cancel restores the original route without replacing the form',async () => {
  const app=browser(), form=app.element('profile-form');app.location.hash='#cabinet/garden-sun/profile';
  app.run('renderedHash=location.hash;shell=()=>{};bindForm("profile-form",async()=>{});');form.listeners.input();
  app.location.hash='#catalog';await app.run('route()');
  assert.equal(app.location.hash,'#cabinet/garden-sun/profile');assert.equal(app.run('activeForm') === form,true);
  assert.equal(app.run('formDirty'),true);
});

test('unload warning is cleared by reset or a successful save, and kept on save failure',async () => {
  const app=browser(), form=app.element('profile-form');app.run('bindForm("profile-form",async()=>{});');form.listeners.input();
  let prevented=false;app.windowListeners.beforeunload({preventDefault(){prevented=true;}});assert.equal(prevented,true);
  form.listeners.reset();assert.equal(app.run('formDirty'),false);form.listeners.input();
  app.context.fetch=async () => response({ok:true});await app.run("api('/organizations/garden-sun',{method:'PATCH',body:{phone:'demo'}})");
  assert.equal(app.run('formDirty'),false);form.listeners.input();
  app.context.fetch=async () => ({ok:false,status:400,json:async () => ({error:'Invalid'})});
  await assert.rejects(app.run("api('/organizations/garden-sun',{method:'PATCH',body:{phone:null}})"),/Invalid/);
  assert.equal(app.run('formDirty'),true);
});

test('profile saves send changed fields only, including normalized arrays',() => {
  const app=browser();app.context.org={name:'Demo',phone:'old',parentInfo:'before',features:['One','Two'],ageGroups:[]};
  app.context.values={name:'Demo',phone:'old',parentInfo:'after',features:' One, Two ',ageGroups:' '};
  assert.deepEqual(jsonValue(app,'changedProfileFields(org,values)'),{parentInfo:'after'});
  app.context.values={phone:'new',features:'Two, Three'};
  assert.deepEqual(jsonValue(app,'changedProfileFields(org,values)'),{phone:'new',features:['Two','Three']});
});

test('a late save response cannot clear changes made in a different form',async () => {
  const app=browser();app.run('bindForm("old-form",async()=>{});');app.element('old-form').listeners.input();
  let resolve;app.context.fetch=() => new Promise(complete => {resolve=complete;});
  const saving=app.run("api('/organizations/garden-sun',{method:'PATCH',body:{phone:'changed'}})");
  app.run('bindForm("new-form",async()=>{});');app.element('new-form').listeners.input();
  resolve(response({ok:true}));await saving;
  assert.equal(app.run('formDirty'),true);assert.equal(app.run('activeForm') === app.element('new-form'),true);
});

test('public organization navigation reloads newly published and archived materials',async () => {
  const app=browser();app.run('shell=()=>{};let shown=[];renderOrganization=(_org,tab)=>{shown=state.public.news.map(item=>item.id);};');
  let published=true;const org={id:'garden-sun'};
  app.context.fetch=async url => {assert.equal(url,'/api/public/bootstrap');return response({organizations:[org],news:published ? [{id:'new-news',orgId:org.id}] : [],documents:[]});};
  app.location.hash='#org/garden-sun/news';await app.run('route()');assert.deepEqual(jsonValue(app,'shown'),['new-news']);
  published=false;app.location.hash='#org/garden-sun/parents';await app.run('route()');
  app.location.hash='#org/garden-sun/news';await app.run('route()');assert.deepEqual(jsonValue(app,'shown'),[]);
});

test('catalog and all-news navigation reload their public data',async () => {
  const app=browser();app.run('shell=()=>{};let shown=[];renderCatalogPage=()=>{shown.push(state.public.organizations[0].id);};renderAllNews=()=>{shown.push(state.public.news[0].id);};');
  app.context.fetch=async () => response({organizations:[{id:'fresh-org'}],news:[{id:'fresh-news'}],documents:[]});
  app.location.hash='#catalog';await app.run('route()');app.location.hash='#all-news';await app.run('route()');
  assert.deepEqual(jsonValue(app,'shown'),['fresh-org','fresh-news']);
});

test('a slower earlier navigation cannot overwrite a newer public page',async () => {
  const app=browser(), pending=[];app.run('shell=()=>{};let shown=[];renderCatalogPage=()=>shown.push("catalog");renderAllNews=()=>shown.push("news");');
  app.context.fetch=() => new Promise(resolve => pending.push(resolve));
  app.location.hash='#all-news';const earlier=app.run('route()');app.location.hash='#catalog';const later=app.run('route()');
  pending[1](response({organizations:[{id:'new'}],news:[],documents:[]}));await later;
  pending[0](response({organizations:[{id:'stale'}],news:[],documents:[]}));await earlier;
  assert.deepEqual(jsonValue(app,'shown'),['catalog']);assert.equal(app.run('state.public.organizations[0].id'),'new');
});

test('an account change invalidates a pending public response',async () => {
  const app=browser();app.run('shell=()=>{};renderAllNews=()=>{throw new Error("Must not render");};');
  let resolve;app.context.fetch=() => new Promise(complete => {resolve=complete;});
  app.location.hash='#all-news';const loading=app.run('route()');app.run('clearPrivate()');
  resolve(response({organizations:[{id:'stale'}],news:[],documents:[]}));await loading;
  assert.equal(app.run('state.public.organizations.length'),0);
});

test('article rendering escapes HTML in the title, summary and body',() => {
  const app=browser();app.context.item={orgId:'garden-sun',title:'<img src=x>',summary:'<script>bad()</script>',body:'<iframe></iframe>',date:'2026-10-12'};
  app.run('renderArticle(item)');const html=app.element('main').innerHTML;
  assert.ok(html.includes('&lt;img src=x&gt;'));assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(/<(img|script|iframe)\b/.test(html),false);
});

test('large text changes the root font size used by rem values',() => {
  const app=browser();app.run('state.largeText=true;shell();');
  assert.equal(app.element('html').style['--base'],'18px');app.run('state.largeText=false;shell();');
  assert.equal(app.element('html').style['--base'],'16px');
});
