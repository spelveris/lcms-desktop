const peptideView = { generation: 0, references: [], results: null, path: '', modifications: [],
  filters: { text: '', evidence: '', charge: '', review: '' }, sort: { key: 'time', direction: 1 } };
const PEPTIDE_ION_COLORS = { b: '#3750aa', y: '#e52a2a' };

function peptideIonLabel(ion) { return `${ion.series}${ion.number} +${ion.charge}`; }

function peptideIonAssignment(row, fragment) {
  const parsed = /^([by])(\d+)(?:\^(\d+)\+|\+)$/.exec(String(fragment.ion || ''));
  if (!parsed) return null;
  const series = parsed[1], number = Number(parsed[2]), charge = Number(parsed[3] || 1);
  const length = row.sequence.length;
  if (number < 1 || number >= length || charge < 1 || charge > 2) return null;
  const bond = series === 'b' ? number : length - number;
  if (fragment.bond !== bond) return null;
  return { ...fragment, series, number, charge, bond,
    start: series === 'b' ? 1 : bond + 1, end: series === 'b' ? bond : length };
}

function peptideIonEvidence(row) {
  const ions = (row.fragments || []).map(fragment => peptideIonAssignment(row, fragment)).filter(Boolean);
  return [...row.sequence].map((residue, index) => {
    const position = index + 1;
    return { residue, position,
      modifications: (row.modifications || []).filter(mod => mod.residue === position),
      bNumber: position < row.sequence.length ? position : null,
      yNumber: position > 1 ? row.sequence.length - index : null,
      b: ions.filter(ion => ion.series === 'b' && ion.end === position).sort((a,b) => a.charge-b.charge),
      y: ions.filter(ion => ion.series === 'y' && ion.start === position).sort((a,b) => a.charge-b.charge),
    };
  });
}

function peptideIonDescription(row, ion) {
  const sequence = row.sequence.slice(ion.start - 1, ion.end);
  const mods = (row.modifications || []).filter(mod => mod.residue >= ion.start && mod.residue <= ion.end)
    .map(mod => `${row.sequence[mod.residue-1]}${mod.residue}: ${mod.delta >= 0 ? '+' : ''}${Number(mod.delta).toFixed(6)} Da`);
  return `${peptideIonLabel(ion)} · cut ${ion.bond}|${ion.bond+1} · peptide residues ${ion.start}–${ion.end}: ${sequence}`
    + ` · measured m/z ${Number(ion.observed_mz).toFixed(5)}, theoretical ${Number(ion.theoretical_mz).toFixed(5)}`
    + ` · error ${Number(ion.error_ppm).toFixed(2)} ppm`
    + (mods.length ? ` · includes ${mods.join('; ')}` : '');
}

function peptideClearIonSequence() {
  const panel = document.getElementById('peptide-ion-sequence');
  if (panel) { panel.hidden = true; panel.replaceChildren(); }
}

