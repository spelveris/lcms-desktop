const peptideView = { generation: 0, references: [], results: null, path: '', modifications: [] };

function peptideRenderLinkages() {
  const container=document.getElementById('peptide-linkages');container.replaceChildren();
  peptideView.modifications.forEach((mod,index)=>{
    const row=document.createElement('div');row.className='tab-toolbar';
    function label(text,input){const node=document.createElement('label');node.textContent=text;node.appendChild(input);row.appendChild(node);}
    const chain=document.createElement('select');
    const fasta=document.getElementById('peptide-fasta').value;
    const count=Math.max(1,(fasta.match(/^>/gm)||[]).length);
    for(let i=0;i<Math.min(26,count);i++){const option=document.createElement('option');option.value=String.fromCharCode(65+i);option.textContent=`Chain ${option.value}`;chain.appendChild(option);}
    // Keep an imported out-of-range chain visible so validation can explain it.
    if(![...chain.options].some(o=>o.value===mod.chain)){const option=document.createElement('option');option.value=mod.chain;option.textContent=`Chain ${mod.chain} (check sequence)`;chain.appendChild(option);}
    chain.value=mod.chain;chain.onchange=()=>{mod.chain=chain.value;peptideClearResults();};label('Chain ',chain);
    const position=document.createElement('input');position.type='number';position.min=1;position.value=mod.position;position.style.width='75px';position.oninput=()=>{mod.position=Number(position.value);peptideClearResults();};label('Residue position ',position);
    const type=document.createElement('select');
    for(const [value,text] of [['unknown',mod.name ? `Unresolved: ${mod.name}` : 'Unknown remnant'],['gg','GGisoK (ε-Gly-Gly lysine)'],['custom','Custom fixed mass shift']]){const option=document.createElement('option');option.value=value;option.textContent=text;type.appendChild(option);}
    type.value=mod.kind|| (mod.delta===null?'unknown':'custom');
    type.onchange=()=>{mod.kind=type.value;mod.delta=type.value==='gg'?114.04292747:null;if(type.value==='gg')mod.block_cleavage=true;peptideClearResults();peptideRenderLinkages();};label('Type ',type);
    const mass=document.createElement('input');mass.type='number';mass.step='0.000001';mass.placeholder='Unresolved';mass.value=mod.delta??'';mass.style.width='130px';mass.disabled=type.value==='gg'||type.value==='unknown';mass.oninput=()=>{mod.delta=mass.value===''?null:Number(mass.value);peptideClearResults();};label('Mass shift (Da) ',mass);
    const block=document.createElement('input');block.type='checkbox';block.checked=mod.block_cleavage===true;block.disabled=type.value==='gg';block.onchange=()=>{mod.block_cleavage=block.checked;peptideClearResults();};label('Blocks trypsin at this residue ',block);
    const remove=document.createElement('button');remove.className='btn btn-sm';remove.textContent='Remove';remove.onclick=()=>{peptideView.modifications.splice(index,1);peptideClearResults();peptideRenderLinkages();};row.appendChild(remove);container.appendChild(row);
  });
}

function peptideClearResults() {
  peptideView.generation += 1;
  peptideView.results = null;
  document.getElementById('peptide-coverage').replaceChildren();
  document.getElementById('peptide-results').replaceChildren();
  document.getElementById('peptide-spectrum-status').textContent = '';
  qtofClearPlot('peptide-spectrum-plot');
}

function peptideSyncSamples(files) {
  const select = document.getElementById('peptide-sample-select'), previous = select.value;
  select.replaceChildren();
  for (const file of files) {
    const option = document.createElement('option'); option.value = file.path; option.textContent = file.name; select.appendChild(option);
  }
  if (files.some(f => f.path === previous)) select.value = previous;
  if (previous && select.value !== previous) peptideClearResults();
  const tab = document.querySelector('[data-tab="tab-peptides"]');
  tab.classList.toggle('hidden', !files.length);
  if (!files.length && tab.classList.contains('active')) document.querySelector('[data-tab="tab-single"]').click();
}

