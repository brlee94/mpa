let directory = null;
let running = null;
const MiB = 1024 * 1024;

export function supported() {
  return typeof showDirectoryPicker === 'function' && typeof Worker === 'function' && typeof navigator.storage?.getDirectory === 'function';
}
export async function chooseDirectory() {
  try { directory = await showDirectoryPicker({ mode: 'readwrite', id: 'mpa-pst-merge-output' }); return directory.name; }
  catch (error) { if (error.name === 'AbortError') return null; throw error; }
}
async function cleanup(record) {
  record.worker?.terminate(); record.worker = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { await record.root.removeEntry(record.name, { recursive: true }); return; }
    catch (error) {
      if (error.name === 'NotFoundError') return;
      if (attempt === 9) throw new Error('병합 작업은 끝났지만 임시 파일을 정리하지 못했습니다. 이 사이트의 저장 공간을 확인해 주세요.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
function leave(active) { window.onbeforeunload = active ? event => { event.preventDefault(); event.returnValue = ''; } : null; }

export async function merge(inputId, name, deduplicate, callback) {
  if (running) throw new Error('다른 병합 작업이 진행 중입니다.');
  if (!directory) throw new Error('결과 저장 폴더를 선택해 주세요.');
  const files = Array.from(document.getElementById(inputId).files);
  if (files.length < 2 || files.length > 256 || files.some(f => !f.name.toLowerCase().endsWith('.pst')))
    throw new Error('PST 파일을 2개 이상, 최대 256개까지 선택해 주세요.');
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > 4 * 1024 ** 3) throw new Error('병합할 PST의 합계는 4GB까지 지원합니다.');
  const space = await navigator.storage.estimate();
  const needed = total + Math.max(...files.map(f => f.size)) + 16 * MiB;
  if (space.quota && space.quota - space.usage < needed)
    throw new Error(`브라우저 임시 저장 공간이 부족합니다. 약 ${(needed / 1024 ** 3).toFixed(1)}GB의 임시 공간이 필요합니다. 일반 Chrome/Edge 창에서 디스크 공간을 확보한 뒤 다시 시도하세요.`);
  const root = await navigator.storage.getDirectory();
  const workName = 'mpa-pst-merge-' + crypto.randomUUID();
  const working = await root.getDirectoryHandle(workName, { create: true });
  const record = { root, name: workName, working, worker: null, cancelled: false, reject: null, outputAbort: null };
  running = record; leave(true);
  let runDirectory = null, outputFileName = null;
  try {
    const converted = await new Promise((resolve, reject) => {
      record.reject = reject;
      record.worker = new Worker(new URL('./merge-worker.js', import.meta.url), { type: 'module' });
      record.worker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
          callback.invokeMethodAsync('MergeProgress', {
            stage: data.stage, file: data.file, index: data.index,
            read: data.Read || 0, added: data.Added || 0, duplicates: data.Duplicates || 0
          }).catch(() => {});
        } else if (data.type === 'complete') resolve(data);
        else if (data.type === 'failure') reject(new Error(data.message));
      };
      record.worker.onerror = error => reject(new Error(error.message || '병합 실행 중 오류가 발생했습니다.'));
      record.worker.postMessage({ type: 'start', files, working, deduplicate });
    });
    // Termination releases the entire merge engine/WASM heap before exporting the final file.
    record.worker.terminate(); record.worker = null;
    if (record.cancelled) throw new DOMException('병합을 중지했습니다.', 'AbortError');
    await callback.invokeMethodAsync('MergeProgress', { stage: '완성된 PST를 선택한 폴더에 저장하는 중', file: '', index: files.length, read: converted.Read, added: converted.Added, duplicates: converted.Duplicates });
    if (record.cancelled) throw new DOMException('병합을 중지했습니다.', 'AbortError');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    runDirectory = await directory.getDirectoryHandle('PST병합-' + stamp + '-' + crypto.randomUUID().slice(0, 8), { create: true });
    outputFileName = name + '.pst';
    const finalHandle = await runDirectory.getFileHandle(outputFileName, { create: true });
    const temporaryFile = await (await working.getFileHandle('merged.tmp')).getFile();
    const writable = await finalHandle.createWritable();
    record.outputAbort = new AbortController();
    if (record.cancelled) record.outputAbort.abort();
    await temporaryFile.stream().pipeTo(writable, { signal: record.outputAbort.signal });
    record.outputAbort = null;
    return { name: outputFileName, size: temporaryFile.size, count: converted.Added, duplicates: converted.Duplicates,
      location: directory.name + '/' + runDirectory.name, peakManagedBytes: converted.PeakManagedBytes, sources: converted.sources };
  } catch (error) {
    if (runDirectory && outputFileName) { try { await runDirectory.removeEntry(outputFileName); } catch { } }
    if (record.cancelled) throw new Error('병합을 중지했습니다. 원본 PST는 그대로 보존됩니다.');
    if (error?.name === 'QuotaExceededError' || String(error?.message).includes('quota'))
      throw new Error(runDirectory ? '결과를 저장할 디스크 공간이 부족합니다. 원본 PST는 보존됩니다.' : '브라우저 임시 저장 공간이 부족합니다. 디스크 공간을 확보하고 일반 Chrome/Edge 창에서 다시 시도하세요. 원본 PST는 보존됩니다.');
    throw error;
  } finally {
    record.reject = null;
    try { await cleanup(record); } finally { if (running === record) running = null; leave(false); }
  }
}
export function cancel() {
  if (!running) return;
  running.cancelled = true;
  running.worker?.terminate(); running.worker = null;
  running.outputAbort?.abort();
  running.reject?.(new DOMException('병합을 중지했습니다.', 'AbortError'));
}

export function downloadReport(text) {
  const url = URL.createObjectURL(new Blob(['\ufeff', text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = '병합결과.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
