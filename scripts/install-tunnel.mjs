import { mkdirSync, writeFileSync, mkdtempSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../.bin/', import.meta.url));
const architecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null;
const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
if (!architecture || !platform) throw new Error('Установите cloudflared по https://developers.cloudflare.com/tunnel/downloads/');
const name = `cloudflared-${platform}-${architecture}${platform === 'darwin' ? '.tgz' : ''}`;
const headers = { 'User-Agent': 'autumn-survey-local-installer', Accept: 'application/vnd.github+json' };
const releaseResponse = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', { headers, signal: AbortSignal.timeout(30000) });
if (!releaseResponse.ok) throw new Error(`GitHub: ${releaseResponse.status}. Можно установить через brew install cloudflared.`);
const release = await releaseResponse.json();
const asset = release.assets.find(asset => asset.name === name);
if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) throw new Error('Нет SHA-256 для подходящего файла. Используйте brew install cloudflared.');
if (!asset.browser_download_url.startsWith('https://github.com/cloudflare/cloudflared/releases/download/')) throw new Error('Неожиданный источник загрузки.');
console.log(`Загружаю официальный cloudflared ${release.tag_name} (${name})…`);
const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120000) });
if (!download.ok) throw new Error(`Загрузка: ${download.status}`);
const bytes = Buffer.from(await download.arrayBuffer());
if ('sha256:' + createHash('sha256').update(bytes).digest('hex') !== asset.digest) throw new Error('Контрольная сумма не совпала. Установка отменена.');
mkdirSync(directory, { recursive: true });
if (platform === 'darwin') {
  const temp = mkdtempSync(join(tmpdir(), 'autumn-cloudflared-'));
  try { writeFileSync(join(temp, 'release.tgz'), bytes); execFileSync('tar', ['-xzf', join(temp, 'release.tgz'), '-C', temp, 'cloudflared']); copyFileSync(join(temp, 'cloudflared'), join(directory, 'cloudflared')); }
  finally { rmSync(temp, { recursive: true, force: true }); }
} else writeFileSync(join(directory, 'cloudflared'), bytes);
chmodSync(join(directory, 'cloudflared'), 0o755);
console.log('Готово. Когда будете готовы к опросу: npm run survey:share');
