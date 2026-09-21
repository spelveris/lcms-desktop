const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function fixture(){const ctx=vm.createContext({console});for(const file of ['qtof.js','peptides.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js',file),'utf8'),ctx);return code=>vm.runInContext(code,ctx);}
test('only instrument-linked MS/MS precursors are associated with a survey',()=>{
 const run=fixture();assert.equal(run('qtofAcquiredPrecursors([{parent_scan_id:5},{parent_scan_id:null},{parent_scan_id:6}],5).length'),1);
 assert.equal(run('qtofNearestSurvey([{time:1,scan_id:1},{time:2,scan_id:2}],1.9).scan_id'),2);
});
test('measured peak sticks retain exact positions/intensities',()=>{
 const run=fixture();const trace=JSON.parse(JSON.stringify(run('qtofStickTrace({mz:[100.12345],intensities:[.125]})')));
 assert.deepEqual(trace.x,[100.12345,100.12345,null]);assert.deepEqual(trace.y,[0,.125,null]);
});
test('unknown modification masses stay unresolved, not zero',()=>{
 const run=fixture();const mods=JSON.parse(JSON.stringify(run("peptideParseMods('B,48,?,block\\nA,3,57.021464')")));
 assert.equal(mods[0].delta,null);assert.equal(mods[0].block_cleavage,true);assert.equal(mods[1].delta,57.021464);
 assert.throws(()=>run("peptideParseMods('B,48,,block')"));
});
test('new panels are hidden by default, and mapping sits beside Deconvolution',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 assert.match(html,/data-tab="tab-deconv">Deconvolution<\/button>\s*<button class="tab-btn hidden" data-tab="tab-peptides">Peptide Mapping/);
 assert.match(html,/class="tab-btn hidden" data-tab="tab-qtof"/);
 const source=fs.readFileSync(path.join(__dirname,'../js/qtof.js'),'utf8');assert.match(source,/is_protein_digest === true/);
});

function domFixture() {
  class Element {
    constructor(tag='div'){this.tag=tag;this.children=[];this.style={};this.value='';this.listeners={};this.disabled=false;this.checked=false;}
    appendChild(child){this.children.push(child);if(this.tag==='select' && this.children.length===1)this.value=child.value;return child;}
    replaceChildren(...children){this.children=children;if(this.tag==='select')this.value='';}
    addEventListener(name,fn){this.listeners[name]=fn;}
    get options(){return this.children;}
  }
  const nodes=new Map();
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},createElement(tag){return new Element(tag);}};
  const ctx=vm.createContext({console,document,Plotly:{purge(){}},api:{}});
  for(const file of ['qtof.js','peptides.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js',file),'utf8'),ctx);
  return {ctx,nodes,run:code=>vm.runInContext(code,ctx)};
}

test('GGisoK editor resolves an imported B48 modification and locks chemistry controls',()=>{
  const {run,nodes}=domFixture();
  run(`document.getElementById('peptide-fasta').value='>A\\nAAAAAK\\n>B\\nAAAAAK';
    peptideView.modifications=[{chain:'B',position:6,name:'GGK',delta:null,block_cleavage:true}];peptideRenderLinkages();`);
  let row=nodes.get('peptide-linkages').children[0];
  assert.equal(row.children[0].children[0].value,'B');
  const type=row.children[2].children[0];type.value='gg';type.onchange();
  row=nodes.get('peptide-linkages').children[0];
  assert.equal(row.children[3].children[0].value,114.04292747);
  assert.equal(row.children[3].children[0].disabled,true);
  assert.equal(row.children[4].children[0].checked,true);
  assert.equal(row.children[4].children[0].disabled,true);
  assert.equal(run('peptideView.modifications[0].kind'),'gg');
});

test('editing input invalidates a pending mapping response',async()=>{
  const {run,nodes,ctx}=domFixture();let resolve;
  ctx.api.analyzePeptides=()=>new Promise(r=>{resolve=r;});
  run(`document.getElementById('peptide-fasta').value='PEPTIDE';`);
  const pending=run('peptideAnalyze()');
  run('peptideClearResults()');
  resolve({matches:[],excluded_modified_peptides:0,coverage:[],warning:''});
  await pending;
  assert.equal(run('peptideView.results'),null);
  assert.equal(nodes.get('peptide-results').children.length,0);
});