function peptideParseMods(text) {
  return text.split('\n').map(s => s.trim()).filter(Boolean).map(line => {
    const [chain, position, delta, block] = line.split(',').map(s => s.trim());
    if (!/^[A-Z]$/.test(chain) || !/^\d+$/.test(position) || !delta || (delta !== '?' && !Number.isFinite(Number(delta))) || (block && block !== 'block')) throw new Error('Use chain,position,mass shift,block; for example B,48,114.042927,block');
    return { chain, position: Number(position), delta: delta === '?' ? null : Number(delta), block_cleavage: block === 'block' };
  });
}

function peptideUseReference(index) {
  const ref = peptideView.references[index]; if (!ref) return;
  peptideClearResults();
  document.getElementById('peptide-fasta').value = ref.fasta;
  peptideView.modifications = ref.modifications.map(m => ({...m,kind:'unknown'}));
  peptideRenderLinkages();
  document.getElementById('peptide-import-status').textContent = `${ref.name} · ${ref.source}. ${ref.warnings.join(' ')} ` + ref.modifications.map(m => `${m.chain}${m.position}: ${m.name} (mass unresolved).`).join(' ');
}

async function peptideImport() {
  peptideClearResults();
  const generation = peptideView.generation, path = document.getElementById('peptide-sample-select').value;
  const status = document.getElementById('peptide-import-status'); status.textContent = 'Reading saved reference metadata…';
  try {
    const data = await api.getPeptideReferences(path);
    if (generation !== peptideView.generation) return;
    peptideView.references = data.references;
    const select = document.getElementById('peptide-reference-select'); select.replaceChildren();
    data.references.forEach((ref, i) => { const option = document.createElement('option'); option.value = i; option.textContent = ref.name; select.appendChild(option); });
    if (data.references.length) peptideUseReference(0);
    else status.textContent = 'No saved BioConfirm reference found. Paste your expected sequence or load FASTA.';
  } catch (error) { if (generation === peptideView.generation) status.textContent = error.message; }
}

function peptideRender(result) {
  const coverage = document.getElementById('peptide-coverage'); coverage.replaceChildren();
  for (const chain of result.coverage) {
    const section = document.createElement('div'); section.style.margin = '16px 0';
    const title = document.createElement('p'); title.textContent = `Chain ${chain.id} · ${chain.name} · candidate-supported coverage ${chain.percent.toFixed(1)}% (shared peptides included)`; section.appendChild(title);
    const positions = new Set(chain.positions), sequence = document.createElement('div');
    Object.assign(sequence.style, { fontFamily: 'monospace', lineHeight: '2', overflowWrap: 'anywhere' });
    [...chain.sequence].forEach((aa, i) => {
      const letter = document.createElement('span'); letter.textContent = aa; letter.title = `${chain.id}${i+1}`;
      Object.assign(letter.style, { background: positions.has(i+1) ? '#cde7fa' : '#eee', color: '#222', padding: '2px' }); sequence.appendChild(letter);
    }); section.appendChild(sequence); coverage.appendChild(section);
  }
  const table = document.createElement('table'); table.className = 'data-table';
  const header = table.createTHead().insertRow();
  for (const label of ['Peptide / modifications', 'Locations', 'Time', 'Charge*', 'Precursor ppm', 'Matched ions', 'Explained intensity', 'Review']) { const th=document.createElement('th'); th.textContent=label; header.appendChild(th); }
  const body = table.createTBody();
  result.matches.forEach(row => {
    const tr = body.insertRow();
    const mods = row.modifications.map(m=>`${m.residue}:${m.delta > 0 ? '+' : ''}${m.delta}`).join(', ');
    const values = [row.sequence + (mods ? ` [${mods}]` : ''), row.locations.map(l=>`${l.chain}:${l.start}–${l.end}`).join(', '), row.time.toFixed(3), `${row.charge}+`, row.precursor_error_ppm.toFixed(2), row.matched_ions, `${row.explained_intensity_pct.toFixed(1)}%`];
    values.forEach(value => { tr.insertCell().textContent = value; });
    const button = document.createElement('button'); button.className = 'btn btn-sm'; button.textContent = row.ambiguous_scan ? 'Competing candidates' : 'View fragments';
    button.addEventListener('click',()=>peptideShowMatch(row)); tr.insertCell().appendChild(button);
  });
  const container = document.getElementById('peptide-results'); container.replaceChildren(table);
  if (!result.matches.length) { const p=document.createElement('p'); p.textContent='No candidates passed the current precursor and fragment evidence thresholds.'; container.appendChild(p); }
}