function peptideRenderIonSequence(row) {
  const panel = document.getElementById('peptide-ion-sequence');
  if (!panel) return;
  panel.replaceChildren(); panel.hidden = false;
  const title = document.createElement('h4'); title.textContent = 'Selected peptide · b/y-ion evidence'; panel.appendChild(title);
  const note = document.createElement('p'); note.className = 'toolbar-note';
  note.textContent = 'N → C sequence. Blue b ions below / red y ions above. Angled marks show matched cuts; unmarked cuts have no matching evidence. +1 and +2 are fragment charges, not precursor charge. * marks a fixed modification. Candidate assignments, not a confirmed sequence.';
  panel.appendChild(note);
  const scroll = document.createElement('div'); scroll.className = 'peptide-ion-scroll';
  function svgNode(tag, attributes={}, text) {
    const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
    for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));
    if(text !== undefined)node.textContent=text;
    return node;
  }
  const spacing=52, width=row.sequence.length*spacing+24;
  const svg=svgNode('svg',{viewBox:`0 0 ${width} 188`,width,height:188,role:'group','aria-label':`Cleavage map for ${row.sequence}`});
  svg.classList.add('peptide-cleavage-map');scroll.appendChild(svg);panel.appendChild(scroll);
  const detail = document.createElement('p'); detail.className = 'toolbar-note peptide-ion-detail';
  detail.setAttribute('role', 'status'); detail.textContent = 'Select a coloured ion to see its fragment sequence, measured m/z and mass error.';
  const residueNodes = [], buttons = [];
  function selectIon(ion, button) {
    residueNodes.forEach((node, index) => node.classList.toggle('is-ion-selected', index + 1 >= ion.start && index + 1 <= ion.end));
    buttons.forEach(node => node.setAttribute('aria-pressed', String(node === button)));
    detail.textContent = peptideIonDescription(row, ion);
  }
  const evidence = peptideIonEvidence(row);
  for (const cell of evidence) {
    const x=38+(cell.position-1)*spacing;
    const residue=svgNode('text',{x,y:96,'text-anchor':'middle',class:'peptide-map-residue'},cell.residue);
    for (const mod of cell.modifications) {
      residue.classList.add('is-modified');
      residue.appendChild(svgNode('title',{},`${cell.residue}${cell.position}: ${mod.delta >= 0 ? '+' : ''}${Number(mod.delta).toFixed(6)} Da (included in fragment masses)`));
      svg.appendChild(svgNode('text',{x:x+14,y:72,class:'peptide-map-modification'},'*'));
    }
    residueNodes.push(residue);svg.appendChild(residue);
    svg.appendChild(svgNode('text',{x,y:180,'text-anchor':'middle',class:'peptide-map-position'},cell.position));
    if (cell.position === row.sequence.length) continue;
    const atCut = { b: cell.b, y: evidence[cell.position].y };
    for (const series of ['b', 'y']) {
      if(!atCut[series].length)continue;
      const cutX=x+spacing/2+(series==='b' ? -2 : 2);
      const path=series==='b' ? `M ${cutX} 88 V 110 l -12 12` : `M ${cutX} 82 V 60 l 12 -12`;
      svg.appendChild(svgNode('path',{d:path,stroke:PEPTIDE_ION_COLORS[series],'stroke-width':1.8,fill:'none','data-bond':cell.position,'data-series':series}));
      atCut[series].forEach((ion,index)=>{
        const ionX=cutX+(series==='b' ? -12 : 12),ionY=series==='b' ? 139+index*19 : 39-index*19;
        const button=svgNode('g',{role:'button',tabindex:0,'aria-pressed':'false','aria-label':peptideIonDescription(row,ion),class:'peptide-map-ion',fill:PEPTIDE_ION_COLORS[series]});
        button.appendChild(svgNode('title',{},peptideIonDescription(row,ion)));
        button.appendChild(svgNode('rect',{x:ionX-25,y:ionY-16,width:50,height:20,rx:3,fill:'transparent'}));
        const label=svgNode('text',{x:ionX,y:ionY,'text-anchor':'middle','font-size':17},series);
        label.appendChild(svgNode('tspan',{'baseline-shift':'sub','font-size':12},ion.number));
        label.appendChild(svgNode('tspan',{'baseline-shift':'super','font-size':10},`+${ion.charge}`));
        button.appendChild(label);
        button.addEventListener('click',()=>selectIon(ion,button));
        button.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectIon(ion,button);}});
        buttons.push(button);svg.appendChild(button);
      });
    }
  }
  panel.appendChild(detail);
}

