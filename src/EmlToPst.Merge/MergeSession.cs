using System.Security.Cryptography;
using System.Text;
using PstBuilder.Foundation;
using PstBuilder.Ltp;
using PstBuilder.Messaging;
using XstReader;
using XstReader.ElementProperties;
using WriterProperty = PstBuilder.Ltp.Property;

namespace EmlToPst.Merge;

public sealed record MergeProgress(int Read, int Added, int Duplicates, string Subject);

// Output is caller-supplied random-access disk I/O. No PST-sized byte array is created.
public sealed class MergeSession : IDisposable
{
    private readonly PstOutputStream output;
    private readonly StoreWriter writer = new() { StoreDisplayName = "병합한 메일" };
    private readonly bool deduplicate;
    private readonly HashSet<string> seen = new(StringComparer.Ordinal);
    private XstFile? source;
    private IEnumerator<(string Path, XstMessage Message)>? messages;
    private bool completed;
    public int Read { get; private set; }
    public int Added { get; private set; }
    public int Duplicates { get; private set; }

    public MergeSession(Stream destination, bool deduplicate)
    {
        this.deduplicate = deduplicate;
        output = new PstOutputStream(destination, leaveOpen: true);
        writer.Begin(output);
    }

    public void OpenSource(Stream stream, string name)
    {
        if (completed || source is not null) throw new InvalidOperationException("PST 처리 순서가 올바르지 않습니다.");
        Span<byte> header = stackalloc byte[12];
        stream.ReadExactly(header);
        if (!header[..4].SequenceEqual("!BDN"u8)) throw new FormatException("올바른 PST 파일이 아닙니다: " + name);
        stream.Position = 0;
        source = new XstFile(stream, name);
        messages = Walk(source.RootFolder, "", true).GetEnumerator();
    }

    private IEnumerable<(string Path, XstMessage Message)> Walk(XstFolder folder, string parent, bool root = false)
    {
        string name = folder.DisplayName ?? "";
        bool wrapper = root || (parent == "" && name == "Top of Personal Folders");
        if (!wrapper && (name.Contains('/') || name.Contains('\\')))
            throw new NotSupportedException("경로 구분자가 포함된 PST 폴더명은 병합할 수 없습니다: " + name);
        string path = wrapper ? parent : parent.Length == 0 ? name : parent + "/" + name;
        // Create message folders on demand; the writer already supplies its system folders.
        foreach (var message in folder.Messages) yield return (path, message);
        if (folder.HasErrorInMessages) throw new IOException("메일 목록을 읽지 못했습니다: " + folder.ErrorInMessages);
        foreach (var child in folder.Folders)
            foreach (var item in Walk(child, path)) yield return item;
        if (folder.HasErrorInFolders) throw new IOException("폴더 목록을 읽지 못했습니다: " + folder.ErrorInFolders);
    }

    public MergeProgress? Step()
    {
        if (messages is null) throw new InvalidOperationException("입력 PST가 준비되지 않았습니다.");
        if (!messages.MoveNext()) return null;
        var (path, mail) = messages.Current;
        if (Read >= 100_000) throw new IOException("한 번에 병합할 수 있는 메일 100,000개를 초과했습니다.");
        var message = Map(mail);
        string subject = message.Subject;
        string? fingerprint = deduplicate ? Fingerprint(path, message) : null;
        Read++;
        if (fingerprint is not null && !seen.Add(fingerprint)) Duplicates++;
        else { writer.AddMessage(writer.GetOrCreateFolder(path, "IPF.Note"), message); Added++; }
        // The source table is lazy; dropping payload properties does not retain previous messages.
        mail.ClearContents();
        if (Read % 16 == 0) GC.Collect();
        return new(Read, Added, Duplicates, subject);
    }

    public void CloseSource()
    {
        messages?.Dispose(); messages = null;
        source?.Dispose(); source = null;
        GC.Collect();
    }

    public long Complete(Stream destination)
    {
        if (source is not null || completed) throw new InvalidOperationException("입력 PST 처리가 끝나지 않았습니다.");
        if (Added == 0) throw new FormatException("병합할 메일이 없습니다.");
        writer.Complete(); output.Flush(); completed = true;
        return destination.Length;
    }

