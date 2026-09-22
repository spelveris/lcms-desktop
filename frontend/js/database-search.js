/* Optional local MS/MS database identification, separate from reference mapping. */
const databaseSearchView = { job: null, result: null, timer: null, generation: 0, requestEpoch: 0, selected: '', initialized: false, locks: new Map() };
const DATABASE_SEARCH_ACTIVE = new Set(['preparing','searching','scoring','cancelling']);

function databaseSearchMode() { return document.getElementById('peptide-analysis-mode').value === 'database'; }

function databaseSearchSampleChanged() {
  databaseSearchView.generation++;
  if(databaseSearchView.initialized)databaseSearchRender();
}

function databaseSearchSetMode() {
  const enabled = databaseSearchMode();
  databaseSearchView.generation++;
  peptideClearResults();
  document.querySelectorAll('.peptide-reference-only').forEach(node => { node.hidden = enabled; });
  document.getElementById('database-search-panel').hidden = !enabled;
  document.getElementById('database-search-settings').hidden = !enabled;
  databaseSearchRender();
}

function databaseSearchSettings() {
  const fields = {precursor_ppm:'ppm',fragment_bin_da:'bin',missed_cleavages:'missed',charge_min:'charge-min',charge_max:'charge-max',min_length:'length-min',max_length:'length-max',q_threshold:'q'};
  const result = {};
  for (const [key, suffix] of Object.entries(fields)) {
    const value = document.getElementById(`database-search-${suffix}`).value;
    if (!String(value).trim() || !Number.isFinite(Number(value))) throw Error('Enter every database-search setting.');
    result[key] = Number(value);
  }
  result.semi_tryptic = document.getElementById('database-search-semi').checked;
  return result;
}

function databaseSearchLock(active) {
  const locks = databaseSearchView.locks;
  if (active && !locks.size) {
    const controls = [...document.querySelectorAll('#peptide-modification-settings input, #peptide-modification-settings select, #database-search-settings input, #database-search-settings select'),
      document.getElementById('peptide-sample-select'), document.getElementById('peptide-analysis-mode')];
    for (const node of controls) { locks.set(node,node.disabled); node.disabled=true; }
  } else if (!active) {
    for (const [node, disabled] of locks) node.disabled=disabled;
    locks.clear();
  }
}

function databaseSearchRender() {
  const state = databaseSearchView, job = state.job, active = DATABASE_SEARCH_ACTIVE.has(job?.state);
  databaseSearchLock(active);
  document.getElementById('btn-database-search').disabled = active;
  document.getElementById('btn-database-search-cancel').hidden = !active;
  document.getElementById('btn-database-search-cancel').disabled = job?.state==='cancelling';
  document.getElementById('database-search-progress').hidden = !active;
  const status=document.getElementById('database-search-status');
  if (job) status.textContent = job.state==='failed' ? `Search failed: ${job.error}` : job.message;
  const matchesSample = state.result?.path === document.getElementById('peptide-sample-select').value;
  document.getElementById('database-search-results').hidden = !matchesSample;
}

async function databaseSearchPoll() {
  clearTimeout(databaseSearchView.timer);
  const epoch=databaseSearchView.requestEpoch;
  try {
    const snapshot = await api.databaseSearchStatus();
    if(epoch!==databaseSearchView.requestEpoch)return;
    databaseSearchView.job=snapshot.job;
    databaseSearchRender();
    if (snapshot.job?.state==='complete' && databaseSearchView.result?.id!==snapshot.job.id) {
      const result=await api.databaseSearchResults(snapshot.job.id);
      if(epoch!==databaseSearchView.requestEpoch || databaseSearchView.job?.id!==result.id)return;
      databaseSearchView.result=result; databaseSearchView.selected='';
      databaseSearchRenderResults(); databaseSearchRender();
    }
    if (DATABASE_SEARCH_ACTIVE.has(snapshot.job?.state)) databaseSearchView.timer=setTimeout(databaseSearchPoll,1000);
  } catch (error) {
    if(epoch!==databaseSearchView.requestEpoch)return;
    document.getElementById('database-search-status').textContent=`Cannot refresh search status: ${error.message}`;
    // Do not repeat the search POST after a dropped connection.
    if(DATABASE_SEARCH_ACTIVE.has(databaseSearchView.job?.state)) databaseSearchView.timer=setTimeout(databaseSearchPoll,3000);
  }
}

