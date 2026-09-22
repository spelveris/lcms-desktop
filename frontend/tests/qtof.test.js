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
    insertBefore(child,before){this.children=this.children.filter(n=>n!==child);this.children.splice(this.children.indexOf(before),0,child);return child;}
    replaceChildren(...children){this.children=children;if(this.tag==='select')this.value='';}
    addEventListener(name,fn){this.listeners[name]=fn;}
    focus(){this.focused=true;}
    setAttribute(name,value){this.attributes[name]=String(value);if(name==='class')this.className=String(value);}
    createTHead(){return this.appendChild(new Element('thead'));}
    createTBody(){return this.appendChild(new Element('tbody'));}
    insertRow(){return this.appendChild(new Element('tr'));}
    insertCell(){return this.appendChild(new Element('td'));}
    get options(){return this.children;}
  }
  const nodes=new Map();
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},createElement(tag){return new Element(tag);},createElementNS(ns,tag){return new Element(tag);}};
  document.getElementById('peptide-ms1-relative').value='5';
  document.getElementById('peptide-ms1-intensity').value='0';
  document.getElementById('peptide-variable-max').value='4';
  document.getElementById('peptide-reduction').value='reduced';
  const ctx=vm.createContext({console,document,showLoading(){},hideLoading(){},Plotly:{purge(){},async react(){}},WEBAPP_LAYOUT:{xaxis:{},yaxis:{}},PLOT_CONFIG:{},api:{}});
  for(const file of ['qtof.js','peptides.js','reference-masses.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js',file),'utf8'),ctx);
  vm.runInContext(`for(const [id,value] of Object.values(PEPTIDE_METHOD_FIELDS))document.getElementById(id).value=String(value);
    document.getElementById('peptide-terminal-truncation').checked=true;`,ctx);
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
 scan_id:9,time:1.5,charge:1,precursor_mz:955.4676,theoretical_precursor_mz:955.4676/(1+2.1e-6),precursor_error_ppm:2.1,matched_ions:4,
 explained_intensity_pct:45,isotope_offset:0,ambiguous_scan:false,
 fragments:[{ion:'b3+',bond:3,observed_mz:324.15539,theoretical_mz:324.1554,error_ppm:-.03,intensity:100},
 {ion:'y5^2+',bond:3,observed_mz:300.2,theoretical_mz:300.2,error_ppm:0,intensity:80}]};

test('preparation and variable chemistry are isolated per sample in this session',()=>{
 const {run,nodes}=domFixture();
 run("peptideSelectPreparation('OppA')");
 nodes.get('peptide-iam').checked=true;nodes.get('peptide-variable-oxidation').checked=true;
 run("peptideSelectPreparation('diUb')");
 assert.equal(nodes.get('peptide-iam').checked,false);assert.equal(nodes.get('peptide-variable-oxidation').checked,false);
 nodes.get('peptide-variable-deamidation').checked=true;
 run("peptideSelectPreparation('OppA')");
 assert.equal(nodes.get('peptide-iam').checked,true);assert.equal(nodes.get('peptide-variable-oxidation').checked,true);
 assert.equal(nodes.get('peptide-variable-deamidation').checked,false);
 assert.deepEqual(JSON.parse(JSON.stringify(run('peptideReadVariableModifications()'))),{oxidation:true,deamidation:false,iam:false,max_per_peptide:4});
 nodes.get('peptide-variable-iam').checked=true;
 assert.throws(()=>run('peptideReadVariableModifications()'),/fixed or variable IAM/);
 nodes.get('peptide-variable-max').value='5';assert.throws(()=>run('peptideReadVariableModifications()'),/1–4/);
});

test('IAM controls are mutually exclusive and variable chemistry changes invalidate results',()=>{
 const {run,nodes}=domFixture();run('initPeptideMapping()');
 nodes.get('peptide-variable-iam').checked=true;nodes.get('peptide-iam').checked=true;
 nodes.get('peptide-iam').listeners.input();assert.equal(nodes.get('peptide-variable-iam').checked,false);
 nodes.get('peptide-variable-iam').checked=true;nodes.get('peptide-variable-iam').listeners.input();
 assert.equal(nodes.get('peptide-iam').checked,false);
 run('peptideView.results={matches:[]}');
 nodes.get('peptide-variable-deamidation').listeners.input();assert.equal(run('peptideView.results'),null);
});
function descendants(node){return [node,...node.children.flatMap(descendants)];}

const chromatogram={times:[0,.5,1,1.5,2,3,8],tic:[100,300,400,500,400,200,100],xic:[0,0,8,12,8,0,0],target_mz:955.46559,ppm:10};

test('mapping shows the whole TIC before any peptide is selected',async()=>{
 const {run,ctx,nodes}=domFixture();const requests=[],renders=[];
 ctx.api.getPeptideChromatogram=async(...args)=>{requests.push(args);return chromatogram;};
 ctx.Plotly.react=async(id,data)=>renders.push(data);
 run('peptideView.path="sample"');await run('peptideLoadChromatogram()');
 assert.deepEqual(requests,[['sample',null,10]]);assert.equal(renders[0].length,1);
 assert.equal(nodes.get('peptide-chromatogram').hidden,false);
 assert.match(nodes.get('peptide-chromatogram-status').textContent,/Whole-run TIC/);
});

test('whole-run TIC stays black with a blue raw-count precursor overlay for both evidence types',()=>{
 const {run,ctx}=domFixture();ctx.data=chromatogram;
 const original=JSON.stringify(ctx.data);
 for(const evidence of ['ms1','msms']){
  ctx.row={...candidate,evidence,ms1_supported:true,time_start:1,time_end:2,precursor_feature:{time_start:1,time_end:2}};
  const {traces,layout}=run('peptideChromatogramPlot(data,row)');
  assert.equal(traces[0].line.color,'#000000');assert.equal(traces[1].line.color,'#215caf');
  assert.deepEqual(Array.from(traces[0].y),chromatogram.tic);assert.deepEqual(Array.from(traces[1].y),chromatogram.xic);
  assert.equal(traces[1].yaxis,'y2');assert.equal(layout.yaxis2.side,'right');
  assert.match(layout.yaxis.title.text,/TIC.*counts/);assert.match(layout.yaxis2.title.text,/Precursor XIC.*counts/);
  assert.deepEqual(Array.from(layout.xaxis.range),[0,8]);assert.equal(layout.xaxis.autorange,false);
  assert.equal(layout.shapes.find(s=>s.type==='rect').x0,1);assert.equal(layout.shapes.find(s=>s.type==='rect').x1,2);
  assert.equal(layout.shapes.find(s=>s.type==='line').x0,1.5);
 }
 assert.equal(JSON.stringify(ctx.data),original);
 const overview=run('peptideChromatogramPlot(data)');assert.equal(overview.traces.length,1);assert.equal(overview.layout.shapes.length,0);
 ctx.row={...candidate,ms1_supported:false,precursor_feature:{time_start:1,time_end:2}};
 assert.equal(run('peptideChromatogramPlot(data,row).layout.shapes.filter(s=>s.type==="rect").length'),0);
});

