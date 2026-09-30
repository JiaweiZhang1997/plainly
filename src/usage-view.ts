import { uiText } from './ui-language.ts';
import { rpc } from './client.ts';
import { TOKEN_FIELDS, type UsageStore } from './usage.ts';
const $ = (id: string) => document.getElementById(id)!;
const number = (value: number) => value.toLocaleString('zh-CN');
let revision = 0;
export async function renderUsage() {
  const own = ++revision;
  try {
    const store = await rpc<UsageStore>('getUsage'); if (own !== revision) return;
    const rows = [...store.rows].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const field of ['input', 'output', 'total'] as const) {
      const reports = rows.reduce((n, row) => n + row.reported[field], 0);
      $( `usage-${field}`).textContent = reports ? number(rows.reduce((n, row) => n + row.tokens[field], 0)) : '—';
    }
    $('usage-requests').textContent = number(rows.reduce((n, row) => n + row.requests, 0));
    const missing = rows.reduce((n, row) => n + row.missing, 0), partial = rows.reduce((n, row) => n + row.partial, 0);
    $('usage-summary').textContent = rows.length ? `自 ${new Date(store.since).toLocaleDateString()} 起 · ${missing} 次未返回用量 · ${partial} 次仅有部分用量。数字仅累加接口已报告的 token。` : '还没有记录。使用模型功能或测试连接后，会自动开始统计。';
    $('usage-rows').replaceChildren(...rows.map(row => {
      const tr = document.createElement('tr');
      const model = document.createElement('td'), name = document.createElement('strong'), detail = document.createElement('small');
      name.textContent = row.model; detail.textContent = row.name; model.dataset.i18nSkip = ''; model.append(name, detail); tr.append(model);
      for (const field of ['input', 'output', 'total'] as const) { const td = document.createElement('td'); td.textContent = row.reported[field] ? number(row.tokens[field]) : '—'; tr.append(td); }
      const requests = document.createElement('td'); requests.textContent = number(row.requests); tr.append(requests);
      const coverage = document.createElement('td'); coverage.textContent = `${row.completeReports} 完整 / ${row.partial} 部分 / ${row.missing} 未提供`; tr.append(coverage);
      const detailRow = document.createElement('small');
      const extras = TOKEN_FIELDS.filter(f => ['cacheRead', 'cacheWrite', 'reasoning'].includes(f) && row.reported[f]);
      const labels: Record<string, string> = { cacheRead: '缓存读取', cacheWrite: '缓存写入', reasoning: '思考' };
      detailRow.textContent = [...extras.map(f => `${uiText(labels[f], document.documentElement.lang === 'en' ? 'en' : 'zh-CN')} ${number(row.tokens[f])}`), ...(row.failed ? [document.documentElement.lang === 'en' ? `${row.failed} incomplete` : `${row.failed} 次未正常完成`] : [])].join(' · ');
      if (detailRow.textContent) coverage.append(detailRow);
      return tr;
    }));
    $('usage-table').hidden = !rows.length;
  } catch (error) { if (own === revision) $('usage-summary').textContent = `无法读取用量：${(error as Error).message}`; }
}
export function initUsage() {
  $('refresh-usage').onclick = () => void renderUsage();
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.plainlyUsage && location.hash === '#usage') void renderUsage(); });
}
