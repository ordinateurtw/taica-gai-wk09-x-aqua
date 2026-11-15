# X-Aqua 資料契約

狀態：設計規格 v0.1，尚未實作。此文件定義未來資料格式，不表示目前已有資料庫或真實量測資料。

參照：[架構設計](architecture.md)、[API 契約](api-contract.md)。契約版本 `schema_version` 初始為字串 `1.0`，與整數資料修訂 `version` 分開管理；不相容格式變更須升級契約並制定轉換規則，不得默默改欄位意義。

## 正規化量測紀錄

每筆代表同一池、同一量測時間、同一來源的一組量測；不強迫未量測項目補值。識別碼由服務端產生 UUID 字串，不含可辨識個人資訊。

| 欄位 | 型別與規則 |
| --- | --- |
| `record_id` | UUID，永久識別碼，不重用 |
| `schema_version` | 字串，初始 `1.0` |
| `version` | 正整數，初始 1；每次修改、刪除、還原、品質覆核或合併狀態變更均遞增 |
| `organization_id` | UUID，由登入身分決定可用組織，不相信任意輸入的組織 |
| `pond_id` | UUID，池別的穩定識別碼，必須屬於授權組織 |
| `pond_code` | 字串，供人閱讀的池號；由池別資料帶出，在組織內唯一，不作永久關聯鍵 |
| `measured_at` | 含時區的 RFC 3339 字串，輸入必須含 `Z` 或時差，儲存與回傳正規化為 UTC；不接受無時區時間 |
| `received_at` | 服務端接收時間，UTC；補傳仍保留原量測時間，不用此欄取代 |
| `values` | 固定四個核心欄位的物件，數值或 `null`；至少一項非空 |
| `units` | 固定單位物件，由服務端依本契約產生，不能以任意單位混用 |
| `source` | 來源物件，格式見下節 |
| `quality` | 品質物件，格式見下節 |
| `status` | `active`、`deleted`、`superseded` 之一，與品質狀態分開 |
| `created_at`、`created_by` | 服務端建立時間及操作者／服務身分識別碼，不可由用戶覆寫 |
| `updated_at`、`updated_by` | 最新修訂時間及操作者，由服務端產生 |
| `deleted_at`、`deleted_by`、`delete_reason` | 軟刪除資訊，非刪除狀態為 `null`；歷次刪除仍保留在版本與稽核 |
| `merged_from` | 來源 `record_id` 陣列，一般紀錄為空陣列；合併產物保留所有直接來源 |
| `superseded_by` | 合併後的新紀錄 ID，非被取代紀錄為 `null` |
| `field_lineage` | 合併逐欄來源：核心欄位對應 `{record_id, version}`；一般紀錄為空物件 |

池號更名保留池別歷史；版本快照中的 `pond_code` 保存當時值。已建立紀錄的池別、量測時間與來源不可直接修改；若人工填錯，採軟刪除後建立正確紀錄並於稽核關聯兩者，避免移動歷史量測。

## 核心數值與單位

`values` 與 `units` 使用完全相同的四個鍵：

| 鍵 | 項目 | `units` 固定值 | 格式檢查 |
| --- | --- | --- | --- |
| `temperature_c` | 水溫 | `°C` | 有限數值 |
| `ph` | pH | `1` | 有限數值；`1` 表示無因次單位 |
| `dissolved_oxygen_mg_l` | DO（溶氧） | `mg/L` | 有限且非負 |
| `salinity_ppt` | 鹽度 | `ppt` | 有限且非負 |

禁止以 0 代表缺測、禁止字串數字、NaN 或 Infinity。未提供欄位在新增時正規化為 `null`；回傳永遠包含四鍵。pH 與水溫的合理範圍、儀器精度及告警門檻由經確認的設備／場域設定判讀，格式檢查不等於養殖安全判定。超出設備範圍可標記品質可疑，不能擅自修正成正常值。

目前不接受其他量測鍵；氨氮、TAN、NH3 僅為未來擴充，須另訂欄位、化學意義與單位，不得取代核心四項。感測器原始單位若不同，需有可追溯轉換規則；未支援的單位進隔離區，不猜測換算，尤其不能任意把其他鹽度尺度當作 ppt。

## 來源分離

`source.type` 僅為 `manual` 或 `sensor`，建立後不可更換。

| 來源 | 必要欄位 | 保護規則 |
| --- | --- | --- |
| `manual` | `entered_by`（服務端操作者）、`entry_method`（`form` 或 `csv_import`）；匯入另有 `import_job_id` | 手動建立端點只接受此類；不得指定 `device_id` 或 `raw_event_id` |
| `sensor` | `device_id`、`raw_event_id`、`event_id`、`normalization_version` | 只由設備接入通道建立，不得由人工表單或 CSV 偽造 |

Phase 02 原始封包獨立為 `raw_event`：包含 `raw_event_id`、`organization_id`、`device_id`、設備產生且在設備內唯一的 `event_id`、原始 `measured_at`、服務端 `received_at`、設備當時池別對應版本、原始 `payload`、`payload_sha256`、封包 `schema_version` 與 `ingest_status`（`accepted` 或 `quarantined`）。憑證、密碼與授權標頭不得進入封包儲存或操作日誌。

