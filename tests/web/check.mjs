import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, webkit } from 'playwright';
import { spawnSync } from 'node:child_process';

const baseUrl = process.env.WEB_URL || 'http://127.0.0.1:8765/mpa/';
const output = path.resolve('artifacts/web-checks');
await fs.mkdir(output, { recursive: true });
const encode = value => Buffer.from(value).toString('base64');
const fixture = Buffer.from(`From: =?UTF-8?B?${encode('보내는 사람')}?= <sender@example.com>
To: Receiver <to@example.com>
Cc: Copy <cc@example.com>
Bcc: Hidden <bcc@example.com>
Subject: =?UTF-8?B?${encode('한글 테스트')}?=
Date: Thu, 22 Oct 2026 10:30:00 +0900
Received: from example.com by local; Thu, 22 Oct 2026 10:31:00 +0900
Message-ID: <web-fixture@example.com>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="outer"

--outer
Content-Type: multipart/alternative; boundary="body"

--body
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: base64

${encode('안녕하세요')}
--body
Content-Type: text/html; charset=utf-8

<html><body><p>안녕하세요 HTML</p><img src="cid:picture@example.com"></body></html>
--body--
--outer
Content-Type: application/octet-stream
Content-Disposition: attachment; filename*=utf-8''%ED%95%9C%EA%B8%80.bin
Content-Transfer-Encoding: base64

AAECgP7/
--outer
Content-Type: image/png; name="picture.png"
Content-Disposition: inline; filename="picture.png"
Content-ID: <picture@example.com>
Content-Transfer-Encoding: base64

iVBORw0KGgo=
--outer
Content-Type: message/rfc822
Content-Disposition: attachment; filename="forwarded.eml"

From: nested@example.com
To: to@example.com
Subject: Nested message
Date: Thu, 22 Oct 2026 10:00:00 +0900

forwarded body
--outer--
`.replaceAll('\n', '\r\n'));
const mail = (name, buffer = fixture) => ({ name, mimeType: 'message/rfc822', buffer });
let checks = 0;
function check(name, action) { action(); console.log(`PASS ${name}`); checks++; }

const dotnet = process.env.DOTNET || 'dotnet';
const build = spawnSync(dotnet, ['build', 'tests/EmlToPst.Inspect', '--configuration', 'Release', '--nologo', '-p:RestoreLockedMode=true'], { encoding: 'utf8', timeout: 90_000 });
assert.equal(build.status, 0, build.stdout + build.stderr);
function readArchive(filename) {
  // Independent reader implementation; it is not used by the browser/writer.
  const result = spawnSync(dotnet, ['tests/EmlToPst.Inspect/bin/Release/net10.0/EmlToPst.Inspect.dll', filename], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

function attachmentBytes(attachment) {
  return Buffer.from(attachment.content, 'base64');
}

async function savePst(page, filename) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'PST 저장하기' }).click();
  const download = await downloadPromise;
  const target = path.join(output, filename);
  await download.saveAs(target);
  return target;
}

