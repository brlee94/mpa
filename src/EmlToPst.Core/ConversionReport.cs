using System.Globalization;
using System.Text;

namespace EmlToPst.Core;

public sealed record ReportEntry(string Path, string Status, string Description, long? Size, string Output)
{
    public bool Saved => Status is "PST 저장 완료" or "이전 PST 저장 완료";
}

public static class ConversionReport
{
    // CSV is data only. Accept the old three-column report and the new extended report.
    public static IReadOnlyList<ReportEntry> Read(string csv)
    {
        var rows = Parse(csv.TrimStart('\ufeff'));
        if (rows.Count < 2 || rows[0].Length < 3 || rows[0][0] != "파일" || rows[0][1] != "결과" || rows[0][2] != "설명")
            throw new FormatException("이 변환기에서 저장한 변환결과.csv를 선택해 주세요.");
        bool extended = rows[0].Length >= 5 && rows[0][3] == "원본 바이트" && rows[0][4] == "저장 PST";
        var result = new List<ReportEntry>();
        foreach (var row in rows.Skip(1))
        {
            if (row.Length == 1 && row[0] == "") continue;
            if (row.Length < 3 || result.Count >= 1000) throw new FormatException("보고서 행 형식 또는 개수를 확인해 주세요.");
            long? size = null;
            if (extended)
            {
                if (row.Length < 5 || !long.TryParse(row[3], NumberStyles.None, CultureInfo.InvariantCulture, out long bytes) || bytes < 0)
                    throw new FormatException("보고서의 원본 파일 크기를 확인해 주세요.");
                size = bytes;
            }
            // Undo only the spreadsheet formula escape inserted by this app's exporter.
            string path = row[0];
            if (path.Length > 1 && path[0] == '\'' && "=+-@\t\r\n".Contains(path[1])) path = path[1..];
            result.Add(new(path, row[1], row[2], size, extended ? row[4] : ""));
        }
        if (result.Select(r => r.Path).Distinct(StringComparer.Ordinal).Count() != result.Count)
            throw new FormatException("동일한 경로가 중복된 보고서는 사용할 수 없습니다.");
        return result;
    }

    private static List<string[]> Parse(string csv)
    {
        var result = new List<string[]>();
        var row = new List<string>();
        var field = new StringBuilder();
        bool quoted = false, closed = false;
        for (int i = 0; i < csv.Length; i++)
        {
            char c = csv[i];
            if (quoted)
            {
                if (c == '"')
                {
                    if (i + 1 < csv.Length && csv[i + 1] == '"') { field.Append('"'); i++; }
                    else { quoted = false; closed = true; }
                }
                else field.Append(c);
            }
            else if (c == ',' || c is '\r' or '\n')
            {
                row.Add(field.ToString()); field.Clear(); closed = false;
                if (c != ',')
                {
                    result.Add(row.ToArray()); row.Clear();
                    if (c == '\r' && i + 1 < csv.Length && csv[i + 1] == '\n') i++;
                }
            }
            else if (c == '"' && field.Length == 0 && !closed) quoted = true;
            else
            {
                if (closed || c == '"') throw new FormatException("CSV 따옴표 형식이 올바르지 않습니다.");
                field.Append(c);
            }
        }
        if (quoted) throw new FormatException("CSV 따옴표가 닫히지 않았습니다.");
        if (field.Length > 0 || row.Count > 0 || closed) { row.Add(field.ToString()); result.Add(row.ToArray()); }
        return result;
    }

    public static string Escape(string text)
    {
        if (text.Length > 0 && "=+-@\t\r\n".Contains(text[0])) text = "'" + text;
        return "\"" + text.Replace("\"", "\"\"") + "\"";
    }
}
