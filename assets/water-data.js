(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  if (!$('water-controls')) return;
  const { LocalWaterRepository, METRICS, KEY } = window.XAquaData;
  let repository;
  const keys = Object.keys(METRICS);
  const qualityNames = { unreviewed: '未覆核', valid: '已確認', suspect: '可疑', rejected: '不採用' };
  const statusNames = { active: '有效', deleted: '已軟刪除', superseded: '已合併取代' };
  const actionNames = { create: '新增', update: '修改', soft_delete: '軟刪除', restore: '還原', query: '查詢', merge_preview: '合併預覽', merge: '確認合併', merge_revert: '撤銷合併', csv_export: 'CSV 匯出', load_test_data: '載入測試資料' };
  let filters = { status: 'active' }, rows = [], selected = new Set(), editRecord = null, actionRecord = null, preview = null;
  let metric = new URLSearchParams(location.search).get('metric');
  if (!keys.includes(metric)) metric = keys[0];
  const message = (text, error = false) => { $('workspace-message').textContent = text; $('workspace-message').classList.toggle('error-text', error); };
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const localDate = date => {
    const d = new Date(date); const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const utc = value => value ? new Date(value).toISOString() : '';
  const displayTime = value => new Date(value).toLocaleString('zh-TW', { hour12: false }) + '（裝置時區）';
  const displayValue = (r, key) => r.values[key] === null ? '—（缺測）' : String(r.values[key]);
  function valuesFromForm() {
    return Object.fromEntries(keys.map(k => { const v = $('record-form').elements[k].value.trim(); return [k, v === '' ? null : Number(v)]; }));
  }
  function selectionState() {
    const picked = rows.filter(r => selected.has(r.record_id));
    $('selection-count').textContent = `已選 ${picked.length} 筆。`;
    $('edit-selected').disabled = picked.length !== 1 || picked[0].status !== 'active';
    $('delete-selected').disabled = picked.length !== 1 || picked[0].status !== 'active';
    $('merge-selected').disabled = picked.length < 2 || picked.some(r => r.status !== 'active');
  }
  function switchMetric(key, updateUrl = true) {
    metric = keys.includes(key) ? key : keys[0];
    document.querySelectorAll('[data-metric]').forEach(n => n.setAttribute('aria-pressed', String(n.dataset.metric === metric)));
    document.querySelectorAll('[data-column]').forEach(n => n.classList.toggle('selected-column', n.dataset.column === metric));
    if (updateUrl) { const url = new URL(location.href); url.searchParams.set('metric', metric); history.replaceState(null, '', url); }
  }
  function render() {
    const state = repository.read();
    if (!state) throw new Error('本機資料已被清除，請重新載入頁面。');
    rows = repository.rows(state, filters);
    selected = new Set([...selected].filter(id => rows.some(r => r.record_id === id)));
    $('record-rows').replaceChildren();
    rows.forEach(r => {
      const tr = el('tr');
      const pickCell = el('td'); const box = el('input'); box.type = 'checkbox'; box.checked = selected.has(r.record_id); box.dataset.pick = r.record_id; box.setAttribute('aria-label', `選取 ${r.pond_code} ${displayTime(r.measured_at)} ${r.record_id}`); pickCell.append(box); tr.append(pickCell);
      const pond = el('td'); pond.append(el('strong', r.pond_code), el('small', displayTime(r.measured_at)), el('small', 'ID ' + r.record_id.slice(0, 8))); tr.append(pond);
      keys.forEach(k => { const td = el('td', displayValue(r, k)); td.dataset.column = k; tr.append(td); });
      const source = el('td'); source.append(el('span', '人工輸入'), el('small', qualityNames[r.quality.status]), el('small', '版本 ' + r.version)); tr.append(source);
      const status = el('td'); status.append(el('span', statusNames[r.status]), el('span', r.is_test ? '測試資料' : '人工輸入（未驗證）', r.is_test ? 'test-badge' : 'muted')); tr.append(status);
      const actions = el('td'), wrap = el('div', undefined, 'row-actions');
      const add = (label, action) => { const b = el('button', label, 'data-button'); b.type = 'button'; b.dataset.action = action; b.dataset.id = r.record_id; wrap.append(b); };
      if (r.status === 'active') { add('修改', 'edit'); add('軟刪除', 'delete'); }
      if (r.status === 'deleted' && !state.merges.some(m => m.reverted && m.result_id === r.record_id)) add('還原', 'restore');
      if (r.status === 'active' && r.version === 1 && state.merges.some(m => !m.reverted && m.result_id === r.record_id)) add('撤銷合併', 'revert');
      add('歷程', 'history'); actions.append(wrap); tr.append(actions); $('record-rows').append(tr);
    });
    if (!rows.length) { const tr = el('tr'), td = el('td', '沒有符合條件的紀錄。可新增人工量測，或載入測試資料演練。'); td.colSpan = 9; tr.append(td); $('record-rows').append(tr); }
    $('result-count').textContent = `${rows.length} 筆結果 · 測試資料 ${rows.filter(r => r.is_test).length} 筆`;
    keys.forEach(k => {
      const latest = [...rows].reverse().find(r => r.status === 'active' && r.values[k] !== null);
      const reading = document.querySelector(`[data-reading="${k}"]`);
      reading.textContent = latest ? `${latest.values[k]}${latest.is_test ? ' · 測試資料' : ' · 人工未驗證'}` : '—';
    });
    $('audit-log').replaceChildren();
    const events = state.audit_events.slice(-20).reverse();
    if (!events.length) $('audit-log').append(el('p', '尚無操作歷程。'));
    events.forEach(event => {
      const block = el('article', undefined, 'audit-entry');
      block.append(el('strong', actionNames[event.action] || event.action), el('p', displayTime(event.occurred_at)), el('p', event.reason));
      const details = el('details'); details.append(el('summary', '查看操作、來源及前後版本快照'), el('pre', JSON.stringify(event, null, 2))); block.append(details); $('audit-log').append(block);
    });
    $('audit-log').append(el('p', `顯示最近 ${events.length} 次；全部 ${state.audit_events.length} 次仍保存在本機。`, 'muted'));
    $('load-demo').disabled = state.audit_events.some(e => e.action === 'load_test_data');
    selectionState(); switchMetric(metric, false);
  }
  async function run(work, target) {
    try { if (target) $(target).textContent = ''; await work(); }
    catch (e) { message(e.message, true); if (target) $(target).textContent = e.message; }
  }
  function openEditor(record = null) {
    editRecord = record ? JSON.parse(JSON.stringify(record)) : null;
    $('record-form').reset(); $('editor-error').textContent = '';
    $('editor-title').textContent = record ? '修改人工量測' : '新增人工量測';
    $('record-pond').value = record?.pond_code || ''; $('record-pond').disabled = !!record;
    $('record-time').value = localDate(record?.measured_at || new Date()); $('record-time').disabled = !!record;
    keys.forEach(k => { $('record-form').elements[k].value = record?.values[k] ?? ''; });
    $('record-test').checked = record ? record.is_test : true; $('record-test').disabled = !!record;
    $('record-reason').value = record ? '' : '人工新增'; $('editor-panel').hidden = false;
    $('editor-panel').scrollIntoView({ block: 'start' });
    (record ? $('record-form').elements[metric] : $('record-pond')).focus();
  }
  function openAction(action, record) {
    actionRecord = { action, record: JSON.parse(JSON.stringify(record)) };
    const titles = { delete: '確認軟刪除', restore: '還原紀錄', revert: '撤銷合併' };
    $('action-title').textContent = titles[action];
    $('action-description').textContent = `${record.pond_code}，${displayTime(record.measured_at)}，版本 ${record.version}。` + (action === 'delete' ? '保留原始數值與歷程，預設查詢將隱藏此筆。' : action === 'restore' ? '還原後品質回到未覆核。' : '合併產物會軟刪除，來源回到有效狀態；已有後續變動時拒絕撤銷。');
    $('action-reason').value = ''; $('action-error').textContent = ''; $('action-dialog').showModal();
  }
  function showHistory(record) {
    const state = repository.read();
    $('history-content').textContent = JSON.stringify({ record, versions: state.versions.filter(v => v.record_id === record.record_id), audit_events: state.audit_events.filter(e => e.record_ids.includes(record.record_id)), merge_history: state.merges.filter(m => m.result_id === record.record_id || m.source_versions.some(s => s.record_id === record.record_id)) }, null, 2);
    $('history-dialog').showModal();
  }
  async function openMerge() {
    const picked = rows.filter(r => selected.has(r.record_id));
    preview = await repository.previewMerge(picked.map(r => ({ record_id: r.record_id, version: r.version })));
    $('merge-options').replaceChildren(); $('merge-form').reset(); $('merge-error').textContent = '';
    $('merge-options').append(el('p', `${preview.records[0].pond_code} · ${displayTime(preview.records[0].measured_at)} · ${preview.records.length} 筆 · ${preview.records[0].is_test ? '測試資料' : '人工未驗證'}。預覽有效 15 分鐘。`));
    keys.forEach(k => {
      const conflict = preview.conflicts.includes(k), field = el('fieldset', undefined, 'merge-field' + (conflict ? ' conflict' : ''));
      field.append(el('legend', `${METRICS[k].label}（${METRICS[k].unit === '1' ? '無單位' : METRICS[k].unit}） · ${conflict ? '有衝突' : '數值相同'}`));
      preview.records.forEach((r, index) => field.append(el('p', `來源 ${index + 1}：${displayValue(r, k)} · ID ${r.record_id} · v${r.version}${r.is_test ? ' · 測試資料' : ''}`)));
      const label = el('label', '保留哪一筆的數值？'), select = el('select'); select.name = k; select.required = true;
      const empty = el('option', '請明確選擇來源'); empty.value = ''; select.append(empty);
      preview.records.forEach((r, index) => { const option = el('option', `來源 ${index + 1}：${displayValue(r, k)}`); option.value = r.record_id; select.append(option); });
      label.append(select); field.append(label); $('merge-options').append(field);
    });
    render(); $('merge-dialog').showModal();
  }
  function currentFilters() {
    return { pond: $('filter-pond').value.trim(), status: $('filter-status').value, from: utc($('filter-from').value), to: utc($('filter-to').value), quality: $('filter-quality').value, source: $('filter-source').value };
  }
  function rowById(id) { const r = rows.find(r => r.record_id === id); if (!r) throw new Error('找不到紀錄，請重新查詢。'); return r; }
  document.querySelectorAll('[data-metric]').forEach(b => b.addEventListener('click', () => switchMetric(b.dataset.metric)));
  $('new-record').addEventListener('click', () => openEditor());
  $('cancel-edit').addEventListener('click', () => { $('editor-panel').hidden = true; editRecord = null; $('new-record').focus(); });
  $('open-query').addEventListener('click', () => { $('query-title').scrollIntoView(); $('filter-pond').focus(); });
  $('record-form').addEventListener('submit', e => {
    e.preventDefault(); const submit = e.submitter; if (submit) submit.disabled = true;
    run(async () => {
      if (editRecord) await repository.update(editRecord.record_id, editRecord.version, valuesFromForm(), $('record-reason').value);
      else await repository.create({ pond_code: $('record-pond').value, measured_at: utc($('record-time').value), values: valuesFromForm(), is_test: $('record-test').checked, reason: $('record-reason').value });
      $('editor-panel').hidden = true; editRecord = null; selected.clear(); render(); message('已儲存至此瀏覽器，版本與操作歷程一併保留。');
    }, 'editor-error').finally(() => { if (submit) submit.disabled = false; });
  });
  $('query-form').addEventListener('submit', e => { e.preventDefault(); run(async () => { const next = currentFilters(); await repository.query(next); filters = next; selected.clear(); render(); message('已套用查詢條件。'); }); });
  $('reset-query').addEventListener('click', () => run(async () => { $('query-form').reset(); const next = currentFilters(); await repository.query(next); filters = next; selected.clear(); render(); message('已重設查詢。'); }));
  $('record-rows').addEventListener('change', e => { if (e.target.dataset.pick) { if (e.target.checked) selected.add(e.target.dataset.pick); else selected.delete(e.target.dataset.pick); selectionState(); } });
  $('record-rows').addEventListener('click', e => run(async () => {
    const b = e.target.closest('button[data-action]'); if (!b) return;
    const record = rowById(b.dataset.id), action = b.dataset.action;
    if (action === 'history') showHistory(record); else if (action === 'edit') openEditor(record); else openAction(action, record);
  }));
  $('edit-selected').addEventListener('click', () => run(async () => openEditor(rowById([...selected][0]))));
  $('delete-selected').addEventListener('click', () => run(async () => openAction('delete', rowById([...selected][0]))));
  $('merge-selected').addEventListener('click', () => run(openMerge));
  $('action-form').addEventListener('submit', e => {
    e.preventDefault(); const b = e.submitter; if (b) b.disabled = true;
    run(async () => {
      const { action, record } = actionRecord, reason = $('action-reason').value;
      if (action === 'delete') await repository.softDelete(record.record_id, record.version, reason);
      else if (action === 'restore') await repository.restore(record.record_id, record.version, reason);
      else await repository.revertMerge(record.record_id, record.version, reason);
      $('action-dialog').close(); selected.clear(); render(); message('操作完成，原始紀錄與歷程已保留。');
    }, 'action-error').finally(() => { if (b) b.disabled = false; });
  });
  $('merge-form').addEventListener('submit', e => {
    e.preventDefault(); const b = e.submitter; if (b) b.disabled = true;
    run(async () => {
      const selections = Object.fromEntries(keys.map(k => [k, $('merge-form').elements[k].value]));
      await repository.merge(preview, selections, $('merge-reason').value, $('merge-confirm').checked);
      $('merge-dialog').close(); selected.clear(); render(); message('合併完成：已建立新紀錄，保留來源、逐欄選值及合併歷程。');
    }, 'merge-error').finally(() => { if (b) b.disabled = false; });
  });
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $(b.dataset.close).close()));
  $('load-demo').addEventListener('click', () => run(async () => { await repository.demo(); render(); message('已載入兩筆測試資料；可選取它們預覽衝突合併。'); }));
  $('export-csv').addEventListener('click', () => run(async () => {
    const result = await repository.exportCsv(filters);
    const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' }), url = URL.createObjectURL(blob), link = el('a');
    link.href = url; link.download = 'x-aqua-water-data.csv'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    render(); message(`已產生 ${result.row_count} 筆 CSV 下載，使用目前已套用的查詢條件。`);
  }));
  window.addEventListener('storage', e => { if (e.key === KEY || e.key === null) run(async () => { selected.clear(); render(); message('其他分頁已變更資料；編輯中的舊版本在儲存時會重新檢查。'); }); });
  run(async () => {
    repository = new LocalWaterRepository(window.localStorage, navigator.locks);
    await repository.init(); render(); switchMetric(metric, false); $('water-controls').hidden = false;
    $('lock-notice').textContent = navigator.locks?.request ? '此瀏覽器支援跨分頁寫入鎖；仍不提供跨裝置同步或伺服器權限保護。' : '此環境不支援跨分頁寫入鎖，請只開啟一個資料管理分頁操作。';
    message('本機工作區已就緒。尚未連接正式資料庫或雲端 API。');
  });
})();
