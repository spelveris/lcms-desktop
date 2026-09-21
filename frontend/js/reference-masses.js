/* One persisted per-run policy for every downstream QTOF analysis. */
const referenceView = { generation: 0, dirty: false, peptidePath: '', referencePath: '', metadata: {} };
const REFERENCE_DRAFT_KEY = 'catrupole-reference-refresh-draft';
const REFERENCE_PEPTIDE_INPUTS = ['peptide-fasta','peptide-missed','peptide-precursor-ppm','peptide-fragment-ppm','peptide-ms1-relative','peptide-ms1-intensity','peptide-reduction','peptide-disulfides'];

function referencePolicyFromControls() {
  const mode = document.getElementById('reference-masses-mode').value;
  const polarity = document.getElementById('reference-masses-polarity').value;
  const charge = Number(document.getElementById('reference-masses-charge').value);
  const targets = mode === 'custom'
    ? document.getElementById('reference-masses-values').value.split(',').map(s=>s.trim()).filter(Boolean).map(s=>({mz:Number(s),polarity,charge})) : [];
  const policy = { mode, ppm:Number(document.getElementById('reference-masses-ppm').value),
    isotopes:document.getElementById('reference-masses-isotopes').checked, targets };
  if (!Number.isFinite(policy.ppm) || policy.ppm < 1 || policy.ppm > 50) throw new Error('Use 1–50 ppm for reference exclusion.');
  if (mode === 'custom' && (!targets.length || targets.length > 16 || targets.some(t=>!Number.isFinite(t.mz)||t.mz<1||t.mz>100000)
      || !Number.isInteger(charge) || charge<1 || charge>6)) throw new Error('Enter 1–16 valid reference m/z values and a reference charge from 1 to 6.');
  return policy;
}

function referenceRender(report, preview=false) {
  const status = document.getElementById('reference-masses-status');
  if (!report) { status.textContent='Load a QTOF sample to check reference ions.'; return; }
  referenceView.dirty=preview;
  const policy=report.policy;
  document.getElementById('reference-masses-mode').value=policy.mode;
  document.getElementById('reference-masses-ppm').value=policy.ppm;
  document.getElementById('reference-masses-isotopes').checked=policy.isotopes;
  document.getElementById('reference-masses-values').value=policy.targets.map(t=>t.mz).join(', ');
  document.getElementById('reference-masses-polarity').value=policy.targets[0]?.polarity || 'positive';
  document.getElementById('reference-masses-charge').value=policy.targets[0]?.charge || 1;
  document.getElementById('reference-masses-custom').hidden=policy.mode!=='custom';
  document.getElementById('reference-masses-summary').textContent=preview ? '· preview — not applied' : report.active ? '· exclusion active' : '· no ions excluded';
  status.textContent=`${report.removed_peaks} reference-window peaks and ${report.removed_msms_scans} reference-precursor MS/MS scans ${preview?'would be excluded (preview only)':'excluded'}.`;
  if(policy.mode==='auto'&&!report.active)status.textContent+=' No active acquisition references found; choose a preset or custom m/z.';
  if(report.method.warning)status.textContent+=` ${report.method.warning}`;
  const container=document.getElementById('reference-masses-detections');container.replaceChildren();
  const table=document.createElement('table');table.className='data-table';container.appendChild(table);
  const header=table.createTHead().insertRow();
  for(const label of ['Reference m/z','Polarity','Measured signal','Median observed m/z','Error (ppm)','Analysis']){
    const th=document.createElement('th');th.textContent=label;header.appendChild(th);
  }
  const body=table.createTBody();
  for(const ion of report.detections){
    const row=body.insertRow();
    const values=[ion.mz.toFixed(6),ion.polarity,
      ion.found?`Found in ${ion.matched_scans}/${ion.total_scans} MS scans`:'Not found',
      ion.observed_mz==null?'—':ion.observed_mz.toFixed(6),ion.error_ppm==null?'—':ion.error_ppm.toFixed(2),
      ion.selected?(preview?'Would exclude':'Excluded window'):'Not selected'];
    for(const value of values)row.insertCell().textContent=value;
  }
}

