# X-Aqua API 契約

狀態：設計規格 v0.1，全部端點均為未來規劃，尚未部署或實作；目前沒有正式 API、資料庫或即時監控服務。路徑 `/api/v1` 僅為預定介面，不代表現有 GitHub Pages 提供服務。

依據：[資料契約](data-contract.md)、[架構設計](architecture.md)。本文不是可直接執行的 OpenAPI 文件；實作前須補齊機器可驗證 schema、測試案例及部署設定。

## 共通約定

- HTTPS 與 JSON；CSV 檔案上傳採 `multipart/form-data`。要求經驗證的使用者或設備身分，授權組織與池別由服務端判定。認證技術尚待選型，憑證不得放進網址、前端原始碼或公開儲存庫。
- 核心 `values` 欄位僅接受 `temperature_c`、`ph`、`dissolved_oxygen_mg_l`、`salinity_ppt`，單位固定為 `°C`、`1`、`mg/L`、`ppt`。單位物件由服務端回傳，不接受用戶任意指定單位。氨氮、TAN、NH3 僅為未來擴充，本版拒絕這些量測鍵。
- 所有識別碼為 UUID 字串，時間依資料契約使用含時區的 RFC 3339，回傳 UTC。拒絕未知欄位與不允許寫入的服務端欄位，不靜默忽略。
- 成功單筆回應為 `{data, meta: {schema_version, request_id}}`；集合 `data` 為陣列，`meta` 另含 `next_cursor` 與 `snapshot_at`。每次回應附 `X-Request-ID`。
- 錯誤為 `{error: {code, message, details}, meta: {request_id}}`，`details` 僅含可公開的欄位與列號，不洩漏其他組織資料、憑證或堆疊。無權存取的物件視為不存在。
- 所有變更、工作提交與設備寫入請求必帶 `Idempotency-Key`，範圍為身分、組織、方法及路徑；相同鍵與相同內容重試回原結果，相同鍵不同內容回 `409 IDEMPOTENCY_CONFLICT`。預定保留成功結果 24 小時；工作提交識別碼與設備事件唯一鍵另永久防止重複提交，不受此期限影響。
- 預覽 token 預定有效 15 分鐘，綁定操作者、組織、輸入雜湊及來源版本；逾期回 `410 PREVIEW_EXPIRED`，必須重新預覽。
- 修改單一紀錄需 `If-Match: "record:<record_id>:v<version>"`；GET 回傳相同格式的 `ETag`。缺少回 `428 PRECONDITION_REQUIRED`，不符回 `412 VERSION_CONFLICT`，不執行寫入；禁止 `If-Match: *` 強制覆寫。
- 修改、刪除、還原、品質覆核、合併及撤銷皆須非空白 `reason`（上限 1000 字）。同一寫入交易中必須保存版本與稽核；稽核不可寫入則整筆失敗。讀取也須留下查詢條件與範圍稽核，不記錄授權標頭。

## 權限能力

| 身分 | 預定能力（仍受組織／池別限制） |
| --- | --- |
| `viewer` | 查詢有效紀錄、建立授權範圍 CSV 匯出 |
| `editor` | viewer 能力，加人工新增、人工數值修改、人工軟刪除、人工還原與匯入 |
| `data_steward` | editor 能力，加品質覆核、合併／撤銷、感測器正規化更正與軟刪除／還原、讀取版本及稽核 |
| `admin` | 管理組織、池別與角色；如需資料操作須另授予對應能力，不自動繞過保護規則 |
| `sensor_ingest` | 僅可向授權設備接入通道送資料，不能操作人工紀錄、查詢其他池或管理角色 |

`include_deleted`、`include_superseded` 及原始封包存取限 `data_steward`。Phase 01 必須先具備基本認證與能力檢查，Phase 04 才擴充完整角色管理介面；DaaS 身分另依訂閱範圍只讀授權。

## Phase 01：人工紀錄與查詢

