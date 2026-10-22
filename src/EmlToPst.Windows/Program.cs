using EmlToPst.Core;

namespace EmlToPst.Windows;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length > 0)
        {
            // For repeatable Windows smoke checks. GUI remains the normal entry point.
            if (args.Length != 3 || args[0] != "--convert") return 2;
            try
            {
                var result = OutlookConverter.Convert(InputPlan.FromFolder(args[1], true), args[2], true,
                    CancellationToken.None, _ => { });
                return result.Failed == 0 && !result.Cancelled ? 0 : 1;
            }
            catch { return 1; }
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
        return 0;
    }
}
