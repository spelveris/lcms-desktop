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
    constructor(tag='div'){
      this.tag=tag;this.children=[];this.style={};this.value='';this.listeners={};this.disabled=false;this.checked=false;this.attributes={};this.className='';
      this.classList={contains:name=>this.className.split(' ').includes(name),
        add:name=>{if(!this.classList.contains(name))this.className+=' '+name;},
        toggle:(name,enabled)=>{this.className=this.className.split(' ').filter(n=>n!==name).join(' ');if(enabled)this.classList.add(name);}};
    }
    appendChild(child){this.children.push(child);if(this.tag==='select' && this.children.length===1)this.value=child.value;return child;}
    replaceChildren(...children){this.children=children;if(this.tag==='select')this.value='';}
    addEventListener(name,fn){this.listeners[name]=fn;}
    setAttribute(name,value){this.attributes[name]=String(value);if(name==='class')this.className=String(value);}
    createTHead(){return this.appendChild(new Element('thead'));}
    createTBody(){return this.appendChild(new Element('tbody'));}
    insertRow(){return this.appendChild(new Element('tr'));}
    insertCell(){return this.appendChild(new Element('td'));}
    get options(){return this.children;}
  }
  const nodes=new Map();
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},createElement(tag){return new Element(tag);},createElementNS(ns,tag){return new Element(tag);}};
  const ctx=vm.createContext({console,document,Plotly:{purge(){},async react(){}},WEBAPP_LAYOUT:{xaxis:{},yaxis:{}},PLOT_CONFIG:{},api:{}});
  for(const file of ['qtof.js','peptides.js','reference-masses.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js',file),'utf8'),ctx);
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

const candidate={sequence:'PEPTIDER',modifications:[],locations:[{chain:'A',start:1,end:8}],evidence:'msms',
 scan_id:9,time:1.5,charge:1,precursor_mz:955.4676,precursor_error_ppm:2.1,matched_ions:4,
 explained_intensity_pct:45,isotope_offset:0,ambiguous_scan:false,
 fragments:[{ion:'b3+',bond:3,observed_mz:324.15539,theoretical_mz:324.1554,error_ppm:-.03,intensity:100},
 {ion:'y5^2+',bond:3,observed_mz:300.2,theoretical_mz:300.2,error_ppm:0,intensity:80}]};
function descendants(node){return [node,...node.children.flatMap(descendants)];}

test('b/y assignments preserve exact cuts, direction and explicit +1/+2 charges',()=>{
 const {run,ctx}=domFixture();ctx.row=candidate;
 assert.equal(run('peptideIonLabel(peptideIonAssignment(row,row.fragments[0]))'),'b3 +1');
 assert.equal(run('peptideIonAssignment(row,row.fragments[1]).start'),4);
 assert.equal(run('peptideIonAssignment(row,{ion:"y5+",bond:5})'),null);
 assert.equal(run('peptideIonAssignment(row,{ion:"b8+",bond:8})'),null);
 assert.equal(run('peptideIonEvidence(row)[2].b[0].charge'),1);
 assert.equal(run('peptideIonEvidence(row)[3].y[0].charge'),2);
});

test('cleavage diagram puts y above and b below the actual inter-residue cut',()=>{
 const {run,ctx,nodes}=domFixture();ctx.row=candidate;run('peptideRenderIonSequence(row)');
 const panel=nodes.get('peptide-ion-sequence'),all=descendants(panel);
 const paths=all.filter(n=>n.tag==='path');assert.equal(paths.length,2);
 assert.deepEqual(paths.map(n=>n.attributes['data-bond']),['3','3']);
 assert.match(paths[0].attributes.d,/V 110 l -12 12/);assert.match(paths[1].attributes.d,/V 60 l 12 -12/);
 const buttons=all.filter(n=>n.attributes.role==='button');
 assert.match(buttons[0].attributes['aria-label'],/b3 \+1 · cut 3\|4/);
 buttons[0].listeners.click();
 assert.equal(all.filter(n=>n.classList.contains('is-ion-selected')).length,3);
 assert.match(panel.children.at(-1).textContent,/PEP/);
 buttons[1].listeners.keydown({key:'Enter',preventDefault(){}});
 assert.equal(all.filter(n=>n.classList.contains('is-ion-selected')).length,5);
 assert.match(panel.children.at(-1).textContent,/TIDER/);
 assert.equal(buttons[1].attributes['aria-pressed'],'true');
});

