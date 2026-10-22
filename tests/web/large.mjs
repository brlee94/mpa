import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const dotnet = process.env.DOTNET || 'dotnet';
const build = spawnSync(dotnet, ['build', 'tests/EmlToPst.Inspect', '-c', 'Release', '--nologo', '-p:RestoreLockedMode=true', '--disable-build-servers', '-m:1'], { encoding: 'utf8', timeout: 90_000 });
assert.equal(build.status, 0, build.stdout + build.stderr);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mpa-large-'));
const output = path.resolve('artifacts/web-large-checks');
await fs.mkdir(output, { recursive: true });
const MiB = 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let checks = 0;
function check(name, action) { action(); checks++; console.log('PASS', name); }
async function sparse(name, length) {
  const filename = path.join(root, name);
  const handle = await fs.open(filename, 'w');
  await handle.truncate(length);
  await handle.close();
  return filename;
}
function inspect(filename) {
  const result = spawnSync(dotnet, ['tests/EmlToPst.Inspect/bin/Release/net10.0/EmlToPst.Inspect.dll', filename, '--summary'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ acceptDownloads: true });
const errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
try {
  // Replace only the native folder dialog. Writes use a real browser FileSystemDirectoryHandle
  // backed by disk (OPFS), with the production stream/close/cleanup code unchanged.
  await page.addInitScript(() => {
    window.__mpaTestDirName = 'mpa-tests-' + crypto.randomUUID();
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      window.__mpaTestDir = await root.getDirectoryHandle(window.__mpaTestDirName, { create: true });
      return window.__mpaTestDir;
    };
  });
  await page.goto(process.env.WEB_URL || 'http://127.0.0.1:8765/mpa/');
  await page.locator('#mail-files:not([disabled])').waitFor({ timeout: 90_000 });
  const exactFile = await sparse('exact-100.eml', 100 * MiB);
  await page.locator('#mail-files').setInputFiles(exactFile);
  const accepted100 = (await page.locator('.file-row').count()) === 1;
  check('exact 100MiB file is accepted', () => assert.equal(accepted100, true));

  const maxBatch = [];
  for (let i = 0; i < 40; i++) maxBatch.push(await sparse(`metadata-${i}.eml`, 100 * MiB));
  maxBatch.push(await sparse('metadata-last.eml', 96 * MiB));
  await page.locator('#mail-files').setInputFiles(maxBatch);
  const limits = await page.locator('.summary').innerText();
  const needsFolder = await page.getByRole('button', { name: 'PST로 변환하기' }).isDisabled();
  check('exact 4GiB batch accepted and requires a save folder', () => {
    assert.match(limits, /41/);
    assert.match(limits, /4\.0 GB/);
    assert.equal(needsFolder, true);
  });
  await page.getByRole('button', { name: '저장 폴더 선택', exact: true }).click();
  await page.locator('.directory-option small').filter({ hasText: '선택한 폴더:' }).waitFor();
  const enabled = await page.getByRole('button', { name: 'PST로 변환하기' }).isEnabled();
  check('selecting a disk folder enables the 4GiB batch', () => assert.equal(enabled, true));
  const extra = await sparse('one-extra-byte.eml', 1);
  await page.locator('#mail-files').setInputFiles([...maxBatch, extra]);
  await page.getByRole('alert').filter({ hasText: '전체 용량이 4.0 GB를 초과' }).waitFor();
  const rejectedBatch = await page.getByRole('button', { name: 'PST로 변환하기' }).isDisabled();
  check('4GiB plus one byte rejected', () => assert.equal(rejectedBatch, true));

  const payload = Buffer.alloc(32 * MiB, 0x5a);
  const eml = Buffer.from(`From: sender@example.com\r\nTo: to@example.com\r\nSubject: Large attachment\r\nDate: Thu, 22 Oct 2026 10:30:00 +0900\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="large"\r\n\r\n--large\r\nContent-Type: text/plain\r\n\r\nLarge test\r\n--large\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="payload.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${payload.toString('base64')}\r\n--large--\r\n`);
  const files = [];
  for (let i = 0; i < 3; i++) {
    const filename = path.join(root, `large-${i + 1}.eml`);
    await fs.writeFile(filename, eml);
    files.push(filename);
  }
  const originalHash = digest(eml), payloadHash = digest(payload);
  const maxHeader = Buffer.from('From: sender@example.com\r\nTo: to@example.com\r\nSubject: Maximum file\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="max"\r\n\r\n--max\r\nContent-Type: text/plain\r\n\r\nMaximum\r\n--max\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="max.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n');
  const maxFooter = Buffer.from('\r\n--max--\r\n');
  const maxPayload = Buffer.alloc(Math.floor((100 * MiB - maxHeader.length - maxFooter.length) / 4) * 3, 0x7b);
  const maxEml = Buffer.concat([maxHeader, Buffer.from(maxPayload.toString('base64')), maxFooter]);
  assert(maxEml.length <= 100 * MiB && maxEml.length >= 100 * MiB - 3);
  const maxOriginalHash = digest(maxEml), maxPayloadHash = digest(maxPayload);
  const maxFile = path.join(root, 'real-100MiB.eml');
  await fs.writeFile(maxFile, maxEml); files.push(maxFile);
  const initialHandles = await page.evaluate(async () => {
    const handle = await window.__mpaTestDir.getFileHandle('keep-existing.txt', { create: true });
    const writer = await handle.createWritable();
    await writer.write('existing file must survive');
    await writer.close();
    return true;
  });
  assert.equal(initialHandles, true);
  await page.locator('#mail-files').setInputFiles(files);
  console.log(`Converting ${((eml.length * 3 + maxEml.length) / MiB).toFixed(1)} MiB of real MIME data into disk-backed PST parts...`);
  await page.getByRole('button', { name: 'PST로 변환하기' }).click();
  await page.getByText('폴더에 저장이 완료되었습니다.', { exact: true }).waitFor({ timeout: 240_000 });
  const saved = await page.evaluate(async () => {
    const entries = [];
    for await (const [runName, run] of window.__mpaTestDir.entries()) {
      if (run.kind !== 'directory') continue;
      for await (const [name, handle] of run.entries()) {
        if (name.endsWith('.pst')) entries.push({ runName, name, size: (await handle.getFile()).size });
      }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  });
  check('large batch splits into four disk-backed PSTs including a real 100MiB EML', () => {
    assert.equal(saved.length, 4);
    assert(saved.every(p => p.size > 0 && p.size <= 384 * MiB));
  });
  const inspected = [];
  for (const entry of saved) {
    const downloadPromise = page.waitForEvent('download');
    await page.evaluate(async ({ runName, name }) => {
      const directory = await window.__mpaTestDir.getDirectoryHandle(runName);
      const file = await (await directory.getFileHandle(name)).getFile();
      const url = URL.createObjectURL(file);
      const link = document.createElement('a'); link.href = url; link.download = name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }, entry);
    const download = await downloadPromise;
    const target = path.join(output, entry.name);
    await download.saveAs(target);
    inspected.push(...inspect(target));
  }
  check('independent reader verifies large attachment and original SHA256', () => {
    assert.equal(inspected.length, 4);
    for (const mail of inspected) {
      const maximum = mail.subject === 'Maximum file';
      assert(['Large attachment', 'Maximum file'].includes(mail.subject));
      assert.equal(mail.attachments.length, 2);
      assert.equal(mail.attachments[0].size, maximum ? maxPayload.length : payload.length);
      assert.equal(mail.attachments[0].sha256, maximum ? maxPayloadHash : payloadHash);
      assert.equal(mail.attachments[1].sha256, maximum ? maxOriginalHash : originalHash);
    }
  });
  const existing = await page.evaluate(async () => (await (await window.__mpaTestDir.getFileHandle('keep-existing.txt')).getFile()).text());
  check('existing destination files preserved', () => assert.equal(existing, 'existing file must survive'));
  await page.evaluate(() => {
    window.__originalCreateWritable = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (...args) {
      if (this.name.endsWith('.pst')) throw new DOMException('Simulated disk full', 'QuotaExceededError');
      return window.__originalCreateWritable.apply(this, args);
    };
  });
  const tiny = path.join(root, 'save-failure.eml');
  await fs.writeFile(tiny, 'From: sender@example.com\r\nTo: to@example.com\r\nSubject: Test write failure\r\n\r\nHello\r\n');
  await page.locator('#mail-files').setInputFiles(tiny);
  await page.getByRole('button', { name: 'PST로 변환하기' }).click();
  await page.getByRole('alert').filter({ hasText: 'Simulated disk full' }).waitFor();
  const filesAfterFailure = await page.evaluate(async () => {
    FileSystemFileHandle.prototype.createWritable = window.__originalCreateWritable;
    const files = [];
    for await (const [runName, run] of window.__mpaTestDir.entries()) {
      if (run.kind !== 'directory') continue;
      for await (const [name, handle] of run.entries()) {
        if (name.endsWith('.pst')) files.push({ runName, name, size: (await handle.getFile()).size });
      }
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  });
  check('failed disk write removes incomplete PST and preserves previous results', () => assert.deepEqual(filesAfterFailure, saved));
  check('no EML data sent to network', () => {
    assert.equal(requests.filter(r => r.method !== 'GET').length, 0);
    assert.deepEqual(errors, []);
  });
  console.log(`${checks} large-file checks passed. Native folder dialog replaced in automation; real browser filesystem used.`);
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  console.error('Browser errors:', errors);
  console.error('Notices:', await page.locator('.notice').allTextContents());
  throw error;
} finally {
  await page.evaluate(async () => {
    if (window.__mpaTestDirName) await (await navigator.storage.getDirectory()).removeEntry(window.__mpaTestDirName, { recursive: true }).catch(() => {});
  }).catch(() => {});
  await browser.close();
  await fs.rm(root, { recursive: true, force: true });
}