function peptideFragmentTraces(row) {
  const assignments = (row.fragments || []).map(fragment => peptideIonAssignment(row, fragment)).filter(Boolean);
  return ['b', 'y'].flatMap(series => {
    const ions = assignments.filter(ion => ion.series === series);
    const sticks=qtofStickTrace({mz:ions.map(ion=>ion.observed_mz),intensities:ions.map(ion=>ion.intensity)});
    sticks.line={color:PEPTIDE_ION_COLORS[series],width:1.4};sticks.name=`Candidate ${series} peaks`;
    return [sticks,{ x: ions.map(ion => ion.observed_mz), y: ions.map(ion => ion.intensity), text: ions.map(ion=>`${peptideIonLabel(ion)}<br>${ion.observed_mz.toFixed(4)}`),
      customdata: ions.map(ion => [ion.theoretical_mz, ion.error_ppm]), name: `Candidate ${series} ions`,
      mode: 'markers+text', textposition: 'top center', type: 'scatter',
      marker: { color: PEPTIDE_ION_COLORS[series], size: 5 }, textfont: { color: PEPTIDE_ION_COLORS[series] },
      hovertemplate: '%{text}<br>Measured %{x:.5f}<br>Theoretical %{customdata[0]:.5f}<br>Error %{customdata[1]:.2f} ppm<extra></extra>' }];
  });
}

function peptideCoverageSpans(result, chain) {
  const spans = new Map();
  for (const row of result.matches || []) {
    if (row.ambiguous_scan) continue; // Same evidence rule as the existing coverage calculation.
    for (const location of row.locations || []) {
      if (location.chain !== chain.id || !Number.isInteger(location.start) || !Number.isInteger(location.end)
          || location.start < 1 || location.end > chain.sequence.length || location.end < location.start
          || chain.sequence.slice(location.start - 1, location.end) !== row.sequence) continue;
      const modifications = (row.modifications || []).map(mod => [mod.residue, mod.delta]).sort((a,b) => a[0]-b[0]);
      const evidence = row.evidence || 'msms';
      const key = JSON.stringify([location.start, location.end, modifications, evidence]);
      if (!spans.has(key)) spans.set(key, { start: location.start, end: location.end, row, evidence, scanIds: new Set() });
      spans.get(key).scanIds.add(row.scan_id);
    }
  }
  const sorted = [...spans.values()].sort((a,b) => a.start-b.start || a.end-b.end);
  const laneEnds = [];
  for (const span of sorted) {
    let lane = laneEnds.findIndex(end => end < span.start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = span.end; span.lane = lane;
    span.spectrumCount = span.scanIds.size; delete span.scanIds;
  }
  return sorted;
}

function peptideRenderCoverageChain(result, chain) {
  const section = document.createElement('section'); section.className = 'peptide-coverage-chain';
  const title = document.createElement('p');
  title.textContent = `Chain ${chain.id} · ${chain.name} · MS/MS candidate coverage ${chain.percent.toFixed(1)}% (shared peptides included; MS-only excluded)`;
  section.appendChild(title);
  const spans = peptideCoverageSpans(result, chain), positions = new Set(chain.positions);
  const note = document.createElement('p'); note.className = 'toolbar-note';
  note.textContent = 'Blue solid: MS/MS-supported. Green dashed: tentative MS-only mass match, not sequence confirmation. Overlaps use separate lines; repeated observations share one underline. Click a line to inspect a spectrum. Competing candidates are excluded; shared peptides map to every compatible chain.';
  section.appendChild(note);
  const scroll = document.createElement('div'); scroll.className = 'peptide-coverage-scroll'; section.appendChild(scroll);
  for (let offset = 0; offset < chain.sequence.length; offset += 50) {
    const sequence = chain.sequence.slice(offset, offset+50), end = offset + sequence.length;
    const block = document.createElement('div'); block.className = 'peptide-coverage-block';
    const range = document.createElement('div'); range.className = 'peptide-coverage-range'; range.textContent = `${offset+1}–${end}`; block.appendChild(range);
    const grid = document.createElement('div'); grid.className = 'peptide-coverage-grid'; grid.style.gridTemplateColumns = `repeat(${sequence.length}, 16px)`;
    [...sequence].forEach((aa, index) => {
      const position = offset + index + 1, letter = document.createElement('span');
      letter.className = `peptide-coverage-residue${positions.has(position) ? ' is-covered' : ''}`;
      letter.textContent = aa; letter.title = `${chain.id}${position}`;
      letter.style.gridColumn = String(index+1); letter.style.gridRow = '1'; grid.appendChild(letter);
    });
    for (const span of spans.filter(span => span.start <= end && span.end > offset)) {
      const start = Math.max(span.start, offset+1), stop = Math.min(span.end, end);
      const line = document.createElement('button'); line.type = 'button';
      line.className = `peptide-coverage-underline evidence-${span.evidence}` + (span.start < start ? ' continues-left' : '') + (span.end > stop ? ' continues-right' : '');
      line.style.gridColumn = `${start-offset} / span ${stop-start+1}`; line.style.gridRow = String(span.lane+2);
      line.title = `${span.row.sequence} · ${chain.id}:${span.start}–${span.end} · ${span.evidence === 'ms1' ? 'MS-only mass hypothesis' : 'MS/MS-supported candidate'} · open representative scan ${span.row.scan_id}`;
      const mods = (span.row.modifications || []).map(mod => `${span.row.sequence[mod.residue-1]}${mod.residue}: ${mod.delta >= 0 ? '+' : ''}${Number(mod.delta).toFixed(6)} Da`);
      if (mods.length) line.title += ` · ${mods.join('; ')}`;
      line.setAttribute('aria-label', line.title); line.addEventListener('click', () => peptideShowMatch(span.row)); grid.appendChild(line);
    }
    block.appendChild(grid); scroll.appendChild(block);
  }
  return section;
}

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
  peptideClearIonSequence();
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
    coverage.appendChild(peptideRenderCoverageChain(result, chain));
  }
  peptideRenderTable(result);
}

