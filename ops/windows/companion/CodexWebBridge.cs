using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace CodexWeb {
  public sealed class Config {
    public string codexCommand { get; set; }
    public string[] workingDirectories { get; set; }
  }
  public static class Program {
    static readonly Encoding Utf8 = new UTF8Encoding(false, true);
    static readonly string PipeName = "codex-web-" + WindowsIdentity.GetCurrent().User.Value;
    static string LogPath;
    static readonly object LogLock = new object();
    public static int Main(string[] args) {
      try { return Run(args).GetAwaiter().GetResult(); }
      catch { Console.Error.WriteLine("CODEX_WEB_COMPANION_FAILED"); return 1; }
    }
    static async Task<int> Run(string[] args) {
      if (args.Length == 2 && args[0] == "--server") {
        var config = new JavaScriptSerializer().Deserialize<Config>(File.ReadAllText(args[1], Utf8));
        if (!File.Exists(config.codexCommand) || !config.codexCommand.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw new Exception();
        if (config.workingDirectories == null || config.workingDirectories.Length == 0) throw new Exception();
        LogPath = Path.Combine(Path.GetDirectoryName(args[1]), "companion.log");
        bool created;
        using (var mutex = new Mutex(true, "Local\\" + PipeName, out created)) {
          if (!created) return 0;
          Log("ready");
          var slots = new SemaphoreSlim(4);
          for (;;) {
            await slots.WaitAsync();
            NamedPipeServerStream pipe = null;
            try {
              pipe = CreateLocalPipe();
              await pipe.WaitForConnectionAsync();
              var owned = pipe;
              var task = Task.Run(async delegate { try { await Serve(owned, config); } finally { slots.Release(); } });
              GC.KeepAlive(task);
            } catch { if (pipe != null) pipe.Dispose(); slots.Release(); throw; }
          }
        }
      }
      if ((args.Length == 2 && args[0] == "--client") || (args.Length == 1 && args[0] == "--probe")) {
        using (var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous)) {
          await Task.Run(delegate { pipe.Connect(8000); });
          var line = args[0] == "--probe" ? "PING" : "CODEX1 " + args[1];
          await WriteLine(pipe, line);
          var reply = await ReadLine(pipe);
          if (reply != "OK") { Console.Error.WriteLine("CODEX_WEB_COMPANION_REJECTED"); return 2; }
          if (args[0] == "--probe") { Console.WriteLine("COMPANION_READY"); return 0; }
          // Read inherited byte handles directly. Framework Console streams use
          // console mode detection which is unreliable inside Windows OpenSSH.
          var input = new FileStream(new SafeFileHandle(GetStdHandle(-10), false), FileAccess.Read, 4096, false);
          var output = new FileStream(new SafeFileHandle(GetStdHandle(-11), false), FileAccess.Write, 4096, false);
          var upstream = Pump(input, pipe);
          var downstream = Pump(pipe, output);
          await Task.WhenAny(upstream, downstream);
          return 0;
        }
      }
      Console.Error.WriteLine("Usage: CodexWebBridge --server config.json | --client base64-cwd | --probe");
      return 2;
    }
    static async Task Serve(NamedPipeServerStream pipe, Config config) {
      IntPtr job = IntPtr.Zero;
      Process child = null;
      using (pipe) {
        try {
          var request = ReadLine(pipe);
          if (await Task.WhenAny(request, Task.Delay(8000)) != request) return;
          var line = await request;
          if (line == "PING") { await WriteLine(pipe, "OK"); return; }
          if (!line.StartsWith("CODEX1 ", StringComparison.Ordinal)) { await WriteLine(pipe, "ERR"); return; }
          var cwd = Path.GetFullPath(Utf8.GetString(Convert.FromBase64String(line.Substring(7))));
          bool allowed = false;
          foreach (var root in config.workingDirectories) {
            if (String.Equals(Path.GetFullPath(root).TrimEnd('\\'), cwd.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) allowed = true;
          }
          if (!allowed || !Directory.Exists(cwd)) { await WriteLine(pipe, "ERR"); return; }
          job = CreateJobObject(IntPtr.Zero, null);
          if (job == IntPtr.Zero) throw new Exception();
          var limit = new JobLimits();
          limit.BasicLimitInformation.LimitFlags = 0x00002000; // Kill the entire process tree on disconnect.
          int length = Marshal.SizeOf(typeof(JobLimits));
          var memory = Marshal.AllocHGlobal(length);
          try {
            Marshal.StructureToPtr(limit, memory, false);
            if (!SetInformationJobObject(job, 9, memory, (uint)length)) throw new Exception();
          } finally { Marshal.FreeHGlobal(memory); }
          child = new Process();
          child.StartInfo = new ProcessStartInfo {
            FileName = config.codexCommand, Arguments = "app-server --listen stdio://",
            WorkingDirectory = cwd, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
          };
          if (!child.Start() || !AssignProcessToJobObject(job, child.Handle)) throw new Exception();
          Log("started pid=" + child.Id);
          // Protocol bytes are never decoded, logged, or mixed with diagnostics.
          var stderr = Pump(child.StandardError.BaseStream, Stream.Null);
          await WriteLine(pipe, "OK");
          var upstream = Pump(pipe, child.StandardInput.BaseStream);
          var downstream = Pump(child.StandardOutput.BaseStream, pipe);
          var exited = Task.Run(delegate { child.WaitForExit(); });
          await Task.WhenAny(upstream, downstream, exited);
          GC.KeepAlive(stderr);
        } catch { Log("connection-failed"); }
        finally {
          if (job != IntPtr.Zero) CloseHandle(job);
          if (child != null) {
            try { if (!child.HasExited) child.Kill(); child.WaitForExit(3000); } catch {}
            child.Dispose();
          }
          Log("connection-closed");
        }
      }
    }
    static Task Pump(Stream source, Stream destination) {
      // Framework console/anonymous-pipe streams can block or buffer small frames.
      // Separate I/O threads and a flush per chunk preserve interactive JSONL traffic.
      return Task.Factory.StartNew(delegate {
        var buffer = new byte[65536];
        int count;
        while ((count = source.Read(buffer, 0, buffer.Length)) > 0) {
          destination.Write(buffer, 0, count);
          destination.Flush();
        }
      }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }
    static void Log(string message) {
      if (LogPath == null) return;
      lock(LogLock) {
        try {
          if (File.Exists(LogPath) && new FileInfo(LogPath).Length > 1048576) File.WriteAllText(LogPath, "");
          File.AppendAllText(LogPath, DateTime.UtcNow.ToString("O") + " " + message + Environment.NewLine);
        } catch {}
      }
    }
    static async Task<string> ReadLine(Stream stream) {
      var bytes = new MemoryStream();
      var one = new byte[1];
      while (bytes.Length < 8192) {
        int count = await stream.ReadAsync(one, 0, 1);
        if (count == 0) throw new EndOfStreamException();
        if (one[0] == 10) return Utf8.GetString(bytes.ToArray()).TrimEnd('\r');
        bytes.WriteByte(one[0]);
      }
      throw new InvalidDataException();
    }
    static Task WriteLine(Stream stream, string text) {
      var bytes = Utf8.GetBytes(text + "\n");
      return stream.WriteAsync(bytes, 0, bytes.Length);
    }
    static NamedPipeServerStream CreateLocalPipe() {
      IntPtr descriptor;
      uint size;
      var sid = WindowsIdentity.GetCurrent().User.Value;
      if (!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")", 1, out descriptor, out size)) throw new Exception();
      try {
        var attributes = new SecurityAttributes { nLength = Marshal.SizeOf(typeof(SecurityAttributes)), lpSecurityDescriptor = descriptor, bInheritHandle = false };
        // PIPE_REJECT_REMOTE_CLIENTS prevents SMB/network access even with valid OS credentials.
        var handle = CreateNamedPipe(@"\\.\pipe\" + PipeName, 0x40000003, 0x00000008, 4, 65536, 65536, 0, ref attributes);
        if (handle.IsInvalid) { handle.Dispose(); throw new Exception(); }
        return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
      } finally { LocalFree(descriptor); }
    }
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes { public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)]
    struct JobLimits { public BasicLimits BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint instances, uint outSize, uint inSize, uint timeout, ref SecurityAttributes attributes);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  }
}
