import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { Store, csv } from '../lib/store.mjs';
import { catalog, ROOT, startServers } from '../server.mjs';

const device = { device: 'desktop', viewportWidth: 1200, reducedMotion: false };
const answer = (optionId, extra = {}) => ({ optionId, skipped: false, activeMs: 4200, elapsedMs: 6500, viewingMs: 3000, replays: 0, mediaError: false, ...extra });
const feedback = { instructions: 'clear', comfort: 4, comment: 'Узнаваемые фигуры' };
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'l1-survey-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
function fixture(t, options) {
  const dir = temporary(t), store = new Store(dir, catalog, options);
  t.after(() => store.close()); return store;
}
function rejectsInput(fn, status = 400) { assert.throws(fn, error => error.status === status); }

test('six distinct tasks, one answer per task, independent clarity and final feedback', t => {
  const store = fixture(t), { token } = store.start(null, device);
  assert.equal(store.start(token, {}).created, false);
  assert.equal(store.summary().participants.started, 1);
  const assigned = store.rows();
  assert.equal(assigned.length, 6); assert.equal(new Set(assigned.map(r => r.shape)).size, 6);
  rejectsInput(() => store.finish(token, feedback), 409);
  rejectsInput(() => store.answer(token, assigned[1].task_id, answer('bad')), 409);
  for (let i = 0; i < 6; i++) {
    const { task } = store.publicState(token);
    assert.equal(task.position, i + 1); assert.equal(task.options.length, 6);
    assert.equal(new Set(task.options.map(o => o.label)).size, 6);
    assert.equal('correct_option' in task, false); assert.equal('shape' in task, false);
    const target = task.options.find(o => o.label === assigned[i].target_label);
    const choice = i === 1 ? task.options.find(o => o.id !== target.id) : target;
    rejectsInput(() => store.rate(token, task.id, 'clear'), 409);
    store.played(token, task.id);
    store.answer(token, task.id, answer(choice.id, { skipped: i === 2, mediaError: i === 2 }));
    const before = store.rows()[i];
    assert.equal(store.publicState(token).task.answered, true);
    assert.equal(store.answer(token, task.id, answer('different')).alreadySaved, true);
    assert.deepEqual(store.rows()[i], before);
    store.rate(token, task.id, i === 2 ? 'unclear' : 'clear');
    store.rate(token, task.id, 'partly');
  }
  assert.equal(store.publicState(token).task, null);
  store.finish(token, feedback); store.finish(token, { ...feedback, comfort: 1 });
  assert.equal(store.publicState(token).participant.completed, true);
  const summary = store.summary();
  assert.deepEqual({ ...summary.tasks }, { answered: 6, correct: 4, skipped: 1, rated: 6 });
  assert.equal(summary.participants.completed, 1);
  assert.equal(store.rows()[0].final_comfort, 4);
  assert.equal(store.rows()[2].clarity, 'unclear'); assert.equal(store.rows()[2].media_error, 1);
  assert.ok(store.rows().every(r => r.status === 'rated' && r.completed_at && r.played_at));
});

test('validation failures leave no partial answers and sessions cannot access another participant', t => {
  const store = fixture(t), a = store.start(null, device).token, b = store.start(null, device).token;
  const task = store.publicState(a).task;
  rejectsInput(() => store.answer(b, task.id, answer(task.options[0].id)), 404);
  rejectsInput(() => store.played(null, task.id), 401);
  for (const invalid of [{ optionId: 'missing' }, { skipped: 'false' }, { activeMs: -1 }, { replays: 1001 }, { elapsedMs: NaN }, { viewingMs: 1.5 }, { mediaError: null }]) {
    rejectsInput(() => store.answer(a, task.id, answer(task.options[0].id, invalid)));
    assert.equal(store.publicState(a).task.answered, false);
  }
  rejectsInput(() => store.start(null, { ...device, viewportWidth: 0 }));
  rejectsInput(() => store.start(null, { ...device, device: 'invalid' }));
  assert.equal(store.summary().participants.started, 2);
  assert.equal(store.mediaAllowed(null, task.media.split('/').at(-1).slice(0, -4)), false);
});

