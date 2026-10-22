Third-party components

Web application:
- XstReader.Streams (MS-PL), adapted from iluvadev/XstReader commit da80989623f60685beaf5132948d32a3da48fd60; see XstReader.Streams/LOCAL-CHANGES.md and LICENSE.md
- PstBuilder 1.3.0 (MIT), https://github.com/ml-ls/PST-Builder
- MimeKit 4.18.2 (MIT), https://github.com/jstedfast/MimeKit
- BouncyCastle.Cryptography 2.7.0 (MIT-style), https://github.com/bcgit/bc-csharp
- Microsoft .NET 10 / ASP.NET Core WebAssembly runtime (Microsoft licenses)

The static website includes license text and runtime notices in licenses.txt.
Microsoft Outlook is not bundled or required by the web app.

Development tests only (not included in the web app):
- XstReader.Api 1.0.6 (MS-PL), https://github.com/iluvadev/XstReader
- Playwright 1.62.1 (Apache-2.0), https://github.com/microsoft/playwright

The separate Windows portable app bundles .NET and requires an installed
classic Microsoft Outlook. Its distribution includes applicable notices.