async function databaseSearchStart() {
  if (DATABASE_SEARCH_ACTIVE.has(databaseSearchView.job?.state)) return;
  const status=document.getElementById('database-search-status'), button=document.getElementById('btn-database-search');
  button.disabled=true;
  try {
    const database = proteinDatabaseView.snapshot && proteinDatabaseSelection(proteinDatabaseView.snapshot);
    if (!database?.installed) throw Error('Choose an organism and download its database first.');
    const path=document.getElementById('peptide-sample-select').value;
    if(!path)throw Error('Load a QTOF protein digest first.');
    const payload={path,database_id:database.id,settings:databaseSearchSettings(),
      preparation:{reduced:document.getElementById('peptide-reduction').value==='reduced',iam:document.getElementById('peptide-iam').checked},
      variable_modifications:peptideReadVariableModifications()};
    databaseSearchView.requestEpoch++;clearTimeout(databaseSearchView.timer);
    databaseSearchView.generation++;peptideClearResults();databaseSearchView.result=null;
    document.getElementById('database-search-results').replaceChildren();
    status.textContent='Starting local database search…';
    databaseSearchView.job=(await api.startDatabaseSearch(payload)).job;
    databaseSearchRender();void databaseSearchPoll();
  } catch(error) {
    status.textContent=error.message;
    // If the server accepted a request whose response was lost, recover its job.
    try { const current=await api.databaseSearchStatus(); if(DATABASE_SEARCH_ACTIVE.has(current.job?.state)){databaseSearchView.job=current.job;databaseSearchRender();void databaseSearchPoll();} } catch(_) {}
  } finally { if(!DATABASE_SEARCH_ACTIVE.has(databaseSearchView.job?.state))button.disabled=false; }
}

function databaseSearchVisiblePsms(result, accession, unfiltered) {
  return result.psms.filter(row => (unfiltered || row.passes_psm_q) && (!accession || row.proteins.includes(accession)));
}

function databaseSearchUseReference(protein) {
  document.getElementById('peptide-fasta').value=`>${protein.header}\n${protein.sequence}`;
  peptideView.modifications=[];peptideRenderLinkages();
  document.getElementById('peptide-analysis-mode').value='reference';databaseSearchSetMode();
  document.getElementById('peptide-import-status').textContent=`Database candidate loaded: ${protein.accession}. Map the supplied reference separately; database q-values do not transfer to new mapping results.`;
}

function databaseSearchRenderResults() {
  const result=databaseSearchView.result, host=document.getElementById('database-search-results');
  host.replaceChildren();if(!result)return;
  function node(tag,text,parent=host){const element=document.createElement(tag);if(text!==undefined)element.textContent=text;parent.appendChild(element);return element;}
  const summary=node('p',`${result.accepted_psms} MS/MS spectrum matches pass ${(result.settings.q_threshold*100).toFixed(0)}% spectrum q · ${result.accepted_peptides} distinct peptides pass the separate peptide-q threshold`);
  summary.title=result.confidence;
  node('p',`${result.path.split(/[\\/]/).pop()} · ${result.database.database_id} · UniProt ${result.database.uniprot_release}`);
  const details=node('details');node('summary','Search confidence & settings',details);
  node('p',result.confidence,details);
  node('p',`Comet ${result.engine_version} · UniProt ${result.database.uniprot_release} · ${result.database.protein_count.toLocaleString()} sequences · ${result.searched_scans} spectra · ${result.decoy_winners} decoy winners · ${result.settings.semi_tryptic?'semi-tryptic':'fully tryptic'} · precursor ±${result.settings.precursor_ppm} ppm · fragments ${result.settings.fragment_bin_da} Da bins`,details);
  const filter=node('label','');const checkbox=document.createElement('input');checkbox.type='checkbox';filter.appendChild(checkbox);filter.appendChild(document.createTextNode(' Show unfiltered candidates'));
  const proteinHost=node('div');proteinHost.className='database-search-scroll';
  const peptideHost=node('div');peptideHost.className='database-search-scroll';
  const selected=node('p','');let page=0;
  const paging=node('div');paging.className='peptide-export-toolbar';
  const previous=node('button','← Previous',paging), next=node('button','Next →',paging), pageLabel=node('span','',paging);
  for(const button of [previous,next]){button.type='button';button.className='btn btn-sm';}
  function table(parent,headings){const table=node('table',undefined,parent);table.className='database-search-table';const header=node('tr',undefined,node('thead',undefined,table));for(const heading of headings)node('th',heading,header);return node('tbody',undefined,table);}
  function showPsms(){
    peptideHost.replaceChildren();const rows=databaseSearchVisiblePsms(result,databaseSearchView.selected,checkbox.checked), size=150;
    const pages=Math.max(1,Math.ceil(rows.length/size));page=Math.min(page,pages-1);
    selected.textContent=databaseSearchView.selected ? `MS/MS matches for ${databaseSearchView.selected}` : 'MS/MS matches for all protein candidates';
    const body=table(peptideHost,['Peptide / modifications','Time (min)','Charge','Measured m/z','Spectrum q','Peptide q','E-value']);
    for(const row of rows.slice(page*size,(page+1)*size)){
      const tr=node('tr',undefined,body), cell=node('td',undefined,tr), button=node('button',row.modified_sequence,cell);
      button.type='button';button.className='btn btn-sm';button.addEventListener('click',()=>databaseSearchShowSpectrum(row));
      for(const value of [row.time.toFixed(4),`+${row.charge}`,row.precursor_mz.toFixed(5),(row.psm_q*100).toFixed(2)+'%',(row.peptide_q*100).toFixed(2)+'%',row.evalue.toExponential(2)])node('td',value,tr);
    }
    pageLabel.textContent=`${rows.length} matches · page ${page+1}/${pages}`;previous.disabled=page===0;next.disabled=page>=pages-1;
  }
  function showProteins(){
    proteinHost.replaceChildren();const proteins=result.proteins.filter(p=>checkbox.checked||p.accepted_psms>0);
    if(!proteins.length)node('p','No protein candidates have MS/MS matches passing this spectrum-q threshold.',proteinHost);
    const body=table(proteinHost,['Protein candidate','Supported peptides','Exclusive peptides','Accepted MS/MS','Coverage','']);
    const all=node('button','All proteins',proteinHost);all.type='button';all.className='btn btn-sm';all.addEventListener('click',()=>{databaseSearchView.selected='';page=0;showPsms();});
    for(const protein of proteins){
      const tr=node('tr',undefined,body), cell=node('td',undefined,tr), choose=node('button',protein.accession,cell);
      choose.type='button';choose.className='btn btn-sm';choose.title=protein.header;
      choose.addEventListener('click',()=>{databaseSearchView.selected=protein.accession;page=0;showPsms();});
      for(const value of [protein.peptides,protein.exclusive_peptides,protein.accepted_psms,protein.coverage_percent.toFixed(1)+'%'])node('td',String(value),tr);
      const use=node('button','Use as reference',node('td',undefined,tr));use.type='button';use.className='btn btn-sm';
      use.disabled=!protein.accepted_psms || protein.sequence.length>10000 || /[^ACDEFGHIKLMNPQRSTVWY]/.test(protein.sequence);
      if(use.disabled)use.title='Needs an accepted spectrum match and a reference supported by the single-protein mapper.';
      use.addEventListener('click',()=>databaseSearchUseReference(protein));
    }
    showPsms();
  }
  checkbox.addEventListener('change',()=>{page=0;showProteins();});previous.addEventListener('click',()=>{page--;showPsms();});next.addEventListener('click',()=>{page++;showPsms();});showProteins();
}

