const peptideView = { generation: 0, references: [], results: null, path: '', modifications: [],
  analyzing: false, selectedMatch: null, selectedSpectrum: null,
  filters: { text: '', evidence: '', charge: '', review: '' }, columnFilters: {}, sort: { key: 'time', direction: 1 } };
const PEPTIDE_ION_COLORS = { b: '#3750aa', y: '#e52a2a' };
let peptideCoverageObserver;

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

function peptideLinkageEvidence(row) {
  return (row.modifications||[]).filter(mod=>mod.kind==='gg'&&row.sequence[mod.residue-1]==='K').map(mod=>({
    residue:mod.residue,
    sites:(row.locations||[]).map(loc=>`${loc.chain}:K${loc.start+mod.residue-1}`).join(' or '),
    evidence:row.evidence==='ms1'?'Fixed-site hypothesis; no MS/MS support':row.site_ambiguous?'MS/MS candidate; competing sites remain':'MS/MS-supported candidate',
    ions:(row.fragments||[]).map(fragment=>peptideIonAssignment(row,fragment)).filter(ion=>ion&&ion.start<=mod.residue&&ion.end>=mod.residue)
      .map(ion=>`${peptideIonLabel(ion)} (${Number(ion.observed_mz).toFixed(5)})`).join(', '),
  }));
}

function peptideRenderLinkageEvidence(panel,row) {
  for(const link of peptideLinkageEvidence(row)){
    const box=document.createElement('div');box.className='peptide-linkage-evidence';
    const heading=document.createElement('p');heading.textContent=`GGisoK: ${link.sites} · ${link.evidence}`;box.appendChild(heading);
    const scheme=document.createElement('p');scheme.className='peptide-linkage-scheme';
    scheme.textContent=`GG remnant — C-terminal carbonyl — Nε of Lys ${link.residue}`;
    box.appendChild(scheme);
    if(link.ions){const ions=document.createElement('p');ions.className='toolbar-note';ions.textContent=`Remnant-containing candidate ions (measured m/z): ${link.ions}`;box.appendChild(ions);}
    const note=document.createElement('p');note.className='toolbar-note';
    note.textContent='The remnant is attached to the lysine side chain, not inserted into the backbone. For ubiquitin, this is consistent with donor G76 linked to acceptor lysine. The GG remnant alone does not identify the donor chain; shared peptides do not distinguish A from B. Intact cross-link topology is not determined by this search.';
    box.appendChild(note);panel.appendChild(box);
  }
}

