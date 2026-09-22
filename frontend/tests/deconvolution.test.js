const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

test('peptide QTOF panel gap and intact control padding are compact without changing controls', () => {
  const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(css, /\.reference-masses-panel\s*\{[^}]*margin:\s*0 0 8px;/);
  assert.doesNotMatch(css, /#reference-masses-panel[^{}]*~\s*\.tab-panel/);
  assert.match(css, /\.tab-panel\s*\{[^}]*padding:\s*10px;/);
  assert.match(css, /\.deconv-controls\s*\{[^}]*padding:\s*10px 16px;/);
  assert.match(css, /\.deconv-controls\s*>\s*\.toggle-expert\s*\{\s*margin-bottom:\s*0;/);
  assert.doesNotMatch(html, /In Deconvolute mode, drag over UV or TIC/);
  for (const id of ['deconv-sample-select', 'deconv-background-select', 'btn-auto-detect-window',
    'btn-run-deconv', 'btn-deconv-mode-deconvolute', 'btn-deconv-mode-zoom', 'btn-refresh-deconv',
    'deconv-intact-method', 'deconv-start', 'deconv-end', 'expert-mode-toggle']) {
    assert.ok(html.includes(`id="${id}"`), `${id} remains available`);
  }
});

test('every tab shares the smaller equal outer inset without per-tab padding overrides', () => {
  const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const panels = [...html.matchAll(/<div\b[^>]*class="tab-panel(?:\s[^\"]*)?"[^>]*>/g)];
  assert.equal(panels.length, 14);
  for (const [panel] of panels) assert.doesNotMatch(panel, /style="[^"]*padding/);
  assert.equal([...css.matchAll(/\.tab-panel\s*\{/g)].length, 1);
  assert.match(css, /\.tab-panel\s*\{[^}]*overflow-y:\s*auto;[^}]*padding:\s*10px;/);
  assert.doesNotMatch(css, /#tab-[\w-]+\s*\{[^}]*padding(?:-top|-left|-right)?:/);
});

function fixture() {
  const elements = new Map();
  const plots = new Map();
  const context = vm.createContext({
    console, setTimeout, clearTimeout,
    localStorage: { getItem() { return null; } },
    document: { addEventListener() {}, getElementById(id) { return elements.get(id) || null; } },
    window: {},
    Plotly: { newPlot(id, data, layout) { plots.set(id, { data, layout }); return { then() {} }; } },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/charts.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/app.js'), 'utf8'), context);
  return { context, elements, plots, run: (code) => vm.runInContext(code, context) };
}

test('Single Sample halves vertical card gaps without changing other tabs or control padding',()=>{
  const css=fs.readFileSync(path.join(root,'css/style.css'),'utf8');
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert.match(css,/#tab-single > \.tab-toolbar,[\s\S]*?#tab-single \.plot-container\s*\{ margin-bottom: 8px; \}/);
  assert.match(css,/#tab-single > \.mz-toolbar\s*\{ margin-bottom: 6px; \}/);
  assert.match(css,/#tab-single > \.metrics-bar\s*\{ row-gap: 6px; \}/);
  assert.match(css,/#tab-single \.plot-stack\s*\{ row-gap: 6px; \}/);
  assert.match(css,/#single-results\s*\{ row-gap: 8px; \}/);
  assert.match(css,/\.tab-toolbar\s*\{[^}]*margin-bottom: 16px;[^}]*padding: 12px 16px;/);
  assert.match(css,/\.mz-toolbar\s*\{[^}]*margin-bottom: 12px;[^}]*padding: 8px 16px;/);
  assert.doesNotMatch(html,/Enter SMILES or draw a molecule, then compute and add target m\/z automatically/);
  assert.match(html,/<div id="single-smiles-result" class="toolbar-note"><\/div>/);
  assert.match(css,/#single-smiles-result:empty\s*\{ display: none; \}/);
  for(const id of ['btn-single-smiles-to-target','btn-single-toggle-sketcher','btn-single-use-drawn'])assert.ok(html.includes(`id="${id}"`));
  const {run,elements}=fixture();
  const result={style:{}};elements.set('single-smiles-result',result);
  run('setSingleSmilesResult("Calculated m/z: 123.456", "success")');
  assert.equal(result.textContent,'Calculated m/z: 123.456');
  assert.equal(result.style.color,'var(--success)');
});

function denseFixture(shift = 0) {
  const masses = [18791.2, 18845.1, 18898.9, 18952.8].map(m => m + shift);
  const heights = [100, 23, 10, 5.7];
  const massKDa = [], relativeIntensity = [];
  for (let i = 0; i < 7000; i++) {
    const mass = 18450 + shift + i * 0.1;
    massKDa.push(mass / 1000);
    relativeIntensity.push(masses.reduce((sum, peak, j) => sum + heights[j] * Math.exp(-0.5 * ((mass - peak) / 2) ** 2), 0));
  }
  return { massKDa, relativeIntensity };
}

test('dense focus uses the selected component and observed charges, not hard-coded masses', () => {
  const { run, context } = fixture();
  context.component = { mass: 18791.26, charge_states: [8, 17, 18, 25] };
  const range = run('getDenseProfileFocusRange(component)');
  assert.ok(range[0] > 18000 && range[0] < 18791);
  assert.ok(range[1] > 19400 && range[1] < 18791.26 * 26 / 25);
  assert.ok(range[0] < 18100 && range[0] > 18791.26 * 24 / 25);
  context.component = { mass: 59000, ion_charges: [35, 45, 50] };
  assert.deepEqual(Array.from(run('getDenseProfileFocusRange(component)')), [57879, 60121]);
  assert.deepEqual(Array.from(run('getDenseProfileFocusRange(null,[500,80000])')), [500,80000]);
  assert.ok(run('getDenseProfileFocusRange({mass:10000,charge_states:[0,NaN,-3]})[0]') > 0);
});

test('focus stops before measured ion-ladder aliases on each side, including asymmetric centres', () => {
  const {run,context}=fixture();
  context.component={mass:20000,mass_std:.4,charge_states:[10,20],ion_charges:[10,20],ion_mzs:[2001.00784,1001.50784]};
  const range=Array.from(run('getDenseProfileFocusRange(component)'));
  const left=1000.5*19,right=1000.5*21;
  assert.ok(range[0]>left&&range[0]<left+60);
  assert.ok(range[1]<right&&range[1]>right-60);
  assert.ok(range[0]<20000&&range[1]>20000);
  context.component.mass_std=10000;
  const uncertain=Array.from(run('getDenseProfileFocusRange(component)'));
  assert.ok(uncertain[0]<20000&&uncertain[1]>20000);
});

test('dense style keeps full calculation limits and only changes the view', () => {
  const { run, context } = fixture();
  context.components = [{mass:18791.26,intensity:100,charge_states:[17,18,25]}];
  run('state.deconvResults={workflow:{id:"qtof-envelope"},components}; state.deconvDisplayComponents=components');
  const focus = run('applyDenseDeconvProfileStyle({deconv_x_min_da:1000,deconv_x_max_da:50000})');
  assert.equal(focus.deconv_x_min_da,1000);assert.equal(focus.deconv_x_max_da,50000);
  assert.equal(focus.deconv_profile_smooth_sigma_da,1);assert.equal(focus.deconv_profile_bin_da,.1);
  assert.ok(focus.deconv_profile_view_max_da>18953);
  run('state.deconvDenseViewMode="full"');
  const full=run('applyDenseDeconvProfileStyle({deconv_x_min_da:1000,deconv_x_max_da:50000})');
  assert.equal(full.deconv_profile_view_min_da,undefined);
  assert.equal(full.deconv_x_min_da,focus.deconv_x_min_da);assert.equal(full.deconv_x_max_da,focus.deconv_x_max_da);
  run('state.deconvDenseViewMode="focus"');
  const exported=run('applyDenseDeconvProfileStyle({deconv_x_min_da:1000,deconv_x_max_da:50000},{includeView:false})');
  assert.equal(exported.deconv_profile_view_min_da,undefined);assert.equal(exported.deconv_profile_view_max_da,undefined);
  assert.equal(exported.deconv_x_min_da,1000);assert.equal(exported.deconv_x_max_da,50000);
  assert.equal(exported.deconv_profile_smooth_sigma_da,1);
});

test('only metadata-confirmed QTOF results use 1 Da profile smoothing', () => {
  const {run}=fixture();
  for(const result of [{}, {spectrum_source:'sample'}, {path:'qtof.sirslt',spectrum:{mz_grid_step:.001}}]) {
    run(`state.deconvResults=${JSON.stringify(result)}`);
    assert.equal(run('applyDenseDeconvProfileStyle().deconv_profile_smooth_sigma_da'),2);
  }
  run('state.deconvResults={workflow:null,spectrum_source:"qtof_centroid_grid"}');
  assert.equal(run('applyDenseDeconvProfileStyle().deconv_profile_smooth_sigma_da'),1);
});

test('dense view controls sit below the graph with the export button, without the removed comment', () => {
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const start=html.indexOf('class="two-col deconv-dense-row"');
  const card=html.slice(start,html.indexOf('class="deconv-plot-card deconv-ion-card"',start));
  assert.ok(card.indexOf('id="deconv-dense-mass-preview"')<card.indexOf('id="dense-profile-view-controls"'));
  assert.match(card,/deconv-dense-actions[\s\S]*dense-profile-view-controls[\s\S]*data-format="pdf-dense"/);
  assert.doesNotMatch(html+fs.readFileSync(path.join(root,'js/app.js'),'utf8'),/Smoothed charge projection: 0.1 Da bins/);
  const css=fs.readFileSync(path.join(root,'css/style.css'),'utf8');
  assert.match(css,/\.deconv-dense-actions\s*\{[^}]*flex: 0 0 auto;[^}]*margin-top: 10px/);
});

test('selecting another coloured-result component focuses that mass and full range is reversible', () => {
  const {run,context}=fixture();context.renders=0;
  run('renderDeconvDenseMassPreview=()=>{renders++};state.deconvDenseViewMode="full";selectDeconvComponent(2)');
  assert.equal(run('state.deconvSelectedComponentIndex'),2);assert.equal(run('state.deconvDenseViewMode'),'focus');
  run('setDenseProfileView("full")');assert.equal(run('state.deconvDenseViewMode'),'full');
  run('setDenseProfileView("focus")');assert.equal(run('state.deconvDenseViewMode'),'focus');assert.equal(context.renders,3);
});

test('clicking a coloured mass bar selects its component once, including after redraw', () => {
  const {run,context,elements}=fixture();const handlers=new Map(),selected=[];
  context.selected=selected;
  elements.set('mass',{on:(event,fn)=>handlers.set(event,fn),removeListener:(event,fn)=>{if(handlers.get(event)===fn)handlers.delete(event)}});
  context.Plotly.newPlot=()=>({then:fn=>fn()});
  const code='charts.plotDeconvMasses("mass",[{mass:10000,intensity:100},{mass:12000,intensity:30}],{onSelect:index=>selected.push(index)})';
  run(code);run(code);assert.equal(handlers.size,1);
  handlers.get('plotly_click')({points:[{curveNumber:1}]});
  handlers.get('plotly_click')({points:[{curveNumber:5}]});
  assert.deepEqual(selected,[1]);
});

test('dense profile labels include main and nearby satellites in Da without changing the profile', () => {
  const {run,context}=fixture();context.profile=denseFixture();
  const before=JSON.stringify(context.profile);
  const labels=run('buildDenseProfileAnnotations(profile,[18450,19150],{mainMass:18791.26,width:550,height:234})');
  assert.deepEqual(Array.from(labels,l=>l.text),['<b>18,791.2 Da</b>','18,845.1 Da','18,898.9 Da','18,952.8 Da']);
  assert.equal(JSON.stringify(context.profile),before);
  assert.ok(labels.every(l=>!l.text.includes('kDa')));
  context.profile=denseFixture(1000);
  const shifted=run('buildDenseProfileAnnotations(profile,[19450,20150],{mainMass:19791.26})');
  assert.match(shifted[0].text,/19,791.2 Da/);
});

test('dense labels remain within the view and do not collide in a narrow panel', () => {
  const {run,context}=fixture();context.profile=denseFixture();
  const width=300,height=234,yMax=130;
  const labels=run(`buildDenseProfileAnnotations(profile,[18450,19150],{mainMass:18791.26,width:${width},height:${height}})`);
  assert.equal(labels.length,4);
  const boxes=Array.from(labels,l=>{
    const text=l.text.replace(/<[^>]+>/g,''),w=text.length*5.6+8;
    const x=(l.x*1000-18450)/700*width+l.ax,y=(yMax-l.y)/yMax*height+l.ay;
    return {x0:x-w/2,x1:x+w/2,y0:y-7,y1:y+7};
  });
  for(let i=0;i<boxes.length;i++){
    const a=boxes[i];assert.ok(a.x0>=-1e-6&&a.x1<=width+1e-6&&a.y0>=0&&a.y1<=height);
    for(const b of boxes.slice(i+1))assert.ok(a.x1<=b.x0||b.x1<=a.x0||a.y1<=b.y0||b.y1<=a.y0);
  }
});

test('small profile ripples are not all labelled; empty/flat profiles are safe', () => {
  const {run,context}=fixture();context.profile=denseFixture();
  context.profile.relativeIntensity=context.profile.relativeIntensity.map((v,i)=>v+0.2*(1+Math.sin(i)));
  assert.equal(run('buildDenseProfileAnnotations(profile,[18450,19150]).length'),4);
  assert.equal(run('buildDenseProfileAnnotations({massKDa:[],relativeIntensity:[]},[0,1]).length'),0);
  assert.equal(run('buildDenseProfileAnnotations({massKDa:[1,2,3],relativeIntensity:[4,4,4]},[1000,3000]).length'),0);
});

test('Da label boxes do not hide neighbouring peak curves in the wider alias-bounded view', () => {
  const {run,context}=fixture();context.profile=denseFixture();
  const labels=run('buildDenseProfileAnnotations(profile,[18078,19506],{mainMass:18791.26,width:692,height:234})');
  assert.equal(labels.length,4);
  for (const label of labels) {
    const text=label.text.replace(/<[^>]+>/g,''),w=text.length*5.6+8;
    const cx=(label.x*1000-18078)/1428*692+label.ax,cy=(130-label.y)/130*234+label.ay;
    for (let i=0;i<context.profile.massKDa.length;i++) {
      const px=(context.profile.massKDa[i]*1000-18078)/1428*692;
      const py=(130-context.profile.relativeIntensity[i])/130*234;
      assert.ok(!(px>=cx-w/2&&px<=cx+w/2&&py>=cy-7&&py<=cy+7),'label must not cover curve');
    }
  }
});

test('dense peak leaders avoid other label boxes and do not cross one another', () => {
  const {run,context}=fixture();context.profile=denseFixture();
  for (const width of [300,692]) {
    const labels=run(`buildDenseProfileAnnotations(profile,[18078,19506],{mainMass:18791.26,width:${width},height:234})`);
    assert.equal(labels.length,4);
    const placed=Array.from(labels,label=>{
      const text=label.text.replace(/<[^>]+>/g,''),w=text.length*5.6+8;
      const x=(label.x*1000-18078)/1428*width,y=(130-label.y)/130*234,cx=x+label.ax,cy=y+label.ay;
      return {x,y,cx,cy,left:cx-w/2,right:cx+w/2,top:cy-7,bottom:cy+7};
    });
    const side=(a,b,x,y)=>(b.cx-a.x)*(y-a.y)-(b.cy-a.y)*(x-a.x);
    for(let i=0;i<placed.length;i++)for(let j=0;j<placed.length;j++){
      if(i===j)continue;
      const a=placed[i],b=placed[j];
      for(let k=1;k<200;k++){
        const x=a.x+(a.cx-a.x)*k/200,y=a.y+(a.cy-a.y)*k/200;
        assert.ok(!(x>b.left&&x<b.right&&y>b.top&&y<b.bottom),'arrow crosses another label');
      }
      assert.ok(!(side(a,a,b.x,b.y)*side(a,a,b.cx,b.cy)<0&&side(b,b,a.x,a.y)*side(b,b,a.cx,a.cy)<0),'arrows cross');
    }
  }
});

test('focused dense rendering preserves the complete trace, normalization and smoothing', () => {
  const {run,context,plots}=fixture();
  context.spectrum={mz:[1001,1051,1101],intensities:[100,25,10]};
  run('charts.plotDenseDeconvolutedMassProfile("full",spectrum,{style:{deconv_x_min_da:9000,deconv_x_max_da:12000,deconv_profile_min_charge:10,deconv_profile_max_charge:10}})');
  run('charts.plotDenseDeconvolutedMassProfile("focused",spectrum,{style:{deconv_x_min_da:9000,deconv_x_max_da:12000,deconv_profile_min_charge:10,deconv_profile_max_charge:10,deconv_profile_view_min_da:9900,deconv_profile_view_max_da:11200,deconv_profile_selected_mass:10000}})');
  const full=plots.get('full'),focus=plots.get('focused');
  assert.deepEqual(Array.from(focus.data[0].x),Array.from(full.data[0].x));
  assert.deepEqual(Array.from(focus.data[0].y),Array.from(full.data[0].y));
  assert.deepEqual(Array.from(focus.layout.xaxis.range),[9.9,11.2]);
  assert.match(focus.data[0].hovertemplate,/Da/);assert.doesNotMatch(focus.data[0].hovertemplate,/kDa/);
  assert.ok(focus.layout.annotations.length>=3);
});

test('dense label binding responds to zoom and resize without relayout loops or duplicate listeners', async()=>{
  const {run,context,elements}=fixture();context.profile=denseFixture();
  const listeners=new Map(),updates=[];
  const plot={layout:{xaxis:{range:[18.45,19.15]},yaxis:{range:[0,130]}},clientWidth:658,clientHeight:340,
    on:(name,fn)=>listeners.set(name,fn),removeListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name)}};
  elements.set('dense',plot);
  context.window.Plotly={relayout:(_plot,value)=>{updates.push(value);return Promise.resolve()}};
  run('bindDenseProfileLabels("dense",profile,[18450,19150],18791.26);bindDenseProfileLabels("dense",profile,[18450,19150],18791.26)');
  assert.equal(listeners.size,1);
  listeners.get('plotly_relayout')({'annotations':[]});assert.equal(updates.length,0);
  listeners.get('plotly_relayout')({'xaxis.range[0]':18.83,'xaxis.range[1]':18.97});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(updates.length,1);assert.ok(updates[0].annotations.every(a=>a.x>=18.83&&a.x<=18.97));
  assert.ok(updates[0]['yaxis.range'][1]<35);
  listeners.get('plotly_relayout')({width:400});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(updates.length,2);
});

test('intact metadata enables an explicit option but keeps the previous calculation as default',()=>{
 const {run,elements}=fixture();
 elements.set('deconv-isotope-workflow',{});elements.set('expert-params',{});
 elements.set('deconv-method-wrap',{});elements.set('deconv-intact-method',{dataset:{},value:'envelope'});
 const before=JSON.stringify(run("getCurrentDeconvolutionParameters('old.sirslt')"));
 run("state.loadedSamples['qtof.sirslt']={isotope_aware_intact:true};syncDeconvMwAlgorithmDefault('qtof.sirslt')");
 assert.equal(elements.get('deconv-method-wrap').hidden,false);
 assert.equal(elements.get('deconv-isotope-workflow').hidden,true);assert.equal(elements.get('expert-params').hidden,false);
 assert.equal(JSON.stringify(run("getCurrentDeconvolutionParameters('qtof.sirslt')")),before);
 elements.get('deconv-intact-method').value='isotope';run("syncDeconvMwAlgorithmDefault('qtof.sirslt')");
 const q=run("getCurrentDeconvolutionParameters('qtof.sirslt')");assert.equal(q.min_charge,2);assert.equal(q.fwhm,0);assert.equal(q.intact_method,'isotope');
 assert.equal(elements.get('expert-params').hidden,true);
 assert.equal(run("getCurrentDeconvolutionParameters('other.sirslt').intact_method"),'envelope');
 run("syncDeconvMwAlgorithmDefault('old.sirslt')");assert.equal(elements.get('expert-params').hidden,false);
 assert.equal(JSON.stringify(run("getCurrentDeconvolutionParameters('old.sirslt')")),before);
});

test('raw inspection does not replace the summed calculation spectrum or round measured values',()=>{
 const {run,elements,context}=fixture();
 context.data={workflow:{id:'qtof-envelope'},spectrum:{mz:[500.123],intensities:[30]},measured_spectrum:{mz:[500.123456789,500.123456799],intensities:[10,20]}};
 elements.set('deconv-spectrum-view',{value:'summed'});
 assert.equal(run('getDisplayedDeconvSpectrum(data)'),context.data.spectrum);
 elements.get('deconv-spectrum-view').value='measured';
 assert.equal(run('getDisplayedDeconvSpectrum(data)'),context.data.measured_spectrum);
 assert.equal(context.data.spectrum.mz[0],500.123);
 assert.equal(run('getDisplayedDeconvSpectrum(data).mz[1]'),500.123456799);
 context.data.workflow.id='qtof-isotope-aware';assert.equal(run('getDisplayedDeconvSpectrum(data)'),context.data.spectrum);
});

test('an older analysis response cannot overwrite a newly selected intact method',async()=>{
 const {run,elements,context}=fixture();
 for(const [id,value] of [['deconv-sample-select','sample'],['deconv-start','1'],['deconv-end','2']])elements.set(id,{value});
 elements.set('expert-mode-toggle',{checked:false});
 const pending=[];context.api={runDeconvolution:()=>new Promise(resolve=>pending.push(resolve))};
 context.rendered=[];
 run('buildActiveDeconvolutionRequest=()=>({start_time:1,end_time:2});setDeconvolutionBusy=()=>{};showLoading=()=>{};hideLoading=()=>{};toast=()=>{};renderReportSummary=()=>{};renderDeconvResults=data=>rendered.push(data.id)');
 const first=run('runDeconvolution()'), second=run('runDeconvolution()');
 pending[1]({id:'new',components:[]});await second;
 pending[0]({id:'old',components:[]});await first;
 assert.deepEqual(context.rendered,['new']);assert.equal(run('state.deconvResults.id'),'new');
});

test('isotope profile bypasses projection and preserves measured and derived decimals',()=>{
 const {run,context,plots}=fixture();context.spectrum={mz:[500.123456789],intensities:[100],isotope_profile:[{mass:3992.929442579032,mz:500.123456789,intensity:100,charge:8,scan_id:4}]};
 run('charts.plotDenseDeconvolutedMassProfile("isotopes",spectrum,{style:{deconv_x_min_da:3990,deconv_x_max_da:4000}})');
 const plot=plots.get('isotopes');assert.deepEqual(JSON.parse(JSON.stringify(plot.data[0].x)),[3992.929442579032,3992.929442579032,null]);
 assert.match(plot.data[0].text[0],/500.123456789/);assert.match(plot.layout.xaxis.title,/Neutral isotope mass/);
 run('charts.plotMassSpectrum("raw",spectrum.mz,spectrum.intensities,[],{centroidSticks:true})');
 assert.deepEqual(JSON.parse(JSON.stringify(plots.get('raw').data[0].x)),[500.123456789,500.123456789,null]);
 assert.equal(context.spectrum.mz.length,1);
});

test('mass spectrum labels retain all supplied decimals through zoom and full hover text, without changing data',()=>{
 const {run,context,plots}=fixture();context.mz=[900,955.467601234567,980,1001.12345678,1100];context.intensities=[0,100,0,80,0];
 for(const range of ['[900,1100]','[950,960]']){
  const labels=run(`buildAdaptiveMassSpectrumAnnotations(mz,intensities,[],${range},900)`);
  assert.equal(labels[0].text,'955.467601234567');assert.equal(labels[0].x,context.mz[1]);
 }
 run('charts.plotMassSpectrum("spectrum",mz,intensities,[])');
 const trace=plots.get('spectrum').data[0];assert.equal(trace.text[1],'955.467601234567');
 assert.match(trace.hovertemplate,/%\{text\}/);assert.equal(trace.x,context.mz);assert.equal(trace.y,context.intensities);
 assert.equal(run('formatSpectrumMz(955.4670000000001,0.001)'),'955.467');
 assert.equal(run('formatSpectrumMz(955.467601234567,0.001)'),'955.467601234567');
 assert.equal(run('formatSpectrumMz(955,0.001)'),'955.000');
 const labels=run('buildAdaptiveMassSpectrumAnnotations([955.466,955.4670000000001,955.468],[0,100,0],[],null,900,0.001)');
 assert.equal(labels[0].text,'955.467');
});

test('long m/z peak labels reserve their text width instead of colliding',()=>{
 const {run}=fixture();const labels=run('buildAdaptiveMassSpectrumAnnotations([900,955.123456789012,956,958.123456789012,970],[0,100,0,90,0],[],[950,970],400)');
 assert.equal(labels.length,1);assert.equal(labels[0].text,'955.123456789012');
});

test('guides retain component identity, deduplicate per mass, and exclude out-of-range ions', () => {
  const { run } = fixture();
  const guides = run(`computeMassSpectrumGuideMzs([100, 1000], [
    {mass: 1000, ion_mzs: [200, 200, 50, 1100, NaN]},
    {mass: 2000, ion_mzs: [200, 500]},
    {mass: 1800, charge_states: [2, 3, 0]}
  ])`);
  assert.deepEqual(JSON.parse(JSON.stringify(guides)), [
    { mz: 200, componentIndex: 0, mass: 1000 },
    { mz: 200, componentIndex: 1, mass: 2000 },
    { mz: 500, componentIndex: 1, mass: 2000 },
    { mz: 901.00784, componentIndex: 2, mass: 1800 },
    { mz: 601.00784, componentIndex: 2, mass: 1800 },
  ]);
  assert.equal(run('computeMassSpectrumGuideMzs([], []).length'), 0);
});

test('m/z dashed guides, mass stems, labels and ion selection share the same colours', () => {
  const { run, plots } = fixture();
  run(`
    const comps = [
      {mass: 10000, intensity: 100, ion_mzs: [200], ion_charges: [50]},
      {mass: 15000, intensity: 70, ion_mzs: [300], ion_charges: [50]},
      {mass: 20000, intensity: 50, ion_mzs: [400], ion_charges: [50]}
    ];
    const mz = [100,200,300,400,500];
    const intensities = [0,100,70,50,0];
    charts.plotMassSpectrum('spectrum', mz, intensities, [], { guideMzs: computeMassSpectrumGuideMzs(mz, comps) });
    charts.plotDeconvMasses('masses', comps);
    charts.plotIonSelectionInteractive('ions', mz, intensities, comps);
  `);
  const guides = plots.get('spectrum').layout.shapes;
  const masses = plots.get('masses');
  const ions = plots.get('ions').data.filter((trace) => trace.line?.width === 1.6);
  assert.equal(new Set(guides.map((guide) => guide.line.color)).size, 3);
  guides.forEach((guide, i) => {
    assert.equal(guide.line.dash, 'dash');
    assert.equal(guide.line.color, masses.data[i].line.color);
    assert.equal(guide.line.color, masses.layout.annotations[i].font.color);
    assert.equal(guide.line.color, ions[i].line.color);
  });
});

test('both second-row plots keep equal heights independently of wrapped download controls', () => {
  const { run, elements } = fixture();
  for (const id of ['deconv-spectrum-plot', 'deconv-mass-plot']) elements.set(id, { style: {}, dataset: {} });
  run('syncDeconvBottomLayout()');
  for (const element of elements.values()) {
    assert.equal(element.style.height, '400px');
    assert.equal(element.dataset.fixedPlotHeight, '400');
  }
});

test('QTOF charge highlights retain sparse raw peaks and use measured display coordinates',()=>{
  const {run,context,plots}=fixture();
  context.mz=Array.from({length:150000},(_,i)=>1000+i*.001);
  context.ints=context.mz.map(()=>0);context.ints[12347]=334400;
  context.comps=[{mass:10000,intensity:100,ion_mzs:[1012.3],ion_charges:[10],
    ion_display_peaks:[{mz:context.mz[12347],intensity:334400}]}];
  run('charts.plotIonSelectionInteractive("ions",mz,ints,comps,{mzGridStep:.001})');
  const plot=plots.get('ions');
  assert.equal(plot.data[0].x.length,150000);
  assert.equal(plot.data[0].y[12347],334400);
  const marker=plot.data.find(t=>t.line?.width===1.6);
  assert.deepEqual(Array.from(marker.x),[1012.347,1012.347]);
  assert.deepEqual(Array.from(marker.y),[0,334400]);
  assert.match(marker.hovertemplate,/Fitted envelope centre 1012.3/);
  assert.ok(plot.layout.yaxis.range[1]>334400);
  assert.equal(context.comps[0].ion_mzs[0],1012.3);
});

test('ProIQ and legacy charge plots retain every measured point without an instrument flag',()=>{
  const {run,context,plots}=fixture();
  context.mz=Array.from({length:18571},(_,i)=>100+i*.1);
  context.ints=context.mz.map(()=>0);context.ints[8405]=12967083;
  context.comps=[{mass:18790.92230142,intensity:100,ion_mzs:[940.551295],ion_charges:[20],
    ion_display_peaks:[{mz:context.mz[8405],intensity:12967083}]}];
  run('charts.plotIonSelectionInteractive("ions",mz,ints,comps)');
  const plot=plots.get('ions');
  assert.equal(plot.data[0].x.length,18571);
  assert.equal(plot.data[0].y[8405],12967083);
  const marker=plot.data.find(t=>t.line?.width===1.6);
  assert.deepEqual(Array.from(marker.x),[context.mz[8405],context.mz[8405]]);
  assert.deepEqual(Array.from(marker.y),[0,12967083]);
  assert.equal(context.comps[0].ion_charges[0],20);
  assert.equal(context.comps[0].mass,18790.92230142);
});

test('sidebar/window resize includes the peptide spectrum and preserves its canvas height',()=>{
  const {run,context,elements}=fixture();const sizes=[];
  context.setTimeout=callback=>callback();
  context.window.Plotly={relayout:(el,size)=>sizes.push(size),Plots:{resize(){}}};
  const plot={classList:{contains:()=>true},dataset:{fixedPlotHeight:'430'},clientWidth:900,clientHeight:430,style:{}};
  elements.set('peptide-spectrum-plot',plot);
  run('schedulePlotlyResize()');
  assert.equal(sizes.length,3);assert.ok(sizes.every(size=>size.width===900&&size.height===430));
  sizes.length=0;plot.clientWidth=480;run('schedulePlotlyResize()');
  assert.equal(sizes.length,3);assert.ok(sizes.every(size=>size.width===480&&size.height===430));
  assert.equal(plot.style.height,'430px');
});

test('existing download controls and all export formats are preserved', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const section = html.slice(html.indexOf('id="deconv-results"'), html.indexOf('<!-- Tab: Batch Deconvolution -->'));
  assert.equal((section.match(/id="btn-export-deconv-spectrum-pdf"/g) || []).length, 1);
  const formats = [...section.matchAll(/btn-export-deconv-masses" data-format="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(formats.sort(), ['pdf', 'pdf-dense', 'pdf-side-by-side', 'pdf-wide', 'png', 'svg']);
  assert.equal((section.match(/btn-export-ion-selection"/g) || []).length, 3);
});

test('mass-spectrum PDF payload remains clean, with no screen-only guides or colours', async () => {
  const { run, context, elements } = fixture();
  elements.set('export-dpi', { value: '300' });
  let payload, filename;
  context.api = { exportDeconvolutionSpectrum: async (value) => { payload = JSON.parse(JSON.stringify(value)); return {}; } };
  context.captureDownload = (_blob, name) => { filename = name; };
  run(`
    state.deconvSamplePath = '/samples/test.D';
    state.deconvResults = { spectrum: { mz: [100, 200], intensities: [10, 20] } };
    showLoading = hideLoading = toast = () => {};
    buildCurrentDeconvStyle = () => ({ fig_width: 8 });
    backendResponseToBlob = async () => 'blob';
    downloadBlob = captureDownload;
  `);
  await run('exportDeconvSpectrumPdf()');
  assert.deepEqual(payload, { sample_name: 'test.D', spectrum: { mz: [100, 200], intensities: [10, 20] }, title: 'Mass Spectrum', format: 'pdf', dpi: 300, style: { fig_width: 8 } });
  assert.equal(filename, 'test_mass_spectrum.pdf');
});

test('UV defaults select recorded QTOF 214 nm and preserve the legacy 194 nm default',()=>{
  const {run}=fixture();
  assert.deepEqual(JSON.parse(JSON.stringify(run('uvWavelengthChoices({qtof:{uv_wavelengths:[278,214]}},[])'))),
    [{value:214,checked:true},{value:278,checked:false}]);
  assert.equal(run('preferredUvWavelength({uv_wavelengths:[194,280]},[])'),194);
  assert.equal(run('preferredUvWavelength({uv_wavelengths:[278,214]},[194])'),214);
  assert.equal(run('preferredUvWavelength({uv_wavelengths:[214,278]},[194,278])'),278);
  assert.equal(run('preferredUvWavelength({uv_wavelengths:[214,278]},[280])'),278);
  assert.equal(run('preferredUvWavelength({uv_wavelengths:[]},[194])'),undefined);
});

test('refreshing UV choices preserves user selections, including deliberately unchecked channels',()=>{
  const {run}=fixture();
  assert.equal(run('uvWavelengthChoices({sample:{uv_wavelengths:[214,278]}},[{value:"214",checked:false},{value:"278",checked:true}])[1].checked'),true);
  assert.equal(run('uvWavelengthChoices({sample:{uv_wavelengths:[214,278]}},[{value:"214",checked:false},{value:"278",checked:false}]).some(option=>option.checked)'),false);
  const mixed=JSON.parse(JSON.stringify(run('uvWavelengthChoices({legacy:{uv_wavelengths:[194,280]},qtof:{uv_wavelengths:[214,278]}},[{value:"194",checked:true},{value:"280",checked:false}])')));
  assert.deepEqual(mixed.filter(option=>option.checked).map(option=>option.value),[194,214]);
});

test('UV area calculation chooses a recorded channel for the selected sample',()=>{
  const {run}=fixture();
  run('state.loadedSamples={qtof:{uv_wavelengths:[278,214]}};getSelectedWavelengths=()=>[194];');
  assert.equal(run('getAreaCalculationWavelength("qtof")'),214);
  assert.ok(Number.isNaN(run('getAreaCalculationWavelength("missing")')));
});

test('UV Time Change uses a shared recorded wavelength rather than another instruments default',async()=>{
  const {run}=fixture();
  run('state.selectedFiles=[{path:"a"},{path:"b"}];state.loadedSamples={a:{uv_wavelengths:[214,278]},b:{uv_wavelengths:[214,278]}};getSelectedWavelengths=()=>[194];');
  assert.equal(await run('resolveTimeChangeUvWavelength()'),214);
  run('state.loadedSamples.b.uv_wavelengths=[194,280]');
  assert.ok(Number.isNaN(await run('resolveTimeChangeUvWavelength()')));
});

test('Deconvolution requests QTOF UV instead of an unavailable wavelength from another instrument',async()=>{
  const {run,context,elements}=fixture();
  for(const [id,value] of [['deconv-start','0'],['deconv-end','5'],['uv-smoothing','0']])elements.set(id,{value});
  elements.set('deconv-uv-plot',{});elements.set('deconv-tic-plot',{});
  let requested;
  context.api={getUVChromatogram:async(path,wavelength)=>{requested=wavelength;return{times:[0,1],intensities:[1,2]};},getTIC:async()=>({times:[],intensities:[]})};
  run(`state.loadedSamples={qtof:{uv_wavelengths:[214,278]}};getSelectedWavelengths=()=>[194];
    getSelectedDeconvBackgroundPath=()=>'';setDeconvEmptyState=()=>{};
    charts.plotChromatogramWithWindow=()=>{};bindDeconvWindowDragSelection=()=>{};schedulePlotlyResize=()=>{};`);
  await run('refreshDeconvWindowContext("qtof")');
  assert.equal(requested,214);
});
