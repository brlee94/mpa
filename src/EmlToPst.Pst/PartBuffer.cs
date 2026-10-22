namespace EmlToPst.Pst;

// Fixed-size blocks avoid MemoryStream's doubling allocations and large contiguous copies.
// PST needs random access to rewrite headers; the finished blocks are read sequentially.
internal sealed class PartBuffer(long limit) : Stream
{
    private const int BlockSize = 1024 * 1024;
    private readonly List<byte[]> blocks = [];
    private long length, position;
    private bool disposed;
    public override bool CanRead => !disposed;
    public override bool CanSeek => !disposed;
    public override bool CanWrite => !disposed;
    public override long Length { get { Check(); return length; } }
    public override long Position
    {
        get { Check(); return position; }
        set { Check(); if (value < 0 || value > limit) throw new ArgumentOutOfRangeException(nameof(value)); position = value; }
    }
    private void Check() => ObjectDisposedException.ThrowIf(disposed, this);
    public override void Flush() => Check();
    public override long Seek(long offset, SeekOrigin origin)
    {
        Position = checked((origin switch { SeekOrigin.Begin => 0, SeekOrigin.Current => position, SeekOrigin.End => length, _ => throw new ArgumentOutOfRangeException(nameof(origin)) }) + offset);
        return position;
    }
    public override void SetLength(long value)
    {
        Check();
        if (value < 0 || value > limit) throw new IOException("PST 한 개의 처리 한도(384MB)를 초과했습니다.");
        while ((long)blocks.Count * BlockSize < value) blocks.Add(new byte[BlockSize]);
        if (value < length)
        {
            int keep = checked((int)((value + BlockSize - 1) / BlockSize));
            if (blocks.Count > keep) blocks.RemoveRange(keep, blocks.Count - keep);
            if (keep > 0 && value % BlockSize != 0) blocks[^1].AsSpan((int)(value % BlockSize)).Clear();
        }
        length = value;
        if (position > length) position = length;
    }
    public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
    public override int Read(Span<byte> destination)
    {
        Check();
        int remaining = (int)Math.Min(destination.Length, Math.Max(0, length - position));
        int total = remaining;
        while (remaining > 0)
        {
            int index = (int)(position / BlockSize), start = (int)(position % BlockSize);
            int take = Math.Min(remaining, BlockSize - start);
            blocks[index].AsSpan(start, take).CopyTo(destination);
            destination = destination[take..]; position += take; remaining -= take;
        }
        return total;
    }
    public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));
    public override void Write(ReadOnlySpan<byte> source)
    {
        Check();
        long end = checked(position + source.Length);
        if (end > limit) throw new IOException("PST 한 개의 처리 한도(384MB)를 초과했습니다.");
        // SetLength also zero-fills any gap created by seeking beyond the end.
        long startPosition = position;
        if (end > length) SetLength(end);
        position = startPosition;
        while (!source.IsEmpty)
        {
            int index = (int)(position / BlockSize), start = (int)(position % BlockSize);
            int take = Math.Min(source.Length, BlockSize - start);
            source[..take].CopyTo(blocks[index].AsSpan(start, take));
            source = source[take..]; position += take;
        }
    }
    protected override void Dispose(bool disposing)
    {
        blocks.Clear(); length = position = 0; disposed = true;
        base.Dispose(disposing);
    }
}
