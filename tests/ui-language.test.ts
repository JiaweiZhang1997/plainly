import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uiText } from '../src/ui-language.ts';

test('UI translation preserves whitespace and never rewrites arbitrary content', () => {
  assert.equal(uiText('  保存修改  ', 'en'), '  Save changes  ');
  assert.equal(uiText('同语学习', 'en'), 'Learn', 'documentation headings must not replace compact control labels');
  assert.equal(uiText('界面语言', 'zh-CN'), '界面语言');
  assert.equal(uiText('版本 0.6.7', 'en'), 'Version 0.6.7');
  assert.equal(uiText('这是用户自己的语言和想法', 'en'), '这是用户自己的语言和想法');
  assert.equal(uiText('删除上传图标 2', 'en'), 'Delete uploaded icon 2');
});

test('dynamic status messages translate counts and nested application errors', () => {
  assert.equal(uiText('停止生成', 'en'), 'Stop generating');
  assert.equal(uiText('正在分段搜索长网页… 2/4', 'en'), 'Searching page sections… 2/4');
  assert.equal(uiText('Jev 授权失败，请检查 API Key 与账户权限。\n本次搜索未完成，请重试。', 'en'), 'Jev authorization failed. Check your API key and account permissions.\nSearch did not finish. Try again.');
  assert.equal(uiText('正在读取 PDF 文字… 3 / 20 页', 'en'), 'Reading PDF text… 3 / 20 pages');
  assert.match(uiText('搜索范围：200 / 240 页 · 99 个片段。仅扫描前 200 页，后续未搜索。', 'en'), /200 \/ 240 pages · 99 passages.*Only the first 200 pages/);
  assert.match(uiText('搜索范围：4 / 24 页 · 90 个片段。已达到本次文字上限，最后一页仅覆盖部分，后续未搜索。', 'en'), /last page is only partially covered/);
  assert.equal(uiText('无法读取用量：设置格式无效。', 'en'), 'Cannot read usage: Invalid settings format.');
  assert.equal(uiText('解释 · 通用系统提示词不能为空，最多 16000 字符。', 'en'), 'Explain · General system prompt cannot be empty and must be no more than 16000 characters.');
});