| 方法與路徑 | 輸入與行為 | 成功 |
| --- | --- | --- |
| `POST /api/v1/records` | `{pond_id, measured_at, values}`；只建立人工紀錄，`source` 由服務端產生 | `201` 完整紀錄、Location 與 ETag |
| `GET /api/v1/records` | `pond_id`、`from`、`to`、`source_type`、`quality_status`、`include_deleted`、`include_superseded`、`limit`、`cursor` | `200` 授權紀錄集合 |
| `GET /api/v1/records/{record_id}` | 預設不回軟刪除或已取代紀錄；專責角色可用對應 include 參數 | `200` 完整紀錄與 ETag |
| `PATCH /api/v1/records/{record_id}` | `{values, reason}`；只更正數值，未提供鍵保持原值，明確 `null` 表示缺測；結果至少一項非空 | `200` 新版本及 ETag |
| `POST /api/v1/records/{record_id}/soft-delete` | `{reason}` 與 If-Match；只接受 `active`，設軟刪除資訊 | `200` 新版本及 ETag |
| `POST /api/v1/records/{record_id}/restore` | `{reason}` 與 If-Match；只接受 `deleted`，清除目前刪除標記，品質回 `unreviewed` | `200` 新版本及 ETag |
| `POST /api/v1/records/{record_id}/quality-reviews` | `{status, flags, reason}` 與 If-Match；專責覆核，須為 `active` | `200` 新版本及 ETag |
| `GET /api/v1/records/{record_id}/versions` | 專責角色，含已刪除／取代紀錄；cursor 分頁 | `200` 不可變版本快照與操作原因 |
| `GET /api/v1/audit-events` | 專責角色，以 `record_id`、`operation_id`、`from`、`to` 與 cursor 篩選 | `200` 授權稽核事件集合 |

`values` 回應包含四個鍵；核心數值、`units`、來源、池號、識別碼、時間、版本、品質、生命週期及稽核參照依資料契約。新增預設品質 `unreviewed`，修改數值也將品質改回 `unreviewed`，保留前次覆核歷史。感測器正規化紀錄只允許 `data_steward` 透過 PATCH 更正，建立新修訂且仍保留 `source.type=sensor` 與原始封包參照；Phase 02 之前此來源不可寫入。

`pond_id`、`measured_at`、來源及所有服務端欄位不得透過 PATCH 變更。人工填錯池或時間需軟刪除後新增；新增可透過 `correction_of`（原 `record_id`）建立稽核關聯，該欄僅此更正情境允許，要求原紀錄已軟刪除、同組織且操作者有兩池權限。一般 DELETE 與硬刪除不提供。

查詢時間區間為 `[from,to)`，排序固定 `measured_at ASC, record_id ASC`。`limit` 預設 100、最大 500；cursor 為服務端簽署的不透明值，綁定篩選與快照，不可換條件續用；快照保存預定 15 分鐘，過期回 `410 CURSOR_EXPIRED`。查詢與匯出預設排除軟刪除及已被取代資料，品質不過濾時必須回傳品質狀態供使用者判讀。

單筆人工新增若命中資料契約的重複候選鍵，回 `409 DUPLICATE_CANDIDATE` 與授權範圍內候選 ID，不自動覆寫。還原遇到有效重複候選也拒絕，需另行評估。

## Phase 01：批次匯入

| 方法與路徑 | 契約 |
| --- | --- |
| `POST /api/v1/import-jobs/preview` | multipart `file`（CSV），建立工作並驗證；`201` 回 `{import_job_id, state, file_sha256, total_rows, valid_rows, errors, duplicate_candidates, preview_token, expires_at}`。若有錯誤 `state=needs_correction`，token 為 null；全通過才 `state=ready` |
| `POST /api/v1/import-jobs/{import_job_id}/commit` | JSON `{preview_token, reason}`；檢查預覽綁定、授權、檔案雜湊與最新重複狀況，原子建立所有人工紀錄；`200` 回 `{import_job_id, state: committed, created_record_ids, operation_id}` |
| `GET /api/v1/import-jobs/{import_job_id}` | 僅工作擁有者或專責角色，回工作狀態、逐列結果與成功產物 |

