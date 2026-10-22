using System.Runtime.InteropServices;
using System.Text;
using EmlToPst.Core;
using MimeKit;

namespace EmlToPst.Windows;

public sealed record ConversionProgress(int Completed, int Total, int Succeeded, int Failed, string FileName);
public sealed record ConversionResult(int Succeeded, int Failed, bool Cancelled, string ReportPath, string? Warning);

// All Outlook calls stay on one STA thread. No Outlook interop installation is needed.
internal sealed class ComScope : IDisposable
{
    private readonly List<object> references = [];
    public dynamic Keep(object value)
    {
        if (Marshal.IsComObject(value) && !references.Any(r => ReferenceEquals(r, value))) references.Add(value);
        return value;
    }
    public void Dispose()
    {
        for (int i = references.Count - 1; i >= 0; i--)
            if (Marshal.IsComObject(references[i])) Marshal.ReleaseComObject(references[i]);
        references.Clear();
    }
}

public static class OutlookConverter
{
    private const string Schema = "http://schemas.microsoft.com/mapi/proptag/";
    public static bool OutlookInstalled => Type.GetTypeFromProgID("Outlook.Application") is not null;

    public static ConversionResult Convert(IReadOnlyList<InputMail> inputs, string destination,
        bool preserveOriginal, CancellationToken cancellation, Action<ConversionProgress> progress)
    {
        if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
            throw new InvalidOperationException("Outlook 변환은 STA 스레드에서 실행해야 합니다.");
        if (inputs.Count == 0) throw new ArgumentException("변환할 EML 파일이 없습니다.");
        destination = Path.GetFullPath(destination);
        if (!destination.EndsWith(".pst", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("저장 파일의 확장자는 .pst여야 합니다.");
        if (File.Exists(destination) || Directory.Exists(destination))
            throw new IOException("같은 이름의 파일이 이미 있습니다. 기존 PST를 보호하기 위해 새 파일 이름을 선택하세요.");
        if (!Directory.Exists(Path.GetDirectoryName(destination)))
            throw new DirectoryNotFoundException("PST를 저장할 폴더가 없습니다.");

        // Serialize this app's imports to the same path without reserving an invalid PST file.
        using var destinationLock = new FileStream(destination + ".emltopst.lock", FileMode.CreateNew,
            FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose);
        if (File.Exists(destination)) throw new IOException("같은 이름의 PST가 이미 생성되었습니다. 다른 이름을 선택하세요.");

        var outlookType = Type.GetTypeFromProgID("Outlook.Application") ??
            throw new InvalidOperationException("클래식 Outlook이 필요합니다. 새 Outlook만으로는 변환할 수 없습니다.");
        string reportPath = destination + "." + Guid.NewGuid().ToString("N")[..8] + ".conversion.csv";
        // Reserve a unique report without replacing existing files.
        using var report = new StreamWriter(new FileStream(reportPath, FileMode.CreateNew, FileAccess.Write), new UTF8Encoding(true));
        report.WriteLine("파일,결과,설명");
        report.Flush();
        using var com = new ComScope();
        dynamic app = com.Keep(Activator.CreateInstance(outlookType)!);
        dynamic session = com.Keep(app.GetNamespace("MAPI"));
        dynamic? root = null;
        string? warning = null;
        int succeeded = 0, failed = 0, completed = 0;
        bool cancelled = false;
        string temp = Path.Combine(Path.GetTempPath(), "EmlToPst-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        try
        {
            // olStoreUnicode = 2. Never attach an existing store or touch the default mailbox.
            session.AddStoreEx(destination, 2);
            dynamic stores = com.Keep(session.Stores);
            for (int i = 1; i <= (int)stores.Count; i++)
            {
                dynamic store = com.Keep(stores.Item(i));
                string? filePath = store.FilePath as string;
                if (!string.IsNullOrEmpty(filePath) &&
                    string.Equals(Path.GetFullPath(filePath), destination, StringComparison.OrdinalIgnoreCase))
                {
                    root = com.Keep(store.GetRootFolder());
                    break;
                }
            }
            if (root is null) throw new InvalidOperationException("새 PST 저장소를 찾지 못했습니다.");
            dynamic rootFolders = com.Keep(root.Folders);
            dynamic importRoot = com.Keep(rootFolders.Add("가져온 메일", 6)); // olFolderInbox
            var folders = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase) { [""] = importRoot };
            foreach (var input in inputs)
            {
                if (cancellation.IsCancellationRequested) { cancelled = true; break; }
                try
                {
                    dynamic folder = importRoot;
                    string key = "";
                    foreach (string segment in input.Folders)
                    {
                        key += "/" + segment;
                        if (!folders.TryGetValue(key, out object? cached))
                        {
                            dynamic children = com.Keep(folder.Folders);
                            folder = com.Keep(children.Add(segment, 6));
                            folders.Add(key, folder);
                        }
                        else folder = cached;
                    }
                    using var message = EmlReader.Read(input.Path);
                    Import(message, input.Path, folder, preserveOriginal, temp);
                    succeeded++;
                    report.WriteLine($"{Csv(input.Path)},성공,\"\"");
                }
                catch (Exception ex)
                {
                    failed++;
                    report.WriteLine($"{Csv(input.Path)},실패,{Csv(ex.Message)}");
                }
                report.Flush();
                completed++;
                progress(new(completed, inputs.Count, succeeded, failed, Path.GetFileName(input.Path)));
            }
        }
        finally
        {
            if (root is not null)
            {
                try { session.RemoveStore(root); }
                catch (COMException)
                {
                    warning = "PST가 Outlook에 연결된 상태입니다. Outlook에서 데이터 파일을 닫은 뒤 이동하세요.";
                }
            }
            try { Directory.Delete(temp, true); }
            catch (IOException) { warning = (warning is null ? "" : warning + " ") + "임시 첨부 폴더를 정리하지 못했습니다: " + temp; }
            catch (UnauthorizedAccessException) { warning = "임시 첨부 폴더를 정리하지 못했습니다: " + temp; }
            // Do not call Application.Quit: the user may already have Outlook open.
        }
        return new(succeeded, failed, cancelled, reportPath, warning);
    }

    private static void Import(MimeMessage message, string originalPath, dynamic folder,
        bool preserveOriginal, string tempRoot)
    {
        using var com = new ComScope();
        dynamic items = com.Keep(folder.Items);
        dynamic mail = com.Keep(items.Add("IPM.Note"));
        dynamic props = com.Keep(mail.PropertyAccessor);
        mail.Subject = message.Subject ?? "";
        if (message.HtmlBody is { } html) mail.HTMLBody = html;
        else mail.Body = message.TextBody ?? "";
        dynamic recipients = com.Keep(mail.Recipients);
        AddRecipients(message.To, 1, recipients, com);
        AddRecipients(message.Cc, 2, recipients, com);
        AddRecipients(message.Bcc, 3, recipients, com);
        if (message.ReplyTo.Count > 0)
        {
            dynamic replyRecipients = com.Keep(mail.ReplyRecipients);
            AddRecipients(message.ReplyTo, 1, replyRecipients, com);
        }
        var sender = message.Sender ?? message.From.Mailboxes.FirstOrDefault();
        if (sender is not null)
        {
            props.SetProperty(Schema + "0x0C1A001F", string.IsNullOrEmpty(sender.Name) ? sender.Address : sender.Name);
            props.SetProperty(Schema + "0x0C1E001F", "SMTP");
            props.SetProperty(Schema + "0x0C1F001F", sender.Address);
            props.SetProperty(Schema + "0x5D01001F", sender.Address);
        }
        var from = message.From.Mailboxes.FirstOrDefault() ?? sender;
        if (from is not null)
        {
            props.SetProperty(Schema + "0x0042001F", string.IsNullOrEmpty(from.Name) ? from.Address : from.Name);
            props.SetProperty(Schema + "0x0064001F", "SMTP");
            props.SetProperty(Schema + "0x0065001F", from.Address);
            props.SetProperty(Schema + "0x5D02001F", from.Address);
        }
        if (message.Date != DateTimeOffset.MinValue)
        {
            props.SetProperty(Schema + "0x00390040", message.Date.UtcDateTime); // client submit time
        }
        if (EmlReader.DeliveryTime(message) is { } delivered)
            props.SetProperty(Schema + "0x0E060040", delivered.UtcDateTime);
        if (!string.IsNullOrWhiteSpace(message.MessageId))
            props.SetProperty(Schema + "0x1035001F", "<" + message.MessageId + ">");
        props.SetProperty(Schema + "0x007D001F", message.Headers.ToString());
        // Set before first Save, clearing MSGFLAG_UNSENT so imported mail is not a draft.
        props.SetProperty(Schema + "0x0E070003", 1);
        dynamic attachments = com.Keep(mail.Attachments);
        string temp = Path.Combine(tempRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        try
        {
            int index = 0;
            foreach (var entity in EmlReader.Attachments(message.Body))
            {
                string name = EmlReader.AttachmentName(entity, ++index);
                string partFolder = Path.Combine(temp, index.ToString());
                Directory.CreateDirectory(partFolder);
                string file = Path.Combine(partFolder, name);
                EmlReader.SaveAttachment(entity, file);
                dynamic attachment = com.Keep(attachments.Add(file, 1, Type.Missing, name));
                if (!string.IsNullOrEmpty(entity.ContentId))
                {
                    dynamic attachProps = com.Keep(attachment.PropertyAccessor);
                    attachProps.SetProperty(Schema + "0x3712001F", entity.ContentId);
                    if (!entity.IsAttachment) attachProps.SetProperty(Schema + "0x7FFE000B", true);
                }
            }
            if (preserveOriginal) com.Keep(attachments.Add(originalPath, 1, Type.Missing, "원본.eml"));
            mail.Save();
        }
        finally
        {
            // Do not classify a saved email as failed just because local cleanup needs a retry.
            try { Directory.Delete(temp, true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private static void AddRecipients(InternetAddressList addresses, int type, dynamic recipients, ComScope com)
    {
        foreach (var mailbox in addresses.Mailboxes)
        {
            // Display names remain in the preserved MIME headers / original EML.
            dynamic recipient = com.Keep(recipients.Add(mailbox.Address));
            recipient.Type = type;
        }
    }

    private static string Csv(string text)
    {
        // Reports may be opened in Excel; don't allow filenames to become formulas.
        if (text.Length > 0 && "=+-@\t\r\n".Contains(text[0])) text = "'" + text;
        return "\"" + text.Replace("\"", "\"\"") + "\"";
    }
}