async function run(browserType, name, launchOptions = {}) {
  const browser = await browserType.launch({ headless: true, ...launchOptions });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
  try {
    await page.goto(baseUrl);
    await page.locator('#mail-files:not([disabled])').waitFor({ timeout: 90_000 });
    const version = await page.getByLabel('앱 버전', { exact: true }).innerText();
    check(`${name}: visible release version identifies the running app`, () => assert.match(version, /버전 4/));
    const initiallyDisabled = await page.getByRole('button', { name: 'PST로 변환하기' }).isDisabled();
    check(`${name}: empty state does not enable conversion`, () => assert.equal(initiallyDisabled, true));
    await page.screenshot({ path: path.join(output, `${name}-desktop.png`), fullPage: true });

    await page.locator('#mail-files').setInputFiles([mail('한글.eml'), mail('invalid.eml', Buffer.from('not an email'))]);
    await page.getByRole('button', { name: 'PST로 변환하기' }).click();
    await page.getByRole('link', { name: 'PST 저장하기' }).waitFor({ timeout: 90_000 });
    const generated = await savePst(page, `${name}.pst`);
    const mails = readArchive(generated);
    {
      const header = await fs.readFile(generated);
      check(`${name}: PST is a real Unicode PST`, () => {
        assert.equal(header.subarray(0, 4).toString(), '!BDN');
        assert.equal(header.readUInt16LE(10), 23);
      });
      check(`${name}: failed EML is excluded`, () => assert.equal(mails.length, 1));
      const message = mails[0];
      check(`${name}: Korean subject/body and HTML`, () => {
        assert.equal(message.subject, '한글 테스트');
        assert.equal(message.body.trim(), '안녕하세요');
        assert.match(message.html, /cid:picture@example.com/);
        assert.match(message.html, /안녕하세요 HTML/);
      });
      check(`${name}: sender, recipients and Message-ID`, () => {
        assert.equal(message.sender, 'sender@example.com');
        assert.equal(message.senderName, '보내는 사람');
        assert.deepEqual(message.to, ['to@example.com']);
        assert.deepEqual(message.cc, ['cc@example.com']);
        assert.deepEqual(message.bcc, ['bcc@example.com']);
        assert.equal(message.messageId, '<web-fixture@example.com>');
      });
      check(`${name}: distinct sent and received UTC dates`, () => {
        assert.equal(new Date(message.sent).toISOString(), '2026-10-22T01:30:00.000Z');
        assert.equal(new Date(message.received).toISOString(), '2026-10-22T01:31:00.000Z');
      });
      check(`${name}: binary/inline/nested/original attachments`, () => {
        assert.equal(message.attachments.length, 4);
        assert.equal(message.attachments[0].filename, '한글.bin');
        assert.deepEqual(attachmentBytes(message.attachments[0]), Buffer.from([0, 1, 2, 128, 254, 255]));
        assert.equal(message.attachments[1].cid, 'picture@example.com');
        assert.match(attachmentBytes(message.attachments[2]).toString(), /Subject: Nested message/);
        assert.deepEqual(attachmentBytes(message.attachments[3]), fixture);
      });
    }
    const reportPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '변환 보고서 저장' }).click();
    const report = await reportPromise;
    const reportPath = path.join(output, `${name}-report.csv`);
    await report.saveAs(reportPath);
    const reportText = await fs.readFile(reportPath, 'utf8');
    check(`${name}: failure report contains invalid source`, () => {
      assert.match(reportText, /invalid\.eml/);
      assert.match(reportText, /변환 실패/);
      assert.match(reportText, /파일,결과,설명,원본 바이트,저장 PST,앱 버전/);
      assert.match(reportText, /recovery-v4/);
    });

    await page.getByLabel('원본 EML 함께 보존').uncheck();
    await page.getByRole('button', { name: '설정 바꿔 다시 변환' }).click();
    await page.getByRole('link', { name: 'PST 저장하기' }).waitFor({ timeout: 90_000 });
    const smaller = await savePst(page, `${name}-without-original.pst`);
    const recheck = readArchive(smaller);
    check(`${name}: original attachment is optional`, () => assert.equal(recheck[0].attachments.length, 3));

    await page.getByRole('button', { name: '모두 지우기' }).click();
    await page.locator('#mail-files').setInputFiles([mail('bad.eml', Buffer.from('broken'))]);
    await page.getByRole('button', { name: 'PST로 변환하기' }).click();
    await page.getByRole('alert').filter({ hasText: '변환 가능한 메일이 없습니다' }).waitFor();
    const invalidDownloads = await page.getByRole('link', { name: 'PST 저장하기' }).count();
    check(`${name}: all-invalid input produces no download`, () => assert.equal(invalidDownloads, 0));

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mpa-folder-'));
    try {
      await fs.mkdir(path.join(directory, '보관함'));
      await fs.writeFile(path.join(directory, 'one.eml'), fixture);
      await fs.writeFile(path.join(directory, '보관함', 'two.eml.15'), fixture);
      await fs.writeFile(path.join(directory, 'ignore.txt'), 'ignored');
      await page.locator('#mail-folder').setInputFiles(directory);
      await page.getByRole('button', { name: 'PST로 변환하기' }).click();
      await page.getByRole('link', { name: 'PST 저장하기' }).waitFor({ timeout: 90_000 });
      const folders = readArchive(await savePst(page, `${name}-folders.pst`));
      check(`${name}: folder hierarchy and .eml.15 selection`, () => {
        assert.equal(folders.length, 2);
        assert.equal(folders.filter(m => m.folder.endsWith('/보관함')).length, 1);
      });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, `${name}-mobile.png`), fullPage: true });
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    check(`${name}: narrow viewport does not overflow`, () => assert.equal(noOverflow, true));
    await page.getByRole('button', { name: '모두 지우기' }).click();
    const oversizedFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'mpa-oversize-'));
    try {
      const oversized = path.join(oversizedFolder, 'too-large.eml');
      const handle = await fs.open(oversized, 'w');
      await handle.truncate(100 * 1024 * 1024 + 1);
      await handle.close();
      await page.locator('#mail-files').setInputFiles(oversized);
      await page.getByRole('alert').filter({ hasText: '파일당 100MB' }).waitFor();
      const oversizedDisabled = await page.getByRole('button', { name: 'PST로 변환하기' }).isDisabled();
      check(`${name}: oversized input rejected`, () => assert.equal(oversizedDisabled, true));
    } finally { await fs.rm(oversizedFolder, { recursive: true, force: true }); }
    await page.locator('#mail-files').setInputFiles(Array.from({ length: 250 }, (_, i) => mail(`cancel-${i}.eml`)));
    await page.getByRole('button', { name: 'PST로 변환하기' }).click();
    await page.getByRole('button', { name: '변환 중지', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '변환을 중지했습니다' }).waitFor();
    const cancelledDownloads = await page.getByRole('link', { name: 'PST 저장하기' }).count();
    check(`${name}: cancellation never exports incomplete PST`, () => assert.equal(cancelledDownloads, 0));
    check(`${name}: mail never leaves the browser`, () => {
      assert.equal(requests.filter(r => r.method !== 'GET').length, 0);
      assert.equal(requests.filter(r => !r.url.startsWith(new URL(baseUrl).origin) && !r.url.startsWith('blob:')).length, 0);
      const frameworkRequests = requests.filter(r => r.url.includes('/_framework/'));
      assert(frameworkRequests.length > 0);
      assert(frameworkRequests.every(r => r.url.startsWith(new URL('_framework/', baseUrl).href)), 'App assets escaped the release directory');
      assert.deepEqual(errors, []);
    });
  } catch (error) {
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true });
    console.error('Browser errors:', errors);
    console.error('Visible notices:', await page.locator('.notice').allTextContents());
    throw error;
  } finally { await browser.close(); }
}

await run(chromium, 'chromium', { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
if (process.env.TEST_WEBKIT === '1') await run(webkit, 'webkit');
console.log(`${checks} browser/PST checks passed.`);