CSV 標頭、空值及單位依資料契約；預定檔案上限 10 MiB、每批 10000 列，超過拒收。格式或列錯誤均不寫入正式紀錄；不得以相同工作偷偷替換檔案或採取部分成功。確認時資料變動導致重複則 `409 PREVIEW_STALE`，重新預覽；已提交工作重試回既有成功結果，不再新增。工作狀態為 `needs_correction`、`ready`、`committed` 或 `expired`；修正檔案須建立新工作。

## Phase 01：合併與撤銷

| 方法與路徑 | 契約 |
| --- | --- |
| `POST /api/v1/merge-previews` | `{sources: [{record_id, version}], field_selection, reason}`；`field_selection` 的四個核心鍵各指定來源 `record_id`，不得直接輸入值。檢查資料契約的同池同時間人工合併限制；`201` 回 `{merge_preview_id, preview_token, expires_at, differences, proposed_record, source_versions}` |
| `POST /api/v1/merges` | `{preview_token, reason}`；專責角色原子建立新紀錄、標記來源被取代並寫稽核；`201` 回 `{merge_id, record, source_versions, operation_id}` |
| `POST /api/v1/merges/{merge_id}/revert` | `{expected_result_version, expected_source_versions, reason}`；專責角色；依資料契約檢查產物未修改且來源未變動，原子補償；`200` 回 `{merge_id, result_record_id, restored_source_ids, operation_id}` |

確認合併需重新比對每筆來源版本，不以過期預覽覆寫；缺版本回 `428`、版本不符回 `412`。若預覽輸入或來源生命週期變更則 `409 PREVIEW_STALE`。選值結果的 `field_lineage` 必須對應指定來源與版本；不平均、不自動捨棄衝突。撤銷不刪來源、產物或稽核，已有下游異動回 `409 MERGE_HAS_DEPENDENTS`；預覽與提交均記錄操作者及關聯。

## Phase 01：CSV 匯出

`POST /api/v1/export-jobs` 接受 `{filters, reason}`，filters 沿用紀錄查詢條件但不接受 cursor；建立授權快照，`202` 回 `{export_job_id, state: queued, snapshot_at}`。`GET /api/v1/export-jobs/{export_job_id}` 回 `queued`、`running`、`completed`、`failed` 或 `expired`；完成另回 `row_count`、`file_sha256`、`expires_at` 及同服務的授權下載路徑。`GET /api/v1/export-jobs/{export_job_id}/download` 需再次認證與檢查池別權限，成功為 `200 text/csv; charset=utf-8`，附下載檔名；權限撤銷即停止後續下載。

匯出工作只包含建立時授權且符合條件的快照；檔案格式及公式防護依資料契約。暫存下載預定 24 小時到期，過期回 `410 EXPORT_EXPIRED`；不公開永久網址。排程、完成、下載及失敗皆稽核。

## Phase 02：感測器接入預留

`POST /api/v1/sensor-events` 僅接受設備身分，輸入 `{schema_version, device_id, event_id, measured_at, payload}`；payload 內含設備送出的原始 `values` 與 `units`，不接受任意 `source.type`。池別依設備在量測當時的授權對應取得；無對應、未知單位、時間無法解析或規則不通過時進隔離區，不能猜測池號或覆寫接收時間。

成功接收 `202` 回 `{raw_event_id, ingest_status, record_id}`，未產生正規化紀錄時 record_id 為 null；`GET /api/v1/sensor-events/{raw_event_id}` 供同設備或專責角色查詢處理結果。即使隔離也保存原始封包與雜湊，格式無法構成合法請求或未授權者則直接拒絕，不保存其敏感內容。格式接受後的品質判讀、正規化及規則版本留處理事件。