async function peptideAnalyze() {
  peptideClearResults(); const generation=peptideView.generation;
  const status=document.getElementById('peptide-status'); status.textContent='Comparing measured MS/MS with the supplied sequence…';
  try {
    const path=document.getElementById('peptide-sample-select').value;
    const result=await api.analyzePeptides({ path, fasta:document.getElementById('peptide-fasta').value, modifications:peptideView.modifications, missed_cleavages:Number(document.getElementById('peptide-missed').value), precursor_ppm:Number(document.getElementById('peptide-precursor-ppm').value), fragment_ppm:Number(document.getElementById('peptide-fragment-ppm').value) });
    if (generation !== peptideView.generation) return;
    Object.assign(peptideView,{results:result,path});
    status.textContent=`${result.matches.length} candidate-spectrum matches; ${result.excluded_modified_peptides} peptides excluded for unresolved modifications. Charge* is inferred from precursor mass (1–6+; isotope offsets 0–2). ${result.warning}`;
    peptideRender(result);
  } catch(error) { if(generation===peptideView.generation) status.textContent=error.message; }
}

async function peptideShowMatch(row) {
  const generation=++peptideView.generation;
  qtofClearPlot('peptide-spectrum-plot');
  try {
    const spectrum=await api.getQtofSpectrum(peptideView.path,row.scan_id,'positive');
    if(generation!==peptideView.generation)return;
    const trace={x:row.fragments.map(f=>f.observed_mz),y:row.fragments.map(f=>f.intensity),text:row.fragments.map(f=>f.ion),mode:'markers+text',textposition:'top center',type:'scatter',marker:{color:'#1f77b4',size:5},hovertemplate:'%{text}<br>Measured %{x:.5f}<extra></extra>'};
    await Plotly.react('peptide-spectrum-plot',[qtofStickTrace(spectrum),trace],{...WEBAPP_LAYOUT,height:350,showlegend:false,xaxis:{...WEBAPP_LAYOUT.xaxis,title:'m/z'},yaxis:{...WEBAPP_LAYOUT.yaxis,title:'Intensity'}},PLOT_CONFIG);
    document.getElementById('peptide-spectrum-status').textContent=`${row.sequence} · measured MS/MS scan ${row.scan_id} · ${row.time.toFixed(4)} min · blue labels are candidate b/y matches, not a confirmed sequence. Precursor isotope offset: ${row.isotope_offset}.`;
  } catch(error) { if(generation===peptideView.generation)document.getElementById('peptide-spectrum-status').textContent=error.message; }
}

function initPeptideMapping() {
  document.getElementById('btn-peptide-import').addEventListener('click',peptideImport);
  document.getElementById('btn-peptide-analyze').addEventListener('click',peptideAnalyze);
  document.getElementById('peptide-reference-select').addEventListener('change',e=>peptideUseReference(Number(e.target.value)));
  document.getElementById('peptide-sample-select').addEventListener('change',()=>{ peptideClearResults(); peptideView.references=[];document.getElementById('peptide-reference-select').replaceChildren();document.getElementById('peptide-import-status').textContent='Reference retained; verify it belongs to the newly selected sample before analysis.'; });
  document.getElementById('btn-peptide-add-linkage').addEventListener('click',()=>{peptideView.modifications.push({chain:'A',position:1,delta:null,kind:'custom',block_cleavage:false});peptideClearResults();peptideRenderLinkages();});
  for(const id of ['peptide-fasta','peptide-missed','peptide-precursor-ppm','peptide-fragment-ppm'])document.getElementById(id).addEventListener('input',peptideClearResults);
  document.getElementById('peptide-fasta').addEventListener('change',peptideRenderLinkages);
  document.getElementById('peptide-fasta-file').addEventListener('change',async event=>{
    const file=event.target.files[0]; if(!file)return;
    peptideClearResults(); const generation=peptideView.generation;
    if(file.size>30000){document.getElementById('peptide-import-status').textContent='FASTA is too large (maximum 30 KB).';return;}
    const text=await file.text(); if(generation!==peptideView.generation)return;
    document.getElementById('peptide-fasta').value=text;
    peptideView.modifications=[];peptideRenderLinkages();
    document.getElementById('peptide-import-status').textContent='FASTA loaded; check fixed modifications before analysis.';
  });
}