test('peptide selection requests matching isotope m/z and ppm but keeps the measured spectrum separate',async()=>{
 const {run,ctx,nodes}=domFixture();const renders=[],requests=[];
 ctx.row={...candidate,ms1_supported:true,precursor_link:'recorded parent',precursor_feature:{time_start:1,time_end:2,observation_count:7}};
 ctx.Plotly.react=async(id,data,layout)=>renders.push({id,data,layout});
 ctx.api.getPeptideChromatogram=async(...args)=>{requests.push(args);return chromatogram;};
 ctx.api.getQtofSpectrum=async()=>({mz:[324.15539],intensities:[100]});
 run('peptideView.path="sample";peptideView.results={settings:{precursor_ppm:7},matches:[row]}');
 await run('peptideShowMatch(row)');
 assert.deepEqual(requests,[['sample',candidate.theoretical_precursor_mz,7]]);
 assert.ok(renders.some(r=>r.id==='peptide-chromatogram-plot'&&r.data.length===2));
 assert.ok(renders.some(r=>r.id==='peptide-spectrum-plot'));
 assert.match(nodes.get('peptide-chromatogram-status').textContent,/Supported MS1 interval 1.000–2.000 min/);
 assert.match(nodes.get('peptide-spectrum-status').textContent,/acquired at 1.5000 min/);
 assert.match(nodes.get('peptide-spectrum-status').textContent,/supported interval 1.000–2.000 min/);
 assert.equal(nodes.get('btn-peptide-spectrum-pdf').disabled,false);
 assert.deepEqual(Array.from(run('peptideView.selectedSpectrum.mz')),[324.15539]);
});

test('late chromatogram replies and cleared results cannot replace a newer peptide selection',async()=>{
 const {run,ctx,nodes}=domFixture();const replies=[],renders=[];
 ctx.row=candidate;ctx.next={...candidate,scan_id:10,time:3};
 ctx.Plotly.react=async(id,data)=>renders.push(data);
 ctx.api.getPeptideChromatogram=()=>new Promise(resolve=>replies.push(resolve));
 const first=run('peptideLoadChromatogram(row)'),second=run('peptideLoadChromatogram(next)');
 replies[1](chromatogram);await second;replies[0]({...chromatogram,xic:[999]});await first;
 assert.equal(renders.length,1);assert.deepEqual(Array.from(renders[0][1].y),chromatogram.xic);
 assert.match(nodes.get('peptide-chromatogram-status').textContent,/3.0000 min/);
 const third=run('peptideLoadChromatogram(row)');run('peptideClearResults()');replies[2](chromatogram);await third;
 assert.equal(nodes.get('peptide-chromatogram').hidden,true);assert.equal(run('peptideView.chromatogram'),null);
 assert.equal(nodes.get('peptide-chromatogram-status').textContent,'');
});

test('a failed chromatogram never blocks the measured spectrum, ladder or export',async()=>{
 const {run,ctx,nodes}=domFixture();ctx.row=candidate;
 ctx.api.getPeptideChromatogram=async()=>{throw Error('No MS1 surveys');};
 ctx.api.getQtofSpectrum=async()=>({mz:[324.15539],intensities:[100]});
 await run('peptideShowMatch(row)');
 assert.match(nodes.get('peptide-chromatogram-status').textContent,/No MS1 surveys/);
 assert.equal(nodes.get('btn-peptide-spectrum-pdf').disabled,false);
 assert.equal(nodes.get('peptide-ion-sequence').hidden,false);
});

test('slow Plotly renders are serialized and stale paintings are cleared before the next overlay',async()=>{
 const {run,ctx}=domFixture();let finish,started,purges=0;const rendered=[];
 const begun=new Promise(resolve=>{started=resolve;});ctx.data=chromatogram;ctx.row=candidate;
 ctx.Plotly.purge=()=>purges++;
 ctx.Plotly.react=async(id,data)=>{rendered.push(data.length);if(rendered.length===1){started();await new Promise(resolve=>{finish=resolve;});}};
 const first=run('peptideView.chromatogramRequest=1;peptideDrawChromatogram(data,null,1)');await begun;
 const next=run('peptideView.chromatogramRequest=2;peptideDrawChromatogram(data,row,2)');
 assert.deepEqual(rendered,[1]);finish();await Promise.all([first,next]);
 assert.deepEqual(rendered,[1,2]);assert.equal(purges,1);
});

test('observation picker groups matching sequence and modifications without merging times, charges or evidence',async()=>{
 const {run,ctx,nodes}=domFixture();ctx.row=candidate;
 ctx.result={matches:[candidate,{...candidate,scan_id:10,time:2,charge:2},
  {...candidate,scan_id:11,time:3,evidence:'ms1',fragments:[],time_start:2.9,time_end:3.1},
  {...candidate,scan_id:12,time:4,modifications:[{residue:3,delta:42}]},
  {...candidate,scan_id:13,time:5,sequence:'DIFFERENT'}]};
 const before=JSON.stringify(ctx.result);
 run('peptideView.results=result;peptideRenderObservations(row)');
 const select=nodes.get('peptide-observation-select');assert.equal(select.children.length,3);
 assert.equal(select.value,'0');assert.equal(select.disabled,false);
 assert.match(select.children[1].textContent,/2.0000 min · MS\/MS · \+2 · scan 10/);
 assert.match(select.children[2].textContent,/MS1 interval 2.900–3.100/);
 ctx.api.getPeptideChromatogram=async()=>chromatogram;
 ctx.api.getQtofSpectrum=async(path,scan)=>{assert.equal(scan,10);return {mz:[1],intensities:[2]};};
 select.value='1';await select.onchange();assert.equal(run('peptideView.selectedMatch.scan_id'),10);
 assert.equal(JSON.stringify(ctx.result),before);
});

test('chromatogram has a full-width fixed-height canvas and participates in window resizing',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 const css=fs.readFileSync(path.join(__dirname,'../css/style.css'),'utf8');
 const app=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');
 assert.match(html,/id="peptide-chromatogram" hidden/);
 assert.match(html,/id="peptide-chromatogram-plot"[^>]*data-fixed-plot-height="300"/);
 assert.match(css,/\.peptide-chromatogram-canvas\s*\{[^}]*width: 100%;[^}]*height: 300px/);
 assert.match(app,/function schedulePlotlyResize[\s\S]*?'peptide-chromatogram-plot'/);
});

