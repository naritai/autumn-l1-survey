const byId = id => document.getElementById(id);
const seconds = ms => ms == null ? '—' : `${(ms / 1000).toFixed(2)} с`;
async function request(path) { const r = await fetch(path, { cache: 'no-store', headers: { 'X-Survey-Admin': '1' } }); if (!r.ok) throw new Error('Не удалось получить результаты.'); return r; }
async function refresh() {
  try {
    const data = await (await request('/api/summary')).json();
    const stats = [['Начали', data.participants.started], ['Завершили', data.participants.completed], ['Ответов', data.tasks.answered], ['Оценок понятности', data.tasks.rated], ['Медиана ответа', seconds(data.response.median_response_ms)], ['90-й перцентиль', seconds(data.response.p90_response_ms)]];
    byId('stats').replaceChildren(...stats.map(([name, value]) => { const d = document.createElement('div'); d.className = 'stat'; const b = document.createElement('b'); b.textContent = value; const s = document.createElement('span'); s.textContent = name; d.append(b, s); return d; }));
    byId('results').replaceChildren(...data.shapes.map(row => { const tr = document.createElement('tr'); for (const value of [row.label, row.answered, row.answered ? `${row.correct} / ${row.answered}` : '—', row.skipped, row.rated ? `${row.clear} / ${row.rated}` : '—', row.response_samples, seconds(row.median_response_ms), seconds(row.p90_response_ms), seconds(row.median_correct_response_ms)]) { const td = document.createElement('td'); td.textContent = value; tr.append(td); } return tr; }));
    byId('empty').hidden = data.participants.started > 0; byId('updated').textContent = `Обновлено ${new Date().toLocaleTimeString('ru-RU')}`; byId('notice').textContent = '';
  } catch (error) { byId('notice').textContent = error.message; }
}
byId('refresh').addEventListener('click', refresh);
byId('export').addEventListener('click', async () => { try { const blob = await (await request('/api/export.csv')).blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'l1-survey-results.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (error) { byId('notice').textContent = error.message; } });
refresh();