test('fixed modifications are marked only on their residue and included fragment',()=>{
 const {run,ctx,nodes}=domFixture();ctx.row={...candidate,modifications:[{residue:4,delta:114.04292747}]};
 run('peptideRenderIonSequence(row)');
 assert.equal(descendants(nodes.get('peptide-ion-sequence')).filter(n=>n.classList.contains('is-modified')).length,1);
 assert.doesNotMatch(run('peptideIonDescription(row,peptideIonAssignment(row,row.fragments[0]))'),/includes/);
 assert.match(run('peptideIonDescription(row,peptideIonAssignment(row,row.fragments[1]))'),/includes T4: \+114.042927/);
});

test('fragment spectrum labels exact observed masses and uses matching b/y colours',()=>{
 const {run,ctx}=domFixture();ctx.row=candidate;
 const traces=JSON.parse(JSON.stringify(run('peptideFragmentTraces(row)')));
 assert.equal(traces.length,4);assert.equal(traces[0].x[0],324.15539);
 assert.equal(traces[1].text[0],'b3 +1<br>324.1554');
 assert.equal(traces[0].line.color,traces[1].marker.color);
 assert.equal(traces[2].line.color,'#e52a2a');
});

test('coverage deduplicates repeated scans, separates overlapping evidence, excludes competing candidates',()=>{
 const {run,ctx}=domFixture();ctx.chain={id:'A',name:'Reference',sequence:'PEPTIDERPEPTIDER',positions:[],percent:0};
 ctx.result={matches:[candidate,{...candidate,scan_id:10},
  {...candidate,evidence:'ms1',locations:[{chain:'A',start:9,end:16}]},
  {...candidate,sequence:'TIDERPEP',locations:[{chain:'A',start:4,end:11}]},
  {...candidate,ambiguous_scan:true,locations:[{chain:'A',start:9,end:16}]}]};
 const spans=JSON.parse(JSON.stringify(run('peptideCoverageSpans(result,chain)')));
 assert.equal(spans.length,3);assert.equal(spans[0].spectrumCount,2);
 assert.equal(spans[1].lane,1);assert.equal(spans[2].evidence,'ms1');
 const node=run('peptideRenderCoverageChain(result,chain)');
 assert.equal(descendants(node).filter(n=>n.classList.contains('evidence-ms1')).length,1);
 assert.equal(descendants(node).filter(n=>n.classList.contains('evidence-msms')).length,2);
});

test('coverage continuation at 50 residues has no false endpoint',()=>{
 const {run,ctx}=domFixture();ctx.chain={id:'A',name:'Reference',sequence:'A'.repeat(60),positions:[],percent:0};
 ctx.result={matches:[{...candidate,sequence:'AAAAAA',locations:[{chain:'A',start:48,end:53}]}]};
 const all=descendants(run('peptideRenderCoverageChain(result,chain)'));
 assert.equal(all.filter(n=>n.classList.contains('continues-right')).length,1);
 assert.equal(all.filter(n=>n.classList.contains('continues-left')).length,1);
});

test('table filters include charge +1 and sort precursor m/z numerically, with missing values last',()=>{
 const {run,ctx}=domFixture();ctx.result={matches:[candidate,{...candidate,scan_id:10,evidence:'ms1',charge:2,precursor_mz:99,explained_intensity_pct:null},
  {...candidate,scan_id:11,precursor_mz:1000,precursor_error_ppm:-12}]};
 run('peptideView.sort={key:"precursor_mz",direction:1}');
 assert.deepEqual(Array.from(run('peptideFilteredRows(result).map(r=>r.scan_id)')),[10,9,11]);
 run('peptideView.filters.charge="1"');assert.equal(run('peptideFilteredRows(result).length'),2);
 run('peptideView.filters.text="A:1"');assert.equal(run('peptideFilteredRows(result).length'),2);
 run('peptideView.filters.evidence="ms1"');assert.equal(run('peptideFilteredRows(result).length'),0);
 run('peptideView.filters={text:"",charge:"",evidence:"",review:""};peptideView.sort={key:"explained_intensity_pct",direction:-1}');
 assert.equal(run('peptideFilteredRows(result).at(-1).scan_id'),10);
});

