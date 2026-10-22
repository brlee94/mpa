using EmlToPst.Core;

namespace EmlToPst.Windows;

public sealed class MainForm : Form
{
    private readonly TextBox source = new() { ReadOnly = true, Dock = DockStyle.Fill };
    private readonly TextBox destination = new() { ReadOnly = true, Dock = DockStyle.Fill };
    private readonly CheckBox recursive = new() { Text = "하위 폴더 포함 (폴더 구조 유지)", Checked = true, AutoSize = true };
    private readonly CheckBox originals = new() { Text = "원본 EML도 각 메일에 첨부하여 보존 (용량 증가)", Checked = true, AutoSize = true };
    private readonly Button chooseFolder = new() { Text = "폴더 선택", AutoSize = true };
    private readonly Button chooseFiles = new() { Text = "파일 선택", AutoSize = true };
    private readonly Button chooseOutput = new() { Text = "저장 위치", AutoSize = true };
    private readonly Button start = new() { Text = "PST 변환 시작", AutoSize = true, Padding = new Padding(12, 5, 12, 5) };
    private readonly Button stop = new() { Text = "중지", Enabled = false, AutoSize = true };
    private readonly ProgressBar bar = new() { Dock = DockStyle.Fill };
    private readonly Label status = new() { Text = "EML 폴더 또는 파일을 선택하세요.", AutoSize = true, MaximumSize = new Size(660, 0) };
    private string[]? selectedFiles;
    private string? selectedFolder;
    private CancellationTokenSource? cancellation;
    private bool running;

