let outputUrl = null;
let selectedDirectory = null;
let runDirectory = null;
let partWriter = null;
let partName = null;

export function canChooseDirectory() {
  return typeof window.showDirectoryPicker === 'function';
}

export async function chooseDirectory() {
  try {
    const directory = await window.showDirectoryPicker({ mode: 'readwrite', id: 'mpa-pst-output' });
    selectedDirectory = directory;
    return directory.name;
  } catch (error) {
    if (error.name === 'AbortError') return null;
    throw error;
  }
}

export async function beginDirectoryRun(name) {
  if (!selectedDirectory) throw new Error('PST를 저장할 폴더를 먼저 선택하세요.');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const runName = `${name.slice(0, 60)}-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
  runDirectory = await selectedDirectory.getDirectoryHandle(runName, { create: true });
  return `${selectedDirectory.name}/${runName}`;
}

export async function openPart(name) {
  if (!runDirectory) throw new Error('저장 폴더가 준비되지 않았습니다.');
  if (partWriter) throw new Error('이전 PST 저장이 끝나지 않았습니다.');
  try {
    await runDirectory.getFileHandle(name);
    throw new Error('같은 이름의 PST가 이미 있습니다. 기존 파일을 덮어쓰지 않습니다.');
  } catch (error) {
    if (error.name !== 'NotFoundError') throw error;
  }
  partName = name;
  try {
    const handle = await runDirectory.getFileHandle(name, { create: true });
    partWriter = await handle.createWritable();
  } catch (error) {
    await abortPart();
    throw error;
  }
}

export async function writePartChunk(bytes) {
  if (!partWriter) throw new Error('PST 저장이 시작되지 않았습니다.');
  // Each interop call awaits the disk write before .NET sends another 256KiB block.
  // DotNetStreamReference's push stream cannot enforce backpressure on the producer.
  await partWriter.write(bytes);
}

export async function closePart() {
  if (!partWriter) throw new Error('PST 저장이 시작되지 않았습니다.');
  await partWriter.close();
  partWriter = null;
  partName = null;
}

export async function abortPart() {
  try { await partWriter?.abort(); } catch { /* Preserve the original error. */ }
  partWriter = null;
  if (partName) {
    try { await runDirectory.removeEntry(partName); } catch { /* A previous part is never removed. */ }
  }
  partName = null;
}

export function paths(id) {
  return Array.from(document.getElementById(id).files, f => f.webkitRelativePath || f.name);
}

export async function prepareDownload(streamReference) {
  const bytes = await streamReference.arrayBuffer();
  const nextUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.ms-outlook' }));
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = nextUrl;
  return { url: outputUrl, size: bytes.byteLength };
}

export function releaseDownload() {
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = null;
}

export function downloadReport(text) {
  const url = URL.createObjectURL(new Blob(['\ufeff', text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = '변환결과.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function confirmLeave(active) {
  window.onbeforeunload = active ? event => { event.preventDefault(); event.returnValue = ''; } : null;
}