test('biomolecule overlay marks only its own interval and labels the apex without altering full-run TIC',()=>{
 const {run,ctx}=domFixture();ctx.data={...chromatogram,xic:[0,0,8,12,8,20,0]};
 ctx.row={...candidate,biomolecule:{id:'b1',confirmed:true,time_start:1,time_end:2,apex_time:1.5,charges:[1,2]}};
 const {traces,layout}=run('peptideChromatogramPlot(data,row)');
 assert.deepEqual(Array.from(traces[0].y),chromatogram.tic);
 assert.deepEqual(Array.from(traces[1].y),[0,0,8,12,8,0,0]);
 assert.equal(layout.annotations[0].x,1.5);assert.equal(layout.annotations[0].y,12);
 assert.match(layout.yaxis2.title.text,/Biomolecule/);assert.deepEqual(Array.from(layout.xaxis.range),[0,8]);
});

test('separate elution feature selector never combines spectra by sequence alone',()=>{
 const {run,ctx,nodes}=domFixture();
 const bio={id:'b1',confirmed:true,time_start:1,time_end:2,apex_time:1.5,charges:[1,2]};
 ctx.row={...candidate,biomolecule:bio};
 ctx.result={matches:[ctx.row,{...candidate,scan_id:10,charge:2,biomolecule:bio},
  {...candidate,scan_id:11,time:8,biomolecule:{...bio,id:'b2',time_start:7,time_end:9,apex_time:8}}]};
 run('peptideView.results=result;peptideRenderObservations(row)');
 assert.equal(nodes.get('peptide-biomolecule-select').children.length,2);
 assert.equal(nodes.get('peptide-observation-select').children.length,2);
 assert.match(nodes.get('peptide-biomolecule-select').children[1].textContent,/7.000–9.000/);
 assert.equal(run('peptideCoverageSpans(result,{id:"A",sequence:"PEPTIDER"}).length'),2);
});

test('method dropdown has editable defaults, sends method and persists only method choices',async()=>{
 const {run,ctx,nodes}=domFixture();const stored=new Map();
 ctx.localStorage={getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v)};
 run('peptideResetMethod()');
 assert.equal(nodes.get('peptide-fragment-ppm').value,'50');
 assert.equal(nodes.get('peptide-mz-min').value,'350');
 assert.equal(nodes.get('peptide-peak-min').value,'100');
 assert.equal(nodes.get('peptide-terminal-truncation').checked,true);
 assert.equal(nodes.get('peptide-default-evidence').value,'msms');
 let payload;ctx.api.analyzePeptides=async value=>{payload=value;return {matches:[],coverage:[],settings:{}};};
 nodes.get('peptide-mz-min').value='300';await run('peptideAnalyze()');
 assert.equal(payload.method.ms1_mz_min,300);assert.equal(payload.method.fragment_peak_limit,0);
 assert.equal(payload.fragment_ppm,50);assert.equal(payload.method.terminal_truncation,true);
 run('peptideSaveMethod();initPeptideMapping()');
 assert.equal(nodes.get('peptide-mz-min').value,'300');
 assert.ok(!stored.values().next().value.includes('fasta'));
 nodes.get('peptide-mz-min').value='';assert.throws(()=>run('peptideReadMethod()'),/Enter a value/);
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 assert.match(html,/<details id="peptide-method-settings"/);
 assert.match(html,/Agilent quality\/identification scores/);
});

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

test('rendered table pairs measured and theoretical precursor m/z with full-precision tooltips',()=>{
 const {run,ctx,nodes}=domFixture();ctx.result={matches:[candidate]};run('peptideRenderTable(result)');
 let all=descendants(nodes.get('peptide-results'));
 assert.ok(all.some(n=>n.textContent==='955.46760'));assert.ok(all.some(n=>n.textContent==='+1'));
 assert.ok(all.some(n=>n.textContent===candidate.theoretical_precursor_mz.toFixed(5)));
 const cells=all.filter(n=>n.classList.contains('peptide-mz-cell'));
 assert.equal(cells.length,2);assert.equal(cells[0].textContent,'955.46760');
 assert.equal(cells[1].textContent,'955.46559');
 assert.match(cells[1].title,new RegExp(String(candidate.theoretical_precursor_mz).replace('.', '\\.')));
 assert.match(cells[1].title,/charge \+1, isotope M\+0, modifications included/);
 const header=all.find(n=>String(n.textContent).startsWith('Measured precursor m/z'));
 header.listeners.click();assert.equal(run('peptideView.sort.key'),'precursor_mz');
 all.find(n=>String(n.textContent).startsWith('Theoretical precursor m/z')).listeners.click();
 assert.equal(run('peptideView.sort.key'),'theoretical_precursor_mz');
 const search=all.find(n=>n.type==='search');search.value='nonexistent';search.listeners.input();
 assert.ok(descendants(nodes.get('peptide-results')).some(n=>n.textContent==='0 of 1 matches'));
 all.find(n=>n.textContent==='Reset filters').listeners.click();
 assert.equal(run('peptideView.filters.text'),'');
});

test('each table header has an independent filter button next to sorting; numeric filters update and reset',()=>{
 const {run,ctx,nodes}=domFixture();ctx.result={matches:[candidate,{...candidate,scan_id:10,precursor_mz:1000}]};
 const before=JSON.stringify(ctx.result);run('peptideRenderTable(result)');
 const all=()=>descendants(nodes.get('peptide-results'));
 const filters=all().filter(n=>n.classList.contains('peptide-filter-button'));assert.equal(filters.length,12);
 const filter=filters.find(n=>n.attributes['aria-label']==='Filter Measured precursor m/z');
 filter.listeners.click();assert.equal(filter.attributes['aria-expanded'],'true');
 const input=all().find(n=>n.attributes['aria-label']==='Measured precursor m/z: Minimum (inclusive)');
 assert.equal(input.focused,true);input.value='980';input.listeners.input();
 assert.ok(all().some(n=>n.textContent==='1 of 2 matches'));assert.equal(filter.attributes['aria-pressed'],'true');
 assert.match(filter.title,/980/);
 all().find(n=>n.classList.contains('peptide-sort-button')&&n.textContent.startsWith('Measured precursor m/z')).listeners.click();
 assert.equal(run('peptideFilteredRows(result)[0].scan_id'),10);
 all().find(n=>n.textContent==='Done').listeners.click();assert.equal(filter.attributes['aria-expanded'],'false');
 filter.listeners.click();assert.equal(all().find(n=>n.attributes['aria-label']==='Measured precursor m/z: Minimum (inclusive)').value,'980');
 all().find(n=>n.textContent==='Clear this filter').listeners.click();assert.equal(run('peptideFilteredRows(result).length'),2);
 filter.listeners.click();all().find(n=>n.attributes['aria-label']==='Measured precursor m/z: Maximum (inclusive)').value='900';
 all().find(n=>n.attributes['aria-label']==='Measured precursor m/z: Maximum (inclusive)').listeners.input();
 assert.equal(run('peptideFilteredRows(result).length'),0);
 all().find(n=>n.textContent==='Reset filters').listeners.click();assert.equal(run('Object.keys(peptideView.columnFilters).length'),0);
 assert.equal(JSON.stringify(ctx.result),before);
});

