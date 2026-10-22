using MimeKit;
using MimeKit.Utils;

namespace EmlToPst.Core;

public static class EmlReader
{
    public static bool IsEml(string path) =>
        path.EndsWith(".eml", StringComparison.OrdinalIgnoreCase) ||
        path.EndsWith(".eml.15", StringComparison.OrdinalIgnoreCase);

    public static MimeMessage Read(string path)
    {
        using var stream = File.OpenRead(path);
        return Read(stream);
    }

    public static MimeMessage Read(Stream stream, bool persistent = false)
    {
        // Persistent parsing reuses the seekable input; callers must keep it open until
        // the message and all attachment reads are finished. File-path reads use copies.
        var message = MimeMessage.Load(stream, persistent);
        if (message.Headers.Count == 0 ||
            !message.Headers.Any(h => h.Id is HeaderId.From or HeaderId.To or
                HeaderId.Subject or HeaderId.Date or HeaderId.MessageId or HeaderId.MimeVersion))
        {
            message.Dispose();
            throw new FormatException("메일 헤더가 없는 파일입니다. 올바른 EML 파일인지 확인하세요.");
        }
        return message;
    }

    public static IEnumerable<MimeEntity> Attachments(MimeEntity? entity)
    {
        if (entity is null) yield break;
        if (entity is MessagePart)
        {
            yield return entity;
            yield break;
        }
        if (entity is Multipart multipart)
        {
            foreach (var child in multipart)
                foreach (var attachment in Attachments(child))
                    yield return attachment;
            yield break;
        }
        if (entity is MimePart part && (part.IsAttachment || part is not TextPart ||
            !string.IsNullOrEmpty(part.FileName) || !string.IsNullOrEmpty(part.ContentId)))
            yield return part;
    }

    public static string AttachmentName(MimeEntity entity, int index)
    {
        var name = entity is MimePart part ? part.FileName : entity.ContentDisposition?.FileName;
        name ??= entity.ContentType.Name;
        if (string.IsNullOrWhiteSpace(name)) name = entity is MessagePart ? "첨부메일.eml" : $"첨부파일-{index}";
        // MIME filenames are untrusted; never allow directory traversal on Windows or Unix.
        name = name.Replace('\\', '/').Split('/').Last();
        var invalid = "<>:\"/\\|?*";
        name = new string(name.Select(c => c < 32 || invalid.Contains(c) ? '_' : c).ToArray()).TrimEnd(' ', '.');
        if (string.IsNullOrEmpty(name)) name = $"첨부파일-{index}";
        string stem = name.Split('.')[0];
        if (new[] { "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9" }.Contains(stem, StringComparer.OrdinalIgnoreCase)) name = "_" + name;
        return name.Length > 150 ? name[..110] + Path.GetExtension(name)[..Math.Min(Path.GetExtension(name).Length, 20)] : name;
    }

    public static void SaveAttachment(MimeEntity entity, string path)
    {
        using var output = File.Create(path);
        WriteAttachment(entity, output);
    }

    public static void WriteAttachment(MimeEntity entity, Stream output)
    {
        switch (entity)
        {
            case MessagePart nested when nested.Message is not null: nested.Message.WriteTo(output); break;
            case MimePart part when part.Content is not null: part.Content.DecodeTo(output); break;
            case MessagePart or MimePart: throw new FormatException("첨부파일의 MIME 내용이 비어 있습니다.");
            default: throw new NotSupportedException("지원하지 않는 MIME 첨부 형식입니다.");
        }
    }

    public static DateTimeOffset? DeliveryTime(MimeMessage message)
    {
        // The top Received header is the latest receiving hop. Keep the original timezone instant.
        foreach (var header in message.Headers.Where(h => h.Id == HeaderId.Received))
        {
            int separator = header.Value.LastIndexOf(';');
            if (separator >= 0 && DateUtils.TryParse(header.Value[(separator + 1)..], out var date)) return date;
        }
        return message.Date == DateTimeOffset.MinValue ? null : message.Date;
    }
}
