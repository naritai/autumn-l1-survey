import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startServers, ROOT } from '../server.mjs';

// Ctrl+C closes both servers and the tunnel. No session time limit.
const executable = process.env.CLOUDFLARED_BIN || (existsSync(join(ROOT, '.bin', 'cloudflared')) ? join(ROOT, '.bin', 'cloudflared') : 'cloudflared');
const probe = spawnSync(executable, ['--version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.error('Сначала установите туннель: npm run tunnel:install\nЛибо: brew install cloudflared');
  process.exit(1);
}
const dataDir = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
const app = await startServers({ dataDir, host: '127.0.0.1' });
const temporaryConfig = join(dataDir, 'quick-tunnel.yml');
// Explicit config prevents an unrelated ~/.cloudflared/config.yml from taking over.
writeFileSync(temporaryConfig, 'loglevel: info\n', { mode: 0o600 });
let tunnel, awake, stopped = false, link = null;
const stop = async reason => {
  if (stopped) return; stopped = true; clearTimeout(startupTimer);
  console.log(`\n${reason}\nОтветы сохранены в ${join(dataDir, 'survey.sqlite')}`);
  tunnel?.kill('SIGTERM'); awake?.kill('SIGTERM'); await app.close();
  const hardStop = setTimeout(() => tunnel?.kill('SIGKILL'), 3000); hardStop.unref();
};
const startupTimer = setTimeout(() => { if (!link) stop('Туннель не запустился за две минуты. Проверьте подключение и запустите снова.'); }, 120000);
console.log(`Локальная проверка: http://127.0.0.1:${app.publicPort}\nРезультаты (не отправляйте участникам): http://127.0.0.1:${app.adminPort}\nОстановка вручную: Ctrl+C\nСоздаю временную HTTPS-ссылку…`);
tunnel = spawn(executable, ['tunnel', '--config', temporaryConfig, '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${app.publicPort}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
function readOutput(chunk) {
  output = (output + chunk.toString()).slice(-20000);
  const found = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
  if (found && !link) {
    link = found[0]; clearTimeout(startupTimer);
    writeFileSync(join(dataDir, 'current-session.json'), JSON.stringify({ url: link, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    console.log(`\nСсылка для участников:\n${link}\n\nСервер работает без ограничения времени. Для остановки нажмите Ctrl+C.\nНе усыпляйте Mac и не закрывайте крышку.`);
  }
}
tunnel.stdout.on('data', readOutput); tunnel.stderr.on('data', readOutput);
tunnel.on('error', error => stop(`Не удалось запустить туннель: ${error.message}`));
tunnel.on('exit', (code, signal) => { if (!stopped) { console.error(output.slice(-2000)); stop(`Туннель остановился (${signal || code}).`); } });
if (process.platform === 'darwin') { awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }); awake.on('error', () => {}); }
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop('Опрос остановлен.'));
process.on('exit', () => { tunnel?.kill('SIGTERM'); awake?.kill('SIGTERM'); });
