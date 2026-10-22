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
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mpa-stress-'));
const output = path.resolve('artifacts/web-stress-checks');
await fs.mkdir(output, { recursive: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const payload = Buffer.alloc(1536 * 1024, 0x61);
const base64 = payload.toString('base64');
const payloadHash = digest(payload);
const files = [], originalHashes = new Map();
let inputSize = 0;
for (let i = 0; i < 638; i++) {
  const file = path.join(root, `${String(i).padStart(3, '0')}.eml`);
  const eml = Buffer.from(`From: sender@example.com\r\nTo: to@example.com\r\nSubject: Stress ${i}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="test"\r\n\r\n--test\r\nContent-Type: text/plain\r\n\r\nStress ${i}\r\n--test\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="data.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64}\r\n--test--\r\n`);
  await fs.writeFile(file, eml); files.push(file); inputSize += eml.length;
  originalHashes.set(`Stress ${i}`, digest(eml));
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ acceptDownloads: true });
// Incognito OPFS has a small default quota; native user-selected folders do not use it.
// Allow enough test-only OPFS storage to exercise the full batch using real disk writes.
const cdp = await page.context().newCDPSession(page);
await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(process.env.WEB_URL || 'http://127.0.0.1:8765/mpa/').origin, quotaSize: 8 * 1024 ** 3 });
const errors = [], requests = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', r => requests.push({ method: r.method(), url: r.url() }));
try {
  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => {
      window.__dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('stress-' + crypto.randomUUID(), { create: true });
      return window.__dir;
    };
  });
  await page.goto(process.env.WEB_URL || 'http://127.0.0.1:8765/mpa/');
  await page.locator('#mail-files:not([disabled])').waitFor({ timeout: 90_000 });
  await page.locator('#mail-files').setInputFiles(files);
  await page.getByRole('button', { name: '저장 폴더 선택', exact: true }).click();
  console.log(`Converting 638 MIME messages, ${(inputSize / 1024 ** 3).toFixed(2)} GiB actual input, original preservation on...`);
  await page.getByRole('button', { name: 'PST로 변환하기' }).click();
  const monitor = setInterval(async () => {
    console.log('Progress:', await page.locator('.progress-label,.success-note,.notice').allTextContents().catch(() => []));
  }, 15_000);
  try {
    await page.waitForFunction(() => document.querySelector('.success-note strong')?.textContent === '폴더에 저장이 완료되었습니다.' || document.querySelector('[role=alert]')?.textContent?.includes('작업을 완료하지 못했습니다'), null, { timeout: 360_000 });
  } finally { clearInterval(monitor); }
  const notice = await page.locator('.notice').allTextContents();
  assert(!notice.some(t => t.includes('작업을 완료하지 못했습니다')), notice.join('\n'));
  assert.equal(await page.locator('.file-state.success').count(), 638);
  const saved = await page.evaluate(async () => {
    const files = [];
    for await (const [runName, run] of window.__dir.entries())
      for await (const [name, handle] of run.entries()) files.push({ runName, name, size: (await handle.getFile()).size });
    return files.sort((a, b) => a.name.localeCompare(b.name));
  });
  assert(saved.length > 4);
  console.log(`PASS all 638 saved into ${saved.length} PSTs. Independently verifying every message and attachment...`);
  const inspected = [];
  for (const entry of saved) {
    const pending = page.waitForEvent('download');
    await page.evaluate(async ({ runName, name }) => {
      const dir = await window.__dir.getDirectoryHandle(runName);
      const file = await (await dir.getFileHandle(name)).getFile();
      const url = URL.createObjectURL(file);
      const a = document.createElement('a'); a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }, entry);
    const download = await pending;
    const target = path.join(output, entry.name);
    await download.saveAs(target);
    const read = spawnSync(dotnet, ['tests/EmlToPst.Inspect/bin/Release/net10.0/EmlToPst.Inspect.dll', target, '--summary'], { encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(read.status, 0, read.stderr);
    const messages = JSON.parse(read.stdout);
    for (const mail of messages) {
      assert.equal(mail.body.trim(), mail.subject);
      assert.equal(mail.attachments.length, 2);
      assert.equal(mail.attachments[0].sha256, payloadHash);
      assert.equal(mail.attachments[1].sha256, originalHashes.get(mail.subject));
    }
    inspected.push(...messages.map(m => m.subject));
    await fs.unlink(target);
    await download.delete();
  }
  assert.equal(inspected.length, 638);
  assert.equal(new Set(inspected).size, 638);
  assert.deepEqual(errors, []);
  assert.equal(requests.filter(r => r.method !== 'GET').length, 0);
  const result = { inputSize, messages: inspected.length, parts: saved.length, outputSize: saved.reduce((n, s) => n + s.size, 0), everyAttachmentAndOriginalSha256Verified: true };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log('PASS', result);
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  console.error('Notices:', await page.locator('.notice').allTextContents()); throw error;
} finally {
  await page.evaluate(async () => {
    if (window.__dir) await (await navigator.storage.getDirectory()).removeEntry(window.__dir.name, { recursive: true });
  }).catch(() => {});
  await browser.close(); await fs.rm(root, { recursive: true, force: true });
}
