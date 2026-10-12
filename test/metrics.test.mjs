import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResponseMetrics } from '../public/metrics.mjs';
import { Store, timeSummary, csv } from '../lib/store.mjs';
import { catalog } from '../server.mjs';

const screen = { answerInput: 'touch', viewportWidth: 390, viewportHeight: 844, videoWidth: 328 };
function clock(prior) {
  let now = 0;
  const timing = new ResponseMetrics(prior, { monotonic: () => now, wall: () => 100000 + now });
  return { timing, advance: ms => { now += ms; } };
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'l1-metrics-'));
  const store = new Store(directory, catalog);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}
function participant(store) { return store.start(null, { device: 'phone', viewportWidth: 390, reducedMotion: false }).token; }
function measuredAnswer(ms, changes = {}) {
  const { timing, advance } = clock(); timing.requestPlay(); timing.playback(true, true); timing.firstFrame('video-frame'); advance(ms);
  const body = { ...timing.answerPayload(screen), skipped: false, mediaError: false };
  return { ...body, ...changes };
}

test('response starts at the first frame, excludes hidden time, includes thinking and freezes before upload', () => {
  const { timing, advance } = clock();
  advance(250); timing.ready(); advance(750); timing.requestPlay();
  advance(100); timing.playback(true, true); timing.firstFrame('video-frame');
  advance(2000); timing.manualPause(); advance(500); timing.visibility(false);
  advance(8000); timing.visibility(true); timing.requestPlay(); timing.playback(true, false);
  advance(1000); timing.playback(false); advance(500);
  const result = timing.answerPayload(screen);
  assert.equal(result.activeMs, 4000); assert.equal(result.elapsedMs, 12000); assert.equal(result.viewingMs, 3000);
  assert.equal(result.metrics.responseMs, 4000); assert.equal(result.metrics.hiddenMs, 8000);
  assert.equal(result.metrics.hiddenCount, 1); assert.equal(result.metrics.pauses, 1);
  assert.equal(result.metrics.timeToPlayMs, 1000); assert.equal(result.metrics.firstFrameDelayMs, 100);
  assert.equal(result.metrics.loadMs, 250); assert.equal(result.replays, 0); assert.equal(result.metrics.taskMs, 13100);
  advance(60000); timing.visibility(false);
  assert.equal(timing.snapshot().activeMs, 4000); assert.equal(result.metrics.responseMs, 4000);
});

test('buffering and full replays are distinct from manual pause and resume', () => {
  const { timing, advance } = clock(); timing.requestPlay(); timing.playback(true, true); timing.firstFrame('playing');
  advance(1000); timing.buffer(); advance(700); timing.buffer();
  advance(300); timing.playback(true); advance(500); timing.playback(false);
  timing.requestPlay(); timing.playback(true, true); advance(500);
  const result = timing.answerPayload(screen);
  assert.equal(result.metrics.bufferingMs, 1000); assert.equal(result.metrics.bufferingCount, 1);
  assert.equal(result.activeMs, 3000); assert.equal(result.viewingMs, 2000); assert.equal(result.replays, 1);
  assert.equal(result.metrics.timingSource, 'playing');
});

test('skip before playback has no response time; reload retains prior measurements', () => {
  const a = clock(); a.advance(1200);
  const skipped = a.timing.answerPayload(screen); assert.equal(skipped.metrics.responseMs, null); assert.equal(skipped.metrics.taskMs, 1200);
  const b = clock(); b.timing.requestPlay(); b.timing.playback(true, true); b.timing.firstFrame('video-frame'); b.advance(1500);
  const saved = b.timing.snapshot();
  let monotonic = 0;
  const restored = new ResponseMetrics(saved, { monotonic: () => monotonic, wall: () => 110000 + monotonic });
  monotonic = 500;
  const result = restored.answerPayload(screen);
  assert.equal(result.activeMs, 2000); assert.equal(result.elapsedMs, 10500); assert.equal(result.metrics.reloads, 1);
  assert.equal(result.metrics.timingSource, 'video-frame');
});

test('new metrics are validated, stored once, exported and summarized with documented exclusions', t => {
  const store = fixture(t);
  for (const [index, ms] of [1000, 2000, 3000, 4000, 8000, 9000].entries()) {
    const token = participant(store), task = store.publicState(token).task;
    const payload = { ...measuredAnswer(ms), optionId: task.options[0].id, skipped: index === 4, mediaError: index === 5 };
    if (index === 0) {
      assert.throws(() => store.answer(token, task.id, { ...payload, metrics: { ...payload.metrics, hiddenMs: -1 } }), error => error.status === 400);
      assert.throws(() => store.answer(token, task.id, { ...payload, metrics: { ...payload.metrics, responseMs: 999 } }), error => error.status === 400);
      assert.equal(store.publicState(token).task.answered, false);
    }
    store.answer(token, task.id, payload);
    store.answer(token, task.id, { ...payload, activeMs: 1 });
  }
  assert.deepEqual(store.summary().response, { response_samples: 4, median_response_ms: 2500, p90_response_ms: 3700 });
  const rows = store.rows(), answered = rows.filter(row => row.answered_at);
  assert.equal(answered[0].response_ms_client, 1000); assert.equal(answered[0].answer_input, 'touch');
  assert.equal(answered[0].metrics_version, 2); assert.equal(answered[0].video_display_width, 328);
  assert.ok(rows.filter(row => !row.answered_at).every(row => row.response_ms_client === null));
  const output = csv(rows);
  for (const name of ['response_ms_client', 'hidden_ms_client', 'manual_pauses', 'page_restores', 'video_load_ms_client', 'timing_source', 'answer_input']) assert.ok(output.includes('"' + name + '"'));
});

test('migration preserves earlier answers and does not invent new metrics', () => {
  const directory = mkdtempSync(join(tmpdir(), 'l1-migration-')); let store;
  try {
    store = new Store(directory, catalog); const token = participant(store), task = store.publicState(token).task;
    const payload = measuredAnswer(2000); delete payload.metrics;
    store.answer(token, task.id, { ...payload, optionId: task.options[0].id });
    store.db.exec('ALTER TABLE tasks DROP COLUMN metrics'); store.close();
    store = new Store(directory, catalog);
    assert.equal(store.publicState(token).task.answered, true);
    assert.equal(store.rows()[0].active_ms_client, 2000); assert.equal(store.rows()[0].response_ms_client, null);
    assert.equal(store.summary().response.response_samples, 0);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('percentiles interpolate and report missing data as null', () => {
  assert.deepEqual(timeSummary([]), { response_samples: 0, median_response_ms: null, p90_response_ms: null });
  assert.deepEqual(timeSummary([1234]), { response_samples: 1, median_response_ms: 1234, p90_response_ms: 1234 });
  assert.deepEqual(timeSummary([4000, 1000, 3000, 2000]), { response_samples: 4, median_response_ms: 2500, p90_response_ms: 3700 });
});