test('theoretical m/z filters and sorts independently, and missing theory is never invented',()=>{
 const {run,ctx,nodes}=domFixture();ctx.result={matches:[candidate,
  {...candidate,scan_id:10,evidence:'ms1',theoretical_precursor_mz:1100,precursor_mz:99},
  {...candidate,scan_id:11,theoretical_precursor_mz:null},
  {...candidate,scan_id:12,theoretical_precursor_mz:undefined}]};
 run('peptideView.sort={key:"theoretical_precursor_mz",direction:-1}');
 assert.deepEqual(Array.from(run('peptideFilteredRows(result).map(r=>r.scan_id)')),[10,9,11,12]);
 run('peptideRenderTable(result)');
 const all=()=>descendants(nodes.get('peptide-results'));
 assert.equal(all().filter(n=>n.classList.contains('peptide-mz-cell')&&n.textContent==='—').length,2);
 all().find(n=>n.attributes['aria-label']==='Filter Theoretical precursor m/z').listeners.click();
 const min=all().find(n=>n.attributes['aria-label']==='Theoretical precursor m/z: Minimum (inclusive)');
 assert.equal(min.type,'number');min.value='1000';min.listeners.input();
 assert.deepEqual(Array.from(run('peptideFilteredRows(result).map(r=>r.scan_id)')),[10]);
 run('peptideView.columnFilters.precursor_mz={min:"1000"}');
 assert.equal(run('peptideFilteredRows(result).length'),0);
});

test('column filters combine inclusive numeric ranges and text while excluding missing numeric evidence',()=>{
 const {run,ctx}=domFixture();ctx.result={matches:[candidate,{...candidate,scan_id:10,evidence:'ms1',explained_intensity_pct:null,matched_ions:0},
  {...candidate,scan_id:11,precursor_error_ppm:-2.1,modifications:[{residue:3,delta:42}]}]};
 run('peptideView.columnFilters={precursor_error_ppm:{min:"-2.1",max:"0"},modification_sites:{text:"a:3p"}}');
 assert.deepEqual(Array.from(run('peptideFilteredRows(result).map(row=>row.scan_id)')),[11]);
 run('peptideView.columnFilters={explained_intensity_pct:{min:"0"}}');assert.equal(run('peptideFilteredRows(result).length'),2);
 run('peptideView.columnFilters={matched_ions:{min:"0"}}');assert.equal(run('peptideFilteredRows(result).length'),2);
 for(const range of ['{min:"abc"}','{min:"10",max:"-10"}']){
  run(`peptideView.columnFilters={precursor_error_ppm:${range}}`);assert.equal(run('peptideFilteredRows(result).length'),0);
 }
 for(const [key,text] of [['sequence','peptide'],['locations','a:1'],['evidence','ms/ms'],['ambiguous_scan','no competing']]){
  ctx.key=key;ctx.query=text;run('peptideView.columnFilters={[key]:{text:query}}');assert.ok(run('peptideFilteredRows(result).length')>=2);
 }
});

test('coverage colours only MS/MS modification candidates with a remnant-bearing fragment at valid global positions',()=>{
 const {run,ctx}=domFixture();ctx.chain={id:'A',name:'Reference',sequence:'AAAAAPEPTIDER',positions:[8],percent:0};
 const row={...candidate,locations:[{chain:'A',start:6,end:13},{chain:'B',start:6,end:13}],modifications:[{residue:3,delta:42}]};
 ctx.result={matches:[row]};
 const all=descendants(run('peptideRenderCoverageChain(result,chain)'));
 const red=all.filter(n=>n.classList.contains('is-modified'));assert.equal(red.length,1);assert.equal(red[0].textContent,'P');assert.match(red[0].title,/A:P8/);
 assert.equal(red[0].classList.contains('is-covered'),true);
 ctx.chain.id='B';assert.equal(run('peptideCoverageModifications(result,chain).size'),1);ctx.chain.id='A';
 for(const override of [{evidence:'ms1'},{sequence_ambiguous:true},{fragments:[candidate.fragments[1]]},
   {locations:[{chain:'A',start:1,end:8}]},{modifications:[{residue:30,delta:42}]}]){
  ctx.result={matches:[{...row,...override}]};assert.equal(run('peptideCoverageModifications(result,chain).size'),0);
 }
 ctx.result={matches:[{...row,site_ambiguous:true,ambiguous_scan:true,sequence_ambiguous:false}]};
 const possible=descendants(run('peptideRenderCoverageChain(result,chain)')).find(n=>n.classList.contains('is-modified'));
 assert.ok(possible.classList.contains('is-modification-ambiguous'));assert.match(possible.title,/Possible site; competing sites remain/);
});

test('blue ladder superscripts and dual-charge labels have clearance from cuts and residue numbers',()=>{
 const {run,ctx,nodes}=domFixture();ctx.row={...candidate,fragments:[candidate.fragments[0],{...candidate.fragments[0],ion:'b3^2+'}]};
 run('peptideRenderIonSequence(row)');const all=descendants(nodes.get('peptide-ion-sequence'));
 const labels=all.filter(n=>n.tag==='g'&&n.attributes.role==='button').map(n=>n.children.find(c=>c.tag==='text'));
 assert.deepEqual(labels.map(n=>Number(n.attributes.y)),[153,173]);
 assert.ok(labels.every(n=>Number(n.attributes.y)-25>122));
 assert.ok(Number(labels.at(-1).attributes.y)+10<Number(all.find(n=>n.classList.contains('peptide-map-position')).attributes.y)-10);
 assert.equal(all.find(n=>n.tag==='svg').attributes.height,'216');
 const residues=all.filter(n=>n.classList.contains('peptide-map-residue'));
 assert.equal(Number(residues[1].attributes.x)-Number(residues[0].attributes.x),36);
 assert.equal(labels[0].attributes['font-size'],'15');
 const hitboxes=all.filter(n=>n.tag==='g'&&n.attributes.role==='button').map(n=>n.children.find(c=>c.tag==='rect'));
 assert.ok(hitboxes.every(n=>Number(n.attributes.width)<36));
});

test('MS-only selection never shows invented fragment-ion evidence',async()=>{
 const {run,ctx,nodes}=domFixture();ctx.row={...candidate,evidence:'ms1',ms1_supported:true,fragments:[],isotope_count:3,isotope_fit:.98,observation_count:3,time_start:1,time_end:2,precursor_intensity:10};
 ctx.api.getQtofSpectrum=async()=>({mz:[955.4676],intensities:[10]});
 await run('peptideShowMatch(row)');
 assert.equal(nodes.get('peptide-ion-sequence').hidden,true);
 assert.match(nodes.get('peptide-spectrum-status').textContent,/No linked MS\/MS/);
 assert.doesNotMatch(nodes.get('peptide-spectrum-status').textContent,/undefined|NaN/);
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
 assert.match(fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),/id="peptide-fragment-ppm"[^>]*value="50"/);
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

test('compact coverage uses half-height clickable evidence lanes and preserves line colours',()=>{
 const css=fs.readFileSync(path.join(__dirname,'../css/style.css'),'utf8');
 assert.match(css,/\.peptide-coverage-grid\s*\{[^}]*grid-template-rows: 20px;[^}]*grid-auto-rows: 8px;/);
 assert.match(css,/\.peptide-coverage-underline\s*\{[^}]*height: 8px;[^}]*min-height: 8px;[^}]*border-bottom: 2px solid #78bef4/);
 assert.match(css,/\.peptide-coverage-underline\.evidence-ms1\s*\{[^}]*2px dashed #5fbd83/);
});