test('60 participants get balanced assignments: 30 per shape, 15 per clip', t => {
  const store = fixture(t, { maximum: 60 });
  for (let i = 0; i < 60; i++) store.start(null, device);
  const rows = store.rows(); assert.equal(rows.length, 360);
  const counts = field => Object.values(rows.reduce((result, row) => { result[row[field]] = (result[row[field]] || 0) + 1; return result; }, {}));
  assert.deepEqual(new Set(counts('shape')), new Set([30]));
  assert.deepEqual(new Set(counts('media_id')), new Set([15]));
  assert.deepEqual(new Set(counts('participant_id')), new Set([6]));
  rejectsInput(() => store.start(null, device), 409);
  assert.equal(store.summary().participants.started, 60);
});

test('answers and stage survive closing and reopening SQLite', t => {
  const dir = temporary(t); let store = new Store(dir, catalog);
  const { token } = store.start(null, device), task = store.publicState(token).task;
  store.answer(token, task.id, answer(task.options[0].id)); store.close();
  store = new Store(dir, catalog); t.after(() => store.close());
  assert.equal(store.publicState(token).task.id, task.id);
  assert.equal(store.publicState(token).task.answered, true);
  store.rate(token, task.id, 'partly'); assert.equal(store.publicState(token).task.position, 2);
});

test('CSV retains Unicode, quotes and newlines and neutralizes spreadsheet formulas', () => {
  const output = csv([{ comment: '=SUM(1,2)', label: 'Лист "осенний"', other: 'строка\nдва' }, { comment: '  +1', label: '@formula', other: null }]);
  assert.ok(output.startsWith('\ufeff'));
  assert.ok(output.includes('"\'=SUM(1,2)"')); assert.ok(output.includes('"\'  +1"'));
  assert.ok(output.includes('"Лист ""осенний"""')); assert.ok(output.includes('"строка\nдва"'));
  assert.ok(output.includes('"\'@formula"')); assert.ok(csv([]).includes('participant_id'));
});

async function httpFixture(t) {
  const app = await startServers({ dataDir: temporary(t), port: 0, adminPort: 0, host: '127.0.0.1' });
  t.after(() => app.close());
  return { app, origin: `http://127.0.0.1:${app.publicPort}`, admin: `http://127.0.0.1:${app.adminPort}` };
}
async function post(origin, path, data, cookie, headers = {}) {
  return fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Survey-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(data) });
}