function peptideRenderIonSequence(row) {
  const panel = document.getElementById('peptide-ion-sequence');
  if (!panel) return;
  panel.replaceChildren(); panel.hidden = false;
  const title = document.createElement('h4'); title.textContent = 'Selected peptide · b/y-ion evidence'; panel.appendChild(title);
  const note = document.createElement('p'); note.className = 'toolbar-note';
  note.textContent = 'Blue b ions below · red y ions above · +1/+2 fragment charge · * modified residue';
  panel.appendChild(note);
  const scroll = document.createElement('div'); scroll.className = 'peptide-ion-scroll';
  function svgNode(tag, attributes={}, text) {
    const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
    for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));
    if(text !== undefined)node.textContent=text;
    return node;
  }
  const spacing=36, width=row.sequence.length*spacing+24;
  const svg=svgNode('svg',{viewBox:`0 0 ${width} 216`,width,height:216,role:'group','aria-label':`Cleavage map for ${row.sequence}`});
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
    const x=26+(cell.position-1)*spacing;
    const residue=svgNode('text',{x,y:96,'text-anchor':'middle',class:'peptide-map-residue'},cell.residue);
    for (const mod of cell.modifications) {
      residue.classList.add('is-modified');
      residue.appendChild(svgNode('title',{},`${cell.residue}${cell.position}: ${mod.delta >= 0 ? '+' : ''}${Number(mod.delta).toFixed(6)} Da (included in fragment masses)`));
      svg.appendChild(svgNode('text',{x:x+14,y:72,class:'peptide-map-modification'},'*'));
    }
    residueNodes.push(residue);svg.appendChild(residue);
    svg.appendChild(svgNode('text',{x,y:204,'text-anchor':'middle',class:'peptide-map-position'},cell.position));
    if (cell.position === row.sequence.length) continue;
    const atCut = { b: cell.b, y: evidence[cell.position].y };
    for (const series of ['b', 'y']) {
      if(!atCut[series].length)continue;
      const cutX=x+spacing/2+(series==='b' ? -2 : 2);
      const path=series==='b' ? `M ${cutX} 88 V 110 l -12 12` : `M ${cutX} 82 V 60 l 12 -12`;
      svg.appendChild(svgNode('path',{d:path,stroke:PEPTIDE_ION_COLORS[series],'stroke-width':1.8,fill:'none','data-bond':cell.position,'data-series':series}));
      atCut[series].forEach((ion,index)=>{
        // Leave room above the blue superscript; it must not touch the cut at y=122.
        const ionX=cutX+(series==='b' ? -12 : 12),ionY=series==='b' ? 153+index*20 : 39-index*19;
        const button=svgNode('g',{role:'button',tabindex:0,'aria-pressed':'false','aria-label':peptideIonDescription(row,ion),class:'peptide-map-ion',fill:PEPTIDE_ION_COLORS[series]});
        button.appendChild(svgNode('title',{},peptideIonDescription(row,ion)));
        button.appendChild(svgNode('rect',{x:ionX-17,y:ionY-16,width:34,height:20,rx:3,fill:'transparent'}));
        const label=svgNode('text',{x:ionX,y:ionY,'text-anchor':'middle','font-size':15},series);
        label.appendChild(svgNode('tspan',{'baseline-shift':'sub','font-size':10},ion.number));
        label.appendChild(svgNode('tspan',{'baseline-shift':'super','font-size':8},`+${ion.charge}`));
        button.appendChild(label);
        button.addEventListener('click',()=>selectIon(ion,button));
        button.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectIon(ion,button);}});
        buttons.push(button);svg.appendChild(button);
      });
    }
  }
  panel.appendChild(detail);
  peptideRenderLinkageEvidence(panel,row);
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
    if (row.sequence_ambiguous ?? row.ambiguous_scan) continue;
    for (const location of row.locations || []) {
      if (location.chain !== chain.id || !Number.isInteger(location.start) || !Number.isInteger(location.end)
          || location.start < 1 || location.end > chain.sequence.length || location.end < location.start
          || chain.sequence.slice(location.start - 1, location.end) !== row.sequence) continue;
      const modifications = (row.modifications || []).map(mod => [mod.residue, mod.delta]).sort((a,b) => a[0]-b[0]);
      const evidence = row.evidence || 'msms';
      const key = JSON.stringify([location.start, location.end, modifications, evidence, row.ms1_supported !== false]);
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

function peptideCoverageBlockSpans(spans, start, end) {
  // Repack each wrapped sequence line independently: an old high lane must not
  // force empty rows underneath later sequence lines. Never merge click targets.
  const visible = spans.filter(span=>span.start<=end&&span.end>=start)
    .map(span=>({...span,blockStart:Math.max(start,span.start),blockEnd:Math.min(end,span.end)}))
    .sort((a,b)=>a.blockStart-b.blockStart||a.blockEnd-b.blockEnd||a.lane-b.lane);
  const laneEnds=[];
  for(const span of visible){
    let lane=laneEnds.findIndex(stop=>stop<span.blockStart);
    if(lane<0)lane=laneEnds.length;
    span.lane=lane;laneEnds[lane]=span.blockEnd;
  }
  return visible;
}

function peptideCoverageColumns(width) {
  if (!Number.isFinite(width) || width <= 0) return 50;
  const count = Math.max(1, Math.floor(width / 16));
  return count >= 20 ? Math.floor(count / 10) * 10 : count;
}

function peptideCoverageModifications(result, chain) {
  const sites = new Map();
  for (const row of result.matches || []) {
    if (row.evidence === 'ms1' || (row.sequence_ambiguous ?? row.ambiguous_scan)) continue;
    const ions = (row.fragments || []).map(fragment => peptideIonAssignment(row, fragment)).filter(Boolean);
    for (const location of row.locations || []) {
      if (location.chain !== chain.id || !Number.isInteger(location.start) || !Number.isInteger(location.end)
          || location.start < 1 || location.end > chain.sequence.length || location.end < location.start
          || chain.sequence.slice(location.start-1, location.end) !== row.sequence) continue;
      for (const mod of row.modifications || []) {
        if (!Number.isInteger(mod.residue) || mod.residue < 1 || mod.residue > row.sequence.length
            || !Number.isFinite(mod.delta) || mod.delta === 0
            || !ions.some(ion => ion.start <= mod.residue && ion.end >= mod.residue)) continue;
        const position = location.start + mod.residue - 1;
        if (!sites.has(position)) sites.set(position, { position, ambiguous: true, labels: new Set() });
        const site = sites.get(position);
        site.ambiguous = site.ambiguous && row.site_ambiguous === true;
        site.labels.add(`${chain.id}:${row.sequence[mod.residue-1]}${position} · ${mod.kind === 'gg' ? 'GGisoK · ' : ''}${mod.delta >= 0 ? '+' : ''}${mod.delta} Da`);
      }
    }
  }
  return sites;
}

function peptideRenderCoverageChain(result, chain, columns = 50) {
  const section = document.createElement('section'); section.className = 'peptide-coverage-chain';
  const title = document.createElement('p');
  title.textContent = `Chain ${chain.id} · ${chain.name} · Coverage: MS ${(chain.ms_percent ?? chain.percent).toFixed(1)}% · MS/MS ${(chain.msms_percent ?? chain.percent).toFixed(1)}%`;
  title.title = 'MS: isotope/retention-time feature-supported coverage. MS/MS: fragment-supported coverage, including candidates whose precursor feature remains unconfirmed. Unique residues are counted once; competing sequences are excluded. The percentages are independent, not additive.';
  section.appendChild(title);
  const spans = peptideCoverageSpans(result, chain), positions = new Set(chain.positions);
  const modificationSites = peptideCoverageModifications(result, chain);
  const scroll = document.createElement('div'); scroll.className = 'peptide-coverage-scroll'; section.appendChild(scroll);
  for (let offset = 0; offset < chain.sequence.length; offset += columns) {
    const sequence = chain.sequence.slice(offset, offset+columns), end = offset + sequence.length;
    const block = document.createElement('div'); block.className = 'peptide-coverage-block';
    const range = document.createElement('div'); range.className = 'peptide-coverage-range'; range.textContent = `${offset+1}–${end}`; block.appendChild(range);
    const grid = document.createElement('div'); grid.className = 'peptide-coverage-grid'; grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
    [...sequence].forEach((aa, index) => {
      const position = offset + index + 1, letter = document.createElement('span');
      letter.className = `peptide-coverage-residue${positions.has(position) ? ' is-covered' : ''}`;
      letter.textContent = aa; letter.title = `${chain.id}${position}`;
      const site = modificationSites.get(position);
      if (site) {
        letter.classList.add('is-modified');
        if (site.ambiguous) letter.classList.add('is-modification-ambiguous');
        letter.title = `${[...site.labels].join('; ')} · ${site.ambiguous ? 'Possible site; competing sites remain' : 'MS/MS-supported modification candidate'} · Shared peptides do not identify a chain`;
      }
      letter.style.gridColumn = String(index+1); letter.style.gridRow = '1'; grid.appendChild(letter);
    });
    for (const span of peptideCoverageBlockSpans(spans, offset+1, end)) {
      const start = Math.max(span.start, offset+1), stop = Math.min(span.end, end);
      const line = document.createElement('button'); line.type = 'button';
      line.className = `peptide-coverage-underline evidence-${span.evidence}` + (span.row.ms1_supported === false ? ' precursor-unconfirmed' : '') + (span.start < start ? ' continues-left' : '') + (span.end > stop ? ' continues-right' : '');
      line.style.gridColumn = `${start-offset} / span ${stop-start+1}`; line.style.gridRow = String(span.lane+2);
      line.title = `${span.row.sequence} · ${chain.id}:${span.start}–${span.end} · ${span.evidence === 'ms1' ? 'MS1 feature-supported mass candidate' : span.row.ms1_supported === false ? 'MS/MS candidate; precursor feature unconfirmed' : 'MS/MS linked to MS1 feature'} · open representative scan ${span.row.scan_id}`;
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
    function label(text,input){const node=document.createElement('label');node.textContent=text;node.appendChild(input);row.appendChild(node);return node;}
    const chain=document.createElement('select');
    const fasta=document.getElementById('peptide-fasta').value;
    const count=Math.max(1,(fasta.match(/^>/gm)||[]).length);
    if(mod.search_all){const option=document.createElement('option');option.value='*';option.textContent='All chains';chain.appendChild(option);}
    for(let i=0;i<Math.min(26,count);i++){const option=document.createElement('option');option.value=String.fromCharCode(65+i);option.textContent=`Chain ${option.value}`;chain.appendChild(option);}
    // Keep an imported out-of-range chain visible so validation can explain it.
    if(![...chain.options].some(o=>o.value===mod.chain)){const option=document.createElement('option');option.value=mod.chain;option.textContent=`Chain ${mod.chain} (check sequence)`;chain.appendChild(option);}
    chain.value=mod.chain;chain.onchange=()=>{mod.chain=chain.value;peptideClearResults();};label('Chain ',chain);
    const position=document.createElement('input');position.type='number';position.min=1;position.value=mod.position;position.style.width='75px';position.oninput=()=>{mod.position=Number(position.value);peptideClearResults();};label('Residue position ',position);
    position.disabled=mod.search_all===true;
    // Hide the unused written position so it cannot look like a site-search constraint.
    if(mod.search_all)row.children[row.children.length-1].hidden=true;
    const type=document.createElement('select');
    for(const [value,text] of [['unknown',mod.name ? `Unresolved: ${mod.name}` : 'Unknown remnant'],['gg','GGisoK (ε-Gly-Gly lysine)'],['custom','Custom elemental change']]){const option=document.createElement('option');option.value=value;option.textContent=text;type.appendChild(option);}
    type.value=mod.kind|| (mod.delta===null?'unknown':'custom');
    type.onchange=()=>{mod.kind=type.value;mod.delta=type.value==='gg'?114.04292747:null;if(type.value==='gg'){mod.block_cleavage=true;mod.formula='C4H6N2O2';}peptideClearResults();peptideRenderLinkages();};label('Type ',type);
    const mass=document.createElement('input');mass.type='number';mass.step='0.000001';mass.placeholder='Unresolved';mass.value=mod.delta??'';mass.style.width='130px';mass.disabled=true;const massLabel=label('Calculated shift (Da) ',mass);
    const block=document.createElement('input');block.type='checkbox';block.checked=mod.block_cleavage===true;block.disabled=type.value==='gg';block.onchange=()=>{mod.block_cleavage=block.checked;peptideClearResults();};label('Blocks trypsin at this residue ',block);
    const search=document.createElement('input');search.type='checkbox';search.checked=mod.search_all===true;
    search.onchange=()=>{mod.search_all=search.checked;if(!search.checked&&mod.chain==='*')mod.chain='A';peptideClearResults();peptideRenderLinkages();
      document.getElementById('peptide-status').textContent=search.checked ? 'Site search configured. Click Map measured MS / MS/MS to reference to search all eligible residues in the selected chain(s); the written residue position is not used.' : 'Fixed-site mapping configured. Click Map measured MS / MS/MS to reference to recalculate.';
    };label('Find site across reference ',search);
    if(mod.search_all){const residues=document.createElement('input');residues.value=mod.kind==='gg'?'K':(mod.residues||'K');residues.disabled=mod.kind==='gg';residues.style.width='65px';residues.title='Eligible residues (e.g. K, ST or * for any residue)';residues.oninput=()=>{mod.residues=residues.value.toUpperCase();peptideClearResults();};label('At residues ',residues);}
    if(type.value==='custom'){
      const formula=document.createElement('input');formula.type='text';formula.value=mod.formula||'';formula.placeholder='C2H2O or H-2';formula.style.width='150px';
      formula.title='Net atoms added or removed relative to the existing residue, not the whole amino acid. Example: C2H2O adds acetyl; H-2 removes two hydrogens.';
      const formulaLabel=label('Chemical formula ',formula);row.insertBefore(formulaLabel,massLabel);
      const note=document.createElement('span');note.className='toolbar-note';row.appendChild(note);
      formula.oninput=async()=>{
        const value=formula.value;mod.formula=value;mod.delta=null;mass.value='';peptideClearResults();note.textContent='Calculating composition…';
        try{const parsed=await api.peptideModificationMass(value);if(mod.formula!==value||mod.kind!=='custom')return;mod.delta=parsed.delta;mass.value=Number(parsed.delta.toFixed(8));note.textContent='Net change relative to the original residue.';}
        catch(error){if(mod.formula===value)note.textContent=error.message;}
      };
      if(mod.formula&&mod.delta==null)formula.oninput();
    }
    const remove=document.createElement('button');remove.className='btn btn-sm';remove.textContent='Remove';remove.onclick=()=>{peptideView.modifications.splice(index,1);peptideClearResults();peptideRenderLinkages();};row.appendChild(remove);container.appendChild(row);
  });
}

function peptideClearResults() {
  peptideView.generation += 1;
  peptideView.results = null;
  document.getElementById('peptide-analysis-details').hidden=true;
  document.getElementById('peptide-analysis-warning').textContent='';
  peptideClearSpectrumExport();
  document.getElementById('btn-peptide-map-pdf').disabled=true;
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
  document.getElementById('peptide-import-status').textContent = '';
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

function peptideRenderCoverage(result, width = document.getElementById('peptide-coverage').clientWidth) {
  const coverage = document.getElementById('peptide-coverage'); coverage.replaceChildren();
  const columns = peptideCoverageColumns(width);
  peptideView.coverageColumns = columns;
  for (const chain of result.coverage) {
    coverage.appendChild(peptideRenderCoverageChain(result, chain, columns));
  }
}

function peptideInitCoverageResize() {
  if (typeof ResizeObserver === 'undefined') return;
  if (peptideCoverageObserver) peptideCoverageObserver.disconnect();
  const coverage = document.getElementById('peptide-coverage');
  peptideCoverageObserver = new ResizeObserver(entries => {
    const width = entries.find(entry => entry.target === coverage)?.contentRect.width;
    if (width > 0 && peptideView.results && peptideCoverageColumns(width) !== peptideView.coverageColumns) {
      // Reflow evidence only: never rerun matching, reset filters or reload spectra.
      peptideRenderCoverage(peptideView.results, width);
    }
  });
  peptideCoverageObserver.observe(coverage);
}

function peptideRender(result) {
  peptideRenderCoverage(result);
  peptideRenderTable(result);
  document.getElementById('btn-peptide-map-pdf').disabled=!result.coverage?.length;
}

function peptideClearSpectrumExport() {
  peptideView.selectedMatch=null;peptideView.selectedSpectrum=null;
  document.getElementById('btn-peptide-spectrum-pdf').disabled=true;
}

async function peptideExportPdf(kind) {
  const result=peptideView.results, row=peptideView.selectedMatch, spectrum=peptideView.selectedSpectrum;
  if(kind==='map' ? !result?.coverage?.length : !row || !spectrum)return;
  const button=document.getElementById(kind==='map'?'btn-peptide-map-pdf':'btn-peptide-spectrum-pdf');
  if(button.disabled)return;
  const sampleName=peptideView.path.split(/[\\/]/).pop() || 'sample';
  const payload={kind,sample_name:sampleName,style:buildCurrentDeconvStyle(),settings:result?.settings,reference_filter:result?.reference_filter};
  if(kind==='map')payload.chains=result.coverage.map(chain=>({...chain,
    spans:peptideCoverageSpans(result,chain).map(span=>({start:span.start,end:span.end,evidence:span.evidence,ms1_supported:span.row.ms1_supported !== false})),
    modification_sites:[...peptideCoverageModifications(result,chain).values()].map(({position,ambiguous})=>({position,ambiguous}))}));
  else Object.assign(payload,{row,spectrum});
  button.disabled=true;showLoading(kind==='map'?'Exporting peptide coverage map PDF…':'Exporting annotated peptide spectrum PDF…');
  try{
    const response=await api.exportPeptidePdf(payload);
    const blob=await backendResponseToBlob(response);
    downloadBlob(blob,`${sanitizeFilename(sampleName)}_peptide_${kind==='map'?'map':`scan_${row.scan_id}`}.pdf`);
    toast('Peptide PDF exported','success');
  }catch(error){toast(`PDF export failed: ${error.message}`,'error');}
  finally{
    button.disabled=kind==='map'?!peptideView.results?.coverage?.length:!peptideView.selectedSpectrum;
    hideLoading();
  }
}

const PEPTIDE_COLUMNS = [
  ['sequence','Peptide / modifications',21], ['locations','Locations',8], ['modification_sites','Protein modification sites',12], ['evidence','Evidence',8],
  ['time','Time (min)',7], ['charge','Charge*',5], ['precursor_mz','Precursor m/z',9],
  ['precursor_error_ppm','Precursor ppm',7], ['matched_ions','Matched ions',6],
  ['explained_intensity_pct','Explained intensity',8], ['ambiguous_scan','Review',9],
];

function peptideLocationText(row) { return row.locations.map(l=>`${l.chain}:${l.start}–${l.end}`).join(', '); }
function peptideModificationSiteText(row) {
  return row.locations.flatMap(location=>(row.modifications||[]).map(mod=>`${location.chain}:${location.start+mod.residue-1}${row.sequence[mod.residue-1]||''} (${mod.delta>=0?'+':''}${Number(mod.delta).toFixed(6)})${mod.variable?' · candidate':''}`)).join(', ') || '—';
}
function peptideEvidenceText(row) { return row.evidence === 'ms1' ? 'MS1 feature · candidate' : row.ms1_supported === false ? 'MS/MS · precursor unconfirmed' : 'MS/MS · linked'; }
function peptideReviewText(row) {
  return (row.sequence_ambiguous ?? row.ambiguous_scan) ? 'Competing sequence' : row.site_ambiguous ? 'Site unresolved' : 'No competing sequence';
}
const PEPTIDE_NUMERIC_COLUMNS = new Set(['time','charge','precursor_mz','precursor_error_ppm','matched_ions','explained_intensity_pct']);
function peptideColumnValue(row, key) {
  if (key === 'sequence') return `${row.sequence} ${(row.modifications || []).map(m=>`${m.residue}:${m.delta}`).join(' ')}`;
  if (key === 'locations') return peptideLocationText(row);
  if (key === 'modification_sites') return peptideModificationSiteText(row);
  if (key === 'evidence') return peptideEvidenceText(row);
  if (key === 'ambiguous_scan') return peptideReviewText(row);
  if (key === 'matched_ions' && row.evidence === 'ms1') return null;
  return row[key];
}
function peptideColumnFilterActive(filter) {
  return filter && [filter.text,filter.min,filter.max].some(value=>String(value ?? '').trim() !== '');
}
function peptideMatchesColumnFilters(row) {
  return Object.entries(peptideView.columnFilters || {}).every(([key,filter])=>{
    if (!peptideColumnFilterActive(filter)) return true;
    const value = peptideColumnValue(row,key);
    if (!PEPTIDE_NUMERIC_COLUMNS.has(key)) return String(value ?? '').toLowerCase().includes(String(filter.text || '').trim().toLowerCase());
    if (value == null || !Number.isFinite(Number(value))) return false;
    return ['min','max'].every(bound=>{
      const input=String(filter[bound] ?? '').trim();
      if (!input) return true;
      const limit=Number(input);
      return Number.isFinite(limit) && (bound === 'min' ? Number(value) >= limit : Number(value) <= limit);
    });
  });
}
function peptideFilteredRows(result) {
  const filters = peptideView.filters, query = filters.text.trim().toLowerCase();
  const rows = result.matches.filter(row => {
    const searchable = `${row.sequence} ${peptideLocationText(row)} ${peptideModificationSiteText(row)} ${row.modifications.map(m=>`${m.residue}:${m.delta}`).join(' ')}`.toLowerCase();
    return (!query || searchable.includes(query)) && (!filters.evidence || (row.evidence || 'msms') === filters.evidence)
      && (!filters.charge || row.charge === Number(filters.charge))
      && (!filters.review || (filters.review === 'site' ? row.site_ambiguous === true : Boolean(row.sequence_ambiguous ?? row.ambiguous_scan) === (filters.review === 'competing')))
      && peptideMatchesColumnFilters(row);
  });
  const {key, direction} = peptideView.sort;
  const value = row => peptideColumnValue(row,key);
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
    ['review','Assignments ',[['','All'],['unambiguous','No competing sequence'],['competing','Competing sequences'],['site','Unresolved modification site']]],
  ]) {
    const select=document.createElement('select');
    for (const [value,label] of options) { const option=document.createElement('option');option.value=value;option.textContent=label;select.appendChild(option); }
    select.value=peptideView.filters[key];
    select.addEventListener('change',()=>{peptideView.filters[key]=select.value;updateRows();}); control(label,select);
  }
  const reset=document.createElement('button');reset.type='button';reset.className='btn btn-sm';reset.textContent='Reset filters';
  reset.addEventListener('click',()=>{peptideView.filters={text:'',evidence:'',charge:'',review:''};peptideView.columnFilters={};peptideRenderTable(result);});toolbar.appendChild(reset);
  const count=document.createElement('span');count.className='toolbar-note';count.setAttribute('role','status');toolbar.appendChild(count);container.appendChild(toolbar);
  const editor=document.createElement('div');editor.className='tab-toolbar peptide-column-filter-editor';editor.id='peptide-column-filter-editor';editor.hidden=true;container.appendChild(editor);
  let openFilter=null;
  function closeFilter() {
    openFilter=null;editor.hidden=true;editor.replaceChildren();
    for (const {filterButton} of headers) filterButton.setAttribute('aria-expanded','false');
  }
  function editFilter(key,label) {
    if(openFilter===key){closeFilter();return;}
    closeFilter();openFilter=key;editor.hidden=false;
    const title=document.createElement('strong');title.textContent=`Filter: ${label}`;editor.appendChild(title);
    const current=peptideView.columnFilters[key] || {};
    let firstInput;
    for(const [field,caption] of PEPTIDE_NUMERIC_COLUMNS.has(key)?[['min','Minimum (inclusive)'],['max','Maximum (inclusive)']]:[['text','Contains']]){
      const labelNode=document.createElement('label');labelNode.textContent=caption+' ';
      const input=document.createElement('input');input.type=field==='text'?'search':'number';input.step='any';input.value=current[field] || '';
      input.setAttribute('aria-label',`${label}: ${caption}`);
      input.addEventListener('input',()=>{
        peptideView.columnFilters[key]={...(peptideView.columnFilters[key] || {}),[field]:input.value};updateRows();
      });
      labelNode.appendChild(input);editor.appendChild(labelNode);firstInput ||= input;
    }
    const clear=document.createElement('button');clear.type='button';clear.className='btn btn-sm';clear.textContent='Clear this filter';
    clear.addEventListener('click',()=>{delete peptideView.columnFilters[key];closeFilter();updateRows();});editor.appendChild(clear);
    const done=document.createElement('button');done.type='button';done.className='btn btn-sm';done.textContent='Done';done.addEventListener('click',closeFilter);editor.appendChild(done);
    editor.onkeydown=event=>{if(event.key==='Escape'){closeFilter();headers.find(h=>h.key===key)?.filterButton.focus();}};
    headers.find(h=>h.key===key)?.filterButton.setAttribute('aria-expanded','true');firstInput?.focus();
  }
  const scroll=document.createElement('div');scroll.className='peptide-table-scroll';container.appendChild(scroll);
  const table = document.createElement('table'); table.className = 'data-table peptide-results-table';scroll.appendChild(table);
  const colgroup = document.createElement('colgroup'); table.appendChild(colgroup);
  for (const [,,width] of PEPTIDE_COLUMNS) {
    const col = document.createElement('col'); col.style.width = `${width}%`; colgroup.appendChild(col);
  }
  const header = table.createTHead().insertRow();
  const headers=[];
  for (const [key,label] of PEPTIDE_COLUMNS) {
    const th=document.createElement('th');th.scope='col';
    const button=document.createElement('button');button.type='button';button.className='peptide-sort-button';
    if(key==='precursor_mz')button.title='Recorded MS/MS precursor m/z, or measured MS1 peak m/z for tentative MS-only matches';
    button.addEventListener('click',()=>{peptideView.sort={key,direction:peptideView.sort.key===key ? -peptideView.sort.direction : 1};updateRows();});
    const controls=document.createElement('div');controls.className='peptide-column-heading';controls.appendChild(button);
    const filterButton=document.createElement('button');filterButton.type='button';filterButton.className='peptide-filter-button';
    filterButton.setAttribute('aria-label',`Filter ${label}`);filterButton.setAttribute('aria-controls',editor.id);filterButton.setAttribute('aria-expanded','false');
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 16 16');icon.setAttribute('aria-hidden','true');
    const funnel=document.createElementNS('http://www.w3.org/2000/svg','path');funnel.setAttribute('d','M2 3h12L9.5 8v5l-3-1V8Z');icon.appendChild(funnel);filterButton.appendChild(icon);
    filterButton.addEventListener('click',()=>editFilter(key,label));controls.appendChild(filterButton);
    th.appendChild(controls);header.appendChild(th);headers.push({th,button,filterButton,key,label});
  }
  const body = table.createTBody();
  const empty=document.createElement('p');container.appendChild(empty);
  function updateRows() {
    const visible=peptideFilteredRows(result);body.replaceChildren();count.textContent=`${visible.length} of ${result.matches.length} matches`;
    for(const {th,button,filterButton,key,label} of headers) {
      const selected=peptideView.sort.key===key;
      th.setAttribute('aria-sort',selected ? (peptideView.sort.direction===1 ? 'ascending' : 'descending') : 'none');
      button.textContent=label+(selected ? (peptideView.sort.direction===1 ? ' ↑' : ' ↓') : ' ↕');
      const filter=peptideView.columnFilters[key],active=peptideColumnFilterActive(filter);
      filterButton.classList.toggle('is-active',Boolean(active));filterButton.setAttribute('aria-pressed',String(Boolean(active)));
      filterButton.title=`Filter ${label}`+(active ? `: ${PEPTIDE_NUMERIC_COLUMNS.has(key) ? `${filter.min || '−∞'} to ${filter.max || '∞'}` : filter.text}` : '');
    }
    visible.forEach(row => {
    const tr = body.insertRow();
    const mods = row.modifications.map(m=>`${m.residue}:${m.delta > 0 ? '+' : ''}${m.delta}`).join(', ');
    const values = [row.sequence + (mods ? ` [${mods}]` : ''), peptideLocationText(row), peptideModificationSiteText(row), peptideEvidenceText(row), row.time.toFixed(3), `+${row.charge}`, row.precursor_mz.toFixed(5), row.precursor_error_ppm.toFixed(2), row.evidence==='ms1' ? '—' : row.matched_ions, row.explained_intensity_pct == null ? '—' : `${row.explained_intensity_pct.toFixed(1)}%`];
    values.forEach(value => { const cell = tr.insertCell(); cell.textContent = value; cell.title = String(value); });
    const button = document.createElement('button'); button.type='button';button.className = 'btn btn-sm'; button.textContent = (row.evidence==='ms1' ? 'View MS peak' : 'View fragments')+((row.sequence_ambiguous ?? row.ambiguous_scan) ? ' · competing sequence' : row.site_ambiguous ? ' · site unresolved' : '');
    button.addEventListener('click',()=>peptideShowMatch(row)); tr.insertCell().appendChild(button);
    });
    empty.textContent=visible.length ? '' : result.matches.length ? 'No matches fit these filters. Reset filters to show all results.' : 'No candidates passed the current mass or fragment evidence thresholds.';
  }
  search.addEventListener('input',()=>{peptideView.filters.text=search.value;updateRows();});updateRows();
}

