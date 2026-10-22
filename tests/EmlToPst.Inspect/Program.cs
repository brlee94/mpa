using System.Text.Json;
using XstReader;
using XstReader.ElementProperties;

if (args.Length != 1) return 2;
using var file = new XstFile(args[0]);
var messages = new List<object>();
void Walk(XstFolder folder, string parent)
{
    string folderPath = parent + "/" + folder.DisplayName;
    foreach (var message in folder.Messages)
    {
        var attachments = new List<object>();
        foreach (var attachment in message.Attachments)
        {
            var content = attachment.Properties[PropertyCanonicalName.PidTagAttachDataBinary]?.Value;
            attachments.Add(new { filename = attachment.LongFileName, cid = attachment.ContentId, content = content is byte[] bytes ? Convert.ToBase64String(bytes) : null });
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
Console.WriteLine(JsonSerializer.Serialize(messages));
return 0;