test('rendered table contains measured precursor m/z, sortable headers and resettable filters',()=>{
 const {run,ctx,nodes}=domFixture();ctx.result={matches:[candidate]};run('peptideRenderTable(result)');
 let all=descendants(nodes.get('peptide-results'));
 assert.ok(all.some(n=>n.textContent==='955.46760'));assert.ok(all.some(n=>n.textContent==='+1'));
 const header=all.find(n=>String(n.textContent).startsWith('Precursor m/z'));
 header.listeners.click();assert.equal(run('peptideView.sort.key'),'precursor_mz');
 const search=all.find(n=>n.type==='search');search.value='nonexistent';search.listeners.input();
 assert.ok(descendants(nodes.get('peptide-results')).some(n=>n.textContent==='0 of 1 matches'));
 all.find(n=>n.textContent==='Reset filters').listeners.click();
 assert.equal(run('peptideView.filters.text'),'');
});

test('MS-only selection never shows invented fragment-ion evidence',async()=>{
 const {run,ctx,nodes}=domFixture();ctx.row={...candidate,evidence:'ms1',fragments:[],observation_count:2,time_start:1,time_end:2,precursor_intensity:10};
 ctx.api.getQtofSpectrum=async()=>({mz:[955.4676],intensities:[10]});
 await run('peptideShowMatch(row)');
 assert.equal(nodes.get('peptide-ion-sequence').hidden,true);
 assert.match(nodes.get('peptide-spectrum-status').textContent,/No supporting MS\/MS/);
});

