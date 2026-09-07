# Only receives process IDs already checked against the fixed package, owner and session.
function Initialize-DesktopWindow {
    if ('CodexWeb.DesktopWindow' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace CodexWeb {
    public static class DesktopWindow {
        private delegate bool EnumWindowsProc(IntPtr window, IntPtr unused);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr unused);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr window);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
        [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        public static IntPtr Find(int[] processIds) {
            var allowed = new HashSet<int>(processIds);
            IntPtr found = IntPtr.Zero, foreground = GetForegroundWindow();
            EnumWindows((window, unused) => {
                uint processId;
                GetWindowThreadProcessId(window, out processId);
                if (!allowed.Contains((int)processId) || GetWindow(window, 4) != IntPtr.Zero ||
                    GetWindowTextLength(window) == 0) return true;
                if (found == IntPtr.Zero || window == foreground) found = window;
                return window != foreground;
            }, IntPtr.Zero);
            return found;
        }
    }
}
'@
}
function Show-DesktopWindow([int[]]$ProcessIds) {
    Initialize-DesktopWindow
    $window=[CodexWeb.DesktopWindow]::Find($ProcessIds)
    if ($window -eq [IntPtr]::Zero) { return $null }
    $null=[CodexWeb.DesktopWindow]::ShowWindowAsync($window,3)
    $null=[CodexWeb.DesktopWindow]::SetForegroundWindow($window)
    Start-Sleep -Milliseconds 150
    if (-not [CodexWeb.DesktopWindow]::IsWindowVisible($window) -or -not [CodexWeb.DesktopWindow]::IsZoomed($window)) { return $null }
    return @{foreground=([CodexWeb.DesktopWindow]::GetForegroundWindow() -eq $window)}
}
