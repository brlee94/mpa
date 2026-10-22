let input = null;
let output = null;
let api = null;
let working = null;
let activeName = '';
let lastProgress = 0;

function progress(data, force = false) {
  const now = performance.now();
  if (force || now - lastProgress > 100) { postMessage({ type: 'progress', ...data }); lastProgress = now; }
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'start') return;
  try {
    working = data.working;
    const outputFile = await working.getFileHandle('merged.tmp', { create: true });
    output = await outputFile.createSyncAccessHandle();
    const manifest = await (await fetch(new URL('./release.json', import.meta.url), { cache: 'no-store' })).json();
    if (!manifest.runtimeModule) throw new Error('병합 실행 파일 정보가 없습니다. 최신 버전 주소를 열어 주세요.');
    // This is an independent .NET runtime, not a thread worker waiting for monoCmd preload.
    globalThis.dotnetSidecar = true;
    const { dotnet } = await import(new URL(manifest.runtimeModule, import.meta.url).href);
    const runtime = await dotnet.create();
    let scratch = new Uint8Array(256 * 1024);
    const handle = id => id === 0 ? input : output;
    runtime.setModuleImports('pst-disk', {
      read(id, position, view) {
        if (scratch.length < view.length) scratch = new Uint8Array(view.length);
        const bytes = scratch.subarray(0, view.length);
        const count = handle(id).read(bytes, { at: position });
        view.set(bytes.subarray(0, count));
        return count;
      },
      write(id, position, view) { return handle(id).write(view.slice(), { at: position }); },
      length(id) { return handle(id).getSize(); },
      truncate(id, length) { handle(id).truncate(length); },
      flush(id) { handle(id).flush(); }
    });
    api = (await runtime.getAssemblyExports('EmlToPst.Web')).EmlToPst.Web.MergeWorkerApi;
    api.Begin(data.deduplicate);
    let totals = { Read: 0, Added: 0, Duplicates: 0 };
    const sources = [];
    for (let index = 0; index < data.files.length; index++) {
      const file = data.files[index]; activeName = file.name;
      progress({ stage: '입력 PST를 준비하는 중', file: activeName, index: index + 1, ...totals }, true);
      const sourceFile = await working.getFileHandle('source.tmp', { create: true });
      await file.stream().pipeTo(await sourceFile.createWritable());
      input = await sourceFile.createSyncAccessHandle();
      const before = totals;
      api.OpenSource(file.name);
      while (true) {
        const next = api.Step();
        if (!next) break;
        totals = JSON.parse(next);
        progress({ stage: '메일과 첨부파일을 병합하는 중', file: activeName, index: index + 1, ...totals });
        // Let the worker deliver progress while all PST I/O stays synchronous and bounded.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      api.CloseSource();
      input.close(); input = null;
      await working.removeEntry('source.tmp');
      sources.push({ name: file.name, read: totals.Read - before.Read, added: totals.Added - before.Added, duplicates: totals.Duplicates - before.Duplicates });
      progress({ stage: '다음 PST를 준비하는 중', file: activeName, index: index + 1, ...totals }, true);
    }
    progress({ stage: '하나의 PST로 마무리하는 중', file: '', index: data.files.length, ...totals }, true);
    const result = JSON.parse(api.Complete());
    api.Dispose(); api = null;
    output.flush(); output.close(); output = null;
    postMessage({ type: 'complete', ...result, sources });
  } catch (error) {
    try { api?.Dispose(); } catch { /* Preserve the original failure. */ }
    try { input?.close(); } catch { }
    try { output?.close(); } catch { }
    input = output = null;
    postMessage({ type: 'failure', message: `${activeName ? activeName + ': ' : ''}${error?.message || error}` });
  }
};
