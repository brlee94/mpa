let outputUrl = null;
let selectedDirectory = null;
let runDirectory = null;

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

export async function savePart(streamReference, name) {
  if (!runDirectory) throw new Error('저장 폴더가 준비되지 않았습니다.');
  // A fresh, uniquely named run folder prevents replacing previous conversion results.
  try {
    await runDirectory.getFileHandle(name);
    throw new Error('같은 이름의 PST가 이미 있습니다. 기존 파일을 덮어쓰지 않습니다.');
  } catch (error) {
    if (error.name !== 'NotFoundError') throw error;
  }
  const handle = await runDirectory.getFileHandle(name, { create: true });
  let writable = null;
  try {
    writable = await handle.createWritable();
    // Backpressure keeps JS memory bounded; do not buffer the PST in arrayBuffer/Blob.
    const readable = await streamReference.stream();
    await readable.pipeTo(writable);
  } catch (error) {
    try { await writable?.abort(); } catch { /* pipeTo may already have aborted it. */ }
    try { await runDirectory.removeEntry(name); } catch { /* Preserve the original error. */ }
    throw error;
  }
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