    private static object? Value(XstElement item, ushort id) => item.Properties[id]?.Value;
    private static string Text(XstElement item, ushort id) => Value(item, id) as string ?? "";
    private static DateTime Date(XstMessage item, ushort id, DateTime fallback)
    {
        var value = Value(item, id);
        if (value is not DateTime date) return fallback;
        if (date.Year < 1601) throw new FormatException("PST에서 사용할 수 없는 날짜입니다.");
        return DateTime.SpecifyKind(date, DateTimeKind.Utc);
    }
    private static MessageItem Map(XstMessage mail)
    {
        string messageClass = Text(mail, 0x001A);
        if (messageClass == "") messageClass = "IPM.Note";
        if (!messageClass.StartsWith("IPM.Note", StringComparison.OrdinalIgnoreCase) && !messageClass.StartsWith("REPORT.IPM.Note", StringComparison.OrdinalIgnoreCase))
            throw new NotSupportedException("메일이 아닌 항목이 포함되어 있습니다 (" + messageClass + "). 연락처·일정·작업은 지원하지 않습니다.");
        var sent = Date(mail, 0x0039, DateTime.UnixEpoch);
        var received = Date(mail, 0x0E06, sent);
        string? html = Value(mail, 0x1013) switch
        {
            byte[] bytes => Encoding.GetEncoding(Value(mail, 0x3FDE) is int cp && cp > 0 ? cp : 65001).GetString(bytes),
            string text => text, _ => null
        };
        if (Text(mail, 0x1000) == "" && string.IsNullOrEmpty(html) && Value(mail, 0x1009) is byte[])
            throw new NotSupportedException("RTF 본문만 있는 메일은 병합을 지원하지 않습니다. EML 변환으로 먼저 본문을 보존해 주세요.");
        var message = new MessageItem
        {
            MessageClass = messageClass, Subject = mail.Subject ?? "", Body = Text(mail, 0x1000), BodyHtml = html,
            SenderName = Text(mail, 0x0C1A), SenderEmail = Text(mail, 0x0C1F), DisplayTo = Text(mail, 0x0E04),
            SubmitTimeUtc = sent, DeliveryTimeUtc = received, CreationTimeUtc = Date(mail, 0x3007, received),
            LastModificationTimeUtc = Date(mail, 0x3008, received), Flags = Value(mail, 0x0E07) is int flags ? flags : 1
        };
        foreach (var recipient in mail.Recipients.To) AddRecipient(message, recipient, 1);
        foreach (var recipient in mail.Recipients.Cc) AddRecipient(message, recipient, 2);
        foreach (var recipient in mail.Recipients.Bcc) AddRecipient(message, recipient, 3);
        foreach (ushort id in new ushort[] { 0x007D, 0x0C1E, 0x0064, 0x5D01, 0x5D02, 0x0E03, 0x0E02, 0x1035, 0x1042, 0x1039, 0x0050 })
            if (Value(mail, id) is string value) message.Properties.Add(WriterProperty.Unicode(id, value));
        message.Properties.Add(WriterProperty.Int32(0x3FDE, 65001));
        message.Properties.Add(WriterProperty.Int32(0x3FFD, 65001));
        foreach (var attachment in mail.Attachments)
        {
            using var stream = attachment.OpenContentStream();
            var item = AttachmentItem.FromStream(attachment.LongFileName ?? attachment.DisplayName ?? "첨부파일", attachment.OpenContentStream, stream.Length, Text(attachment, 0x370E));
            item.ContentId = attachment.ContentId;
            item.IsInline = attachment.IsInlineAttachment;
            message.Attachments.Add(item);
        }
        return message;
    }
    private static void AddRecipient(MessageItem message, XstRecipient recipient, int type) => message.Recipients.Add(new()
    {
        DisplayName = recipient.DisplayName ?? "", EmailAddress = recipient.Address ?? "", RecipientType = type,
        AddressType = Text(recipient, 0x3002) is { Length: > 0 } addressType ? addressType : "SMTP"
    });

    // Only remove exact matches within the same folder; Message-ID alone never decides duplicates.
    private static string Fingerprint(string path, MessageItem item)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        void Add(string value)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            hash.AppendData(BitConverter.GetBytes(bytes.Length)); hash.AppendData(bytes);
        }
        Add(path); Add(item.MessageClass); Add(item.Subject); Add(item.Body); Add(item.BodyHtml ?? "");
        Add(item.SenderName); Add(item.SenderEmail); Add(item.DisplayTo);
        Add(item.DeliveryTimeUtc.Ticks.ToString()); Add(item.SubmitTimeUtc.Ticks.ToString()); Add(item.Flags.ToString());
        Add("recipients:" + item.Recipients.Count);
        foreach (var r in item.Recipients) { Add(r.DisplayName); Add(r.EmailAddress); Add(r.AddressType); Add(r.RecipientType.ToString()); }
        Add("properties:" + item.Properties.Count);
        foreach (var property in item.Properties) { Add(property.PropId.ToString()); hash.AppendData(BitConverter.GetBytes(property.Data.Length)); hash.AppendData(property.Data); }
        byte[] buffer = new byte[64 * 1024];
        Add("attachments:" + item.Attachments.Count);
        foreach (var attachment in item.Attachments)
        {
            Add(attachment.FileName); Add(attachment.MimeType ?? ""); Add(attachment.ContentId ?? ""); Add(attachment.IsInline.ToString());
            Add(attachment.ContentLength.ToString());
            using var stream = attachment.OpenContent!();
            int count;
            while ((count = stream.Read(buffer, 0, buffer.Length)) > 0) hash.AppendData(buffer.AsSpan(0, count));
        }
        return Convert.ToHexString(hash.GetHashAndReset());
    }
    public void Dispose() { CloseSource(); output.Dispose(); seen.Clear(); }
}
