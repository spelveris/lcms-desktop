/* Pinned, checksum-verified build dependency; never downloads user data. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ASSETS = {
  'darwin-arm64': ['comet.aarch64.macos.exe', '1b93ed1cf690026a75d80e1e0ce3ed57394bcd47ba5c8587441668c006e32f0e'],
  'darwin-x64': ['comet.macos.exe', 'b248e8644d8a2034572223e613859cda9aa85fb00a06800fc3ae98411534db62'],
  'win32-x64': ['comet.win64.exe', '5664e2152dcd6f0caf889c944967a9717654025dbcbc4f0f30e28daa7030f78b'],
  'linux-x64': ['comet.linux.exe', 'af515b6ed5a17efafff7277a6a9c73cee97e26d38f3c9b2a8da16adaa44e6d9e'],
  'linux-arm64': ['comet.aarch64.linux.exe', 'a8c5314d440fd56a15b16be1465e4ed74f3e0a0abe0afd293932452cbe8f5dcc'],
};
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
async function prepare(root = path.resolve(__dirname, '..')) {
  const platform = `${process.platform}-${process.arch}`, asset = ASSETS[platform];
  if (!asset) throw Error(`Comet is not packaged for ${platform}`);
  const directory = path.join(root, 'build', 'comet', platform);
  const binary = path.join(directory, process.platform === 'win32' ? 'comet.exe' : 'comet');
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(binary) && digest(fs.readFileSync(binary)) === asset[1]) return binary;
  const response = await fetch(`https://github.com/UWPR/Comet/releases/download/v2026.02.2/${asset[0]}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error(`Comet download failed (${response.status})`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 20000000 || digest(data) !== asset[1]) throw Error('Comet checksum verification failed');
  fs.writeFileSync(binary, data, { mode: 0o755 });
  fs.chmodSync(binary, 0o755);
  return binary;
}
module.exports = { prepare, ASSETS };
if (require.main === module) prepare().then(binary => console.log(binary)).catch(error => { console.error(error.message); process.exitCode = 1; });
