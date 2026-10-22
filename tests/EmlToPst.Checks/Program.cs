using System.Text;
using EmlToPst.Core;
using MimeKit;

string root = Path.Combine(Path.GetTempPath(), "emltopst-checks-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
int passed = 0;
try
{
    void Check(string name, Action action)
    {
        action();
        passed++;
        Console.WriteLine("PASS " + name);
    }
    void Expect(bool condition, string reason)
    {
        if (!condition) throw new Exception(reason);
    }
    byte[] attachmentBytes = [0, 1, 2, 128, 254, 255];
    string fixture = """
        From: =?UTF-8?B?67O064K064qUIOyCrOuejA==?= <sender@example.com>
        To: Receiver <to@example.com>
        Cc: Copy <cc@example.com>
        Bcc: Hidden <bcc@example.com>
        Subject: =?UTF-8?B?7ZWc6riAIO2FjOyKpO2KuA==?=
        Date: Thu, 22 Oct 2026 10:30:00 +0900
        Received: from example.com by local; Thu, 22 Oct 2026 10:31:00 +0900
        Message-ID: <fixture-001@example.com>
        MIME-Version: 1.0
        Content-Type: multipart/mixed; boundary="outer"

        --outer
        Content-Type: multipart/alternative; boundary="body"

        --body
        Content-Type: text/plain; charset=utf-8
        Content-Transfer-Encoding: base64

        7JWI64WV7ZWY7IS47JqU
        --body
        Content-Type: text/html; charset=utf-8

        <html><body><p>Hello</p><img src="cid:picture@example.com"></body></html>
        --body--
        --outer
        Content-Type: application/octet-stream
        Content-Disposition: attachment; filename*=utf-8''%ED%95%9C%EA%B8%80.bin
        Content-Transfer-Encoding: base64

        AAECgP7/
        --outer
        Content-Type: image/png; name="picture.png"
        Content-Disposition: inline; filename="picture.png"
        Content-ID: <picture@example.com>
        Content-Transfer-Encoding: base64

        iVBORw0KGgo=
        --outer
        Content-Type: message/rfc822
        Content-Disposition: attachment; filename="forwarded.eml"

        From: nested@example.com
        To: to@example.com
        Subject: Nested message
        Date: Thu, 22 Oct 2026 10:00:00 +0900

        forwarded body
        --outer--
        """.Replace("\r\n", "\n").Replace("\n", "\r\n");
    string path = Path.Combine(root, "메일.EML");
    File.WriteAllText(path, fixture, new UTF8Encoding(false));
    using var message = EmlReader.Read(path);
    Check("RFC 2047 Korean subject and sender", () =>
    {
        Expect(message.Subject == "한글 테스트", "Encoded subject changed");
        Expect(message.From.Mailboxes.First().Name == "보내는 사람", "Encoded sender changed");
    });
    Check("recipients, Message-ID and timezone", () =>
    {
        Expect(message.To.Mailboxes.Single().Address == "to@example.com", "To lost");
        Expect(message.Cc.Mailboxes.Single().Address == "cc@example.com", "Cc lost");
        Expect(message.Bcc.Mailboxes.Single().Address == "bcc@example.com", "Bcc lost");
        Expect(message.MessageId == "fixture-001@example.com", "Message-ID lost");
        Expect(message.Date.UtcDateTime == new DateTime(2026, 10, 22, 1, 30, 0, DateTimeKind.Utc), "Date changed");
    });
    Check("plain text and HTML alternatives", () =>
    {
        Expect(message.TextBody?.Trim() == "안녕하세요", "UTF-8 body changed");
        Expect(message.HtmlBody?.Contains("cid:picture@example.com") == true, "HTML CID lost");
    });
    var parts = EmlReader.Attachments(message.Body).ToList();
    Check("attachments exclude body alternatives", () => Expect(parts.Count == 3, "Expected binary, inline and nested mail"));
    Check("attachment bytes and RFC 2231 Korean filename", () =>
    {
        Expect(EmlReader.AttachmentName(parts[0], 1) == "한글.bin", "Filename changed");
        string output = Path.Combine(root, "decoded.bin");
        EmlReader.SaveAttachment(parts[0], output);
        Expect(File.ReadAllBytes(output).SequenceEqual(attachmentBytes), "Binary attachment changed");
    });
    Check("inline image CID retained", () => Expect(parts[1].ContentId == "picture@example.com", "Inline CID lost"));
    Check("nested EML survives serialization", () =>
    {
        string nested = Path.Combine(root, "nested.eml");
        EmlReader.SaveAttachment(parts[2], nested);
        using var restored = EmlReader.Read(nested);
        Expect(restored.Subject == "Nested message", "Nested mail changed");
        File.Delete(nested);
    });
    Check("delivery time uses Received instead of sent time", () =>
        Expect(EmlReader.DeliveryTime(message)?.UtcDateTime == new DateTime(2026, 10, 22, 1, 31, 0, DateTimeKind.Utc), "Delivery date changed"));
    Check("unsafe and reserved attachment filenames", () =>
    {
        var part = new MimePart("application", "octet-stream") { FileName = "../../escape?.bin" };
        Expect(EmlReader.AttachmentName(part, 1) == "escape_.bin", "Traversal not removed");
        part.FileName = "C:\\outside\\AUX.txt";
        Expect(EmlReader.AttachmentName(part, 1) == "_AUX.txt", "Windows path or reserved name survived");
        part.Dispose();
    });
    Check("malformed input rejected", () =>
    {
        string invalid = Path.Combine(root, "invalid.eml");
        File.WriteAllText(invalid, "this is not an email");
        bool rejected = false;
        try { using var ignored = EmlReader.Read(invalid); }
        catch (FormatException) { rejected = true; }
        File.Delete(invalid);
        Expect(rejected, "Invalid email accepted");
    });
    Check("recursive plan preserves paths and ignores other formats", () =>
    {
        Directory.CreateDirectory(Path.Combine(root, "보관함"));
        File.WriteAllText(Path.Combine(root, "보관함", "second.eml.15"), fixture);
        File.WriteAllText(Path.Combine(root, "ignore.txt"), fixture);
        var top = InputPlan.FromFolder(root, false);
        var all = InputPlan.FromFolder(root, true);
        Expect(top.Count == 1 && all.Count == 2, "Incorrect discovery count");
        Expect(all.Single(x => x.Folders.Length > 0).Folders.SequenceEqual(new[] { "보관함" }), "Hierarchy changed");
    });
    Check("selected files deduplicated and checked", () =>
    {
        Expect(InputPlan.FromFiles([path, path]).Count == 1, "Duplicate selected file");
        bool rejected = false;
        try { InputPlan.FromFiles([Path.Combine(root, "ignore.txt")]); }
        catch (ArgumentException) { rejected = true; }
        Expect(rejected, "Non-EML selected file accepted");
    });
    Console.WriteLine($"{passed} checks passed; Outlook/PST integration not executed on this host.");
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"FAILED after {passed} checks: {ex}");
    return 1;
}
finally { Directory.Delete(root, true); }
