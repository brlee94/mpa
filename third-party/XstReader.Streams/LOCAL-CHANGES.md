Source: https://github.com/iluvadev/XstReader at da80989623f60685beaf5132948d32a3da48fd60, MS-PL (LICENSE.md).

Local changes for browser PST merging:
- Replace FileStream-only read signatures with Stream; add an owning seekable-stream XstFile constructor.
- Use synchronous cleanup, and drop lazy root collections without rereading a disposed input.
- Keep signed/encrypted messages in their raw form; do not use certificates or decrypt during merge.
- Add streaming attachment access with exact payload length, reusing the upstream block decoder.
- Require exact reads so truncated input cannot silently zero-fill structures.
- Build the reader for .NET 10 with a pinned Pkcs dependency.

Original copyright and license notices are preserved. Modified source is distributed under MS-PL.
