import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const shuffle = values => {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
};
const id = () => randomBytes(16).toString('hex');
const now = () => new Date().toISOString();
export class InputError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw new InputError(`Неверное поле: ${name}.`);
  return value;
}
function metrics(input, activeMs) {
  if (input === undefined || input === null) return null; // Clients opened before this update remain compatible.
  if (typeof input !== 'object' || Array.isArray(input) || input.version !== 2) throw new InputError('Неверная версия метрик.');
  const result = { version: 2 };
  for (const key of ['responseMs', 'timeToPlayMs', 'firstFrameDelayMs', 'loadMs']) result[key] = input[key] === null ? null : integer(input[key], 0, 86_400_000, key);
  for (const key of ['taskMs', 'hiddenMs', 'bufferingMs']) result[key] = integer(input[key], 0, 86_400_000, key);
  for (const key of ['hiddenCount', 'pauses', 'reloads', 'bufferingCount']) result[key] = integer(input[key], 0, 10000, key);
  if (!['video-frame', 'playing', 'legacy-playing', 'not-played'].includes(input.timingSource)) throw new InputError('Неверный источник таймера.');
  if (!['mouse', 'touch', 'pen', 'keyboard', 'unknown'].includes(input.answerInput)) throw new InputError('Неверный способ ввода.');
  if (typeof input.capped !== 'boolean') throw new InputError('Неверный флаг метрик.');
  if ((input.timingSource === 'not-played') !== (result.responseMs === null) || (result.responseMs !== null && result.responseMs !== activeMs)) throw new InputError('Несогласованные метрики времени.');
  return { ...result, timingSource: input.timingSource, answerInput: input.answerInput, capped: input.capped,
    viewportWidth: integer(input.viewportWidth, 200, 10000, 'viewportWidth'), viewportHeight: integer(input.viewportHeight, 100, 10000, 'viewportHeight'), videoWidth: integer(input.videoWidth, 0, 10000, 'videoWidth') };
}
export function timeSummary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => {
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * fraction, low = Math.floor(index), high = Math.ceil(index);
    return Math.round(sorted[low] + (sorted[high] - sorted[low]) * (index - low));
  };
  return { response_samples: sorted.length, median_response_ms: percentile(0.5), p90_response_ms: percentile(0.9) };
}