async function peptideAnalyze() {
  if(peptideView.analyzing)return;
  peptideClearResults(); const generation=peptideView.generation;
  const status=document.getElementById('peptide-status'),button=document.getElementById('btn-peptide-analyze');
  const searching=peptideView.modifications.some(mod=>mod.search_all);
  status.textContent=searching?'Searching eligible modification sites across the reference and matching MS/MS…':'Comparing measured MS and MS/MS with the supplied sequence…';
  peptideView.analyzing=true;button.disabled=true;button.setAttribute('aria-busy','true');showLoading(status.textContent);
  try {
    const path=document.getElementById('peptide-sample-select').value;
    const relative=document.getElementById('peptide-ms1-relative').value;
    const intensity=document.getElementById('peptide-ms1-intensity').value;
    if(!String(relative).trim()||!String(intensity).trim())throw new Error('Enter both MS-only thresholds; use 0 to disable a cutoff.');
    const result=await api.analyzePeptides({ path, fasta:document.getElementById('peptide-fasta').value, modifications:peptideView.modifications, missed_cleavages:Number(document.getElementById('peptide-missed').value), precursor_ppm:Number(document.getElementById('peptide-precursor-ppm').value), fragment_ppm:Number(document.getElementById('peptide-fragment-ppm').value), ms1_min_relative_percent:Number(relative), ms1_min_intensity:Number(intensity),
      preparation:{reduced:document.getElementById('peptide-reduction').value!=='unreduced',iam:document.getElementById('peptide-iam').checked,disulfides:document.getElementById('peptide-disulfides').value} });
    if (generation !== peptideView.generation) return;
    Object.assign(peptideView,{results:result,path});
    status.textContent=`${result.matches.filter(r=>r.evidence!=='ms1').length} MS/MS matches · ${result.matches.filter(r=>r.evidence==='ms1').length} MS-only candidates`;
    const details=document.getElementById('peptide-analysis-details');details.hidden=false;details.open=false;
    document.getElementById('peptide-analysis-warning').textContent=`${result.excluded_modified_peptides} peptides excluded. ${result.settings?.searched_modification_sites || 0} modification sites searched. ${result.settings?.preparation?.description || ''} ${result.warning || ''}`;
    peptideRender(result);
  } catch(error) { if(generation===peptideView.generation) status.textContent=error.message; }
  finally{peptideView.analyzing=false;button.disabled=false;button.setAttribute('aria-busy','false');hideLoading();}
}