function referenceSyncSamples(files, metadata) {
  referenceView.metadata=metadata;
  const eligible=files.filter(file=>metadata[file.path]?.qtof);
  const panel=document.getElementById('reference-masses-panel');panel.hidden=!eligible.length;
  const select=document.getElementById('reference-masses-sample'),previous=select.value;
  select.replaceChildren();
  for(const file of eligible){const option=document.createElement('option');option.value=file.path;option.textContent=file.name;select.appendChild(option);}
  if(eligible.some(file=>file.path===previous))select.value=previous;
  if(eligible.some(file=>file.path===referenceView.referencePath)){select.value=referenceView.referencePath;referenceView.referencePath='';}
  if(select.value!==previous){referenceView.generation++;referenceView.dirty=false;}
  if(select.value&&!referenceView.dirty)referenceRender(metadata[select.value]?.qtof?.reference_filter);
  if(referenceView.peptidePath&&document.getElementById('peptide-sample-select').options){
    const peptide=document.getElementById('peptide-sample-select');
    if([...peptide.options].some(option=>option.value===referenceView.peptidePath)){
      peptide.value=referenceView.peptidePath;referenceView.peptidePath='';
    }
  }
}

async function referenceDetect() {
  const generation=++referenceView.generation,path=document.getElementById('reference-masses-sample').value;
  const status=document.getElementById('reference-masses-status');status.textContent='Checking measured MS1 peaks…';
  try {
    const report=await api.previewReferenceMasses(path,referencePolicyFromControls());
    if(generation!==referenceView.generation)return;
    referenceRender(report,true);
  } catch(error){if(generation===referenceView.generation)status.textContent=error.message;}
}

async function referenceApply() {
  const status=document.getElementById('reference-masses-status'),button=document.getElementById('reference-masses-apply');
  try {
    const policy=referencePolicyFromControls(),path=document.getElementById('reference-masses-sample').value;
    if(!path)throw new Error('Select a loaded QTOF run.');
    referenceView.generation++;
    button.disabled=true;status.textContent='Applying reference exclusion…';
    if(typeof showLoading==='function')showLoading('Applying reference-ion settings…');
    // Preserve the user's editable peptide inputs, but never stale analysis results.
    const draft={path:document.getElementById('peptide-sample-select').value, referencePath:path,
      referenceOpen:document.getElementById('reference-masses-panel').open, modifications:peptideView.modifications,
      iam:document.getElementById('peptide-iam').checked,
      values:Object.fromEntries(REFERENCE_PEPTIDE_INPUTS.map(id=>[id,document.getElementById(id).value]))};
    sessionStorage.setItem(REFERENCE_DRAFT_KEY,JSON.stringify(draft));
    await api.setReferenceMasses(path,policy);
    // A renderer refresh cancels old requests and clears every result/export cache.
    // It neither quits nor updates the installed application.
    window.location.reload();
  } catch(error){try{sessionStorage.removeItem(REFERENCE_DRAFT_KEY);}catch(_){}if(typeof hideLoading==='function')hideLoading();status.textContent=error.message;button.disabled=false;}
}

function initReferenceMasses() {
  document.getElementById('reference-masses-sample').addEventListener('change',()=>{
    referenceView.generation++;const path=document.getElementById('reference-masses-sample').value;
    referenceRender(referenceView.metadata[path]?.qtof?.reference_filter);
  });
  document.getElementById('reference-masses-mode').addEventListener('change',()=>{
    referenceView.generation++;referenceView.dirty=true;
    document.getElementById('reference-masses-custom').hidden=document.getElementById('reference-masses-mode').value!=='custom';
    document.getElementById('reference-masses-status').textContent='Changed settings are not applied yet.';
  });
  for(const id of ['ppm','isotopes','values','polarity','charge'])document.getElementById(`reference-masses-${id}`).addEventListener('input',()=>{
    referenceView.generation++;referenceView.dirty=true;
    document.getElementById('reference-masses-status').textContent='Changed settings are not applied yet.';
  });
  document.getElementById('reference-masses-detect').addEventListener('click',referenceDetect);
  document.getElementById('reference-masses-apply').addEventListener('click',referenceApply);
  try {
    const text=sessionStorage.getItem(REFERENCE_DRAFT_KEY);sessionStorage.removeItem(REFERENCE_DRAFT_KEY);
    if(text){const draft=JSON.parse(text);
      for(const [id,value] of Object.entries(draft.values||{}))if(REFERENCE_PEPTIDE_INPUTS.includes(id))document.getElementById(id).value=value;
      document.getElementById('peptide-iam').checked=draft.iam===true;
      document.getElementById('peptide-disulfides-label').hidden=document.getElementById('peptide-reduction').value!=='unreduced';
      peptideView.modifications=Array.isArray(draft.modifications)?draft.modifications:[];
      referenceView.peptidePath=draft.path||'';referenceView.referencePath=draft.referencePath||'';
      document.getElementById('reference-masses-panel').open=draft.referenceOpen===true;peptideRenderLinkages();
    }
  } catch(_){ /* Ignore an invalid local UI draft; backend settings remain authoritative. */ }
}
