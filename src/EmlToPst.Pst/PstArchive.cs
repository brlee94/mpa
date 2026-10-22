using EmlToPst.Core;
using MimeKit;
using PstBuilder.Foundation;
using PstBuilder.Ltp;
using PstBuilder.Messaging;

namespace EmlToPst.Pst;

public sealed class PstArchive : IDisposable
{
    public const long MaxInputBytes = 100L * 1024 * 1024;
    public const long MaxFileBytes = 25L * 1024 * 1024;
    public const int MaxFiles = 1000;
    private readonly LimitedMemoryStream stream = new(300L * 1024 * 1024);
    private readonly PstOutputStream output;
    private readonly StoreWriter writer = new() { StoreDisplayName = "가져온 메일" };
    private bool completed;

    public PstArchive()
    {
        output = new PstOutputStream(stream, leaveOpen: true);
        writer.Begin(output);
    }

    // Parsing completes before the store is changed. Invalid EML can be skipped safely.
    public static MessageItem Prepare(byte[] original, bool preserveOriginal)
    {
        using var input = new MemoryStream(original, writable: false);
        using var mime = EmlReader.Read(input);
        var from = mime.From.Mailboxes.FirstOrDefault() ?? mime.Sender;
        DateTime sent = mime.Date == DateTimeOffset.MinValue ? DateTime.UtcNow : mime.Date.UtcDateTime;
        DateTime received = EmlReader.DeliveryTime(mime)?.UtcDateTime ?? sent;
        if (sent.Year < 1601 || received.Year < 1601) throw new FormatException("PST에서 사용할 수 없는 날짜입니다.");
        var message = new MessageItem
        {
            Subject = mime.Subject ?? "",
            Body = mime.TextBody ?? "",
            BodyHtml = mime.HtmlBody,
            SenderName = string.IsNullOrEmpty(from?.Name) ? from?.Address ?? "" : from.Name,
            SenderEmail = from?.Address ?? "",
            DisplayTo = string.Join("; ", mime.To.Mailboxes.Select(m => string.IsNullOrEmpty(m.Name) ? m.Address : m.Name)),
            DeliveryTimeUtc = received,
            SubmitTimeUtc = sent,
            CreationTimeUtc = received,
            LastModificationTimeUtc = received,
            Flags = PropertyTags.MsgFlagRead
        };
        AddRecipients(message, mime.To, 1);
        AddRecipients(message, mime.Cc, 2);
        AddRecipients(message, mime.Bcc, 3);
        message.Properties.Add(Property.Unicode(0x007D, mime.Headers.ToString() ?? ""));
        message.Properties.Add(Property.Int32(0x3FDE, 65001)); // HTML bytes are UTF-8.
        message.Properties.Add(Property.Int32(0x3FFD, 65001));
        message.Properties.Add(Property.Unicode(0x0C1E, "SMTP"));
        message.Properties.Add(Property.Unicode(0x0064, "SMTP"));
        message.Properties.Add(Property.Unicode(0x5D01, message.SenderEmail));
        message.Properties.Add(Property.Unicode(0x5D02, message.SenderEmail));
        message.Properties.Add(Property.Unicode(0x0E03, string.Join("; ", mime.Cc.Mailboxes.Select(m => m.ToString()))));
        message.Properties.Add(Property.Unicode(0x0E02, string.Join("; ", mime.Bcc.Mailboxes.Select(m => m.ToString()))));
        if (!string.IsNullOrEmpty(mime.MessageId)) message.Properties.Add(Property.Unicode(0x1035, "<" + mime.MessageId + ">"));
        if (!string.IsNullOrEmpty(mime.InReplyTo)) message.Properties.Add(Property.Unicode(0x1042, "<" + mime.InReplyTo + ">"));
        if (mime.References.Count > 0) message.Properties.Add(Property.Unicode(0x1039, string.Join(" ", mime.References.Select(r => "<" + r + ">"))));
        if (mime.ReplyTo.Count > 0) message.Properties.Add(Property.Unicode(0x0050, string.Join("; ", mime.ReplyTo.Mailboxes.Select(m => m.Address))));
        int index = 0;
        foreach (var entity in EmlReader.Attachments(mime.Body))
        {
            using var data = new MemoryStream();
            EmlReader.WriteAttachment(entity, data);
            message.Attachments.Add(new AttachmentItem
            {
                FileName = EmlReader.AttachmentName(entity, ++index),
                Content = data.ToArray(),
                MimeType = entity.ContentType.MimeType,
                ContentId = entity.ContentId,
                IsInline = !entity.IsAttachment && !string.IsNullOrEmpty(entity.ContentId)
            });
        }
        if (preserveOriginal)
            message.Attachments.Add(new AttachmentItem { FileName = "원본.eml", Content = original, MimeType = "message/rfc822" });
        return message;
    }

    public void Add(MessageItem message, string folderPath)
    {
        if (completed) throw new InvalidOperationException("이미 완료된 PST입니다.");
        writer.AddMessage(writer.GetOrCreateFolder("가져온 메일/" + folderPath, "IPF.Note"), message);
    }

    public Stream Complete()
    {
        if (completed) throw new InvalidOperationException("이미 완료된 PST입니다.");
        writer.Complete();
        output.Flush();
        completed = true;
        stream.Position = 0;
        return stream;
    }

    private static void AddRecipients(MessageItem message, InternetAddressList list, int type)
    {
        foreach (var mailbox in list.Mailboxes)
            message.Recipients.Add(new RecipientItem
            {
                DisplayName = string.IsNullOrEmpty(mailbox.Name) ? mailbox.Address : mailbox.Name,
                EmailAddress = mailbox.Address,
                RecipientType = type
            });
    }

    public void Dispose() { output.Dispose(); stream.Dispose(); }
}

internal sealed class LimitedMemoryStream(long limit) : MemoryStream
{
    public override void Write(byte[] buffer, int offset, int count)
    {
        if (Position + count > limit) throw new IOException("결과가 브라우저 처리 한도(300MB)를 초과했습니다. 파일을 나누어 변환하세요.");
        base.Write(buffer, offset, count);
    }
}
