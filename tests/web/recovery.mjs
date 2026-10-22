import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const dotnet = process.env.DOTNET || 'dotnet';
const build = spawnSync(dotnet, ['build', 'tests/EmlToPst.Inspect', '-c', 'Release', '--nologo', '-p:RestoreLockedMode=true', '--disable-build-servers', '-m:1'], { encoding: 'utf8', timeout: 90_000 });
assert.equal(build.status, 0, build.stdout + build.stderr);
const output = path.resolve('artifacts/web-recovery-checks');
await fs.mkdir(output, { recursive: true });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mpa-recovery-'));
const files = [];
for (let i = 0; i < 638; i++) {
  const name = `${String(i).padStart(3, '0')}.eml`;
  const filename = path.join(root, name);
  await fs.writeFile(filename, `From: sender@example.com\r\nTo: to@example.com\r\nSubject: Recovery ${i}\r\n\r\nUnique body ${i}\r\n`);
  files.push(filename);
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ acceptDownloads: true });
const errors = [], requests = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', r => requests.push({ method: r.method(), url: r.url() }));
let checks = 0;
function check(name, action) { action(); checks++; console.log('PASS', name); }
async function report() {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '변환 보고서 저장' }).click();
  const download = await pending;
  const target = path.join(output, 'report.csv');
  await download.saveAs(target);
  return fs.readFile(target, 'utf8');
}
async function entries() {
  return page.evaluate(async () => {
    const files = [];
    for await (const [runName, run] of window.__dir.entries()) {
      for await (const [name, handle] of run.entries()) files.push({ runName, name, size: (await handle.getFile()).size });
    }
    return files;
  });
}
async function inspect(entries) {
  const messages = [];
  for (const entry of entries) {
    const pending = page.waitForEvent('download');
    await page.evaluate(async ({ runName, name }) => {
      const run = await window.__dir.getDirectoryHandle(runName);
      const file = await (await run.getFileHandle(name)).getFile();
      const url = URL.createObjectURL(file);
      const a = document.createElement('a'); a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }, entry);
    const download = await pending;
    const target = path.join(output, `${entry.runName}-${entry.name}`);
    await download.saveAs(target);
    const read = spawnSync(dotnet, ['tests/EmlToPst.Inspect/bin/Release/net10.0/EmlToPst.Inspect.dll', target, '--summary'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(read.status, 0, read.stderr);
    messages.push(...JSON.parse(read.stdout));
  }
  return messages;
}
try {
  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => {
      window.__dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('recovery-' + crypto.randomUUID(), { create: true });
      return window.__dir;
    };
  });
  await page.goto(process.env.WEB_URL || 'http://127.0.0.1:8765/mpa/');
  await page.locator('#mail-files:not([disabled])').waitFor({ timeout: 90_000 });
  await page.locator('#mail-files').setInputFiles(files.slice(0, 131));
  await page.getByRole('button', { name: '저장 폴더 선택', exact: true }).click();
  await page.evaluate(() => {
    const original = FileSystemFileHandle.prototype.createWritable;
    let opened = 0;
    FileSystemFileHandle.prototype.createWritable = async function (...args) {
      if (this.name.endsWith('.pst') && ++opened === 2) throw new DOMException('Simulated disk full', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await page.getByRole('button', { name: 'PST로 변환하기' }).click();
  await page.getByRole('alert').filter({ hasText: 'Simulated disk full' }).waitFor({ timeout: 90_000 });
  const first = await entries();
  const failedReport = await report();
  check('failed second PST preserves exactly 64 saved messages and records global cause', () => {
    assert.equal(first.length, 1);
    assert.equal((failedReport.match(/,"PST 저장 완료",/g) || []).length, 64);
    assert.equal((failedReport.match(/Simulated disk full/g) || []).length, 67);
    assert.match(failedReport, /원본 바이트/);
    assert.match(failedReport, /저장 PST/);
    assert.match(failedReport, /"미처리"/);
  });
  await page.getByRole('button', { name: '미저장 메일만 다시 변환', exact: true }).click();
  await page.getByText('폴더에 저장이 완료되었습니다.', { exact: true }).waitFor({ timeout: 90_000 });
  const all = await entries();
  const recovered = await inspect(all);
  check('retry writes only 67 unsaved mails and preserves the original PST', () => {
    assert.equal(all.length, 3);
    assert(all.some(e => e.runName === first[0].runName && e.name === first[0].name && e.size === first[0].size));
    assert.equal(recovered.length, 131);
    assert.equal(new Set(recovered.map(m => m.subject)).size, 131);
    for (const mail of recovered) assert.equal(mail.body.trim(), mail.subject.replace('Recovery', 'Unique body'));
  });
  const extendedReport = await report();
  check('recovery report retains each saved PST association', () => {
    assert.equal((extendedReport.match(/,"PST 저장 완료",/g) || []).length, 131);
    assert(extendedReport.includes(first[0].runName));
  });
  // A fresh selection must match the full report, not just basename or row position.
  await page.getByRole('button', { name: '모두 지우기' }).click();
  await page.locator('#mail-files').setInputFiles(files.slice(0, 130));
  await page.locator('#resume-report').setInputFiles({ name: 'extended.csv', mimeType: 'text/csv', buffer: Buffer.from(extendedReport) });
  await page.getByRole('alert').filter({ hasText: '일치하지 않습니다' }).waitFor();
  const skippedOnMismatch = await page.locator('.file-state.success').count();
  check('mismatched recovery selection does not skip any source', () => assert.equal(skippedOnMismatch, 0));
  await page.locator('#mail-files').setInputFiles(files.slice(0, 131));
  await page.locator('#resume-report').setInputFiles({ name: 'extended.csv', mimeType: 'text/csv', buffer: Buffer.from(extendedReport) });
  await page.getByRole('status').filter({ hasText: '저장 완료 131개를 제외' }).waitFor();
  const marked = await page.locator('.file-state.success').count();
  check('new report reopens with exact file sizes and saved states', () => assert.equal(marked, 131));

  const old = '파일,결과,설명\r\n' + files.map((f, i) => `"${path.basename(f)}","${i < 286 ? 'PST 저장 완료' : '저장되지 않음'}",""`).join('\r\n');
  await page.locator('#mail-files').setInputFiles(files);
  await page.locator('#resume-report').setInputFiles({ name: '변환결과.csv', mimeType: 'text/csv', buffer: Buffer.from('\ufeff' + old) });
  await page.getByRole('status').filter({ hasText: '352개만 변환합니다' }).waitFor();
  const beforeLegacy = await entries();
  await page.getByRole('button', { name: '완료 제외하고 변환하기' }).click();
  await page.getByText('폴더에 저장이 완료되었습니다.', { exact: true }).waitFor({ timeout: 120_000 });
  const afterLegacy = await entries();
  const added = afterLegacy.filter(e => !beforeLegacy.some(old => old.runName === e.runName && old.name === e.name));
  const resumed = await inspect(added);
  check('legacy 638-row report skips 286 and saves exactly the remaining 352 once', () => {
    assert.equal(added.length, 6);
    assert.equal(resumed.length, 352);
    assert.equal(new Set(resumed.map(m => m.subject)).size, 352);
    assert(resumed.every(m => Number(m.subject.split(' ')[1]) >= 286));
    assert.equal(afterLegacy.length, beforeLegacy.length + 6);
  });
  check('recovery does not send email or reports to the network', () => {
    assert.deepEqual(errors, []);
    assert.equal(requests.filter(r => r.method !== 'GET').length, 0);
  });
  console.log(`${checks} recovery checks passed.`);
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  console.error(await page.locator('.notice').allTextContents());
  throw error;
} finally {
  await page.evaluate(async () => {
    if (window.__dir) await (await navigator.storage.getDirectory()).removeEntry(window.__dir.name, { recursive: true });
  }).catch(() => {});
  await browser.close(); await fs.rm(root, { recursive: true, force: true });
}
