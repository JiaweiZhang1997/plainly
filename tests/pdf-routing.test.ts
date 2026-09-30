import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pdfRedirectRules, nativePdfRule, redirectedPdfSource, pdfPageNumber } from '../src/pdf-routing.ts';
import { pdfSource } from '../src/pdf-text.ts';
import { defaults, normalizeSettings } from '../src/core.ts';
test('automatic PDF routing migrates to native by default and can be disabled', () => {
  const old: any = defaults(); delete old.pdfPreferenceVersion; old.pdfAutoOpen = true;
  assert.equal(normalizeSettings(old).pdfAutoOpen, false); assert.equal(normalizeSettings({ ...old, pdfAutoOpen: false }).pdfAutoOpen, false);
  assert.equal(normalizeSettings({ ...defaults(), pdfAutoOpen: true }).pdfAutoOpen, true);
  const rules = pdfRedirectRules('chrome-extension://test/pdf.html');
  assert.ok(rules.every(rule => JSON.stringify(rule.condition.resourceTypes) === '["main_frame"]'));
  for (const rule of rules.slice(0, 2)) { assert.deepEqual(rule.condition.requestMethods, ['get']); assert.ok(rule.condition.responseHeaders?.length); assert.ok(rule.condition.excludedResponseHeaders?.length); }
  assert.ok(new RegExp(rules[2].condition.regexFilter!, 'i').test('file:///tmp/book.PDF'));
  assert.ok(new RegExp(rules[2].condition.regexFilter!, 'i').test('file:///tmp/book.PDF#page=2'));
  assert.ok(!new RegExp(rules[2].condition.regexFilter!, 'i').test('file:///tmp/book.pdf.html'));
});
test('raw DNR handoff and native bypass preserve signed URL characters and restrict the bypass to one tab and exact URL', () => {
  const url = 'https://example.org/download?a=1+b&signature=a%2Fb%3D&name=foo.pdf';
  assert.equal(redirectedPdfSource('?source=' + url), url); assert.equal(redirectedPdfSource('?other=' + url), undefined);
  const rule = nativePdfRule(7, url + '#page=2'); assert.deepEqual(rule.condition.tabIds, [7]);
  const regex = new RegExp(rule.condition.regexFilter!); assert.ok(regex.test(url)); assert.ok(regex.test(url + '#page=2')); assert.ok(!regex.test(url + '&other=true'));
  assert.equal(pdfPageNumber('#page=5&zoom=100'), 5); assert.equal(pdfPageNumber('#page=-1'), 1);
  assert.equal(pdfSource('file:///tmp/book.pdf', true), 'file:///tmp/book.pdf'); assert.throws(() => pdfSource('file:///tmp/secret.txt', true));
});