function peptideSpectrumLayout(maximum) {
  return {...WEBAPP_LAYOUT, height:430, showlegend:false,
    margin:{...WEBAPP_LAYOUT.margin, b:72},
    xaxis:{...WEBAPP_LAYOUT.xaxis, title:{text:'Mass-to-charge (m/z)',standoff:10}, automargin:true, showgrid:false},
    yaxis:{...WEBAPP_LAYOUT.yaxis, title:'Counts',showgrid:false,range:[0,maximum>0?maximum*1.25:1]}};
}

async function peptideShowMatch(row) {
  const generation=++peptideView.generation;
  peptideClearSpectrumExport();
  peptideClearIonSequence();
  const msOnly=row.evidence==='ms1';
  document.getElementById('peptide-spectrum-status').textContent=msOnly ? 'Loading measured MS survey…' : 'Loading measured fragment spectrum…';
  qtofClearPlot('peptide-spectrum-plot');
  try {
    const spectrum=await api.getQtofSpectrum(peptideView.path,row.scan_id,'positive');
    if(generation!==peptideView.generation)return;
    const isotopePeaks=row.isotope_peaks || [{mz:row.precursor_mz,intensity:row.precursor_intensity,offset:row.isotope_offset}];
    const overlays=msOnly ? [{x:isotopePeaks.map(p=>p.mz),y:isotopePeaks.map(p=>p.intensity),text:isotopePeaks.map(p=>`M${p.offset?`+${p.offset}`:''} · +${row.charge}`),mode:'markers+text',textposition:'top center',marker:{color:'#48a66b',size:7},type:'scatter'}] : peptideFragmentTraces(row);
    const maximum=spectrum.intensities.reduce((a,b)=>Math.max(a,b),0);
    await Plotly.react('peptide-spectrum-plot',[qtofStickTrace(spectrum),...overlays],peptideSpectrumLayout(maximum),PLOT_CONFIG);
    if(generation!==peptideView.generation)return;
    if(!msOnly)peptideRenderIonSequence(row);
    peptideView.selectedMatch=row;peptideView.selectedSpectrum=spectrum;
    document.getElementById('btn-peptide-spectrum-pdf').disabled=false;
    document.getElementById('peptide-spectrum-status').textContent=msOnly
      ? `${row.sequence} · MS1 feature apex: scan ${row.scan_id} · ${row.time.toFixed(4)} min · m/z ${row.precursor_mz.toFixed(5)} · +${row.charge}, isotope offset ${row.isotope_offset}. ${Number(row.precursor_intensity).toPrecision(5)} counts${row.precursor_relative_intensity_pct==null?'':` (${row.precursor_relative_intensity_pct.toFixed(2)}% of scan maximum)`}. ${row.isotope_count} required isotope peaks across ${row.observation_count} consecutive surveys (${row.time_start.toFixed(3)}–${row.time_end.toFixed(3)} min); envelope fit ${(100*row.isotope_fit).toFixed(1)}%. No linked MS/MS: peptide sequence remains a candidate.`
      : `${row.sequence} · measured MS/MS scan ${row.scan_id} · ${row.time.toFixed(4)} min · precursor m/z ${row.precursor_mz.toFixed(5)}, inferred +${row.charge}. ${row.ms1_supported ? `MS1 feature linked (${row.precursor_link}); ${row.precursor_feature.observation_count} surveys.` : 'Precursor feature unconfirmed; excluded from MS feature coverage.'} Blue b / red y labels are candidate matches. Precursor isotope offset: ${row.isotope_offset}.`;
  } catch(error) { if(generation===peptideView.generation)document.getElementById('peptide-spectrum-status').textContent=error.message; }
}

