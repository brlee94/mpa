let outputUrl = null;

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
