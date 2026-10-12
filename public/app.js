import { ResponseMetrics } from './metrics.mjs';
const $ = id => document.getElementById(id);
const video = $('motion-video');
let current = null, busy = false, retryAction = null;
let timing = null, started = false, mediaError = false, seenPlaying = false, frameCallback = null, videoGeneration = 0;
let pendingAnswer = null;
const sections = ['challenge', 'finish', 'done'];
const pendingKey = 'autumn-survey-pending';
function stored(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } }
function persist(key, value) { try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, JSON.stringify(value)); } catch {} }
function show(name) { sections.forEach(id => $(id).hidden = id !== name); clearNotice(); }
function clearNotice() { $('notice').textContent = ''; $('retry-request').hidden = true; retryAction = null; }
function failure(error, retry) { $('notice').textContent = error.message || 'Нет соединения. Ответ ещё не сохранён.'; retryAction = retry; $('retry-request').hidden = !retry; }
async function api(path, data) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-Survey-Request': '1' }, body: data === undefined ? undefined : JSON.stringify(data) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Не удалось сохранить ответ.'); return result;
  } catch (error) { if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('Нет соединения с сервером. Данные ещё не подтверждены — повторите сохранение.'); throw error; }
  finally { clearTimeout(timeout); }
}
function updateClocks() {
  if (!timing) return;
  const snapshot = timing.snapshot();
  if (current) persist(`timing:${current.id}`, snapshot);
}
function stopVideo() { timing?.playback(false); video.pause(); updateClocks(); }
function answerInput(event) { return event.detail === 0 ? 'keyboard' : ['mouse', 'touch', 'pen'].includes(event.pointerType) ? event.pointerType : 'unknown'; }
function buttonState() {
  $('play-video').disabled = busy || mediaError || !!pendingAnswer;
  document.querySelectorAll('#answers button').forEach(button => button.disabled = busy || !!pendingAnswer || !started || !!current?.answered);
  $('skip').disabled = busy || !!pendingAnswer;
  document.querySelectorAll('[data-clarity]').forEach(button => button.disabled = busy);
}
function renderAnswers(options) {
  $('answers').replaceChildren(...options.map(option => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = option.label; button.dataset.option = option.id; button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', event => submitAnswer(option.id, false, answerInput(event))); return button;
  }));
}
function prepareVideo(url) {
  videoGeneration++;
  if (frameCallback != null) video.cancelVideoFrameCallback?.(frameCallback);
  frameCallback = null;
  video.pause(); video.src = url; video.load(); started = false; seenPlaying = false; mediaError = false;
  $('play-video').hidden = false; $('play-video').textContent = 'Показать движение';
}
async function begin() {
  if (busy) return; busy = true; buttonState(); clearNotice();
  $('notice').textContent = 'Загрузка задания…';
  try {
    const width = Math.max(200, Math.min(10000, window.innerWidth));
    const state = await api('/api/start', { device: width < 600 ? 'phone' : width < 1000 ? 'tablet' : 'desktop', viewportWidth: width, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
    showState(state);
  } catch (error) { failure(error, begin); }
  finally { busy = false; buttonState(); }
}
function showState(state) {
  if (!state.participant) throw new Error('Не удалось открыть сессию. Повторите загрузку.');
  stopVideo(); current = state.task;
  if (state.participant.completed) { show('done'); return; }
  if (!current) { show('finish'); return; }
  show('challenge'); $('step-label').textContent = 'Задание'; $('step-count').textContent = `${current.position} из ${state.total}`;
  const prior = stored(`timing:${current.id}`);
  timing = new ResponseMetrics(prior && typeof prior.activeMs === 'number' ? prior : null, { visible: !document.hidden });
  renderAnswers(current.options); prepareVideo(current.media);
  if (current.answered) renderRating(); else { $('answer-area').hidden = false; $('rating').hidden = true; }
  const pending = stored(pendingKey);
  pendingAnswer = pending?.taskId === current.id && !current.answered ? pending : null;
  if (pendingAnswer) {
    timing.freeze();
    document.querySelectorAll('#answers button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.option === pendingAnswer.body.optionId)));
    failure(new Error('Есть ответ, сохранение которого ещё не подтверждено.'), () => sendAnswer(pendingAnswer));
  } else persist(pendingKey, null);
  buttonState();
  updateClocks();
}
function renderRating() { stopVideo(); timing?.freeze(); $('answer-area').hidden = true; $('rating').hidden = false; $('play-video').hidden = true; }
async function sendAnswer(pending) {
  if (busy) return; busy = true; buttonState(); clearNotice();
  try {
    await api(`/api/tasks/${pending.taskId}/answer`, pending.body); persist(pendingKey, null); pendingAnswer = null; current.answered = true; renderRating();
  } catch (error) { failure(error, () => sendAnswer(pending)); }
  finally { busy = false; buttonState(); }
}
function submitAnswer(optionId, skipped, input = 'unknown') {
  if (busy || pendingAnswer || !current || current.answered) return;
  stopVideo();
  document.querySelectorAll('#answers button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.option === optionId)));
  const metrics = timing.answerPayload({ answerInput: input, viewportWidth: Math.max(200, Math.min(10000, innerWidth)), viewportHeight: Math.max(100, Math.min(10000, innerHeight)), videoWidth: Math.max(0, Math.min(10000, Math.round(video.getBoundingClientRect().width))) });
  const pending = { taskId: current.id, body: { optionId, skipped, ...metrics, mediaError } };
  pendingAnswer = pending; persist(pendingKey, pending); sendAnswer(pending);
}
async function rate(clarity) {
  if (busy) return; busy = true; buttonState(); clearNotice();
  try { await api(`/api/tasks/${current.id}/rating`, { clarity }); const result = await api('/api/session'); showState(result); }
  catch (error) { failure(error, () => rate(clarity)); }
  finally { busy = false; buttonState(); }
}
async function finish(event) {
  event?.preventDefault(); if (busy || !$('final-form').reportValidity()) return; busy = true; clearNotice();
  $('final-form').querySelector('button').disabled = true;
  const form = new FormData($('final-form'));
  try { await api('/api/finish', { instructions: form.get('instructions'), comfort: Number(form.get('comfort')), comment: String(form.get('comment') || '') }); show('done'); }
  catch (error) { failure(error, () => finish()); }
  finally { busy = false; $('final-form').querySelector('button').disabled = false; }
}
$('skip').addEventListener('click', event => submitAnswer(null, true, answerInput(event)));
$('retry-request').addEventListener('click', () => retryAction?.());
$('final-form').addEventListener('submit', finish);
document.querySelectorAll('[data-clarity]').forEach(b => b.addEventListener('click', () => rate(b.dataset.clarity)));
$('play-video').addEventListener('click', async () => {
  if (!video.paused) { timing?.manualPause(); stopVideo(); return; }
  if (video.ended) { video.currentTime = 0; seenPlaying = false; }
  timing?.requestPlay();
  if (typeof video.requestVideoFrameCallback === 'function' && !started) {
    const generation = videoGeneration;
    if (frameCallback != null) video.cancelVideoFrameCallback(frameCallback);
    frameCallback = video.requestVideoFrameCallback(() => {
      frameCallback = null;
      if (generation === videoGeneration && !video.paused && !document.hidden) firstFrame('video-frame');
    });
  }
  try { await video.play(); } catch { failure(new Error('Видео не удалось запустить. Повторите попытку или выберите «Не могу различить фигуру».')); }
});
function firstFrame(source) {
  if (!timing || current?.answered || pendingAnswer) return;
  const wasStarted = started; started = true; timing.firstFrame(source);
  if (!wasStarted && current) api(`/api/tasks/${current.id}/played`, {}).catch(() => {});
  buttonState(); updateClocks();
}
video.addEventListener('playing', () => {
  if (!timing) return;
  timing.playback(true, !seenPlaying); seenPlaying = true;
  if (typeof video.requestVideoFrameCallback !== 'function' && !document.hidden) firstFrame('playing');
  $('play-video').textContent = 'Пауза'; buttonState(); updateClocks();
});
video.addEventListener('canplay', () => { timing?.ready(); updateClocks(); });
video.addEventListener('pause', () => { timing?.playback(false); updateClocks(); $('play-video').textContent = video.ended ? 'Повторить движение' : started ? 'Продолжить просмотр' : 'Показать движение'; });
video.addEventListener('ended', () => { $('play-video').textContent = 'Повторить движение'; });
video.addEventListener('waiting', () => { timing?.buffer(); updateClocks(); });
video.addEventListener('error', () => { if (!video.getAttribute('src')) return; mediaError = true; failure(new Error('Видео не загрузилось. Можно пропустить это задание — мы отметим техническую проблему.')); buttonState(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopVideo(); timing?.visibility(!document.hidden); updateClocks(); });
window.addEventListener('pagehide', () => { stopVideo(); timing?.visibility(false); updateClocks(); });
window.addEventListener('pageshow', () => { timing?.visibility(!document.hidden); });
begin();
