using System.Runtime.InteropServices.JavaScript;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using EmlToPst.Merge;

namespace EmlToPst.Web;

[SupportedOSPlatform("browser")]
public static partial class MergeWorkerApi
{
    private static MergeSession? session;
    private static Stream? destination;
    private static long peakManagedBytes;
    [JSExport]
    public static void Begin(bool deduplicate)
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        destination = new BufferedStream(new BrowserDiskStream(1, true), 256 * 1024);
        session = new MergeSession(destination, deduplicate);
        peakManagedBytes = 0;
    }
    [JSExport]
    public static void OpenSource(string name) => session!.OpenSource(new BufferedStream(new BrowserDiskStream(0, false), 64 * 1024), name);
    [JSExport]
    public static string Step()
    {
        var progress = session!.Step();
        peakManagedBytes = Math.Max(peakManagedBytes, GC.GetTotalMemory(false));
        return progress is null ? "" : JsonSerializer.Serialize(progress);
    }
    [JSExport]
    public static void CloseSource() => session!.CloseSource();
    [JSExport]
    public static string Complete()
    {
        long size = session!.Complete(destination!);
        return JsonSerializer.Serialize(new { session.Read, session.Added, session.Duplicates, Size = size, PeakManagedBytes = peakManagedBytes });
    }
    [JSExport]
    public static void Dispose()
    {
        session?.Dispose(); session = null;
        destination?.Dispose(); destination = null;
        GC.Collect();
    }
}

[SupportedOSPlatform("browser")]
internal static partial class BrowserDisk
{
    [JSImport("read", "pst-disk")]
    internal static partial int Read(int id, double position, [JSMarshalAs<JSType.MemoryView>] Span<byte> bytes);
    [JSImport("write", "pst-disk")]
    internal static partial int Write(int id, double position, [JSMarshalAs<JSType.MemoryView>] Span<byte> bytes);
    [JSImport("length", "pst-disk")]
    internal static partial double Length(int id);
    [JSImport("truncate", "pst-disk")]
    internal static partial void Truncate(int id, double length);
    [JSImport("flush", "pst-disk")]
    internal static partial void Flush(int id);
}

[SupportedOSPlatform("browser")]
internal sealed class BrowserDiskStream(int id, bool writable) : Stream
{
    private long position;
    private bool disposed;
    private const long MaxOutputBytes = 8L * 1024 * 1024 * 1024;
    private void Check() => ObjectDisposedException.ThrowIf(disposed, this);
    public override bool CanRead => !disposed;
    public override bool CanWrite => !disposed && writable;
    public override bool CanSeek => !disposed;
    public override long Length { get { Check(); return checked((long)BrowserDisk.Length(id)); } }
    public override long Position { get { Check(); return position; } set { Check(); if (value < 0) throw new ArgumentOutOfRangeException(nameof(value)); position = value; } }
    public override int Read(byte[] bytes, int offset, int count) => Read(bytes.AsSpan(offset, count));
    public override int Read(Span<byte> bytes)
    {
        Check(); int read = BrowserDisk.Read(id, position, bytes); position += read; return read;
    }
    public override void Write(byte[] bytes, int offset, int count) => Write(bytes.AsSpan(offset, count));
    public override void Write(ReadOnlySpan<byte> bytes)
    {
        Check();
        if (!writable) throw new NotSupportedException();
        if (position + bytes.Length > MaxOutputBytes) throw new IOException("병합 결과 한도(8GB)를 초과했습니다.");
        int count = BrowserDisk.Write(id, position, MemoryMarshal.CreateSpan(ref MemoryMarshal.GetReference(bytes), bytes.Length));
        if (count != bytes.Length) throw new IOException("디스크 쓰기가 끝나지 않았습니다. 저장 공간을 확인해 주세요.");
        position += count;
    }
    public override long Seek(long offset, SeekOrigin origin) { Position = checked((origin switch { SeekOrigin.Begin => 0, SeekOrigin.Current => position, SeekOrigin.End => Length, _ => throw new ArgumentOutOfRangeException(nameof(origin)) }) + offset); return position; }
    public override void SetLength(long value) { Check(); if (!writable || value < 0 || value > MaxOutputBytes) throw new IOException("지원하지 않는 결과 파일 크기입니다."); BrowserDisk.Truncate(id, value); if (position > value) position = value; }
    public override void Flush() { Check(); if (writable) BrowserDisk.Flush(id); }
    protected override void Dispose(bool disposing) { disposed = true; base.Dispose(disposing); }
}