重送去重以設備事件鍵為準，相同事件不同內容回 `409 EVENT_CONTENT_CONFLICT`；離線補傳與亂序使用 `measured_at`，不能假裝目前讀值。錯誤更正只能增加版本或處理事件，原始封包不提供 PATCH／DELETE。

## Phase 03：監控及告警預留

- `GET /api/v1/alerts`：以池、時間、狀態查詢，cursor 分頁。
- `POST /api/v1/alert-rules`：專責角色輸入 `{pond_id, metric, condition, threshold, duration_seconds, hysteresis, missing_after_seconds, enabled, reason}`；metric 僅核心四鍵，缺資料規則可不帶數值門檻。建立後保存規則 ID 與版本，不預設養殖安全門檻。
- `PATCH /api/v1/alert-rules/{rule_id}`：專責角色，預期版本與原因，規則變更另留歷史。
- `POST /api/v1/alerts/{alert_id}/acknowledge` 及 `/resolve`：專責角色，預期版本、原因，保存確認者與時間；衝突處理比照紀錄。

告警內容必含 `alert_id`、池號、規則 ID／版本、觸發紀錄 ID／版本、量測與偵測時間、生命週期、通知嘗試及結果。規則採版本 ETag `"rule:<rule_id>:v<version>"`，告警採 `"alert:<alert_id>:v<version>"`。實際排程頻率、延遲容忍、告警通路與全天候維運目標需另訂及演練；本輪沒有啟用監控。

## Phase 04：Dashboard、DaaS 與身分管理預留

- `GET /api/v1/dashboard/summary`：授權池別、期間與核心指標彙整；回應包含資料時間、有效樣本數、缺測數、品質篩選及彙整方法版本，不把缺測當作 0。
- `GET /api/v1/daas/records`：訂閱身分，只讀、欄位與池別／期間限制、cursor 分頁；回傳契約版本、來源與品質。不直接回原始封包或私人操作快照。
- `GET /api/v1/me`：身分、組織、池別及能力範圍。
- `POST /api/v1/access-grants`、`POST /api/v1/access-grants/{grant_id}/revoke`：限授權管理者，指定主體、角色／能力、組織與池別、效期及原因；撤銷具版本檢查與稽核，管理者不得授予自己未被委派的權限。

上述僅預留路徑與行為邊界；彙整精確 schema、訂閱與配額、身分提供者及權限委派模型須在 Phase 04 實作前完成版本化契約。

## 錯誤與必要驗收

| HTTP | 代碼範例 | 行為 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | JSON／CSV 結構或欄位不合法 |
| 401 / 403 | `UNAUTHENTICATED` / `FORBIDDEN` | 未登入或無操作能力；不得寫入 |
| 404 | `NOT_FOUND` | 不存在或不在授權範圍 |
| 409 | `DUPLICATE_CANDIDATE`、`PREVIEW_STALE`、`INVALID_STATE` | 需重新查詢、預覽或人工處理 |
| 410 | `PREVIEW_EXPIRED`、`CURSOR_EXPIRED`、`EXPORT_EXPIRED` | 重新建立工作／查詢 |
| 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | 保留原資料，不強制覆寫 |
| 413 | `PAYLOAD_TOO_LARGE` | 超過檔案、列數或封包限制 |
| 422 | `VALIDATION_FAILED` | 數值、池別、時間或業務規則不符 |
| 429 | `RATE_LIMITED` | 回傳 Retry-After，依身分與配額限流 |
| 503 | `SERVICE_UNAVAILABLE` | 暫時失敗；寫入成功與否透過冪等重試確認 |

未來測試至少涵蓋：人工與感測器通道隔離、跨組織拒絕、同版本並發衝突、稽核失敗回滾、軟刪除與還原、合併選值與撤銷限制、原始封包不可變、匯入整批回滾與重複提交、UTC／時區與亂序補傳、單位／缺值、CSV 公式防護及下載撤權、告警去重與通知失敗。本輪只建立文件，這些執行測試尚未進行。