const PEPTIDE_COLUMNS = [
  ['sequence','Peptide / modifications'], ['locations','Locations'], ['evidence','Evidence'],
  ['time','Time (min)'], ['charge','Charge*'], ['precursor_mz','Precursor m/z'],
  ['precursor_error_ppm','Precursor ppm'], ['matched_ions','Matched ions'],
  ['explained_intensity_pct','Explained intensity'], ['ambiguous_scan','Review'],
];

function peptideLocationText(row) { return row.locations.map(l=>`${l.chain}:${l.start}–${l.end}`).join(', '); }
function peptideEvidenceText(row) { return row.evidence === 'ms1' ? 'MS-only · tentative' : 'MS/MS'; }
function peptideFilteredRows(result) {
  const filters = peptideView.filters, query = filters.text.trim().toLowerCase();
  const rows = result.matches.filter(row => {
    const searchable = `${row.sequence} ${peptideLocationText(row)} ${row.modifications.map(m=>`${m.residue}:${m.delta}`).join(' ')}`.toLowerCase();
    return (!query || searchable.includes(query)) && (!filters.evidence || (row.evidence || 'msms') === filters.evidence)
      && (!filters.charge || row.charge === Number(filters.charge))
      && (!filters.review || Boolean(row.ambiguous_scan) === (filters.review === 'competing'));
  });
  const {key, direction} = peptideView.sort;
  const value = row => key === 'locations' ? peptideLocationText(row) : key === 'evidence' ? peptideEvidenceText(row) : row[key];
  return rows.sort((a,b) => {
    const av=value(a), bv=value(b);
    if (av == null || bv == null) return av == null ? (bv == null ? 0 : 1) : -1;
    const comparison = typeof av === 'string' ? av.localeCompare(bv, undefined, {numeric:true}) : Number(av)-Number(bv);
    return direction*comparison || a.time-b.time || a.scan_id-b.scan_id;
  });
}

