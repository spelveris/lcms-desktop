/* Download management only: never feed an organism FASTA to the single-reference mapper. */
const proteinDatabaseView = { snapshot: null, busy: false, offline: false, timer: null, initialized: false };
const PROTEIN_DATABASE_ACTIVE = new Set(['connecting', 'downloading', 'verifying', 'installing', 'cancelling']);

function proteinDatabaseSize(bytes) {
  return `${(Number(bytes || 0) / 1e6).toFixed(1)} MB`;
}

function proteinDatabaseSelection(snapshot) {
  const preset = snapshot?.presets.find(item => item.id === snapshot.selected_preset);
  return snapshot?.databases.find(item => item.id === preset?.database_id);
}

function proteinDatabaseMessage(snapshot) {
  const database = proteinDatabaseSelection(snapshot);
  const job = snapshot?.job;
  const active = job && PROTEIN_DATABASE_ACTIVE.has(job.state);
  if (active) {
    const name = snapshot.databases.find(item => item.id === job.database_id)?.label || 'Database';
    const phases = { connecting: 'Connecting to UniProt…', verifying: 'Verifying protein sequences…',
      installing: 'Saving verified database…', cancelling: 'Cancelling download…' };
    return { state: 'working', text: `${name} · ${job.state === 'downloading'
      ? `${proteinDatabaseSize(job.downloaded_bytes)} / ${proteinDatabaseSize(job.total_bytes)} downloaded`
      : phases[job.state]}` };
  }
  if (!database) return { state: 'idle', text: 'Choose an organism or cell line. Nothing downloads automatically.' };
  if (database.installed) return { state: 'installed', text: `${database.label} · ${database.saved.protein_count.toLocaleString()} sequences · ${proteinDatabaseSize(database.saved.bytes)} · UniProt ${database.saved.uniprot_release} · Available offline` };
  if (database.saved?.invalid) return { state: 'error', text: `Saved database needs attention: ${database.saved.error}. Move its folder aside before downloading again.` };
  if (job?.database_id === database.id && job.state === 'failed') return { state: 'error', text: `Download failed: ${job.error}. You can retry.` };
  if (job?.database_id === database.id && job.state === 'cancelled') return { state: 'idle', text: 'Download cancelled. No incomplete database was installed.' };
  return { state: 'idle', text: `${database.label} · Not downloaded · Approximately ${database.estimated_download_mb} MB download` };
}

function renderProteinDatabases() {
  const state = proteinDatabaseView;
  const snapshot = state.snapshot;
  const select = document.getElementById('protein-database-select');
  const button = document.getElementById('protein-database-download');
  const cancel = document.getElementById('protein-database-cancel');
  const progress = document.getElementById('protein-database-progress');
  const status = document.getElementById('protein-database-status');
  const job = snapshot?.job;
  const active = Boolean(job && PROTEIN_DATABASE_ACTIVE.has(job.state));
  const database = proteinDatabaseSelection(snapshot);
  if (snapshot) {
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = 'Choose organism / cell line…'; placeholder.disabled = true;
    select.replaceChildren(placeholder);
    const groups = new Map();
    for (const preset of snapshot.presets) {
      if (!groups.has(preset.group)) {
        const group = document.createElement('optgroup'); group.label = preset.group;
        select.appendChild(group); groups.set(preset.group, group);
      }
      const option = document.createElement('option'); option.value = preset.id;
      const saved = snapshot.databases.find(item => item.id === preset.database_id)?.installed;
      option.textContent = preset.label + (saved ? ' · Downloaded' : '');
      groups.get(preset.group).appendChild(option);
    }
    select.value = snapshot.selected_preset || '';
    document.getElementById('protein-database-directory').textContent = snapshot.directory;
  }
  select.disabled = !snapshot || state.busy || state.offline || active;
  button.textContent = state.offline ? 'Retry connection' : database?.installed ? 'Downloaded' : 'Download';
  button.disabled = Boolean(state.busy || (!state.offline && (!database || database.installed || active || database.saved?.invalid)));
  cancel.hidden = !active;
  cancel.disabled = state.busy || state.offline || job?.state === 'cancelling' || job?.state === 'installing';
  progress.hidden = !active || state.offline;
  if (job?.state === 'downloading' && job.total_bytes > 0) {
    progress.max = job.total_bytes; progress.value = job.downloaded_bytes;
  } else progress.removeAttribute('value');
  const message = proteinDatabaseMessage(snapshot);
  status.textContent = state.offline ? 'Cannot reach the database manager. Saved databases are not removed. Retry to refresh status.' : message.text;
  status.setAttribute('data-state', state.offline ? 'error' : message.state);
}

async function proteinDatabaseRequest(operation) {
  if (proteinDatabaseView.busy) return;
  clearTimeout(proteinDatabaseView.timer);
  proteinDatabaseView.busy = true;
  renderProteinDatabases();
  let failed = false;
  try {
    proteinDatabaseView.snapshot = await operation();
    proteinDatabaseView.offline = false;
  } catch (error) {
    failed = true;
    // A failed POST might still have started the download; refresh before retrying it.
    try {
      proteinDatabaseView.snapshot = await api.proteinDatabases();
      proteinDatabaseView.offline = false;
    } catch (_) { proteinDatabaseView.offline = true; }
    document.getElementById('protein-database-status').textContent = error.message;
  } finally {
    proteinDatabaseView.busy = false;
    const errorText = failed ? document.getElementById('protein-database-status').textContent : null;
    renderProteinDatabases();
    if (errorText && !proteinDatabaseView.offline) {
      const status = document.getElementById('protein-database-status');
      status.textContent = errorText; status.setAttribute('data-state', 'error');
    }
    if (!proteinDatabaseView.offline && PROTEIN_DATABASE_ACTIVE.has(proteinDatabaseView.snapshot?.job?.state)) {
      proteinDatabaseView.timer = setTimeout(() => proteinDatabaseRequest(() => api.proteinDatabases()), 1000);
    }
  }
}

function initProteinDatabases() {
  if (proteinDatabaseView.initialized) return;
  proteinDatabaseView.initialized = true;
  document.getElementById('protein-database-select').addEventListener('change', event => {
    const preset = event.target.value;
    proteinDatabaseRequest(() => api.selectProteinDatabase(preset));
  });
  document.getElementById('protein-database-download').addEventListener('click', () => {
    if (proteinDatabaseView.offline) return proteinDatabaseRequest(() => api.proteinDatabases());
    const database = proteinDatabaseSelection(proteinDatabaseView.snapshot);
    if (database && !database.installed) proteinDatabaseRequest(() => api.downloadProteinDatabase(database.id));
  });
  document.getElementById('protein-database-cancel').addEventListener('click', () => {
    const id = proteinDatabaseView.snapshot?.job?.database_id;
    if (id) proteinDatabaseRequest(() => api.cancelProteinDatabase(id));
  });
  const folder = document.getElementById('protein-database-folder');
  folder.disabled = typeof globalThis.catrupoleDatabases?.openFolder !== 'function';
  folder.addEventListener('click', async () => {
    try { await globalThis.catrupoleDatabases.openFolder(); }
    catch (error) { document.getElementById('protein-database-status').textContent = error.message; }
  });
  proteinDatabaseRequest(() => api.proteinDatabases());
}
