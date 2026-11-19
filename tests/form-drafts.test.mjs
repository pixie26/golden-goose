import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,setup,view} from '../lib/core.mjs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function bank(){const s=initialState();setup(s,'token','token','a-strong-parent-password','123456');return s;}
async function mount(fetchState){
 const initial=view(bank(),'kid'),handlers={},docHandlers={},posts=[],intervals=[];
 const root={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[],addEventListener:(event,handler)=>(handlers[event]??=[]).push(handler)};
 const toast={textContent:'',className:''};
 const document={visibilityState:'visible',getElementById:id=>id==='root'?root:id==='toast'?toast:null,addEventListener:(event,handler)=>(docHandlers[event]??=[]).push(handler)};
 const ctx=vm.createContext({document,console,location:{hostname:'localhost'},setTimeout:()=>0,clearTimeout:()=>{},setInterval:fn=>{intervals.push(fn);return intervals.length;},
  FormData:class{constructor(form){this.rows=form.formDataEntries();}entries(){return this.rows[Symbol.iterator]();}},
  fetch:async(path,options)=>{
   if(path==='/api/bootstrap')return response({initialized:true,role:'kid',data:initial});
   if(options?.body)posts.push(JSON.parse(options.body));
   return fetchState(path,options);
  }});
 vm.runInContext(source,ctx);
 for(let i=0;i<5&&!root.innerHTML;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(root.innerHTML,'bootstrap rendered');
 return {ctx,root,handlers,docHandlers,posts,toast,initial,intervals};
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

test('a visibility refresh does not erase a form that became dirty while awaiting the server',async()=>{
 const request=deferred();
 const m=await mount(()=>request.promise);
 const pending=vm.runInContext('refreshWhenIdle()',m.ctx);
 vm.runInContext('formDirty=true',m.ctx);m.root.innerHTML='typed wish draft';
 request.resolve(response({...m.initial,summary:{...m.initial.summary,cashCents:16200}}));
 await pending;
 assert.equal(m.root.innerHTML,'typed wish draft');
 assert.equal(vm.runInContext('data.summary.cashCents',m.ctx),0);
 assert.equal(vm.runInContext('formDirty',m.ctx),true);
});

test('idle visibility refresh updates data, but a newer action state wins over an older in-flight read',async()=>{
 let request=deferred();
 const m=await mount(()=>request.promise);
 let pending=vm.runInContext('refreshWhenIdle()',m.ctx);
 request.resolve(response({...m.initial,summary:{...m.initial.summary,cashCents:10000,availableCents:10000}}));
 await pending;
 assert.equal(vm.runInContext('data.summary.cashCents',m.ctx),10000);
 request=deferred();pending=vm.runInContext('refreshWhenIdle()',m.ctx);
 vm.runInContext('data={...data,summary:{...data.summary,cashCents:20000}}',m.ctx);
 request.resolve(response({...m.initial,summary:{...m.initial.summary,cashCents:5000}}));
 await pending;
 assert.equal(vm.runInContext('data.summary.cashCents',m.ctx),20000);
});

test('failed submissions send the typed one-character name and leave the form ready to correct',async()=>{
 const m=await mount(()=>response({error:'可用余额不足'},400));
 const button={disabled:false,isConnected:true},values={name:'鞋',amount:'123'};
 const form={dataset:{op:'wish.add'},querySelector:()=>button,formDataEntries:()=>Object.entries(values)};
 vm.runInContext('formDirty=true',m.ctx);
 const before=m.root.innerHTML;let prevented=false;
 for(const submit of m.handlers.submit)await submit({target:{closest:()=>form},preventDefault(){prevented=true;}});
 assert.equal(prevented,true);
 assert.deepEqual(m.posts[0].payload,{name:'鞋',amount:'123'});
 assert.equal(m.root.innerHTML,before);
 assert.equal(button.disabled,false);
 assert.equal(vm.runInContext('busy',m.ctx),false);
 assert.equal(vm.runInContext('formDirty',m.ctx),true);
 assert.equal(m.toast.textContent,'可用余额不足');
});

test('notification polling also discards a snapshot superseded by a completed action',async()=>{
 const request=deferred(),m=await mount(()=>request.promise);
 assert.equal(m.intervals.length,1);
 const pending=m.intervals[0]();
 vm.runInContext('data={...data,summary:{...data.summary,cashCents:20000}}',m.ctx);
 request.resolve(response({...m.initial,summary:{...m.initial.summary,cashCents:10000}}));
 await pending;
 assert.equal(vm.runInContext('data.summary.cashCents',m.ctx),20000);
});

function fakeForm(op,identity,fields,{open=false,id=''}={}){
 const disclosure={open};
 const form={dataset:{op},id,querySelector:selector=>selector==='[name="id"]'?{value:identity.id||''}:selector==='[name="symbol"]'?{value:identity.symbol||''}:null,querySelectorAll:()=>fields,closest:()=>disclosure};
 for(const field of fields){field.dataset??={};field.closest=()=>form;}
 return {form,disclosure};
}
const input=(name,type,value,extra={})=>({name,type,value,disabled:false,...extra});

test('pagination drafts preserve matching forms and selections without copying identities or secrets',async()=>{
 const m=await mount(()=>response({}));
 const oldSell=fakeForm('stock.sell',{symbol:'AAPL'},[input('symbol','hidden','AAPL'),input('qty','number','2.5')]);
 const oldEdit=fakeForm('task.update',{id:'task-1'},[input('id','hidden','task-1'),input('name','text','整理书架'),input('active','select-one','false'),input('secret','password','do-not-copy')],{open:true});
 const login=fakeForm('login',{},[input('password','password','do-not-copy')]);
 m.ctx.oldScope={querySelectorAll:()=>[oldSell.form,oldEdit.form,login.form]};
 vm.runInContext('globalThis.drafts=captureFormDrafts(oldScope)',m.ctx);
 assert.equal(m.ctx.drafts.size,2);
 assert.doesNotMatch(JSON.stringify([...m.ctx.drafts.values()]),/do-not-copy/);
 const newSell=fakeForm('stock.sell',{symbol:'AAPL'},[input('symbol','hidden','AAPL'),input('qty','number','')]);
 const otherSell=fakeForm('stock.sell',{symbol:'MSFT'},[input('symbol','hidden','MSFT'),input('qty','number','')]);
 const newEdit=fakeForm('task.update',{id:'task-1'},[input('id','hidden','task-1'),input('name','text','默认任务'),input('active','select-one','true'),input('secret','password','')]);
 m.ctx.newScope={querySelectorAll:()=>[newSell.form,otherSell.form,newEdit.form]};
 vm.runInContext('restoreFormDrafts(newScope,drafts)',m.ctx);
 assert.equal(newSell.form.querySelectorAll()[1].value,'2.5');
 assert.equal(otherSell.form.querySelectorAll()[1].value,'');
 assert.equal(newEdit.form.querySelectorAll()[1].value,'整理书架');
 assert.equal(newEdit.form.querySelectorAll()[2].value,'false');
 assert.equal(newEdit.form.querySelectorAll()[3].value,'');
 assert.equal(newEdit.disclosure.open,true);
});
