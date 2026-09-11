using System;
using System.IO;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

// This owns an unnamed Job Object, never a process found by title/name.
public sealed class PreviewWindow : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO { public int cb; public IntPtr reserved, desktop, title; public int x,y,cx,cy,xChars,yChars,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; public override string ToString() { return Left+","+Top+","+Right+","+Bottom; } }
    delegate bool EnumCallback(IntPtr window, IntPtr arg);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr ps, IntPtr ts, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXTENDED_LIMIT limits,int size);
    [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr job,int kind,out ACCOUNTING info,int size,IntPtr length);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback,IntPtr arg);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out RECT rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window,out RECT rect);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window,int attribute,out RECT rect,int size);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    IntPtr job = IntPtr.Zero;
    public PreviewWindow(string executable, string[] args, string cwd) {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Exception("PREVIEW_LAUNCH");
        EXTENDED_LIMIT limits=new EXTENDED_LIMIT(); limits.basic.flags=0x2000;
        if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) { Dispose(); throw new Exception("PREVIEW_LAUNCH"); }
        var command=new StringBuilder(Quote(executable)); foreach(var arg in args) command.Append(" ").Append(Quote(arg));
        var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(typeof(STARTUPINFO)); PROCESS_INFORMATION pi;
        // Suspended launch prevents a child escaping before ownership has been established.
        if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,cwd,ref si,out pi)) { Dispose(); throw new Exception("PREVIEW_LAUNCH"); }
        try { if(!AssignProcessToJobObject(job,pi.process) || ResumeThread(pi.thread)==0xffffffff) { TerminateProcess(pi.process,1); throw new Exception("PREVIEW_LAUNCH"); } }
        catch { Dispose(); throw; } finally { CloseHandle(pi.thread); CloseHandle(pi.process); }
    }
    public static string Quote(string value) {
        var b=new StringBuilder("\""); int slashes=0;
        foreach(char c in value) { if(c=='\\') { slashes++; continue; } if(c=='\"') { b.Append('\\',slashes*2+1).Append(c); slashes=0; continue; } b.Append('\\',slashes).Append(c); slashes=0; }
        return b.Append('\\',slashes*2).Append('"').ToString();
    }
    public bool Alive { get { ACCOUNTING info; return job!=IntPtr.Zero && QueryInformationJobObject(job,1,out info,Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero) && info.active>0; } }
    public bool Owns(IntPtr window) {
        uint pid; GetWindowThreadProcessId(window,out pid); var process=OpenProcess(0x1000,false,pid);
        if(process==IntPtr.Zero) return false;
        try { bool result; return IsProcessInJob(process,job,out result) && result; } finally { CloseHandle(process); }
    }
    public IntPtr Find() {
        IntPtr best=IntPtr.Zero; long area=0;
        EnumWindows(delegate(IntPtr window,IntPtr ignored) { RECT r; if(IsWindowVisible(window) && !IsIconic(window) && Owns(window) && GetClientRect(window,out r)) { long size=(long)(r.Right-r.Left)*(r.Bottom-r.Top); if(size>area && size>1024) { best=window; area=size; } } return true; },IntPtr.Zero);
        return best;
    }
    public string Bounds(IntPtr window) { RECT r; return Owns(window) && GetWindowRect(window,out r) ? r.ToString() : ""; }
    public string Capture(IntPtr window,string destination,bool desktopCrop) {
        var task=Task.Factory.StartNew(delegate {
            // PrintWindow paints DPI-unaware applications in their logical coordinates.
            // Match its window context so buffer bounds and WM_PRINT use the same units.
            // Explicit desktop crops instead require physical multi-monitor coordinates.
            SetThreadDpiAwarenessContext(desktopCrop ? new IntPtr(-4) : GetWindowDpiAwarenessContext(window));
            if(!Owns(window) || !IsWindowVisible(window) || IsIconic(window)) return "PREVIEW_WINDOW";
            RECT r; if(!GetWindowRect(window,out r)) return "PREVIEW_WINDOW";
            if(desktopCrop) { RECT frame; if(DwmGetWindowAttribute(window,9,out frame,Marshal.SizeOf(typeof(RECT)))==0) r=frame;
                int x=GetSystemMetrics(76),y=GetSystemMetrics(77); r.Left=Math.Max(r.Left,x); r.Top=Math.Max(r.Top,y); r.Right=Math.Min(r.Right,x+GetSystemMetrics(78)); r.Bottom=Math.Min(r.Bottom,y+GetSystemMetrics(79)); }
            int w=r.Right-r.Left,h=r.Bottom-r.Top; if(w<32 || h<32 || w>8192 || h>8192 || (long)w*h>32000000) return "PREVIEW_BOUNDS";
            using(var bitmap=new Bitmap(w,h,PixelFormat.Format32bppArgb)) {
                using(var graphics=Graphics.FromImage(bitmap)) {
                    graphics.Clear(Color.Magenta);
                    if(desktopCrop) graphics.CopyFromScreen(r.Left,r.Top,0,0,new Size(w,h));
                    else { var dc=graphics.GetHdc(); bool ok; try { ok=PrintWindow(window,dc,0); } finally { graphics.ReleaseHdc(dc); } if(!ok) return "PREVIEW_CAPTURE"; }
                }
                if(!Owns(window)) return "PREVIEW_WINDOW";
                // Reject constant/blank buffers; a valid window normally contains multiple tones.
                int first=bitmap.GetPixel(w/2,h/2).ToArgb(), varied=0;
                for(int y=8;y<h-8;y+=Math.Max(1,h/32)) for(int x=8;x<w-8;x+=Math.Max(1,w/32)) if(bitmap.GetPixel(x,y).ToArgb()!=first) varied++;
                if(varied<5) return "PREVIEW_BLANK";
                using(var memory=new MemoryStream()) { bitmap.Save(memory,ImageFormat.Png); if(memory.Length>8388608) return "PREVIEW_SIZE"; File.WriteAllBytes(destination+".tmp",memory.ToArray()); }
                File.Move(destination+".tmp",destination);
                return "";
            }
        });
        if(!task.Wait(5000)) return "PREVIEW_CAPTURE_TIMEOUT";
        return task.Result;
    }
    public void Dispose() { if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; } }
}