test('stale spectrum response cannot restore a cleared sequence map',async()=>{
 const {run,ctx,nodes}=domFixture();ctx.row=candidate;let resolve;
 ctx.api.getQtofSpectrum=()=>new Promise(r=>{resolve=r;});
 const pending=run('peptideShowMatch(row)');run('peptideClearResults()');
 resolve({mz:[324.15539],intensities:[100]});await pending;
 assert.equal(nodes.get('peptide-ion-sequence').hidden,true);
 assert.equal(nodes.get('peptide-spectrum-status').textContent,'');
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

test('coverage displays MS and MS/MS separately and no longer shows the removed instruction',()=>{
 const {run,ctx}=domFixture();ctx.result={matches:[candidate]};
 ctx.chain={id:'A',name:'Example',sequence:'PEPTIDER',positions:[1,2,3,4],percent:50,ms_percent:100,msms_percent:50};
 const panel=run('peptideRenderCoverageChain(result,chain)');
 assert.match(panel.children[0].textContent,/MS 100\.0% · MS\/MS 50\.0%/);
 assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../js/peptides.js'),'utf8'),/Angled marks show matched cuts/);
 assert.match(fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),/id="peptide-fragment-ppm"[^>]*value="20"/);
});

test('whole-reference site search disables written position and fixes GGisoK to lysines',()=>{
 const {run,nodes}=domFixture();
 run(`document.getElementById('peptide-fasta').value='AAAAAK';peptideView.modifications=[{chain:'A',position:1,kind:'gg',delta:114.04292747,block_cleavage:true}];peptideRenderLinkages()`);
 let row=nodes.get('peptide-linkages').children[0];
 const toggle=row.children[5].children[0];toggle.checked=true;toggle.onchange();
 row=nodes.get('peptide-linkages').children[0];
 assert.equal(row.children[1].children[0].disabled,true);
 assert.equal(row.children[6].children[0].value,'K');assert.equal(row.children[6].children[0].disabled,true);
 assert.ok(row.children[0].children[0].options.some(option=>option.value==='*'));
});

test('protein-wide modification positions are searchable and alternative sites do not hide sequence coverage',()=>{
 const {run,ctx}=domFixture();ctx.row={...candidate,locations:[{chain:'B',start:45,end:52}],
  modifications:[{residue:4,delta:114.04292747,variable:true}],ambiguous_scan:true,sequence_ambiguous:false,site_ambiguous:true};
 assert.match(run('peptideModificationSiteText(row)'),/B:48T.*candidate/);
 ctx.result={matches:[ctx.row]};run('peptideView.filters.text="B:48"');assert.equal(run('peptideFilteredRows(result).length'),1);
 run('peptideView.filters.review="site"');assert.equal(run('peptideFilteredRows(result).length'),1);
 ctx.chain={id:'B',sequence:'A'.repeat(44)+'PEPTIDER'};
 assert.equal(run('peptideCoverageSpans(result,chain).length'),1);
});

test('reference controls validate custom masses and distinguish detected signal from selected exclusion',()=>{
 const {run,ctx,nodes}=domFixture();
 run(`document.getElementById('reference-masses-mode').value='custom';document.getElementById('reference-masses-values').value='922.009798, 121.050873';document.getElementById('reference-masses-polarity').value='positive';document.getElementById('reference-masses-charge').value='1';document.getElementById('reference-masses-ppm').value='20';document.getElementById('reference-masses-isotopes').checked=true;`);
 assert.equal(run('referencePolicyFromControls().targets.length'),2);
 run(`document.getElementById('reference-masses-values').value='not a mass'`);assert.throws(()=>run('referencePolicyFromControls()'));
 ctx.report={policy:{mode:'auto',ppm:20,isotopes:true,targets:[]},active:true,removed_peaks:3,removed_msms_scans:0,method:{},detections:[
   {mz:922.009798,polarity:'positive',found:true,matched_scans:3,total_scans:5,observed_mz:922.010,error_ppm:.22,selected:true},
   {mz:121.050873,polarity:'positive',found:false,observed_mz:null,error_ppm:null,selected:false}]};
 run('referenceRender(report)');const all=descendants(nodes.get('reference-masses-detections'));
 assert.ok(all.some(n=>n.textContent==='Found in 3/5 MS scans'));assert.ok(all.some(n=>n.textContent==='Not found'));
 assert.ok(all.some(n=>n.textContent==='Excluded window'));assert.ok(all.some(n=>n.textContent==='Not selected'));
});

test('applying references preserves peptide inputs then refreshes to invalidate every old calculation',async()=>{
 const {run,ctx,nodes}=domFixture();let saved,reloaded=false;
 ctx.sessionStorage={setItem(key,value){saved=JSON.parse(value);}};
 ctx.window={location:{reload(){reloaded=true;}}};ctx.api.setReferenceMasses=async(path,policy)=>{assert.equal(path,'sample');assert.equal(policy.mode,'922');};
 run(`document.getElementById('reference-masses-sample').value='sample';document.getElementById('reference-masses-mode').value='922';document.getElementById('reference-masses-ppm').value='20';document.getElementById('peptide-fasta').value='PEPTIDER';`);
 await run('referenceApply()');assert.equal(saved.values['peptide-fasta'],'PEPTIDER');assert.equal(reloaded,true);
});

test('reference detection previews pending choices and never applies them',async()=>{
 const {run,ctx,nodes}=domFixture();let applied=false;
 ctx.api.setReferenceMasses=async()=>{applied=true;};
 ctx.api.previewReferenceMasses=async(path,policy)=>{assert.equal(policy.mode,'off');return {policy,active:false,removed_peaks:0,removed_msms_scans:0,method:{},detections:[]};};
 run(`document.getElementById('reference-masses-sample').value='sample';document.getElementById('reference-masses-mode').value='off';document.getElementById('reference-masses-ppm').value='20'`);
 await run('referenceDetect()');assert.equal(applied,false);
 assert.match(nodes.get('reference-masses-summary').textContent,/preview — not applied/);
 assert.equal(run('referenceView.dirty'),true);
});

test('edited reference settings invalidate a pending detection response',async()=>{
 const {run,ctx,nodes}=domFixture();let resolve;
 ctx.sessionStorage={getItem(){return null;},removeItem(){}};
 ctx.api.previewReferenceMasses=()=>new Promise(r=>{resolve=r;});run('initReferenceMasses()');
 run(`document.getElementById('reference-masses-mode').value='922';document.getElementById('reference-masses-ppm').value='20'`);
 const pending=run('referenceDetect()');nodes.get('reference-masses-mode').value='off';nodes.get('reference-masses-mode').listeners.change();
 resolve({policy:{mode:'922',ppm:20,targets:[],isotopes:true},active:true,method:{},detections:[]});await pending;
 assert.equal(nodes.get('reference-masses-mode').value,'off');
 assert.match(nodes.get('reference-masses-status').textContent,/not applied yet/);
});