原始封包不可覆寫、修改或透過一般紀錄軟刪除端點刪除；隔離後的復核以新增處理事件保存。正規化失敗不刪原始證據；成功時保留 `raw_event_id`。設備重送依 `(organization_id, device_id, event_id)` 去重：相同原始內容回傳原結果，不重複建立；同鍵不同內容回報衝突並記錄安全稽核。人工覆核感測器讀值須新增修訂及原因，不更動原始封包、來源與量測時間。

## 品質與生命週期

`quality` 包含 `status`（`unreviewed`、`valid`、`suspect`、`rejected`）、`flags`（代碼陣列，如 `missing_metric`、`late_arrival`、`outside_device_range`）、`reviewed_by`、`reviewed_at`、`rule_version`（自動規則版本，未使用時為 null）、`reason`。新增人工紀錄預設 `unreviewed`；感測器依具版本的規則評估，未通過規則不能自動標為 `valid`。覆核必須記錄規則版本或覆核者與理由；缺項紀錄加 `missing_metric`，不自動補值。

`status=active` 才是一般查詢與 Dashboard 的預設資料；`deleted` 與 `superseded` 保留可追溯歷史。數值告警只使用 `active` 且 `quality.status=valid` 的資料；品質不明及缺資料需另顯示，不當作正常值。

## 修訂、軟刪除與合併

- 任何成功變更建立不可變版本快照與稽核事件，同一交易提交；同版本競爭只能有一方成功。
- 軟刪除要求原因及預期版本；還原只適用 `deleted`，還原後品質設為 `unreviewed`。`superseded` 不得直接還原，須走合併撤銷。
- 合併來源至少兩筆，必須同組織、同池、同量測時間、`active` 且全部是人工來源。不同時間、人工與感測器混合、感測器間重複不得以人工合併處理；感測器去重另依事件鍵執行。
- 合併預覽列出所有欄位差異，使用者逐欄選擇來源版本中的值；缺測仍可選 `null`，但結果至少一項非空。不允許合併時另輸入新數值或平均值。
- 確認後建立全新人工紀錄（`version=1`、`quality.status=unreviewed`），以 `merged_from` 及 `field_lineage` 保留來源；來源各自增加版本並標記 `superseded` 與 `superseded_by`。所有原值與版本保留。
- 合併撤銷需專責權限、原因與產物及來源的預期版本。僅產物仍為 `active`、未被後續修改（`version=1`），來源仍被此產物取代且未變動時可原子撤銷：產物軟刪除，來源回 `active` 並設品質 `unreviewed`；全部增加版本與稽核。若已有下游修訂或合併，拒絕自動撤銷，由管理者另訂補償方案，不覆蓋後續資料。

## 匯入、查詢與匯出

人工 CSV 編碼為 UTF-8（可帶 BOM），必要標頭為 `pond_id,measured_at,temperature_c,ph,dissolved_oxygen_mg_l,salinity_ppt`；空白數值代表缺測，時間必須含時區。單位固定為上表，其他欄位、來源欄位與任意單位拒收，不能直接將匯出檔當作匯入覆寫。原始檔須限制大小並記錄檔案雜湊，預覽回報逐列錯誤及重複候選。

人工重複候選鍵為「同組織、池、量測時間、人工來源」，相同值也不自動刪除或合併。批次檔內重複列不得提交；與既有 `active` 紀錄重疊須先排除或另走明確合併流程。提交前重新檢查候選與池別授權，任一列錯誤整批不寫入；同一工作只允許成功提交一次。

查詢以量測時間半開區間 `[from,to)`、池別、來源、品質及生命週期篩選，排序固定為 `measured_at` 再 `record_id`。CSV 匯出固定 UTF-8 BOM、含標頭，至少包含識別碼、組織、池號、時間、四項數值、四項單位（使用對應鍵加 `_unit`）、來源類型與來源 ID、契約版本、資料版本、品質、生命週期。空值輸出空欄，使用 CSV 引號處理分隔字元；使用者可控文字以 `= + - @` 或控制字元起始時做試算表公式注入防護，合法數字仍以數字輸出。匯出保存篩選條件、快照時間、操作者、筆數、檔案雜湊及下載期限，不含密鑰、私人資料或完整稽核快照。

## 操作稽核

不可變 `audit_event` 必含：`audit_id`、`operation_id`、`request_id`、`organization_id`、`actor_id`、`actor_type`（`user` 或 `service`）、`action`、目標 `record_id` 陣列、`occurred_at`（服務端 UTC）、`reason`、`before_versions`、`after_versions`、前後快照參照、來源／產物關聯、`result` 與失敗代碼。快照參照必須可由授權稽核者還原當時內容。

動作涵蓋新增、查詢、修改、軟刪除、還原、品質覆核、匯入預覽／提交、合併預覽／提交／撤銷、匯出、感測器接收及存取拒絕。讀取與失敗事件不增加紀錄版本；失敗不保留敏感請求內容。成功寫入與其稽核必須同交易，稽核失敗即拒絕該次寫入；稽核資料不可透過業務 API 修改或刪除。
