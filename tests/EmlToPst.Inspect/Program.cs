using System.Text.Json;
using XstReader;
using XstReader.ElementProperties;

if (args.Length is < 1 or > 2 || (args.Length == 2 && args[1] is not ("--summary" or "--folders"))) return 2;
bool summary = args.Length == 2 && args[1] == "--summary";
bool foldersOnly = args.Length == 2 && args[1] == "--folders";
var folders = new List<string>();
using var file = new XstFile(args[0]);
var messages = new List<object>();
void Walk(XstFolder folder, string parent)
{
    string folderPath = parent + "/" + folder.DisplayName;
    folders.Add(folderPath);
    foreach (var message in foldersOnly ? Enumerable.Empty<XstMessage>() : folder.Messages)
    {
        var attachments = new List<object>();
        foreach (var attachment in message.Attachments)
        {
            // XstReader represents out-of-line binary properties as node IDs.
            // Its export API resolves both inline bytes and streamed subnodes.
            using var content = new MemoryStream();
            attachment.SaveToStream(content);
            byte[] bytes = content.GetBuffer();
            int length = checked((int)content.Length);
            attachments.Add(new
            {
                filename = attachment.LongFileName,
                cid = attachment.ContentId,
                content = !summary ? Convert.ToBase64String(bytes, 0, length) : null,
                size = content.Length,
                sha256 = summary ? Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes.AsSpan(0, length))).ToLowerInvariant() : null
            });
        }
        object? Get(PropertyCanonicalName property) => message.Properties[property]?.Value;
        messages.Add(new
        {
            folder = folderPath,
            subject = message.Subject,
            body = Get(PropertyCanonicalName.PidTagBody),
            html = Get(PropertyCanonicalName.PidTagHtml) is byte[] html ? System.Text.Encoding.UTF8.GetString(html) : null,
            sender = Get(PropertyCanonicalName.PidTagSenderEmailAddress),
            senderName = Get(PropertyCanonicalName.PidTagSenderName),
            sent = Get(PropertyCanonicalName.PidTagClientSubmitTime),
            received = Get(PropertyCanonicalName.PidTagMessageDeliveryTime),
            messageId = Get(PropertyCanonicalName.PidTagInternetMessageId),
            to = message.Recipients.To.Select(r => r.Address).ToArray(),
            cc = message.Recipients.Cc.Select(r => r.Address).ToArray(),
            bcc = message.Recipients.Bcc.Select(r => r.Address).ToArray(),
            attachments
        });
    }
    foreach (var child in folder.Folders) Walk(child, folderPath);
}
Walk(file.RootFolder, "");
Console.WriteLine(foldersOnly ? JsonSerializer.Serialize(folders) : JsonSerializer.Serialize(messages));
return 0;
