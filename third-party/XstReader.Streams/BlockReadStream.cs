// Local addition to XstReader.Streams. Distributed under MS-PL; see LICENSE.md.
using System;
using System.Collections.Generic;
using System.IO;

namespace XstReader
{
    internal sealed class BlockReadStream : Stream
    {
        private readonly IEnumerator<byte[]> blocks;
        private readonly long length;
        private byte[] current = Array.Empty<byte>();
        private int offset;
        private long position;
        private bool disposed;
        public BlockReadStream(IEnumerable<byte[]> source, long length) { blocks = source.GetEnumerator(); this.length = length; }
        public override bool CanRead => !disposed;
        public override bool CanWrite => false;
        public override bool CanSeek => false;
        public override long Length => length;
        public override long Position { get => position; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int start, int count)
        {
            if (disposed) throw new ObjectDisposedException(nameof(BlockReadStream));
            int copied = 0;
            while (copied < count)
            {
                if (offset == current.Length)
                {
                    if (!blocks.MoveNext()) break;
                    current = blocks.Current; offset = 0;
                }
                int take = Math.Min(count - copied, current.Length - offset);
                Array.Copy(current, offset, buffer, start + copied, take);
                offset += take; copied += take; position += take;
            }
            return copied;
        }
        protected override void Dispose(bool disposing) { blocks.Dispose(); current = Array.Empty<byte>(); disposed = true; base.Dispose(disposing); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