function peptideRenderTable(result) {
  const container = document.getElementById('peptide-results'); container.replaceChildren();
  const toolbar = document.createElement('div'); toolbar.className = 'tab-toolbar peptide-table-filters';
  function control(labelText, element) {
    const label = document.createElement('label'); label.textContent = labelText; label.appendChild(element); toolbar.appendChild(label);
  }
  const search = document.createElement('input'); search.type='search'; search.placeholder='Sequence, location or modification';
  search.value=peptideView.filters.text;
  control('Find ',search);
  for (const [key,label,options] of [
    ['evidence','Evidence ',[['','All'],['msms','MS/MS'],['ms1','MS-only (tentative)']]],
    ['charge','Charge* ',[['','All'],...[1,2,3,4,5,6].map(z=>[String(z),`+${z}`])]],
    ['review','Assignments ',[['','All'],['unambiguous','No competing sequence'],['competing','Competing candidates']]],
  ]) {
    const select=document.createElement('select');
    for (const [value,label] of options) { const option=document.createElement('option');option.value=value;option.textContent=label;select.appendChild(option); }
    select.value=peptideView.filters[key];
    select.addEventListener('change',()=>{peptideView.filters[key]=select.value;updateRows();}); control(label,select);
  }
  const reset=document.createElement('button');reset.type='button';reset.className='btn btn-sm';reset.textContent='Reset filters';
  reset.addEventListener('click',()=>{peptideView.filters={text:'',evidence:'',charge:'',review:''};peptideRenderTable(result);});toolbar.appendChild(reset);
  const count=document.createElement('span');count.className='toolbar-note';count.setAttribute('role','status');toolbar.appendChild(count);container.appendChild(toolbar);
  const scroll=document.createElement('div');scroll.className='peptide-table-scroll';container.appendChild(scroll);
  const table = document.createElement('table'); table.className = 'data-table';scroll.appendChild(table);
  const header = table.createTHead().insertRow();
  const headers=[];
  for (const [key,label] of PEPTIDE_COLUMNS) {
    const th=document.createElement('th');th.scope='col';
    const button=document.createElement('button');button.type='button';button.className='peptide-sort-button';
    if(key==='precursor_mz')button.title='Recorded MS/MS precursor m/z, or measured MS1 peak m/z for tentative MS-only matches';
    button.addEventListener('click',()=>{peptideView.sort={key,direction:peptideView.sort.key===key ? -peptideView.sort.direction : 1};updateRows();});
    th.appendChild(button);header.appendChild(th);headers.push({th,button,key,label});
  }
  const body = table.createTBody();
  const empty=document.createElement('p');container.appendChild(empty);
  function updateRows() {
    const visible=peptideFilteredRows(result);body.replaceChildren();count.textContent=`${visible.length} of ${result.matches.length} matches`;
    for(const {th,button,key,label} of headers) {
      const selected=peptideView.sort.key===key;
      th.setAttribute('aria-sort',selected ? (peptideView.sort.direction===1 ? 'ascending' : 'descending') : 'none');
      button.textContent=label+(selected ? (peptideView.sort.direction===1 ? ' ↑' : ' ↓') : ' ↕');
    }
    visible.forEach(row => {
    const tr = body.insertRow();
    const mods = row.modifications.map(m=>`${m.residue}:${m.delta > 0 ? '+' : ''}${m.delta}`).join(', ');
    const values = [row.sequence + (mods ? ` [${mods}]` : ''), peptideLocationText(row), peptideEvidenceText(row), row.time.toFixed(3), `+${row.charge}`, row.precursor_mz.toFixed(5), row.precursor_error_ppm.toFixed(2), row.evidence==='ms1' ? '—' : row.matched_ions, row.explained_intensity_pct == null ? '—' : `${row.explained_intensity_pct.toFixed(1)}%`];
    values.forEach(value => { tr.insertCell().textContent = value; });
    const button = document.createElement('button'); button.type='button';button.className = 'btn btn-sm'; button.textContent = (row.evidence==='ms1' ? 'View MS peak' : 'View fragments')+(row.ambiguous_scan ? ' · competing' : '');
    button.addEventListener('click',()=>peptideShowMatch(row)); tr.insertCell().appendChild(button);
    });
    empty.textContent=visible.length ? '' : result.matches.length ? 'No matches fit these filters. Reset filters to show all results.' : 'No candidates passed the current mass or fragment evidence thresholds.';
  }
  search.addEventListener('input',()=>{peptideView.filters.text=search.value;updateRows();});updateRows();
}