export class Store {
  constructor(directory, catalog, { total = 6, maximum = 200 } = {}) {
    this.catalog = catalog; this.total = total; this.maximum = maximum;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'survey.sqlite');
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, started_at TEXT NOT NULL, completed_at TEXT,
        device TEXT NOT NULL, viewport_width INTEGER, reduced_motion INTEGER NOT NULL, study_version TEXT NOT NULL,
        instructions TEXT, comfort INTEGER, comment TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id), position INTEGER NOT NULL,
        shape TEXT NOT NULL, media_id TEXT NOT NULL, options TEXT NOT NULL, correct_option TEXT NOT NULL,
        issued_at TEXT, played_at TEXT, answered_at TEXT, rated_at TEXT, selected_option TEXT, correct INTEGER,
        skipped INTEGER, clarity TEXT, active_ms INTEGER, elapsed_ms INTEGER, viewing_ms INTEGER, replays INTEGER,
        media_error INTEGER, metrics TEXT, UNIQUE(participant_id, position)
      );
      CREATE INDEX IF NOT EXISTS tasks_participant ON tasks(participant_id, position);
      CREATE INDEX IF NOT EXISTS tasks_shape ON tasks(shape);`);
    if (!this.db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'metrics')) this.db.exec('ALTER TABLE tasks ADD COLUMN metrics TEXT');
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  participant(token) { return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? this.db.prepare('SELECT * FROM participants WHERE token_hash = ?').get(digest(token)) : null; }
  requireParticipant(token) { const p = this.participant(token); if (!p) throw new InputError('Сессия не найдена. Вернитесь на начало.', 401); return p; }
  start(token, device) {
    if (this.participant(token)) return { token, created: false };
    if (!['phone', 'tablet', 'desktop'].includes(device.device)) throw new InputError('Неверный тип устройства.');
    const width = integer(device.viewportWidth, 200, 10000, 'viewportWidth');
    if (typeof device.reducedMotion !== 'boolean') throw new InputError('Неверный параметр reducedMotion.');
    return this.transaction(() => {
      if (this.db.prepare('SELECT count(*) AS n FROM participants').get().n >= this.maximum) throw new InputError('Набор участников завершён.', 409);
      const participantId = id(), sessionToken = randomBytes(32).toString('hex');
      this.db.prepare('INSERT INTO participants(id,token_hash,started_at,device,viewport_width,reduced_motion,study_version) VALUES(?,?,?,?,?,?,?)')
        .run(participantId, digest(sessionToken), now(), device.device, width, +device.reducedMotion, this.catalog.version);
      const counts = Object.fromEntries(this.db.prepare('SELECT shape,count(*) AS n FROM tasks GROUP BY shape').all().map(r => [r.shape, r.n]));
      const shapes = shuffle(Object.keys(this.catalog.labels)).sort((a, b) => (counts[a] || 0) - (counts[b] || 0)).slice(0, this.total);
      for (const [index, shape] of shuffle(shapes).entries()) {
        const candidates = this.catalog.videos.filter(v => v.shape === shape);
        const mediaCounts = Object.fromEntries(this.db.prepare('SELECT media_id,count(*) AS n FROM tasks WHERE shape=? GROUP BY media_id').all(shape).map(r => [r.media_id, r.n]));
        const media = shuffle(candidates).sort((a, b) => (mediaCounts[a.id] || 0) - (mediaCounts[b.id] || 0))[0];
        const options = shuffle([shape, ...shuffle(Object.keys(this.catalog.labels).filter(s => s !== shape)).slice(0, 5)]).map(s => ({ id: id(), label: this.catalog.labels[s], shape: s }));
        this.db.prepare('INSERT INTO tasks(id,participant_id,position,shape,media_id,options,correct_option) VALUES(?,?,?,?,?,?,?)')
          .run(id(), participantId, index + 1, shape, media.id, JSON.stringify(options.map(({ id, label }) => ({ id, label }))), options.find(o => o.shape === shape).id);
      }
      return { token: sessionToken, created: true };
    });
  }
  publicState(token) {
    const p = this.participant(token); if (!p) return { participant: null };
    const task = this.db.prepare('SELECT * FROM tasks WHERE participant_id=? AND rated_at IS NULL ORDER BY position LIMIT 1').get(p.id);
    if (task && !task.issued_at) { task.issued_at = now(); this.db.prepare('UPDATE tasks SET issued_at=? WHERE id=? AND issued_at IS NULL').run(task.issued_at, task.id); }
    return {
      participant: { id: p.id, completed: !!p.completed_at }, total: this.total,
      task: task ? { id: task.id, position: task.position, media: `/media/${task.media_id}.mp4`, options: JSON.parse(task.options), answered: !!task.answered_at, selected: task.selected_option, skipped: !!task.skipped } : null
    };
  }
  taskFor(token, taskId) {
    const p = this.requireParticipant(token);
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=? AND participant_id=?').get(taskId, p.id);
    if (!task) throw new InputError('Задание не найдено.', 404);
    if (this.db.prepare('SELECT count(*) AS n FROM tasks WHERE participant_id=? AND position<? AND rated_at IS NULL').get(p.id, task.position).n) throw new InputError('Завершите предыдущее задание.', 409);
    return task;
  }
  played(token, taskId) {
    const task = this.taskFor(token, taskId);
    this.db.prepare('UPDATE tasks SET played_at=COALESCE(played_at,?) WHERE id=?').run(now(), task.id);
    return { saved: true };
  }
  answer(token, taskId, body) {
    return this.transaction(() => {
      const task = this.taskFor(token, taskId);
      if (task.answered_at) return { saved: true, alreadySaved: true };
      if (typeof body.skipped !== 'boolean' || typeof body.mediaError !== 'boolean') throw new InputError('Неверный ответ.');
      const selected = body.skipped ? null : body.optionId;
      if (!body.skipped && !JSON.parse(task.options).some(o => o.id === selected)) throw new InputError('Такого варианта ответа нет.');
      const active = integer(body.activeMs, 0, 3_600_000, 'activeMs');
      const elapsed = integer(body.elapsedMs, 0, 86_400_000, 'elapsedMs');
      const viewing = integer(body.viewingMs, 0, 3_600_000, 'viewingMs');
      const replays = integer(body.replays, 0, 1000, 'replays');
      const extra = metrics(body.metrics, active);
      this.db.prepare('UPDATE tasks SET answered_at=?,selected_option=?,correct=?,skipped=?,active_ms=?,elapsed_ms=?,viewing_ms=?,replays=?,media_error=?,metrics=? WHERE id=?')
        .run(now(), selected, +(!body.skipped && selected === task.correct_option), +body.skipped, active, elapsed, viewing, replays, +body.mediaError, extra ? JSON.stringify(extra) : null, task.id);
      return { saved: true };
    });
  }
  rate(token, taskId, clarity) {
    if (!['clear', 'partly', 'unclear'].includes(clarity)) throw new InputError('Выберите оценку понятности.');
    return this.transaction(() => {
      const task = this.taskFor(token, taskId);
      if (!task.answered_at) throw new InputError('Сначала выберите ответ.', 409);
      if (!task.rated_at) this.db.prepare('UPDATE tasks SET clarity=?,rated_at=? WHERE id=?').run(clarity, now(), task.id);
      return { saved: true };
    });
  }
  finish(token, body) {
    const p = this.requireParticipant(token);
    if (!['clear', 'partly', 'unclear'].includes(body.instructions)) throw new InputError('Оцените инструкцию.');
    const comfort = integer(body.comfort, 1, 5, 'comfort');
    if (typeof body.comment !== 'string' || body.comment.length > 1000) throw new InputError('Комментарий должен быть короче 1000 символов.');
    return this.transaction(() => {
      if (this.db.prepare('SELECT count(*) AS n FROM tasks WHERE participant_id=? AND rated_at IS NULL').get(p.id).n) throw new InputError('Завершите задания.', 409);
      this.db.prepare('UPDATE participants SET completed_at=?,instructions=?,comfort=?,comment=? WHERE id=? AND completed_at IS NULL')
        .run(now(), body.instructions, comfort, body.comment, p.id);
      return { saved: true };
    });
  }
  mediaAllowed(token, mediaId) {
    if (mediaId === this.catalog.training.id) return true;
    const p = this.participant(token); return !!(p && this.db.prepare('SELECT 1 FROM tasks WHERE participant_id=? AND media_id=?').get(p.id, mediaId));
  }
  rows() {
    return this.db.prepare(`SELECT p.id AS participant_id,p.study_version,p.started_at AS participant_started_at,p.completed_at,p.device,p.viewport_width,p.reduced_motion,
      p.instructions AS final_instructions,p.comfort AS final_comfort,p.comment,t.position,t.id AS task_id,t.shape,t.media_id,t.issued_at,t.played_at,t.answered_at,t.rated_at,
      t.selected_option,t.correct,t.skipped,t.clarity,t.active_ms AS active_ms_client,t.elapsed_ms AS elapsed_ms_client,t.viewing_ms AS viewing_ms_client,t.replays,t.media_error,t.options,t.correct_option,t.metrics
      FROM participants p JOIN tasks t ON t.participant_id=p.id ORDER BY p.started_at,t.position`).all().map(row => {
        const opts = JSON.parse(row.options);
        row.target_label = this.catalog.labels[row.shape]; row.selected_label = opts.find(o => o.id === row.selected_option)?.label || '';
        row.option_order = opts.map(o => o.label).join(' | '); row.status = row.rated_at ? 'rated' : row.answered_at ? 'answered' : row.played_at ? 'viewed' : row.issued_at ? 'opened' : 'assigned';
        const m = row.metrics ? JSON.parse(row.metrics) : {};
        Object.assign(row, {
          metrics_version: m.version ?? null, response_ms_client: m.responseMs ?? null, task_ms_client: m.taskMs ?? null,
          time_to_play_ms_client: m.timeToPlayMs ?? null, first_frame_delay_ms_client: m.firstFrameDelayMs ?? null, video_load_ms_client: m.loadMs ?? null,
          hidden_ms_client: m.hiddenMs ?? null, tab_hides: m.hiddenCount ?? null, manual_pauses: m.pauses ?? null, page_restores: m.reloads ?? null,
          buffering_ms_client: m.bufferingMs ?? null, buffering_events: m.bufferingCount ?? null, timing_source: m.timingSource ?? null,
          answer_input: m.answerInput ?? null, answer_viewport_width: m.viewportWidth ?? null, answer_viewport_height: m.viewportHeight ?? null,
          video_display_width: m.videoWidth ?? null, timing_capped: m.capped == null ? null : +m.capped,
          task_elapsed_ms_server: row.answered_at && row.issued_at ? Date.parse(row.answered_at) - Date.parse(row.issued_at) : null,
          study_duration_ms_server: row.completed_at ? Date.parse(row.completed_at) - Date.parse(row.participant_started_at) : null
        });
        delete row.options; delete row.correct_option; delete row.metrics; return row;
      });
  }
  summary() {
    const measured = this.db.prepare('SELECT shape,correct,skipped,media_error,metrics FROM tasks WHERE answered_at IS NOT NULL AND metrics IS NOT NULL').all()
      .map(row => ({ ...row, metrics: JSON.parse(row.metrics) }))
      .filter(row => !row.skipped && !row.media_error && !row.metrics.capped && row.metrics.responseMs != null && ['video-frame', 'playing'].includes(row.metrics.timingSource));
    const durations = rows => timeSummary(rows.map(row => row.metrics.responseMs));
    return {
      participants: this.db.prepare('SELECT count(*) AS started,count(completed_at) AS completed FROM participants').get(),
      tasks: this.db.prepare('SELECT count(answered_at) AS answered,coalesce(sum(correct),0) AS correct,coalesce(sum(skipped),0) AS skipped,count(rated_at) AS rated FROM tasks').get(),
      response: durations(measured),
      shapes: this.db.prepare(`SELECT shape,count(answered_at) AS answered,coalesce(sum(correct),0) AS correct,coalesce(sum(skipped),0) AS skipped,
        coalesce(sum(clarity='clear'),0) AS clear,count(clarity) AS rated,round(avg(CASE WHEN answered_at IS NOT NULL THEN active_ms END)) AS avg_active_ms
        FROM tasks GROUP BY shape ORDER BY shape`).all().map(row => ({ ...row, label: this.catalog.labels[row.shape], ...durations(measured.filter(task => task.shape === row.shape)),
          median_correct_response_ms: durations(measured.filter(task => task.shape === row.shape && task.correct)).median_response_ms }))
    };
  }
  close() { this.db.close(); }
}

export function csv(rows) {
  const columns = rows.length ? Object.keys(rows[0]) : ['participant_id','status','shape','correct','clarity'];
  const cell = value => {
    let text = value == null ? '' : String(value);
    if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\ufeff' + [columns.map(cell).join(','), ...rows.map(row => columns.map(k => cell(row[k])).join(','))].join('\r\n') + '\r\n';
}
