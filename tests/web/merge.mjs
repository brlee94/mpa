import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const dotnet = process.env.DOTNET || 'dotnet';
const baseUrl = process.env.WEB_URL || 'http://127.0.0.1:8765/mpa/releases/merge-v5/';
const output = path.resolve('artifacts/web-merge-checks'); await fs.mkdir(output, { recursive: true });
function run(project, ...args) {
  const r = spawnSync(dotnet, [project, ...args], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout;
}
for (const project of ['tests/EmlToPst.MergeChecks', 'tests/EmlToPst.Inspect']) {
  const r = spawnSync(dotnet, ['build', project, '-c', 'Release', '-p:RestoreLockedMode=true', '--disable-build-servers', '-m:1', '--nologo'], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
}
const helper = 'tests/EmlToPst.MergeChecks/bin/Release/net10.0/EmlToPst.MergeChecks.dll';
const fixture = path.join(output, 'fixtures'); run(helper, '--fixtures', fixture);
const files = ['part-a.pst', 'part-b.pst', 'part-different.pst'].map(n => path.join(fixture, n));
const hash = async p => createHash('sha256').update(await fs.readFile(p)).digest('hex');
const sourceHashes = await Promise.all(files.map(hash));
function inspect(filename) { return JSON.parse(run('tests/EmlToPst.Inspect/bin/Release/net10.0/EmlToPst.Inspect.dll', filename)); }
const inputMessages = files.flatMap(inspect);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mpa-merge-browser-'));
// Persistent contexts use the normal disk-backed OPFS backend, rather than incognito memory storage.
const browser = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', acceptDownloads: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [], requests = [];
page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push({ method: r.method(), url: r.url() }));
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS', name); }
async function entries() {
  return page.evaluate(async () => {
    const entries = [];
    for await (const [runName, run] of window.__output.entries())
      for await (const [name, file] of run.entries()) entries.push({ runName, name, size: (await file.getFile()).size });
    return entries;
  });
}
async function temporaryCount() {
  return page.evaluate(async () => {
    let count = 0;
    for await (const [name] of (await navigator.storage.getDirectory()).entries()) if (name.startsWith('mpa-pst-merge-')) count++;
    return count;
  });
}
async function save(entry, target) {
  const pending = page.waitForEvent('download');
  await page.evaluate(async ({ runName, name }) => {
    const dir = await window.__output.getDirectoryHandle(runName);
    const file = await (await dir.getFileHandle(name)).getFile();
    const url = URL.createObjectURL(file); const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, entry);
  await (await pending).saveAs(target);
}
async function start() {
  await page.getByRole('button', { name: '하나의 PST로 합치기', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.merge-success') || document.querySelector('#merge [role=alert]'), null, { timeout: 180_000 });
  const notice = await page.locator('#merge [role=alert]').allTextContents();
  assert.equal(notice.length, 0, notice.join('\n'));
}
try {
  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => {
      window.__output = await (await navigator.storage.getDirectory()).getDirectoryHandle('merge-tests-' + crypto.randomUUID(), { create: true });
      return window.__output;
    };
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(...args) { super(...args); this.addEventListener('message', e => { if (e.data.type === 'complete') window.__mergeResult = e.data; }); }
    };
  });
  await page.goto(baseUrl);
  await page.locator('#merge-files:not([disabled])').waitFor({ timeout: 90_000 });
  const emptyDisabled = await page.getByRole('button', { name: '하나의 PST로 합치기', exact: true }).isDisabled();
  check('empty merger requires PST inputs and a destination', () => assert.equal(emptyDisabled, true));
  await page.locator('#merge-files').setInputFiles(files);
  await page.getByRole('button', { name: '병합 결과 저장 폴더 선택', exact: true }).click();
  await page.locator('#mail-files').setInputFiles({ name: 'waiting.eml', mimeType: 'message/rfc822', buffer: Buffer.from('From: a@example.com\r\nSubject: waiting\r\n\r\ntext') });
  await page.getByRole('button', { name: '하나의 PST로 합치기', exact: true }).click();
  const disabledDuringMerge = await page.locator('#mail-files').isDisabled();
  check('EML conversion cannot overlap the merge engine', () => assert.equal(disabledDuringMerge, true));
  await page.waitForFunction(() => document.querySelector('.merge-success') || document.querySelector('#merge [role=alert]'), null, { timeout: 180_000 });
  assert.deepEqual(await page.locator('#merge [role=alert]').allTextContents(), []);
  const saved = await entries();
  const metrics = await page.evaluate(() => window.__mergeResult);
  check('multiple input PSTs create exactly one real PST', () => { assert.equal(saved.length, 1); assert.equal(metrics.Added, 5); assert.equal(metrics.Duplicates, 1); });
  const target = path.join(output, 'merged.pst'); await save(saved[0], target);
  const result = inspect(target);
  const folders = JSON.parse(run('tests/EmlToPst.Inspect/bin/Release/net10.0/EmlToPst.Inspect.dll', target, '--folders'));
  check('system folders are not duplicated into the mail hierarchy', () => {
    assert.equal(folders.filter(p => p === '/Root/Top of Personal Folders/Deleted Items').length, 1);
    assert.equal(folders.filter(p => p === '/Root/Top of Personal Folders/Finder').length, 0);
  });
  check('folder hierarchy, headers, HTML, recipients, dates and every attachment preserved', () => {
    assert.equal(result.length, 5);
    const unique = [];
    for (const message of inputMessages) if (!unique.some(m => JSON.stringify(m) === JSON.stringify(message))) unique.push(message);
    assert.deepEqual(result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), unique.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  });
  const temps = await temporaryCount();
  check('worker is disposed and temporary PSTs removed after success', () => assert.equal(temps, 0));
  await page.locator('#merge-deduplicate').uncheck();
  await start();
  const all = await entries();
  const retained = all.find(e => !saved.some(old => old.runName === e.runName));
  await save(retained, path.join(output, 'with-duplicates.pst'));
  const duplicates = inspect(path.join(output, 'with-duplicates.pst'));
  check('duplicate preservation is selectable', () => assert.equal(duplicates.length, 6));
  const reportPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '병합 보고서 저장' }).click();
  const reportPath = path.join(output, 'merge-report.csv'); await (await reportPromise).saveAs(reportPath);
  const report = await fs.readFile(reportPath, 'utf8');
  check('merge report records source counts, final location and app version', () => { assert.match(report, /part-a\.pst/); assert.match(report, /병합 메일/); assert.match(report, /merge-v5/); });
  await page.locator('#merge-files').setInputFiles(files);
  await page.getByRole('button', { name: '하나의 PST로 합치기', exact: true }).click();
  await page.getByRole('button', { name: '병합 중지', exact: true }).click();
  await page.locator('#merge [role=alert]').filter({ hasText: '병합을 중지했습니다' }).waitFor({ timeout: 30_000 });
  const afterCancel = await entries(); const tempsAfterCancel = await temporaryCount();
  check('cancellation releases the worker and leaves no partial output', () => { assert.deepEqual(afterCancel, all); assert.equal(tempsAfterCancel, 0); });
  const broken = path.join(fixture, 'broken.pst'); await fs.writeFile(broken, 'broken PST input');
  await page.locator('#merge-files').setInputFiles([files[0], broken]);
  await page.getByRole('button', { name: '하나의 PST로 합치기', exact: true }).click();
  await page.locator('#merge [role=alert]').filter({ hasText: 'broken.pst' }).waitFor({ timeout: 180_000 });
  const afterInvalid = await entries();
  check('invalid source aborts the whole merge without publishing partial mail', () => assert.deepEqual(afterInvalid, all));
  await page.locator('#merge-files').setInputFiles([files[0], path.join(fixture, 'contacts.pst')]);
  await page.getByRole('button', { name: '하나의 PST로 합치기', exact: true }).click();
  await page.locator('#merge [role=alert]').filter({ hasText: '메일이 아닌 항목' }).waitFor({ timeout: 180_000 });
  const afterUnsupported = await entries();
  check('unsupported contact items stop the merge instead of being silently lost', () => assert.deepEqual(afterUnsupported, all));
  await page.locator('#merge-files').setInputFiles(files);
  await page.evaluate(() => {
    const original = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (...args) {
      if (this.name.endsWith('.pst')) throw new DOMException('Simulated output disk full', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await page.getByRole('button', { name: '하나의 PST로 합치기', exact: true }).click();
  await page.locator('#merge [role=alert]').filter({ hasText: '디스크 공간이 부족' }).waitFor({ timeout: 180_000 });
  const afterFailure = await entries(); const tempsAfterFailure = await temporaryCount();
  check('final disk error preserves earlier results and removes incomplete output and temp data', () => { assert.deepEqual(afterFailure, all); assert.equal(tempsAfterFailure, 0); });
  const afterHashes = await Promise.all(files.map(hash));
  check('input PST bytes remain unchanged', () => assert.deepEqual(afterHashes, sourceHashes));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  check('merge UI fits a narrow viewport', () => assert.equal(overflow, false));
  check('PST content stays local and worker reports no uncaught errors', () => { assert.equal(requests.filter(r => r.method !== 'GET').length, 0); assert.deepEqual(errors, []); });
  console.log(`${checks} PST merge checks passed.`);
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  console.error('Notices:', await page.locator('#merge .notice').allTextContents()); console.error('Errors:', errors); throw error;
} finally {
  await page.evaluate(async () => { if (window.__output) await (await navigator.storage.getDirectory()).removeEntry(window.__output.name, { recursive: true }); }).catch(() => {});
  await browser.close(); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