async function peptideAnalyze() {
  peptideClearResults(); const generation=peptideView.generation;
  const status=document.getElementById('peptide-status'); status.textContent='Comparing measured MS and MS/MS with the supplied sequence…';
  try {
    const path=document.getElementById('peptide-sample-select').value;
    const result=await api.analyzePeptides({ path, fasta:document.getElementById('peptide-fasta').value, modifications:peptideView.modifications, missed_cleavages:Number(document.getElementById('peptide-missed').value), precursor_ppm:Number(document.getElementById('peptide-precursor-ppm').value), fragment_ppm:Number(document.getElementById('peptide-fragment-ppm').value) });
    if (generation !== peptideView.generation) return;
    Object.assign(peptideView,{results:result,path});
    status.textContent=`${result.matches.filter(r=>r.evidence!=='ms1').length} MS/MS candidate-spectrum matches; ${result.matches.filter(r=>r.evidence==='ms1').length} tentative MS-only hypotheses. ${result.excluded_modified_peptides} peptides excluded for unresolved modifications. Charge* is inferred from mass (+1 to +6; isotope offsets 0–2). ${result.warning}`;
    peptideRender(result);
  } catch(error) { if(generation===peptideView.generation) status.textContent=error.message; }
}

async function peptideShowMatch(row) {
  const generation=++peptideView.generation;
  peptideClearIonSequence();
  const msOnly=row.evidence==='ms1';
  document.getElementById('peptide-spectrum-status').textContent=msOnly ? 'Loading measured MS survey…' : 'Loading measured fragment spectrum…';
  qtofClearPlot('peptide-spectrum-plot');
  try {
    const spectrum=await api.getQtofSpectrum(peptideView.path,row.scan_id,'positive');
    if(generation!==peptideView.generation)return;
    const overlays=msOnly ? [{x:[row.precursor_mz],y:[row.precursor_intensity],text:[`MS-only +${row.charge}`],mode:'markers+text',textposition:'top center',marker:{color:'#48a66b',size:7},type:'scatter'}] : peptideFragmentTraces(row);
    const maximum=spectrum.intensities.reduce((a,b)=>Math.max(a,b),0);
    await Plotly.react('peptide-spectrum-plot',[qtofStickTrace(spectrum),...overlays],{...WEBAPP_LAYOUT,height:430,showlegend:false,xaxis:{...WEBAPP_LAYOUT.xaxis,title:'Mass-to-charge (m/z)',showgrid:false},yaxis:{...WEBAPP_LAYOUT.yaxis,title:'Counts',showgrid:false,range:[0,maximum>0?maximum*1.25:1]}},PLOT_CONFIG);
    if(generation!==peptideView.generation)return;
    if(!msOnly)peptideRenderIonSequence(row);
    document.getElementById('peptide-spectrum-status').textContent=msOnly
      ? `${row.sequence} · measured MS scan ${row.scan_id} · ${row.time.toFixed(4)} min · m/z ${row.precursor_mz.toFixed(5)} · tentative +${row.charge}, isotope offset ${row.isotope_offset}. ${row.observation_count} survey observations across ${row.time_start.toFixed(3)}–${row.time_end.toFixed(3)} min; strongest shown. No supporting MS/MS assignment: no b/y cleavage evidence or confirmed sequence.`
      : `${row.sequence} · measured MS/MS scan ${row.scan_id} · ${row.time.toFixed(4)} min · precursor m/z ${row.precursor_mz.toFixed(5)}, inferred +${row.charge} · blue b / red y labels are candidate matches, not a confirmed sequence. Precursor isotope offset: ${row.isotope_offset}.`;
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