test('wrapped coverage repacks sparse later lines without changing peptide locations or click targets',()=>{
 const {run,ctx}=domFixture();ctx.chain={id:'A',name:'Example',sequence:'A'.repeat(100),positions:[],percent:0};
 ctx.result={matches:[[1,40],[2,41],[3,70]].map(([start,end],i)=>({...candidate,scan_id:i+1,
   sequence:'A'.repeat(end-start+1),locations:[{chain:'A',start,end}]}))};
 let selected;ctx.capture=row=>{selected=row;};run('peptideShowMatch=capture');
 const panel=run('peptideRenderCoverageChain(result,chain)');
 const blocks=descendants(panel).filter(n=>n.classList.contains('peptide-coverage-block'));
 const later=descendants(blocks[1]).filter(n=>n.tag==='button');
 assert.equal(later.length,1);assert.equal(later[0].style.gridRow,'2');
 assert.equal(later[0].classList.contains('continues-left'),true);
 later[0].listeners.click();assert.equal(selected.scan_id,3);
 assert.deepEqual(selected.locations,[{chain:'A',start:3,end:70}]);
});

test('compact local lanes reuse nonoverlapping space but keep overlapping evidence separately clickable',()=>{
 const {run,ctx}=domFixture();ctx.spans=[{start:1,end:5,lane:2},{start:6,end:10,lane:3},{start:3,end:8,lane:4}];
 const before=JSON.stringify(ctx.spans);
 const compact=JSON.parse(JSON.stringify(run('peptideCoverageBlockSpans(spans,1,50)')));
 assert.deepEqual(compact.map(span=>span.lane),[0,1,0]);
 assert.equal(JSON.stringify(ctx.spans),before);
});

test('compact wrapped lanes preserve every evidence target without overlap or empty lanes',()=>{
 const {run,ctx}=domFixture();
 ctx.spans=Array.from({length:80},(_,id)=>({id,start:1+(id*17)%160,end:Math.min(200,15+(id*17)%160+(id*7)%40),lane:id}));
 for(let start=1;start<=200;start+=50){
  ctx.blockStart=start;ctx.blockEnd=start+49;
  const compact=JSON.parse(JSON.stringify(run('peptideCoverageBlockSpans(spans,blockStart,blockEnd)')));
  assert.deepEqual(compact.map(s=>s.id).sort((a,b)=>a-b),ctx.spans.filter(s=>s.start<=start+49&&s.end>=start).map(s=>s.id));
  const lanes=[...new Set(compact.map(s=>s.lane))].sort((a,b)=>a-b);
  assert.deepEqual(lanes,lanes.map((_,i)=>i));
  for(const lane of lanes){
   const members=compact.filter(s=>s.lane===lane);
   for(let i=1;i<members.length;i++)assert.ok(members[i-1].blockEnd<members[i].blockStart);
  }
 }
});

test('compact MS-only and MS/MS lines keep distinct accessible buttons and select their own spectrum',()=>{
 const {run,ctx}=domFixture();ctx.chain={id:'A',name:'Reference',sequence:'PEPTIDER',positions:[],percent:0};
 ctx.result={matches:[candidate,{...candidate,scan_id:10,evidence:'ms1'}]};
 let selected;ctx.capture=row=>{selected=row;};run('peptideShowMatch=capture');
 const panel=run('peptideRenderCoverageChain(result,chain)');
 const buttons=descendants(panel).filter(n=>n.tag==='button');
 assert.equal(buttons.length,2);assert.notEqual(buttons[0].style.gridRow,buttons[1].style.gridRow);
 for(const button of buttons){
  assert.equal(button.type,'button');assert.ok(button.attributes['aria-label']);
  button.listeners.click();assert.equal(selected.evidence,button.classList.contains('evidence-ms1')?'ms1':'msms');
 }
 assert.ok(buttons.some(n=>n.attributes['aria-label'].includes('MS1 feature-supported mass candidate')));
 assert.ok(!descendants(panel).some(n=>String(n.textContent).includes('Blue solid:')));
});

test('removing the imported-reference comment does not alter reference or modification import',()=>{
 const {run,nodes}=domFixture();
 run("peptideView.references=[{name:'Synthetic reference',source:'method.bcpmx',fasta:'>A\\nAAAAAK',modifications:[{chain:'A',position:6,name:'Unknown modification',delta:null}],warnings:['Imported settings only']}];peptideUseReference(0)");
 assert.equal(nodes.get('peptide-fasta').value,'>A\nAAAAAK');
 assert.equal(nodes.get('peptide-import-status').textContent,'');
 assert.equal(run('peptideView.modifications[0].delta'),null);
 assert.equal(run('peptideView.modifications[0].position'),6);
});

test('unconfirmed MS/MS precursor is distinct from a linked solid blue line',async()=>{
 const {run,ctx,nodes}=domFixture();ctx.chain={id:'A',name:'Reference',sequence:'PEPTIDER',positions:[],percent:0};
 ctx.row={...candidate,ms1_supported:false,precursor_link:'unconfirmed'};
 ctx.result={matches:[ctx.row,{...candidate,scan_id:10,ms1_supported:true}]};
 const panel=run('peptideRenderCoverageChain(result,chain)');
 const buttons=descendants(panel).filter(n=>n.tag==='button');
 assert.equal(buttons.length,2);
 assert.equal(buttons.filter(n=>n.classList.contains('precursor-unconfirmed')).length,1);
 assert.match(run('peptideEvidenceText(row)'),/precursor unconfirmed/);
 ctx.api.getQtofSpectrum=async()=>({mz:[100],intensities:[10]});
 await run('peptideShowMatch(row)');
 assert.match(nodes.get('peptide-spectrum-status').textContent,/excluded from MS feature coverage/);
});

test('coverage uses available panel width rather than a fixed 50-residue limit',()=>{
 const run=fixture();
 for(const [width,columns] of [[480,30],[800,50],[1280,80],[1560,90],[120,7],[0,50]]){
  assert.equal(run(`peptideCoverageColumns(${width})`),columns);
 }
 assert.equal(run('peptideCoverageColumns(undefined)'),50);
});

