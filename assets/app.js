'use strict';
// 原生 details 即使未啟用 JavaScript 仍可閱讀；批次操作只在腳本可用時加入。
const entries = Array.from(document.querySelectorAll('.knowledge-card details'));
if (entries.length) {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = 'detail-control';
  const updateLabel = () => {
    control.textContent = entries.every(entry => entry.open) ? '收合全部管理重點' : '展開全部管理重點';
  };
  control.addEventListener('click', () => {
    const shouldOpen = !entries.every(entry => entry.open);
    entries.forEach(entry => { entry.open = shouldOpen; });
    updateLabel();
  });
  entries.forEach(entry => entry.addEventListener('toggle', updateLabel));
  updateLabel();
  document.querySelector('.knowledge-grid').before(control);
}
