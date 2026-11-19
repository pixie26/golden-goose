import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,setup,view} from '../lib/core.mjs';

// Exercise the shipped app and its actual delegated submit handlers. The small
// controls below supply native ValidityState flags; they do not replace app code.
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const response=body=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
async function mount(){
 const state=initialState();setup(state,'t','t','a-strong-parent-password','123456');
 const initial=view(state,'kid'),handlers={},registrations=[],posts=[],counts={formData:0,confirm:0};
 const root={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[],addEventListener(event,handler,options){(handlers[event]??=[]).push(handler);registrations.push({event,options});}};
 const toast={textContent:'',className:''};
 const document={visibilityState:'visible',getElementById:id=>id==='root'?root:id==='toast'?toast:null,addEventListener(){}};
 const context=vm.createContext({document,console,location:{hostname:'localhost'},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,confirm(){counts.confirm++;return true;},
  FormData:class{constructor(form){counts.formData++;this.rows=form.formDataEntries();}entries(){return this.rows[Symbol.iterator]();}},
  fetch:async(path,options)=>{if(path==='/api/bootstrap')return response({initialized:true,role:'kid',data:initial});if(options?.body){posts.push(JSON.parse(options.body));return response({ok:true});}return response(initial);}
 });
 vm.runInContext(source,context);
 for(let i=0;i<8&&!root.innerHTML;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(root.innerHTML,'app bootstrapped');
 return {context,root,handlers,registrations,posts,counts,toast,run:code=>vm.runInContext(code,context)};
}
function control({name='amount',type='number',value='',label='',attrs={},native={},willValidate=true,disabled=false,tagName='INPUT'}={}){
 let custom='';
 const el={name,type,value,tagName,willValidate,disabled,dataset:{},focused:0,reported:0,
  labels:label?[{textContent:label,querySelector:()=>({textContent:label})}]:[],
  getAttribute:key=>Object.hasOwn(attrs,key)?String(attrs[key]):null,
  setCustomValidity(message){custom=message;},
  focus(){this.focused++;},
  reportValidity(){this.reported++;return this.validity.valid;},
  closest(selector){return selector.startsWith('form')?this.form:null;},
  get validationMessage(){return custom||(!this.validity.valid?'Value must be less than or equal to the maximum.':'');},
  get validity(){const flags=typeof native==='function'?native(this):native;return {...flags,customError:!!custom,valid:!custom&&!Object.values(flags).some(Boolean)};}
 };
 return el;
}
function formFor(op,fields){
 const button={disabled:false,isConnected:true};
 const form={dataset:{op},querySelector:selector=>selector==='button[type="submit"]'?button:null,querySelectorAll:()=>fields,formDataEntries:()=>fields.filter(f=>f.name&&!f.disabled).map(f=>[f.name,f.value])};
 for(const field of fields)field.form=form;
 return {form,button};
}
async function submit(m,form){let prevented=false;for(const handler of m.handlers.submit)await handler({target:{closest:()=>form},preventDefault(){prevented=true;}});assert.equal(prevented,true);}

test('Chinese validation covers money, quantity, precise steps and declared field formats without rewriting values',async()=>{
 const m=await mount();
 const cases=[
  [{name:'amount',value:'101',attrs:{max:'100'},native:{rangeOverflow:true}},/金额不能超过 O\$ 100\.0/],
  [{name:'amount',value:'0',attrs:{min:'0.1'},native:{rangeUnderflow:true}},/金额不能少于 O\$ 0\.1/],
  [{name:'loanLimit',value:'501',attrs:{max:'500'},native:{rangeOverflow:true}},/借款额度不能超过 O\$ 500\.0/],
  [{name:'quantity',value:'501',attrs:{max:'500'},native:{rangeOverflow:true}},/数量不能超过 500/],
  [{name:'quantity',value:'1.5',attrs:{step:'1'},native:{stepMismatch:true}},/数量必须是整数/],
  [{name:'amount',value:'2.555',attrs:{step:'0.01'},native:{stepMismatch:true}},/金额最多保留 2 位小数/],
  [{name:'qty',value:'0.1234567',attrs:{step:'0.000001'},native:{stepMismatch:true}},/股数最多保留 6 位小数/],
  [{name:'price',value:'1.2345',attrs:{step:'0.001'},native:{stepMismatch:true}},/价格最多保留 3 位小数/],
  [{name:'amount',value:'',native:{badInput:true,valueMissing:true}},/请输入有效的数字/],
  [{name:'name',type:'text',value:'',label:'想要什么',native:{valueMissing:true}},/请填写「想要什么」/],
  [{name:'pin',type:'password',value:'12a',attrs:{pattern:'[0-9]{6,10}'},native:{patternMismatch:true}},/PIN.*6–10 位数字/],
  [{name:'password',type:'password',value:'',label:'我的 PIN',native:{valueMissing:true}},/请填写「我的 PIN」/],
  [{name:'newPassword',type:'password',value:'short',attrs:{minlength:'12'},native:{tooShort:true}},/12 个字符/],
  [{name:'link',type:'url',value:'not-a-url',native:{typeMismatch:true}},/请输入完整的网址/],
  [{name:'date',type:'date',value:'',native:{badInput:true}},/请输入有效的日期或时间/],
  [{name:'date',type:'date',value:'2026-11-19',attrs:{max:'2026-11-18'},native:{rangeOverflow:true}},/不能晚于 2026-11-18/],
  [{name:'notes',type:'text',value:'a'.repeat(241),attrs:{maxlength:'240'},native:{tooLong:true}},/最多填写 240 个字符/],
  [{name:'symbol',tagName:'SELECT',type:'select-one',native:{valueMissing:true}},/请选择「股票」/]
 ];
 for(const [spec,expected] of cases){
  const el=control(spec),before=el.value;m.context.el=el;
  const message=m.run('localizeFieldValidity(el)');
  assert.match(message,expected);assert.equal(el.validationMessage,message);assert.equal(el.value,before,'validation preserves the exact typed value');
  assert.doesNotMatch(message,/Value must|Please fill|less than|greater than/);
 }
});

test('finer money bounds remain exact and never display a rounded allowance that could permit overspending',async()=>{
 const m=await mount(),amount=control({value:'123.46',attrs:{max:'123.45',step:'0.01'},native:{rangeOverflow:true}});
 m.context.el=amount;assert.match(m.run('localizeFieldValidity(el)'),/超过本次允许的上限/);
 assert.doesNotMatch(amount.validationMessage,/123\.5/);assert.equal(amount.getAttribute('max'),'123.45');assert.equal(amount.getAttribute('step'),'0.01');assert.equal(amount.value,'123.46');
 const minimum=control({value:'0',attrs:{min:'0.01'},native:{rangeUnderflow:true}});m.context.el=minimum;
 assert.match(m.run('localizeFieldValidity(el)'),/低于允许的最小值/);assert.doesNotMatch(minimum.validationMessage,/O\$ 0\.0/);
});

test('an invalid repay form stops before FormData, confirmation or POST; an autofilled correction succeeds on the next attempt',async()=>{
 const m=await mount(),amount=control({value:'101.00',attrs:{max:'100.00',step:'0.01'},native:el=>({rangeOverflow:Number(el.value)>100})});
 const id=control({name:'id',type:'hidden',value:'loan-1',willValidate:false});
 const {form,button}=formFor('loan.repay',[id,amount]);
 await submit(m,form);
 assert.equal(m.counts.formData,0);assert.equal(m.counts.confirm,0);assert.equal(m.posts.length,0);assert.equal(m.run('busy'),false);assert.equal(button.disabled,false);
 assert.equal(amount.focused,1);assert.equal(amount.reported,1);assert.match(amount.validationMessage,/O\$ 100\.0/);
 // Deliberately no input/change event: autofill and programmatic edits must not
 // leave a stale customError blocking the next otherwise-valid submission.
 amount.value='12.35';await submit(m,form);
 assert.equal(amount.validationMessage,'');assert.equal(m.counts.formData,1);assert.equal(m.counts.confirm,1);assert.equal(m.posts.length,1);
 assert.deepEqual(m.posts[0].payload,{id:'loan-1',amount:'12.35'});assert.equal(amount.value,'12.35');assert.equal(button.disabled,false);
});

test('all invalid fields are localized but only the first is reported, and one-character wish names remain valid',async()=>{
 const m=await mount(),name=control({name:'name',type:'text',label:'想要什么',native:el=>({valueMissing:!el.value})});
 const amount=control({value:'-1',attrs:{min:'0.1',step:'0.1'},native:el=>({rangeUnderflow:Number(el.value)<0.1})});
 const {form}=formFor('wish.add',[name,amount]);await submit(m,form);
 assert.equal(m.posts.length,0);assert.match(name.validationMessage,/请填写/);assert.match(amount.validationMessage,/O\$ 0\.1/);
 assert.equal(name.reported,1);assert.equal(amount.reported,0);
 name.value='鞋';amount.value='12.3';await submit(m,form);
 assert.equal(m.posts.length,1);assert.deepEqual(m.posts[0].payload,{name:'鞋',amount:'12.3'});
});

test('invalid capture localizes fallback validation and both input/change clear old messages',async()=>{
 const m=await mount();
 assert.ok(m.registrations.some(x=>x.event==='invalid'&&(x.options===true||x.options?.capture)),'invalid uses capture because native invalid events do not bubble');
 const amount=control({value:'101',attrs:{max:'100'},native:el=>({rangeOverflow:Number(el.value)>100})});formFor('fixed.open',[amount]);
 for(const listener of m.handlers.invalid||[])listener({target:amount});
 assert.match(amount.validationMessage,/金额不能超过 O\$ 100\.0/);
 amount.value='20';for(const listener of m.handlers.input||[])await listener({target:amount});assert.equal(amount.validationMessage,'');
 amount.setCustomValidity('旧错误');for(const listener of m.handlers.change||[])await listener({target:amount});assert.equal(amount.validationMessage,'');
 assert.equal(amount.value,'20');
});

test('manual validation skips hidden/disabled controls and tolerates existing DOM-light test adapters',async()=>{
 const m=await mount(),valid=control({name:'name',type:'text',value:'鞋'}),hidden=control({name:'id',type:'hidden',native:{valueMissing:true},willValidate:false}),disabled=control({name:'pin',type:'password',native:{valueMissing:true},disabled:true});
 const {form}=formFor('wish.add',[valid,hidden,disabled]);m.context.form=form;
 assert.equal(m.run('validateFormInChinese(form)'),true);
 assert.equal(m.run('validateFormInChinese({})'),true);assert.equal(m.run('localizeFieldValidity(null)'),'' );
 assert.equal(m.run("localizeFieldValidity({name:'amount',value:'2.55'})"),'');
 const rendered=m.run("opForm('wish.add',field('name','想要什么'))");assert.match(rendered,/<form\b[^>]*\bnovalidate\b/);
 m.run("data.tasks=[{id:'validation-task',name:'整理书架',unit:'次',rewardCents:100,active:true}]");
 const taskHtml=m.run('tasks()');assert.match(taskHtml,/<form\b(?=[^>]*data-op="task.complete")(?=[^>]*\bnovalidate\b)[^>]*>/);
});
