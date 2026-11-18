// Runs a command on a separate Windows desktop that is never shown, so the app's window, its
// file dialogs and anything else it opens stay off the user's screen and never take the
// keyboard away from what the user is doing.
//
//   rc-hidden-desktop.exe <desktop name> <program> [arguments...]
//
// The command inherits this process's standard input, output and error, and everything it
// starts lands on the same desktop. The exit code is the command's. When this launcher ends
// (or is killed), everything it started is ended with it.
//
// Compiled on first use by e2e/lib/hidden.mjs with the C# compiler that ships with Windows.

using System;
using System.Runtime.InteropServices;
using System.Text;

static class RcHiddenDesktop {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public int dwProcessId, dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr security);
  [DllImport("user32.dll")]
  static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string app, StringBuilder commandLine, IntPtr processSecurity, IntPtr threadSecurity, bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]
  static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObjectW(IntPtr security, string name);
  [DllImport("kernel32.dll")]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
  [DllImport("kernel32.dll")]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  // The quoting rule the C runtime (and so Node, Rust and most programs) reads arguments by.
  static string Quote(string arg) {
    if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
    var s = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in arg) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { s.Append('\\', slashes * 2 + 1); s.Append('"'); slashes = 0; continue; }
      s.Append('\\', slashes); slashes = 0; s.Append(c);
    }
    s.Append('\\', slashes * 2);
    s.Append('"');
    return s.ToString();
  }

  static int Main(string[] args) {
    if (args.Length < 2) {
      Console.Error.WriteLine("usage: rc-hidden-desktop <desktop name> <program> [arguments...]");
      return 2;
    }
    const uint GENERIC_ALL = 0x10000000;
    IntPtr desktop = CreateDesktopW(args[0], IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
    if (desktop == IntPtr.Zero) {
      Console.Error.WriteLine("rc-hidden-desktop: could not create the desktop (error " + Marshal.GetLastWin32Error() + ")");
      return 3;
    }

    var commandLine = new StringBuilder();
    for (int i = 1; i < args.Length; i++) {
      if (i > 1) commandLine.Append(' ');
      commandLine.Append(Quote(args[i]));
    }

    var startup = new STARTUPINFO();
    startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    startup.lpDesktop = "WinSta0\\" + args[0];
    startup.dwFlags = 0x100; // STARTF_USESTDHANDLES
    startup.hStdInput = GetStdHandle(-10);
    startup.hStdOutput = GetStdHandle(-11);
    startup.hStdError = GetStdHandle(-12);

    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job != IntPtr.Zero) {
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
    }

    PROCESS_INFORMATION info;
    const uint CREATE_SUSPENDED = 0x4;
    if (!CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED, IntPtr.Zero, null, ref startup, out info)) {
      Console.Error.WriteLine("rc-hidden-desktop: could not start " + args[1] + " (error " + Marshal.GetLastWin32Error() + ")");
      CloseDesktop(desktop);
      return 4;
    }
    if (job != IntPtr.Zero) AssignProcessToJobObject(job, info.hProcess);
    ResumeThread(info.hThread);
    CloseHandle(info.hThread);

    WaitForSingleObject(info.hProcess, 0xFFFFFFFF);
    uint code;
    if (!GetExitCodeProcess(info.hProcess, out code)) code = 1;
    CloseHandle(info.hProcess);
    if (job != IntPtr.Zero) CloseHandle(job);
    CloseDesktop(desktop);
    return unchecked((int)code);
  }
}