async function databaseSearchShowSpectrum(psm) {
  const result=databaseSearchView.result, generation=++databaseSearchView.generation;
  if(!result || result.path!==document.getElementById('peptide-sample-select').value)return;
  peptideClearResults();
  const status=document.getElementById('peptide-spectrum-status');status.textContent='Loading matched measured MS/MS spectrum…';
  try {
    const row=await api.databaseSearchSpectrum(result.id,psm.scan_id);
    if(generation!==databaseSearchView.generation || !databaseSearchMode())return;
    const spectrum=row.spectrum;const maximum=spectrum.intensities.reduce((a,b)=>Math.max(a,b),0);
    document.getElementById('peptide-spectrum-card').hidden=false;
    await Plotly.react('peptide-spectrum-plot',[qtofStickTrace(spectrum),...peptideFragmentTraces(row)],peptideSpectrumLayout(maximum),PLOT_CONFIG);
    if(generation!==databaseSearchView.generation || !databaseSearchMode())return;
    peptideRenderIonSequence(row);
    Object.assign(peptideView,{path:result.path,selectedMatch:row,selectedSpectrum:spectrum});
    peptideSetExportAvailable('spectrum',true);
    status.textContent=`${row.sequence} · measured MS/MS ${row.scan_id} · ${row.time.toFixed(4)} min · m/z ${row.precursor_mz.toFixed(5)} · +${row.charge} · spectrum q ${(row.psm_q*100).toFixed(2)}%, peptide q ${(row.peptide_q*100).toFixed(2)}%. b/y display matches: ±${row.annotation_ppm} ppm; modification sites are search assignments.`;
  } catch(error){if(generation===databaseSearchView.generation)status.textContent=error.message;}
}

function initDatabaseSearch() {
  if(databaseSearchView.initialized)return;databaseSearchView.initialized=true;
  document.getElementById('peptide-analysis-mode').addEventListener('change',databaseSearchSetMode);
  document.getElementById('btn-database-search').addEventListener('click',databaseSearchStart);
  document.getElementById('btn-database-search-cancel').addEventListener('click',async()=>{
    try {databaseSearchView.job=(await api.cancelDatabaseSearch(databaseSearchView.job.id)).job;databaseSearchRender();}
    catch(error){document.getElementById('database-search-status').textContent=error.message;}
  });
  document.getElementById('peptide-sample-select').addEventListener('change',databaseSearchSampleChanged);
  databaseSearchSetMode();void databaseSearchPoll();
}
