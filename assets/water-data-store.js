/* X-Aqua 本機資料層：無網路或認證能力。日後由同介面的 API adapter 替換。 */
(function (root) {
  'use strict';
  const KEY = 'x-aqua.water-data.v1';
  const METRICS = Object.freeze({
    temperature_c: { label: '水溫', unit: '°C' },
    ph: { label: 'pH', unit: '1' },
    dissolved_oxygen_mg_l: { label: 'DO（溶氧）', unit: 'mg/L' },
    salinity_ppt: { label: '鹽度', unit: 'ppt' }
  });
  const keys = Object.keys(METRICS);
  const clone = value => JSON.parse(JSON.stringify(value));
  const now = () => new Date().toISOString();
  const uuid = () => {
    if (root.crypto.randomUUID) return root.crypto.randomUUID();
    const b = root.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    return Array.from(b, (n, i) => ([4, 6, 8, 10].includes(i) ? '-' : '') + n.toString(16).padStart(2, '0')).join('');
  };
  function check(ok, message) { if (!ok) throw new Error(message); }
  function reasonText(text) {
    check(typeof text === 'string' && text.trim().length > 0 && text.trim().length <= 1000, '請填寫操作原因（1～1000 字）。');
    return text.trim();
  }
  function valuesOf(input) {
    check(input && typeof input === 'object' && !Array.isArray(input), '量測格式錯誤。');
    check(Object.keys(input).every(k => keys.includes(k)), '只接受四項核心量測欄位。');
    const result = {};
    keys.forEach(k => {
      const v = input[k] === undefined ? null : input[k];
      check(v === null || (typeof v === 'number' && Number.isFinite(v)), '量測必須是有限數字；未量測請留白。');
      check(v === null || !['dissolved_oxygen_mg_l', 'salinity_ppt'].includes(k) || v >= 0, 'DO 與鹽度不得為負值。');
      result[k] = v;
    });
    check(keys.some(k => result[k] !== null), '至少填寫一項量測值。');
    return result;
  }
  function timeOf(value) {
    check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), '量測時間必須有效且包含時區。');
    const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/).slice(1).map(Number);
    const [year, month, day, hour, minute, second] = parts;
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    check(month >= 1 && month <= 12 && day >= 1 && day <= days && hour <= 23 && minute <= 59 && second <= 59, '量測日期或時間不存在。');
    return new Date(value).toISOString();
  }
  function quality(values) {
    return { status: 'unreviewed', flags: keys.some(k => values[k] === null) ? ['missing_metric'] : [], reviewed_by: null, reviewed_at: null, rule_version: null, reason: null };
  }
  function validateState(s) {
    check(s && s.schema_version === '1.0' && Number.isInteger(s.revision) && s.revision >= 0 && typeof s.organization_id === 'string' && typeof s.actor_id === 'string', '本機資料版本或識別資訊損壞，已停止寫入，請先備份原始資料。');
    ['records', 'ponds', 'versions', 'audit_events', 'merges'].forEach(k => check(Array.isArray(s[k]), '本機資料結構損壞，已停止寫入。'));
    const ids = new Set();
    s.records.forEach(r => {
      check(r && typeof r.record_id === 'string' && !ids.has(r.record_id) && r.schema_version === '1.0' && Number.isInteger(r.version) && r.version > 0, '紀錄識別碼或版本損壞。');
      ids.add(r.record_id);
      valuesOf(r.values); timeOf(r.measured_at);
      check(r.source?.type === 'manual' && r.organization_id === s.organization_id && s.ponds.some(p => p.pond_id === r.pond_id), '本機版僅接受本組織人工紀錄。');
      check(['active', 'deleted', 'superseded'].includes(r.status) && ['unreviewed', 'valid', 'suspect', 'rejected'].includes(r.quality?.status), '紀錄狀態損壞。');
      check(typeof r.is_test === 'boolean' && keys.every(k => r.units?.[k] === METRICS[k].unit), '測試標記或單位不符。');
    });
    return s;
  }
  class LocalWaterRepository {
    constructor(storage, locks = null) { this.storage = storage; this.locks = locks; }
    read() {
      let raw;
      try { raw = this.storage.getItem(KEY); } catch (_) { throw new Error('瀏覽器不允許存取 localStorage，無法儲存資料。'); }
      if (raw === null) return null;
      try { return validateState(JSON.parse(raw)); } catch (e) { throw new Error('本機資料無法讀取，未覆寫原內容：' + e.message); }
    }
    async locked(work) {
      if (this.locks?.request) return this.locks.request(KEY, work);
      return work(); // 無 Web Locks 時僅能提供單頁版本檢查；UI 與文件明示限制。
    }
    async init() {
      return this.locked(() => {
        let s = this.read();
        if (!s) {
          s = { schema_version: '1.0', revision: 0, organization_id: uuid(), actor_id: uuid(), records: [], ponds: [], versions: [], audit_events: [], merges: [] };
          this.save(s, null);
        }
        return clone(s);
      });
    }
    save(state, expectedRevision) {
      const current = this.read();
      check((current?.revision ?? null) === expectedRevision, '其他分頁已更新資料，請重新查詢後再操作。');
      validateState(state);
      try { this.storage.setItem(KEY, JSON.stringify(state)); } catch (_) { throw new Error('儲存失敗：空間不足或存取遭拒；本次操作未儲存。'); }
    }
    event(s, action, before, after, reason, extra = {}) {
      const event = {
        audit_id: uuid(), operation_id: uuid(), request_id: uuid(), organization_id: s.organization_id,
        actor_id: s.actor_id, actor_type: 'user', action, record_ids: [...new Set([...before, ...after].map(r => r.record_id))],
        occurred_at: now(), reason, before_versions: before.map(r => ({ record_id: r.record_id, version: r.version })),
        after_versions: after.map(r => ({ record_id: r.record_id, version: r.version })),
        before_snapshots: clone(before), after_snapshots: clone(after), result: 'success', failure_code: null, ...clone(extra)
      };
      s.audit_events.push(event);
      after.forEach(r => s.versions.push({ record_id: r.record_id, version: r.version, audit_id: event.audit_id, snapshot: clone(r) }));
      return event;
    }
    async transaction(work) {
      return this.locked(() => {
        const s = this.read(); check(s, '資料尚未初始化。');
        const revision = s.revision;
        const result = work(s);
        s.revision += 1;
        this.save(s, revision); // 版本、紀錄、歷程均包含於單一 setItem，不分開寫入。
        return clone(result);
      });
    }
    record(s, id, version, status = 'active') {
      const r = s.records.find(r => r.record_id === id);
      check(r && r.version === version, '紀錄已變更或不存在，請重新查詢。');
      check(r.status === status, '紀錄狀態已變更，請重新查詢。');
      return r;
    }
    pond(s, code) {
      check(typeof code === 'string' && code.trim() && code.trim().length <= 80, '請填寫池號（最多 80 字）。');
      const pondCode = code.trim();
      let p = s.ponds.find(p => p.pond_code === pondCode);
      if (!p) { p = { pond_id: uuid(), pond_code: pondCode }; s.ponds.push(p); }
      return p;
    }
    makeRecord(s, input) {
      const p = this.pond(s, input.pond_code), v = valuesOf(input.values), at = now();
      check(typeof input.is_test === 'boolean', '請指定是否為測試資料。');
      return {
        record_id: uuid(), schema_version: '1.0', version: 1, organization_id: s.organization_id,
        ...p, measured_at: timeOf(input.measured_at), received_at: at, values: v,
        units: Object.fromEntries(keys.map(k => [k, METRICS[k].unit])),
        source: { type: 'manual', entered_by: s.actor_id, entry_method: 'form' }, quality: quality(v), status: 'active',
        created_at: at, created_by: s.actor_id, updated_at: at, updated_by: s.actor_id,
        deleted_at: null, deleted_by: null, delete_reason: null, merged_from: [], superseded_by: null, field_lineage: {}, is_test: input.is_test
      };
    }
    bump(s, r) { r.version += 1; r.updated_at = now(); r.updated_by = s.actor_id; }
    async create(input) {
      return this.transaction(s => {
        const r = this.makeRecord(s, input);
        check(!s.records.some(x => x.status === 'active' && x.pond_id === r.pond_id && x.measured_at === r.measured_at), '已有同池同時間紀錄，請查詢後修改，勿重複新增。');
        s.records.push(r); this.event(s, 'create', [], [r], reasonText(input.reason || '人工新增')); return r;
      });
    }
    async update(id, version, values, reason) {
      reason = reasonText(reason);
      return this.transaction(s => {
        const r = this.record(s, id, version), old = clone(r);
        r.values = valuesOf(values); r.quality = quality(r.values); this.bump(s, r);
        this.event(s, 'update', [old], [r], reason); return r;
      });
    }
    async softDelete(id, version, reason) {
      reason = reasonText(reason);
      return this.transaction(s => {
        const r = this.record(s, id, version), old = clone(r);
        r.status = 'deleted'; r.deleted_at = now(); r.deleted_by = s.actor_id; r.delete_reason = reason;
        this.bump(s, r); this.event(s, 'soft_delete', [old], [r], reason); return r;
      });
    }
    async restore(id, version, reason) {
      reason = reasonText(reason);
      return this.transaction(s => {
        const r = this.record(s, id, version, 'deleted'), old = clone(r);
        check(!s.records.some(x => x.status === 'active' && x.pond_id === r.pond_id && x.measured_at === r.measured_at), '已有同池同時間有效紀錄，無法直接還原。');
        r.status = 'active'; r.deleted_at = r.deleted_by = r.delete_reason = null; r.quality = quality(r.values);
        this.bump(s, r); this.event(s, 'restore', [old], [r], reason); return r;
      });
    }
    rows(s, filters = {}) {
      filters = { ...filters, from: filters.from ? timeOf(filters.from) : '', to: filters.to ? timeOf(filters.to) : '' };
      check(!filters.from || !filters.to || filters.from < filters.to, '查詢結束時間必須晚於開始時間。');
      return s.records.filter(r => (!filters.pond || r.pond_code.includes(filters.pond)) &&
        (filters.status === 'all' || r.status === (filters.status || 'active')) &&
        (!filters.quality || r.quality.status === filters.quality) && (!filters.source || r.source.type === filters.source) &&
        (!filters.from || r.measured_at >= filters.from) && (!filters.to || r.measured_at < filters.to))
        .sort((a, b) => a.measured_at.localeCompare(b.measured_at) || a.record_id.localeCompare(b.record_id));
    }
    async query(filters) {
      return this.transaction(s => {
        const rows = this.rows(s, filters);
        this.event(s, 'query', [], [], '本機查詢', { filters, matched_record_ids: rows.map(r => r.record_id) }); return rows;
      });
    }
    async previewMerge(sources) {
      return this.transaction(s => {
        check(sources.length >= 2 && new Set(sources.map(r => r.record_id)).size === sources.length, '合併需選取至少兩筆不同紀錄。');
        const records = sources.map(x => this.record(s, x.record_id, x.version));
        check(records.every(r => r.pond_id === records[0].pond_id && r.measured_at === records[0].measured_at && r.organization_id === records[0].organization_id && r.source.type === 'manual'), '只能合併同池、同時間的有效人工紀錄。');
        check(records.every(r => r.is_test === records[0].is_test), '測試資料不得與非測試資料合併。');
        const preview = { preview_id: uuid(), expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), records: clone(records), sources: clone(sources), conflicts: keys.filter(k => new Set(records.map(r => r.values[k])).size > 1) };
        this.event(s, 'merge_preview', [], [], '預覽合併，尚未變更紀錄', { preview }); return preview;
      });
    }
    async merge(preview, selections, reason, confirmed) {
      reason = reasonText(reason); check(confirmed === true, '請先確認合併預覽。');
      return this.transaction(s => {
        const saved = s.audit_events.find(e => e.action === 'merge_preview' && e.preview?.preview_id === preview.preview_id)?.preview;
        check(saved && saved.expires_at > now(), '預覽不存在或已逾 15 分鐘，請重新預覽。');
        check(!s.merges.some(m => m.preview_id === saved.preview_id), '此預覽已合併，請重新查詢。');
        const records = saved.sources.map(x => this.record(s, x.record_id, x.version));
        const before = clone(records), vals = {}, lineage = {};
        keys.forEach(k => {
          const r = records.find(r => r.record_id === selections[k]);
          check(r, '每項指標都必須明確選擇來源紀錄。'); vals[k] = r.values[k]; lineage[k] = { record_id: r.record_id, version: r.version };
        });
        const result = this.makeRecord(s, { pond_code: records[0].pond_code, measured_at: records[0].measured_at, values: vals, is_test: records[0].is_test });
        result.merged_from = records.map(r => r.record_id); result.field_lineage = lineage;
        records.forEach(r => { r.status = 'superseded'; r.superseded_by = result.record_id; this.bump(s, r); });
        s.records.push(result);
        const merge = { merge_id: uuid(), preview_id: saved.preview_id, result_id: result.record_id, source_versions: records.map(r => ({ record_id: r.record_id, version: r.version })), reverted: false };
        s.merges.push(merge); this.event(s, 'merge', before, [...records, result], reason, { merge_id: merge.merge_id, field_lineage: lineage }); return result;
      });
    }
    async revertMerge(id, version, reason) {
      reason = reasonText(reason);
      return this.transaction(s => {
        const m = s.merges.find(m => m.result_id === id && !m.reverted); check(m, '沒有可撤銷的合併。');
        const result = this.record(s, id, version); check(result.version === 1, '合併產物已有修改，不能自動撤銷。');
        const sources = m.source_versions.map(x => this.record(s, x.record_id, x.version, 'superseded'));
        check(sources.every(r => r.superseded_by === id), '來源已有後續合併，無法撤銷。');
        check(!s.records.some(r => r.status === 'active' && r.record_id !== id && r.pond_id === result.pond_id && r.measured_at === result.measured_at), '已有新的同時量測，不能自動撤銷。');
        const before = clone([result, ...sources]);
        result.status = 'deleted'; result.deleted_at = now(); result.deleted_by = s.actor_id; result.delete_reason = reason; this.bump(s, result);
        sources.forEach(r => { r.status = 'active'; r.superseded_by = null; r.quality = quality(r.values); this.bump(s, r); });
        m.reverted = true; this.event(s, 'merge_revert', before, [result, ...sources], reason, { merge_id: m.merge_id }); return sources;
      });
    }
    async demo() {
      return this.transaction(s => {
        check(!s.audit_events.some(e => e.action === 'load_test_data'), '測試資料已載入，不重複建立。');
        // 僅測試 fixture 保留兩筆衝突，供合併演練；一般新增仍拒絕重複。
        const measured = '2026-01-01T00:00:00Z';
        const records = [
          this.makeRecord(s, { pond_code: '測試池-A', measured_at: measured, values: { temperature_c: 25, ph: 7, dissolved_oxygen_mg_l: null, salinity_ppt: 12 }, is_test: true }),
          this.makeRecord(s, { pond_code: '測試池-A', measured_at: measured, values: { temperature_c: 26, ph: 7, dissolved_oxygen_mg_l: 5, salinity_ppt: 13 }, is_test: true })
        ];
        s.records.push(...records); this.event(s, 'load_test_data', [], records, '測試資料：僅用於功能演練，非養殖建議或實測數據'); return records;
      });
    }
    async exportCsv(filters) {
      return this.transaction(s => {
        const records = this.rows(s, filters), at = now();
        const headers = ['record_id', 'organization_id', 'pond_id', 'pond_code', 'measured_at', 'received_at', ...keys, ...keys.map(k => k + '_unit'), 'source_type', 'source_id', 'schema_version', 'version', 'quality_status', 'status', 'is_test', 'data_label'];
        const cell = value => {
          let v = value === null || value === undefined ? '' : String(value);
          if (typeof value === 'string' && /^[\s]*[=+@-]|^[\x00-\x1f]/.test(value)) v = "'" + v;
          return '"' + v.replace(/"/g, '""') + '"';
        };
        const rows = records.map(r => [r.record_id, r.organization_id, r.pond_id, r.pond_code, r.measured_at, r.received_at, ...keys.map(k => r.values[k]), ...keys.map(k => r.units[k]), r.source.type, r.source.entered_by, r.schema_version, r.version, r.quality.status, r.status, r.is_test, r.is_test ? '測試資料' : '人工輸入（未驗證）']);
        const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
        this.event(s, 'csv_export', [], [], '匯出目前查詢結果', { filters, snapshot_at: at, row_count: records.length, file_name: 'x-aqua-water-data.csv' });
        return { csv, row_count: records.length, snapshot_at: at };
      });
    }
  }
  const exported = { LocalWaterRepository, METRICS, KEY, valuesOf, timeOf };
  root.XAquaData = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof window !== 'undefined' ? window : globalThis);