test('responsive sequence wrapping preserves every residue, range and crossing peptide',()=>{
 const {run,ctx}=domFixture();ctx.chain={id:'A',name:'Reference',sequence:'A'.repeat(185),positions:[],percent:0};
 ctx.result={matches:[{...candidate,sequence:'A'.repeat(16),locations:[{chain:'A',start:75,end:90}]}]};
 const all=descendants(run('peptideRenderCoverageChain(result,chain,80)'));
 assert.equal(all.filter(n=>n.classList.contains('peptide-coverage-residue')).length,185);
 assert.deepEqual(all.filter(n=>n.classList.contains('peptide-coverage-range')).map(n=>n.textContent),['1–80','81–160','161–185']);
 assert.ok(all.filter(n=>n.classList.contains('peptide-coverage-grid')).every(n=>n.style.gridTemplateColumns==='repeat(80, minmax(0, 1fr))'));
 assert.equal(all.filter(n=>n.classList.contains('continues-left')).length,1);
 assert.equal(all.filter(n=>n.classList.contains('continues-right')).length,1);
 const lines=all.filter(n=>n.tag==='button');
 assert.deepEqual(lines.map(n=>n.style.gridColumn),['75 / span 6','1 / span 10']);
});

test('panel resize reflows coverage without rerunning analysis, resetting filters or replacing the table',()=>{
 const {run,ctx,nodes}=domFixture();let callback,observed;
 ctx.ResizeObserver=class{constructor(fn){callback=fn;}observe(node){observed=node;}disconnect(){}};
 ctx.result={matches:[candidate],coverage:[{id:'A',name:'Reference',sequence:'PEPTIDER'.repeat(20),positions:[],percent:0}]};
 nodes.get('peptide-coverage') || run("document.getElementById('peptide-coverage')");
 const coverage=nodes.get('peptide-coverage');coverage.clientWidth=800;
 run('peptideView.results=result;peptideRender(result);peptideView.filters.charge="1";peptideInitCoverageResize()');
 assert.equal(observed,coverage);
 const table=nodes.get('peptide-results').children[1];const original=coverage.children[0];
 callback([{target:coverage,contentRect:{width:810}}]);assert.equal(coverage.children[0],original);
 callback([{target:coverage,contentRect:{width:1280}}]);assert.notEqual(coverage.children[0],original);
 assert.equal(run('peptideView.coverageColumns'),80);
 assert.equal(run('peptideView.filters.charge'),'1');assert.equal(nodes.get('peptide-results').children[1],table);
 const resized=coverage.children[0];callback([{target:coverage,contentRect:{width:0}}]);assert.equal(coverage.children[0],resized);
 run('peptideClearResults()');callback([{target:coverage,contentRect:{width:480}}]);assert.equal(coverage.children.length,0);
});

test('peptide table allocates one panel width, wraps long values and preserves all columns and exact numbers',()=>{
 const {run,ctx,nodes}=domFixture();ctx.result={matches:[{...candidate,sequence:'K'.repeat(70),modifications:[{residue:45,delta:114.04292747}]}]};
 run('peptideRenderTable(result)');
 const all=descendants(nodes.get('peptide-results'));
 const table=all.find(n=>n.tag==='table');assert.ok(table.classList.contains('peptide-results-table'));
 const columns=all.filter(n=>n.tag==='col');assert.equal(columns.length,12);
 assert.equal(columns.reduce((sum,n)=>sum+parseFloat(n.style.width),0),100);
 assert.equal(all.filter(n=>n.tag==='th').length,12);assert.equal(all.filter(n=>n.tag==='td').length,12);
 assert.deepEqual(columns.map(n=>n.style.width),['18%','8%','7%','10%','5%','5%','10%','10%','6%','5%','7%','9%']);
 assert.ok(all.some(n=>n.textContent==='K'.repeat(70)+' [45:+114.04292747]'));
 assert.ok(all.some(n=>n.textContent==='955.46760'&&n.title==='Measured precursor m/z: 955.4676'));
 assert.ok(all.some(n=>n.textContent==='z* ↕'&&n.attributes['aria-label']==='Sort by Charge*'));
 const css=fs.readFileSync(path.join(__dirname,'../css/style.css'),'utf8');
 assert.match(css,/table\.data-table\.peptide-results-table\s*\{[^}]*width: 100%;[^}]*table-layout: fixed/);
 assert.match(css,/table\.data-table\.peptide-results-table th, table\.data-table\.peptide-results-table td\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere/);
 assert.match(css,/\.peptide-results-table \.peptide-sort-button\s*\{[^}]*white-space: normal/);
 assert.match(css,/\.peptide-results-table \.btn\s*\{[^}]*white-space: normal/);
});

test('mapping shows a loading overlay, prevents duplicate searches, and restores controls on error',async()=>{
 const {run,ctx,nodes}=domFixture();let resolve,calls=0,shown=[],hidden=0;
 ctx.showLoading=text=>shown.push(text);ctx.hideLoading=()=>hidden++;
 ctx.api.analyzePeptides=()=>{calls++;return new Promise(r=>{resolve=r;});};
 run("peptideView.modifications=[{chain:'A',kind:'gg',search_all:true}]");
 const pending=run('peptideAnalyze()');await run('peptideAnalyze()');
 assert.equal(calls,1);assert.match(shown[0],/Searching eligible modification sites/);
 assert.equal(nodes.get('btn-peptide-analyze').disabled,true);
 resolve({matches:[],coverage:[],settings:{searched_modification_sites:15},excluded_modified_peptides:0,warning:''});await pending;
 assert.equal(hidden,1);assert.equal(nodes.get('btn-peptide-analyze').disabled,false);
 assert.equal(nodes.get('peptide-status').textContent,'0 MS/MS matches · 0 MS-only candidates');
 assert.match(nodes.get('peptide-analysis-warning').textContent,/15 modification sites searched/);
 assert.equal(nodes.get('peptide-analysis-details').hidden,false);
 assert.equal(nodes.get('peptide-analysis-details').open,false);
 ctx.api.analyzePeptides=async()=>{throw Error('Invalid composition');};await run('peptideAnalyze()');
 assert.equal(hidden,2);assert.equal(nodes.get('btn-peptide-analyze').attributes['aria-busy'],'false');
 assert.equal(nodes.get('peptide-status').textContent,'Invalid composition');
});

test('whole-reference checkbox hides the unused written position and explains how to start',()=>{
 const {run,nodes}=domFixture();run("peptideView.modifications=[{chain:'A',kind:'gg',position:48,delta:114.04292747}];peptideRenderLinkages()");
 let row=nodes.get('peptide-linkages').children[0];
 const checkbox=row.children.find(n=>n.textContent==='Find site across reference ').children[0];
 checkbox.checked=true;checkbox.onchange();row=nodes.get('peptide-linkages').children[0];
 const position=row.children.find(n=>n.textContent==='Residue position ');
 assert.equal(position.hidden,true);assert.equal(position.children[0].disabled,true);
 assert.equal(run('peptideView.modifications[0].search_all'),true);
 assert.match(nodes.get('peptide-status').textContent,/Click Map/);
});

