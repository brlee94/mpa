import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const dotnet = process.env.DOTNET || 'dotnet';
const baseUrl = process.env.WEB_URL || 'http://127.0.0.1:8765/mpa/releases/merge-v5/';
const output = path.resolve('artifacts/web-merge-large-checks'); await fs.mkdir(output, { recursive: true });
const fixtures = path.join(output, 'inputs');
const target = path.join(output, 'merged.pst');
function invoke(args, timeout = 180_000) {
  const r = spawnSync(dotnet, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stdout + r.stderr + (r.error?.message || '')); return r.stdout;
}
for (const p of ['tests/EmlToPst.MergeChecks', 'tests/EmlToPst.Inspect']) invoke(['build', p, '-c', 'Release', '-p:RestoreLockedMode=true', '--disable-build-servers', '-m:1']);
console.log('Generating three disk-backed source PSTs (2.25GiB of attachment payload)...');
invoke(['tests/EmlToPst.MergeChecks/bin/Release/net10.0/EmlToPst.MergeChecks.dll', '--large-fixtures', fixtures]);
const expected = JSON.parse(await fs.readFile(path.join(fixtures, 'expected.json')));
const files = ['large-1.pst', 'large-2.pst', 'large-3.pst'].map(n => path.join(fixtures, n));
let inputBytes = 0; for (const p of files) inputBytes += (await fs.stat(p)).size;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mpa-merge-browser-'));
// Persistent contexts use the normal disk-backed OPFS backend, rather than incognito memory storage.
const browser = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', acceptDownloads: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(baseUrl).origin, quotaSize: 12 * 1024 ** 3 });
const errors = [], requests = [];
page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push(r.method()));
try {
  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => { window.__output = await (await navigator.storage.getDirectory()).getDirectoryHandle('merge-large-' + crypto.randomUUID(), { create: true }); return window.__output; };
    const Original = window.Worker;
    window.Worker = class extends Original { constructor(...args) { super(...args); this.addEventListener('message', e => { if (e.data.type === 'complete') window.__mergeResult = e.data; }); } };
  });
  await page.goto(baseUrl);
  await page.locator('#merge-files:not([disabled])').waitFor({ timeout: 90_000 });
  await page.locator('#merge-files').setInputFiles(files);
  await page.locator('#merge-deduplicate').uncheck();
  await page.getByRole('button', { name: '병합 결과 저장 폴더 선택', exact: true }).click();
  await page.getByRole('button', { name: '하나의 PST로 합치기', exact: true }).click();
  const monitor = setInterval(async () => console.log('Progress:', await page.locator('#merge .merge-progress,#merge .notice').allTextContents().catch(() => [])), 15_000);
  try { await page.waitForFunction(() => document.querySelector('.merge-success') || document.querySelector('#merge [role=alert]'), null, { timeout: 600_000 }); }
  finally { clearInterval(monitor); }
  assert.deepEqual(await page.locator('#merge [role=alert]').allTextContents(), []);
  const metrics = await page.evaluate(() => window.__mergeResult);
  assert.equal(metrics.Added, expected.count); assert.equal(metrics.Duplicates, 0);
  assert(metrics.Size > 2 * 1024 ** 3, 'Output must cross the signed 32-bit 2GiB offset boundary');
  assert(metrics.PeakManagedBytes < 512 * 1024 * 1024, 'Managed merge memory must stay far below the PST file size');
  const pending = page.waitForEvent('download');
  const outputFile = await page.evaluate(async () => {
    let saved = null, count = 0;
    for await (const [, run] of window.__output.entries()) for await (const [name, handle] of run.entries()) {
      const file = await handle.getFile(); saved = { name, size: file.size }; count++;
      const url = URL.createObjectURL(file); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
    if (count !== 1) throw new Error('Expected exactly one merged PST');
    return saved;
  });
  const download = await pending; await download.saveAs(target);
  console.log(`Saved ${(outputFile.size / 1024 ** 3).toFixed(2)}GiB single PST; independently reading every message and attachment...`);
  const messages = JSON.parse(invoke(['tests/EmlToPst.Inspect/bin/Release/net10.0/EmlToPst.Inspect.dll', target, '--summary']));
  assert.equal(messages.length, expected.count); assert.equal(new Set(messages.map(m => m.subject)).size, expected.count);
  for (const m of messages) {
    assert.equal(m.body, m.subject.replace('Large', 'Body'));
    assert.equal(m.attachments.length, 1); assert.equal(m.attachments[0].size, expected.attachmentBytes); assert.equal(m.attachments[0].sha256, expected.sha256);
    assert(m.folder.endsWith('/가져온 메일/대용량'));
  }
  const tempCount = await page.evaluate(async () => { let n = 0; for await (const [name] of (await navigator.storage.getDirectory()).entries()) if (name.startsWith('mpa-pst-merge-')) n++; return n; });
  assert.equal(tempCount, 0); assert.deepEqual(errors, []); assert.equal(requests.filter(m => m !== 'GET').length, 0);
  const result = { inputBytes, outputBytes: outputFile.size, messages: messages.length, managedPeakBytes: metrics.PeakManagedBytes, everyAttachmentSha256Verified: true, temporaryFilesRemoved: true };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log('PASS', result);
  await download.delete();
} catch (error) {
  console.error('Notices:', await page.locator('#merge .notice').allTextContents()); console.error(errors);
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); throw error;
} finally {
  await page.evaluate(async () => { if (window.__output) await (await navigator.storage.getDirectory()).removeEntry(window.__output.name, { recursive: true }); }).catch(() => {});
  await browser.close(); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); await fs.rm(fixtures, { recursive: true, force: true }); await fs.rm(target, { force: true });
}