test('HTTP study flow persists first answer, hides correctness and serves seekable videos', async t => {
  const { origin, app } = await httpFixture(t);
  const start = await post(origin, '/api/start', device);
  assert.equal(start.status, 200);
  const cookie = start.headers.get('set-cookie').split(';')[0];
  assert.match(start.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  let state = await start.json();
  assert.equal((await fetch(origin + state.task.media)).status, 404);
  const firstRange = await fetch(origin + state.task.media, { headers: { Cookie: cookie, Range: 'bytes=0-63' } });
  assert.equal(firstRange.status, 206); assert.match(firstRange.headers.get('content-range'), /^bytes 0-63\//);
  assert.equal((await firstRange.arrayBuffer()).byteLength, 64);
  const suffix = await fetch(origin + state.task.media, { headers: { Cookie: cookie, Range: 'bytes=-16' } });
  assert.equal(suffix.status, 206); assert.equal((await suffix.arrayBuffer()).byteLength, 16);
  const badRange = await fetch(origin + state.task.media, { headers: { Cookie: cookie, Range: 'bytes=9999999999-' } });
  assert.equal(badRange.status, 416);
  for (let i = 0; i < 6; i++) {
    assert.equal(state.task.position, i + 1);
    const path = `/api/tasks/${state.task.id}`;
    const response = await post(origin, path + '/answer', answer(state.task.options[0].id), cookie);
    assert.deepEqual(await response.json(), { saved: true });
    assert.equal((await post(origin, path + '/answer', answer(state.task.options[1].id), cookie)).status, 200);
    assert.equal(app.store.rows()[i].selected_option, state.task.options[0].id);
    assert.equal((await post(origin, path + '/rating', { clarity: 'clear' }, cookie)).status, 200);
    state = await (await fetch(origin + '/api/session', { headers: { Cookie: cookie } })).json();
  }
  assert.equal((await post(origin, '/api/finish', feedback, cookie)).status, 200);
  state = await (await fetch(origin + '/api/session', { headers: { Cookie: cookie } })).json();
  assert.equal(state.participant.completed, true);
});

test('public routes cannot expose the database, catalog or admin; cross-site mutations are rejected', async t => {
  const { origin, admin } = await httpFixture(t);
  for (const path of ['/catalog.json', '/data/survey.sqlite', '/api/summary', '/api/export.csv', '/admin.html', '/admin.js', '/tools/generate_media.py']) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
  assert.equal((await post(origin, '/api/start', device, null, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await post(origin, '/api/start', device, null, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post(origin, '/api/start', device, null, { 'X-Survey-Request': '' })).status, 403);
  assert.equal((await post(origin, '/api/start', device, null, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(origin, '/api/start', { ...device, excess: 'x'.repeat(9000) })).status, 413);
  assert.equal((await fetch(admin + '/api/summary')).status, 403);
  assert.equal((await fetch(admin + '/api/summary', { headers: { 'X-Survey-Admin': '1', Origin: origin } })).status, 403);
  // fetch normalizes Host, so exercise DNS-rebinding protection through raw HTTP.
  const wrongHost = await new Promise((resolve, reject) => {
    const req = request(admin + '/api/summary', { headers: { 'X-Survey-Admin': '1', Host: 'unrelated.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(wrongHost, 403);
  const summary = await fetch(admin + '/api/summary', { headers: { 'X-Survey-Admin': '1' } });
  assert.equal(summary.status, 200); assert.equal((await summary.json()).participants.started, 0);
  const download = await fetch(admin + '/api/export.csv', { headers: { 'X-Survey-Admin': '1' } });
  assert.equal(download.status, 200); assert.match(download.headers.get('content-type'), /text\/csv/);
  const config = await (await fetch(origin + '/api/config')).json();
  assert.equal('closesAt' in config, false);
});

test('manual SIGINT stops the local servers and tunnel and leaves an exportable database', { timeout: 15000 }, async t => {
  const dir = temporary(t), fake = join(dir, 'fake-cloudflared.cjs'), marker = join(dir, 'tunnel-stopped');
  writeFileSync(fake, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('cloudflared fake'); process.exit(0); }
console.error('https://local-test-only.trycloudflare.com');
setInterval(() => {}, 1000);
process.on('SIGTERM', () => { require('fs').writeFileSync(process.env.TEST_STOP_MARKER, 'stopped'); process.exit(0); });
`, { mode: 0o700 });
  const child = spawn(process.execPath, ['scripts/share.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '0', ADMIN_PORT: '0', DATA_DIR: dir, CLOUDFLARED_BIN: fake, TEST_STOP_MARKER: marker }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Startup timed out: ' + output)), 8000);
    const read = chunk => { output += chunk; if (output.includes('Сервер работает без ограничения времени.')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Exited ${code}: ${output}`)); });
  });
  await ready;
  const origin = /Локальная проверка: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)[1];
  const admin = /Результаты .*?: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)[1];
  assert.equal((await post(origin, '/api/start', device)).status, 200);
  assert.equal((await fetch(admin)).status, 200);
  const ended = once(child, 'exit'); child.kill('SIGINT');
  const [code] = await ended; assert.equal(code, 0);
  assert.equal(readFileSync(marker, 'utf8'), 'stopped');
  await assert.rejects(fetch(origin + '/health')); await assert.rejects(fetch(admin));
  assert.ok(existsSync(join(dir, 'survey.sqlite')));
  const exported = spawnSync(process.execPath, ['scripts/export.mjs'], { cwd: ROOT, env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(readFileSync(join(dir, 'results.csv'), 'utf8'), /assigned/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'current-session.json'), 'utf8')).url, 'https://local-test-only.trycloudflare.com');
});