function initPeptideMapping() {
  for(const id of ['peptide-reduction','peptide-iam','peptide-disulfides'])document.getElementById(id).addEventListener('input',()=>{
    peptideClearResults();document.getElementById('peptide-disulfides-label').hidden=document.getElementById('peptide-reduction').value!=='unreduced';
  });
  peptideInitCoverageResize();
  document.getElementById('btn-peptide-map-pdf').addEventListener('click',()=>peptideExportPdf('map'));
  document.getElementById('btn-peptide-spectrum-pdf').addEventListener('click',()=>peptideExportPdf('spectrum'));
  document.getElementById('btn-peptide-import').addEventListener('click',peptideImport);
  document.getElementById('btn-peptide-analyze').addEventListener('click',peptideAnalyze);
  document.getElementById('peptide-reference-select').addEventListener('change',e=>peptideUseReference(Number(e.target.value)));
  document.getElementById('peptide-sample-select').addEventListener('change',()=>{ peptideClearResults(); peptideView.references=[];document.getElementById('peptide-reference-select').replaceChildren();document.getElementById('peptide-import-status').textContent='Reference retained; verify it belongs to the newly selected sample before analysis.'; });
  document.getElementById('btn-peptide-add-linkage').addEventListener('click',()=>{peptideView.modifications.push({chain:'A',position:1,delta:null,kind:'custom',block_cleavage:false});peptideClearResults();peptideRenderLinkages();});
  for(const id of ['peptide-fasta','peptide-missed','peptide-precursor-ppm','peptide-fragment-ppm','peptide-ms1-relative','peptide-ms1-intensity'])document.getElementById(id).addEventListener('input',peptideClearResults);
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