test('custom modification accepts composition, displays calculated mass and rejects stale previews',async()=>{
 const {run,ctx,nodes}=domFixture();let resolve;
 ctx.api.peptideModificationMass=()=>new Promise(r=>{resolve=r;});
 run("peptideView.modifications=[{chain:'A',kind:'custom',position:1,delta:null}];peptideRenderLinkages()");
 const row=nodes.get('peptide-linkages').children[0];
 const formulaLabel=row.children.find(n=>n.textContent==='Chemical formula ');
 const massLabel=row.children.find(n=>n.textContent==='Calculated shift (Da) ');
 assert.equal(row.children.indexOf(formulaLabel)+1,row.children.indexOf(massLabel));
 const formula=formulaLabel.children[0];
 const mass=massLabel.children[0];
 assert.equal(mass.disabled,true);formula.value='C2H2O';const pending=formula.oninput();
 run("peptideView.modifications[0].formula='H-2'");resolve({delta:42.01056468403});await pending;
 assert.equal(mass.value,'');ctx.api.peptideModificationMass=async()=>({delta:-2.01565006446});
 formula.value='H-2';await formula.oninput();assert.equal(mass.value,-2.01565006);
 assert.equal(run('peptideView.modifications[0].formula'),'H-2');
});

test('custom chemical formula stays immediately left of calculated shift in fixed and whole-reference modes',()=>{
 for(const searchAll of [false,true]){
  const {run,nodes}=domFixture();
  run(`peptideView.modifications=[{chain:'A',kind:'custom',position:48,formula:'C2H2O',delta:42.01056468403,search_all:${searchAll}}];peptideRenderLinkages()`);
  const row=nodes.get('peptide-linkages').children[0];
  const labels=row.children.map(n=>n.textContent);
  const formulaIndex=labels.indexOf('Chemical formula ');
  assert.ok(formulaIndex>=0);
  assert.equal(labels[formulaIndex-1],'Type ');
  assert.equal(labels[formulaIndex+1],'Calculated shift (Da) ');
  assert.equal(row.children[formulaIndex].children[0].value,'C2H2O');
  assert.equal(row.children[formulaIndex+1].children[0].disabled,true);
 }
});

test('GGisoK linkage view identifies acceptor sites without claiming donor-chain identity',()=>{
 const {run,ctx,nodes}=domFixture();ctx.row={...candidate,sequence:'AAAAAK',modifications:[{residue:6,delta:114.04292747,kind:'gg'}],
  locations:[{chain:'A',start:43,end:48},{chain:'B',start:43,end:48}]};
 run("peptideRenderLinkageEvidence(document.getElementById('peptide-ion-sequence'),row)");
 const text=descendants(nodes.get('peptide-ion-sequence')).map(n=>n.textContent||'').join(' ');
 assert.match(text,/A:K48 or B:K48/);assert.match(text,/Nε of Lys 6/);assert.match(text,/does not identify the donor chain/);
 assert.match(text,/not inserted into the backbone/);
});

test('both peptide PDF downloads use Deconvolution style and original analysis or selected scan',async()=>{
 const {run,ctx,nodes}=domFixture();let payload,saved;
 ctx.buildCurrentDeconvStyle=()=>({fig_width:6,line_width:.8,show_grid:false});
 ctx.backendResponseToBlob=async r=>r;ctx.downloadBlob=(blob,name)=>{saved=name;};ctx.sanitizeFilename=name=>name;ctx.toast=()=>{};
 ctx.api.exportPeptidePdf=async p=>{payload=p;return 'pdf';};
 ctx.result={matches:[candidate],coverage:[{id:'A',name:'Reference',sequence:'PEPTIDER',positions:[],percent:0}]};ctx.row=candidate;
 run("peptideView.results=result;peptideView.path='/local/sample.sirslt';peptideRender(result)");
 await run("peptideExportPdf('map')");assert.equal(payload.style.fig_width,6);assert.equal(payload.chains[0].spans.length,1);assert.match(saved,/_peptide_map.pdf$/);
 ctx.result.matches=[{...candidate,modifications:[{residue:3,delta:42}],site_ambiguous:true}];
 await run("peptideExportPdf('map')");assert.deepEqual(JSON.parse(JSON.stringify(payload.chains[0].modification_sites)),[{position:3,ambiguous:true}]);
 run("peptideView.selectedMatch=row;peptideView.selectedSpectrum={scan_id:9,mz:[324.15539],intensities:[100]};document.getElementById('btn-peptide-spectrum-pdf').disabled=false");
 await run("peptideExportPdf('spectrum')");assert.equal(payload.spectrum.mz[0],324.15539);assert.equal(payload.row,candidate);assert.match(saved,/_peptide_scan_9.pdf$/);
 run('peptideClearResults()');assert.equal(nodes.get('btn-peptide-map-pdf').disabled,true);assert.equal(nodes.get('btn-peptide-spectrum-pdf').disabled,true);
});

test('MS-only thresholds are adjustable, sent to matching, and cleared edits invalidate coverage',async()=>{
 const {run,ctx,nodes}=domFixture();let payload;
 ctx.api.analyzePeptides=async p=>{payload=p;return {matches:[],coverage:[],excluded_modified_peptides:0,warning:''};};
 run('initPeptideMapping()');
 const relative=nodes.get('peptide-ms1-relative'),intensity=nodes.get('peptide-ms1-intensity');
 relative.value='7.5';intensity.value='250';await run('peptideAnalyze()');
 assert.equal(payload.ms1_min_relative_percent,7.5);assert.equal(payload.ms1_min_intensity,250);
 relative.value='0';intensity.value='0';await run('peptideAnalyze()');
 assert.equal(payload.ms1_min_relative_percent,0);assert.equal(payload.ms1_min_intensity,0);
 relative.listeners.input();assert.equal(run('peptideView.results'),null);
 await run('peptideAnalyze()');intensity.listeners.input();assert.equal(run('peptideView.results'),null);
 intensity.value='';payload=null;await run('peptideAnalyze()');
 assert.equal(payload,null);assert.match(nodes.get('peptide-status').textContent,/Enter both MS-only thresholds/);
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 assert.match(html,/id="peptide-ms1-relative"[^>]*value="0"/);
 assert.match(html,/id="peptide-ms1-intensity"[^>]*value="0"/);
});

test('sample preparation is sent to calculations and edits invalidate results',async()=>{
 const {run,ctx,nodes}=domFixture();let payload;
 ctx.api.analyzePeptides=async p=>{payload=p;return {matches:[],coverage:[],excluded_modified_peptides:0,warning:'Details only'};};
 run('initPeptideMapping()');nodes.get('peptide-reduction').value='unreduced';nodes.get('peptide-iam').checked=true;nodes.get('peptide-disulfides').value='A:3-A:18';
 nodes.get('peptide-reduction').listeners.input();assert.equal(nodes.get('peptide-disulfides-label').hidden,false);
 await run('peptideAnalyze()');
 assert.deepEqual(JSON.parse(JSON.stringify(payload.preparation)),{reduced:false,iam:true,disulfides:'A:3-A:18'});
 assert.doesNotMatch(nodes.get('peptide-status').textContent,/Details only/);
 nodes.get('peptide-iam').listeners.input();assert.equal(run('peptideView.results'),null);
 assert.equal(nodes.get('peptide-analysis-details').hidden,true);
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 assert.doesNotMatch(html,/Choose a chain and residue, then the remnant/);
 assert.doesNotMatch(html,/“Find site across reference” tests eligible positions/);
});

