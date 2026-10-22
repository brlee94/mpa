using System.Text;
using System.Text.Json;
using EmlToPst.Merge;
using PstBuilder.Foundation;
using PstBuilder.Ltp;
using PstBuilder.Messaging;

if (args.Length == 2 && args[0] == "--large-fixtures")
{
    Directory.CreateDirectory(args[1]);
    byte[] payload = new byte[8 * 1024 * 1024]; Array.Fill(payload, (byte)0xA7);
    for (int part = 0; part < 3; part++)
    {
        string name = Path.Combine(args[1], $"large-{part + 1}.pst");
        using var file = File.Create(name);
        using var output = new PstOutputStream(file, leaveOpen: true);
        var writer = new StoreWriter(); writer.Begin(output);
        var folder = writer.GetOrCreateFolder("가져온 메일/대용량", "IPF.Note");
        for (int i = 0; i < 96; i++)
        {
            int id = part * 96 + i;
            var message = new MessageItem { Subject = $"Large {id}", Body = $"Body {id}", SenderEmail = "sender@example.com", SubmitTimeUtc = DateTime.UnixEpoch, DeliveryTimeUtc = DateTime.UnixEpoch };
            message.Attachments.Add(AttachmentItem.FromStream("payload.bin", () => new MemoryStream(payload, false), payload.Length, "application/octet-stream"));
            writer.AddMessage(folder, message);
        }
        writer.Complete(); output.Flush();
    }
    File.WriteAllText(Path.Combine(args[1], "expected.json"), JsonSerializer.Serialize(new { count = 288, attachmentBytes = payload.Length, sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(payload)).ToLowerInvariant() }));
    Console.WriteLine("Large PST fixtures created."); return 0;
}
if (args.Length == 2 && args[0] == "--fixtures")
{
    Directory.CreateDirectory(args[1]);
    byte[] binary = Enumerable.Range(0, 65536).Select(i => (byte)(i % 251)).ToArray();
    byte[] original = Encoding.UTF8.GetBytes("From: sender@example.com\r\nTo: to@example.com\r\nSubject: Original\r\n\r\n한글 원본\r\n");
    MessageItem Mail(string subject, string body)
    {
        var item = new MessageItem { Subject = subject, Body = body, BodyHtml = "<p>" + body + "</p><img src=\"cid:image@test\">", SenderName = "발신자", SenderEmail = "sender@example.com", DisplayTo = "수신자", SubmitTimeUtc = new DateTime(2026, 10, 22, 1, 30, 0, DateTimeKind.Utc), DeliveryTimeUtc = new DateTime(2026, 10, 22, 1, 31, 0, DateTimeKind.Utc) };
        item.Recipients.Add(new() { DisplayName = "수신자", EmailAddress = "to@example.com", RecipientType = 1 });
        item.Recipients.Add(new() { EmailAddress = "cc@example.com", RecipientType = 2 });
        item.Recipients.Add(new() { EmailAddress = "bcc@example.com", RecipientType = 3 });
        item.Properties.Add(Property.Unicode(0x1035, "<same-id@example.com>"));
        item.Properties.Add(Property.Int32(0x3FDE, 65001));
        item.Attachments.Add(new() { FileName = "자료.bin", Content = binary, MimeType = "application/octet-stream" });
        item.Attachments.Add(new() { FileName = "image.png", Content = new byte[] { 1, 3, 5 }, MimeType = "image/png", ContentId = "image@test", IsInline = true });
        item.Attachments.Add(new() { FileName = "원본.eml", Content = original, MimeType = "message/rfc822" });
        return item;
    }
    void Create(string name, params (string Folder, MessageItem Mail)[] items)
    {
        using var file = File.Create(Path.Combine(args[1], name));
        using var output = new PstOutputStream(file, leaveOpen: true);
        var writer = new StoreWriter(); writer.Begin(output);
        foreach (var (folder, mail) in items) writer.AddMessage(writer.GetOrCreateFolder(folder, "IPF.Note"), mail);
        writer.Complete(); output.Flush();
    }
    Create("part-a.pst", ("가져온 메일/보관함", Mail("공통 메일", "같은 본문")), ("가져온 메일/보관함/하위", Mail("메일 A", "A 본문")));
    Create("part-b.pst", ("가져온 메일/보관함", Mail("공통 메일", "같은 본문")), ("가져온 메일/보관함/하위", Mail("메일 B", "B 본문")));
    Create("part-different.pst", ("가져온 메일/보관함", Mail("공통 메일", "바뀐 본문")), ("가져온 메일/다른 폴더", Mail("공통 메일", "같은 본문")));
    var contact = Mail("Contact", "unsupported"); contact.MessageClass = "IPM.Contact";
    Create("contacts.pst", ("Contacts", contact));
    Console.WriteLine("Fixtures created."); return 0;
}
if (args.Length >= 3)
{
    bool deduplicate = args[0] != "--keep-duplicates";
    int start = deduplicate ? 0 : 1;
    using var destination = File.Create(args[start]);
    using var session = new MergeSession(destination, deduplicate);
    foreach (string name in args.Skip(start + 1))
    {
        session.OpenSource(File.OpenRead(name), Path.GetFileName(name));
        while (session.Step() is not null) { }
        session.CloseSource();
    }
    long size = session.Complete(destination);
    Console.WriteLine(JsonSerializer.Serialize(new { session.Read, session.Added, session.Duplicates, size }));
    return 0;
}
return 2;
