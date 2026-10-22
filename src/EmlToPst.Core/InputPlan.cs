namespace EmlToPst.Core;

public sealed record InputMail(string Path, string[] Folders);

public static class InputPlan
{
    public static List<InputMail> FromFolder(string root, bool recursive)
    {
        root = Path.GetFullPath(root);
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = recursive,
            IgnoreInaccessible = false,
            AttributesToSkip = FileAttributes.ReparsePoint,
            MatchCasing = MatchCasing.CaseInsensitive
        };
        return Directory.EnumerateFiles(root, "*", options)
            .Where(EmlReader.IsEml)
            .OrderBy(p => p, StringComparer.OrdinalIgnoreCase)
            .Select(path => new InputMail(path,
                Path.GetRelativePath(root, Path.GetDirectoryName(path)!) is "." ? [] :
                Path.GetRelativePath(root, Path.GetDirectoryName(path)!).Split(Path.DirectorySeparatorChar)))
            .ToList();
    }

    public static List<InputMail> FromFiles(IEnumerable<string> paths) => paths
        .Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase)
        .OrderBy(p => p, StringComparer.OrdinalIgnoreCase)
        .Select(path => EmlReader.IsEml(path) ? new InputMail(path, []) :
            throw new ArgumentException($"EML 파일이 아닙니다: {Path.GetFileName(path)}"))
        .ToList();
}