test('reference refresh preserves reduction, IAM and disulfide choices',async()=>{
 const {run,ctx,nodes}=domFixture();let saved;
 ctx.sessionStorage={setItem(key,value){saved=value;},getItem(){return saved;},removeItem(){}};
 ctx.window={location:{reload(){}}};ctx.api.setReferenceMasses=async()=>{};
 run("document.getElementById('reference-masses-sample').value='sample';document.getElementById('reference-masses-mode').value='off';document.getElementById('reference-masses-ppm').value='20';document.getElementById('peptide-reduction').value='unreduced';document.getElementById('peptide-iam').checked=true;document.getElementById('peptide-disulfides').value='A:3-A:18'");
 await run('referenceApply()');nodes.get('peptide-reduction').value='reduced';nodes.get('peptide-iam').checked=false;nodes.get('peptide-disulfides').value='';run('initReferenceMasses()');
 assert.equal(nodes.get('peptide-reduction').value,'unreduced');assert.equal(nodes.get('peptide-iam').checked,true);assert.equal(nodes.get('peptide-disulfides').value,'A:3-A:18');
 assert.equal(nodes.get('peptide-disulfides-label').hidden,false);
});

test('reference refresh restores chemistry of a saved sample after the list initially selects another',()=>{
 const {run,ctx,nodes}=domFixture();
 run("peptideSelectPreparation('second');document.getElementById('peptide-variable-oxidation').checked=true;peptideSelectPreparation('first')");
 run("for(const path of ['first','second']){const option=document.createElement('option');option.value=path;document.getElementById('peptide-sample-select').appendChild(option);}referenceView.peptidePath='second'");
 const select=nodes.get('peptide-sample-select');
 ctx.files=[{path:'first',name:'First'},{path:'second',name:'Second'}];ctx.metadata={first:{qtof:{}},second:{qtof:{}}};
 run('referenceSyncSamples(files,metadata)');
 assert.equal(select.value,'second');assert.equal(nodes.get('peptide-variable-oxidation').checked,true);
 assert.equal(run('peptidePreparationPath'),'second');
});

test('MS-only selected spectrum discloses actual passing intensity and relative strength',async()=>{
 const {run,ctx,nodes}=domFixture();ctx.row={...candidate,evidence:'ms1',ms1_supported:true,fragments:[],isotope_count:3,isotope_fit:.98,observation_count:3,time_start:1,time_end:2,precursor_intensity:250,precursor_relative_intensity_pct:7.5};
 ctx.api.getQtofSpectrum=async()=>({mz:[955.4676],intensities:[250]});
 await run('peptideShowMatch(row)');
 assert.match(nodes.get('peptide-spectrum-status').textContent,/250.00 counts \(7.50% of scan maximum\)/);
 assert.match(nodes.get('peptide-spectrum-status').textContent,/3 consecutive surveys/);
 assert.match(nodes.get('peptide-spectrum-status').textContent,/envelope fit 98.0%/);
});

test('applying reference filtering preserves MS-only threshold choices across its refresh',async()=>{
 const {run,ctx,nodes}=domFixture();let saved,reloaded=false;
 ctx.sessionStorage={setItem(key,value){saved=value;},getItem(){return saved;},removeItem(){}};
 ctx.window={location:{reload(){reloaded=true;}}};ctx.api.setReferenceMasses=async()=>{};
 run("document.getElementById('reference-masses-sample').value='sample';document.getElementById('reference-masses-mode').value='off';document.getElementById('reference-masses-ppm').value='20';document.getElementById('peptide-ms1-relative').value='8';document.getElementById('peptide-ms1-intensity').value='1500'");
 await run('referenceApply()');assert.equal(reloaded,true);
 run("document.getElementById('peptide-ms1-relative').value='5';document.getElementById('peptide-ms1-intensity').value='0';initReferenceMasses()");
 assert.equal(nodes.get('peptide-ms1-relative').value,'8');assert.equal(nodes.get('peptide-ms1-intensity').value,'1500');
});

test('both blue and green coverage clicks reserve room for the full horizontal m/z title',async()=>{
 const {run,ctx}=domFixture();const renders=[];
 ctx.WEBAPP_LAYOUT.margin={l:60,r:20,t:40,b:50};
 ctx.WEBAPP_LAYOUT.xaxis={automargin:true,color:'#000000'};
 const original=JSON.stringify(ctx.WEBAPP_LAYOUT);
 ctx.Plotly.react=async(id,data,layout)=>renders.push({id,data,layout});
 ctx.api.getQtofSpectrum=async()=>({scan_id:9,mz:[324.15539,955.4676],intensities:[100,250]});
 ctx.chain={id:'A',name:'Reference',sequence:'PEPTIDER',positions:[],percent:0};
 ctx.result={matches:[candidate,{...candidate,evidence:'ms1',fragments:[],precursor_intensity:250,observation_count:1,time_start:1,time_end:1}]};
 const section=run('peptideRenderCoverageChain(result,chain)');
 const lines=descendants(section).filter(n=>n.classList.contains('peptide-coverage-underline'));
 assert.equal(lines.length,2);
 for(const line of lines)await line.listeners.click();
 assert.equal(renders.length,2);
 for(const {id,data,layout} of renders){
   assert.equal(id,'peptide-spectrum-plot');assert.equal(layout.height,430);
   assert.equal(layout.margin.b,72);assert.equal(layout.margin.l,60);
   assert.equal(layout.xaxis.title.text,'Mass-to-charge (m/z)');
   assert.equal(layout.xaxis.title.standoff,10);assert.equal(layout.xaxis.automargin,true);
   assert.deepEqual(Array.from(data[0].x),[324.15539,324.15539,null,955.4676,955.4676,null]);
   assert.deepEqual(Array.from(data[0].y),[0,100,null,0,250,null]);
 }
 assert.equal(JSON.stringify(ctx.WEBAPP_LAYOUT),original);
});

test('peptide canvas height excludes outer-card padding and borders',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 assert.match(html,/<div class="plot-container peptide-spectrum-card">\s*<div id="peptide-spectrum-plot" class="peptide-spectrum-canvas" data-fixed-plot-height="430"><\/div>\s*<\/div>/);
 const css=fs.readFileSync(path.join(__dirname,'../css/style.css'),'utf8');
 assert.match(css,/\.peptide-spectrum-canvas\s*\{[^}]*width: 100%;[^}]*height: 430px;[^}]*padding: 0;[^}]*border: 0;/);
 assert.doesNotMatch(html,/id="peptide-spectrum-plot"[^>]*class="plot-container"/);
});