    public MainForm()
    {
        Text = "EML → PST 변환기";
        Font = new Font("Malgun Gothic", 10);
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(760, 470);
        MinimumSize = new Size(650, 480);
        StartPosition = FormStartPosition.CenterScreen;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), ColumnCount = 1, RowCount = 12 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Controls.Add(layout);
        layout.Controls.Add(new Label { Text = "EML 메일을 Outlook PST로", Font = new Font(Font.FontFamily, 18, FontStyle.Bold), AutoSize = true });
        layout.Controls.Add(new Label { Text = "Windows 10/11 · 클래식 Outlook 및 기본 프로필 필요 · 관리자 권한 불필요", AutoSize = true, Margin = new Padding(0, 8, 0, 18) });
        layout.Controls.Add(new Label { Text = "1. 원본 메일 (.eml / .eml.15)", AutoSize = true });
        layout.Controls.Add(Row(source, chooseFolder, chooseFiles));
        layout.Controls.Add(recursive);
        layout.Controls.Add(new Label { Text = "2. 새 PST 파일", AutoSize = true, Margin = new Padding(0, 12, 0, 0) });
        layout.Controls.Add(Row(destination, chooseOutput));
        layout.Controls.Add(originals);
        layout.Controls.Add(new Label { Text = "원본 파일과 기존 PST는 수정하지 않습니다. 실패 파일은 CSV 보고서에 기록됩니다.", AutoSize = true, Margin = new Padding(0, 8, 0, 8) });
        layout.Controls.Add(Row(null, start, stop));
        bar.Height = 20;
        layout.Controls.Add(bar);
        layout.Controls.Add(status);
        chooseFolder.Click += (_, _) =>
        {
            using var dialog = new FolderBrowserDialog { Description = "EML 파일이 있는 폴더", UseDescriptionForTitle = true };
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            selectedFolder = dialog.SelectedPath;
            selectedFiles = null;
            source.Text = selectedFolder;
            recursive.Enabled = true;
            SetDefaultOutput();
        };
        chooseFiles.Click += (_, _) =>
        {
            using var dialog = new OpenFileDialog { Filter = "EML 메일|*.eml;*.eml.15", Multiselect = true, Title = "변환할 EML 선택" };
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            selectedFiles = dialog.FileNames;
            selectedFolder = null;
            source.Text = selectedFiles.Length == 1 ? selectedFiles[0] : $"{selectedFiles.Length:N0}개 파일 선택";
            recursive.Enabled = false;
            SetDefaultOutput();
        };
        chooseOutput.Click += (_, _) =>
        {
            using var dialog = new SaveFileDialog { Filter = "Outlook 데이터 파일|*.pst", DefaultExt = "pst", FileName = Path.GetFileName(destination.Text), Title = "새 PST 저장 위치" };
            if (dialog.ShowDialog(this) == DialogResult.OK) destination.Text = dialog.FileName;
        };
        start.Click += (_, _) => BeginConversion();
        stop.Click += (_, _) =>
        {
            cancellation?.Cancel();
            stop.Enabled = false;
            status.Text = "현재 메일 처리 후 중지합니다. 완료된 메일은 PST에 남습니다.";
        };
        FormClosing += (_, e) =>
        {
            if (!running) return;
            e.Cancel = true;
            cancellation?.Cancel();
            status.Text = "현재 메일을 마친 뒤 종료할 수 있습니다. 완료된 PST는 보존됩니다.";
        };
        Shown += (_, _) =>
        {
            if (!OutlookConverter.OutlookInstalled)
            {
                status.Text = "클래식 Outlook이 감지되지 않았습니다. 이 버전은 클래식 Outlook이 설치된 PC에서 사용할 수 있습니다.";
                start.Enabled = false;
            }
        };
    }

    private static TableLayoutPanel Row(Control? field, params Button[] buttons)
    {
        var row = new TableLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, ColumnCount = buttons.Length + 1, Margin = new Padding(0, 5, 0, 5) };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        if (field is not null) row.Controls.Add(field, 0, 0);
        for (int i = 0; i < buttons.Length; i++)
        {
            row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            row.Controls.Add(buttons[i], i + 1, 0);
        }
        return row;
    }

    private void SetDefaultOutput()
    {
        if (destination.Text.Length == 0)
            destination.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), $"변환메일-{DateTime.Now:yyyyMMdd-HHmmss}.pst");
        status.Text = "준비되었습니다. 저장 위치를 확인한 뒤 변환을 시작하세요.";
    }

    private void SetRunning(bool value)
    {
        running = value;
        foreach (var control in new Control[] { chooseFolder, chooseFiles, chooseOutput, originals, recursive, start }) control.Enabled = !value;
        recursive.Enabled = !value && selectedFiles is null;
        stop.Enabled = value;
    }

    private void BeginConversion()
    {
        if (selectedFolder is null && selectedFiles is null)
        {
            MessageBox.Show(this, "원본 EML 폴더 또는 파일을 선택하세요.", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        // Capture every UI value before starting the worker (no cross-thread control access).
        string? folder = selectedFolder;
        string[]? files = selectedFiles;
        string output = destination.Text;
        bool includeSubfolders = recursive.Checked, preserveOriginal = originals.Checked;
        cancellation?.Dispose();
        cancellation = new CancellationTokenSource();
        var token = cancellation.Token;
        SetRunning(true);
        bar.Value = 0;
        status.Text = "EML 목록과 Outlook을 준비하고 있습니다…";
        var worker = new Thread(() =>
        {
            try
            {
                var inputs = files is null ? InputPlan.FromFolder(folder!, includeSubfolders) : InputPlan.FromFiles(files);
                var result = OutlookConverter.Convert(inputs, output, preserveOriginal, token, progress =>
                    BeginInvoke(() =>
                    {
                        bar.Maximum = progress.Total;
                        bar.Value = progress.Completed;
                        status.Text = $"{progress.Completed:N0}/{progress.Total:N0} · 성공 {progress.Succeeded:N0} · 실패 {progress.Failed:N0}\n{progress.FileName}";
                    }));
                BeginInvoke(() =>
                {
                    SetRunning(false);
                    string summary = $"{(result.Cancelled ? "중지됨" : "처리 완료")} · 성공 {result.Succeeded:N0} · 실패 {result.Failed:N0}";
                    status.Text = summary;
                    MessageBox.Show(this, summary + "\n\nPST: " + output + "\n보고서: " + result.ReportPath +
                        (result.Warning is null ? "" : "\n\n" + result.Warning) +
                        "\n\nOutlook의 ‘파일 → 열기 및 내보내기 → Outlook 데이터 파일 열기’에서 결과를 확인하세요.",
                        Text, MessageBoxButtons.OK, result.Failed > 0 || result.Cancelled ? MessageBoxIcon.Warning : MessageBoxIcon.Information);
                });
            }
            catch (Exception ex)
            {
                BeginInvoke(() =>
                {
                    SetRunning(false);
                    status.Text = "변환을 완료하지 못했습니다.";
                    MessageBox.Show(this, ex.Message + "\n\n클래식 Outlook에서 기본 프로필이 열리는지 확인하세요. 이미 생성된 PST가 있다면 새 이름을 선택하세요.",
                        Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                });
            }
        }) { IsBackground = true, Name = "Outlook STA import" };
        worker.SetApartmentState(ApartmentState.STA);
        worker.Start();
    }
}
