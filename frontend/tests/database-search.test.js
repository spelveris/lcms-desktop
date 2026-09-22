const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
function fixture(){
  class Node {
    constructor(){this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.children=[];this.listeners={};}
    appendChild(node){this.children.push(node);return node;}
    replaceChildren(...nodes){this.children=nodes;}
    addEventListener(type,fn){this.listeners[type]=fn;}
  }
  const nodes=new Map(), refs=[new Node(),new Node()], timers=[];
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);},
    querySelectorAll(query){return query==='.peptide-reference-only'?refs:[];},createElement(){return new Node();},createTextNode(text){return {textContent:text};}};
  const ctx=vm.createContext({document,console,setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},
    peptideClearResults(){},peptideReadVariableModifications(){return {oxidation:true};},peptideRenderLinkages(){},peptideView:{modifications:[]},
    api:{},proteinDatabaseView:{snapshot:{database:true}},proteinDatabaseSelection(){return {id:'ecoli-k12',installed:true};}});
  vm.runInContext(fs.readFileSync(path.join(root,'js/database-search.js'),'utf8'),ctx);
  document.getElementById('peptide-analysis-mode').value='database';document.getElementById('peptide-sample-select').value='/measured/digest.sirslt';
  document.getElementById('peptide-reduction').value='reduced';
  for(const [key,value] of Object.entries({ppm:10,bin:.02,missed:2,'charge-min':1,'charge-max':6,'length-min':5,'length-max':50,q:.01}))document.getElementById('database-search-'+key).value=String(value);
  return {nodes,refs,ctx,timers,run:code=>vm.runInContext(code,ctx)};
}

test('database search is optional and mode changes retain the supplied sequence',()=>{
 const f=fixture();f.ctx.document.getElementById('peptide-fasta').value='REFERENCE';
 f.run('databaseSearchSetMode()');assert.ok(f.refs.every(node=>node.hidden));assert.equal(f.nodes.get('database-search-panel').hidden,false);
 f.nodes.get('peptide-analysis-mode').value='reference';f.run('databaseSearchSetMode()');
 assert.ok(f.refs.every(node=>!node.hidden));assert.equal(f.nodes.get('database-search-panel').hidden,true);assert.equal(f.nodes.get('peptide-fasta').value,'REFERENCE');
});
test('database requests contain organism and chemistry, never the supplied sequence or site hypotheses',async()=>{
 const f=fixture();let payload;
 f.ctx.api={async startDatabaseSearch(value){payload=value;return {job:{id:'new',state:'searching',message:'Searching'}};},async databaseSearchStatus(){return {job:{id:'new',state:'searching',message:'Searching'}};}};
 await f.run('databaseSearchStart()');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(payload.database_id,'ecoli-k12');assert.equal(payload.path,'/measured/digest.sirslt');assert.equal(payload.settings.semi_tryptic,false);
 assert.equal(payload.preparation.iam,false);assert.equal(payload.fasta,undefined);assert.equal(payload.modifications,undefined);
 assert.equal(f.nodes.get('btn-database-search').disabled,true);assert.equal(f.nodes.get('btn-database-search-cancel').hidden,false);
});
test('failed start is not blindly repeated and absent databases block search',async()=>{
 const f=fixture();let calls=0;
 f.ctx.api={async startDatabaseSearch(){calls++;throw Error('lost reply');},async databaseSearchStatus(){return {job:{id:'accepted',state:'searching',message:'Searching'}};}};
 await f.run('databaseSearchStart()');assert.equal(calls,1);assert.equal(f.run('databaseSearchView.job.id'),'accepted');
 const g=fixture();g.ctx.proteinDatabaseSelection=()=>({installed:false});g.ctx.api={async databaseSearchStatus(){return {job:null};},async startDatabaseSearch(){throw Error('Must not run');}};
 await g.run('databaseSearchStart()');assert.match(g.nodes.get('database-search-status').textContent,/download its database first/);
});
test('default results filter spectrum q, with explicit opt-in for unfiltered candidates',()=>{
 const f=fixture();f.ctx.result={psms:[{passes_psm_q:true,proteins:['A']},{passes_psm_q:false,proteins:['A']},{passes_psm_q:true,proteins:['B']}]};
 assert.equal(f.run("databaseSearchVisiblePsms(result,'A',false).length"),1);
 assert.equal(f.run("databaseSearchVisiblePsms(result,'A',true).length"),2);
 assert.equal(f.run("databaseSearchVisiblePsms(result,'',false).length"),2);
});
test('old status replies cannot overwrite a newer search job',async()=>{
 const f=fixture();let resolve;
 f.ctx.api.databaseSearchStatus=()=>new Promise(done=>{resolve=done;});
 const pending=f.run('databaseSearchPoll()');
 f.run("databaseSearchView.requestEpoch++;databaseSearchView.job={id:'new',state:'searching'}");
 resolve({job:{id:'old',state:'complete'}});await pending;
 assert.equal(f.run('databaseSearchView.job.id'),'new');
});
test('sample changes hide results belonging to a different digest',()=>{
 const f=fixture();f.run("databaseSearchView.initialized=true;databaseSearchView.result={path:'/other/digest.sirslt'};databaseSearchSampleChanged()");
 assert.equal(f.nodes.get('database-search-results').hidden,true);
 assert.equal(f.run('databaseSearchView.generation'),1);
});
test('chemistry and remnants share one dropdown, and Refresh follows Run Deconvolution',()=>{
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
 const group=html.split('<details id="peptide-modification-settings"')[1].split('</details>')[0];
 assert.ok(group.includes('<summary>Variable modifications</summary>'));
 for(const id of ['peptide-reduction','peptide-iam','peptide-variable-iam','peptide-linkages','btn-peptide-add-linkage'])assert.ok(group.includes(`id="${id}"`),id);
 assert.ok(!html.includes('Variable modifications · this sample'));
 assert.ok(/id="btn-run-deconv"[^>]*>Run Deconvolution<\/button>\s*<button id="btn-refresh-deconv" class="btn btn-deconv-refresh"/.test(html));
 assert.ok(!html.includes('Storage &amp; database information'));
});
