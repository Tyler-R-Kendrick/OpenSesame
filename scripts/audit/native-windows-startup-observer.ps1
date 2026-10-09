param([Parameter(Mandatory = $true)][string]$Binary)
$ErrorActionPreference = 'Stop'

# A second execution of the exact failed executable; the original gate stays failed.
# No stack-size setting, replacement runtime, symbol server, or environment override.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
public static class NativeStartupObserver {
    const uint Continue = 0x00010002, NotHandled = 0x80010001;
    const uint StackOverflow = 0xC00000FD, Breakpoint = 0x80000003;
    const uint Symbols = 0x02081706; // Local path, ignore _NT_SYMBOL_PATH, no symsrv discovery.

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort Show, ReservedBytes;
        public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    public sealed class Frame {
        public string Address, StackAddress, ModuleBase, ModuleRelativeAddress;
        public string Symbol, SymbolDisplacement;
    }
    public sealed class Observation {
        public string Qualification = "Second unchanged --version diagnostic execution; original gate result remains authoritative.";
        public string SymbolQualification = "Local DbgHelp resolution only; nearest symbol plus displacement is not an inferred source function.";
        public uint ProcessId, ThreadId, FirstChance, ExitCode;
        public bool SawStackOverflow, SawExit, SymbolsInitialized, TimedOut;
        public string ExceptionAddress, InstructionPointer, StackPointer, FramePointer;
        public string ThreadStackBase, ThreadStackLimit, MainModuleBase;
        public int ContextError, StackWalkError, ThreadBoundsError, SymbolInitializationError;
        public List<Frame> Frames = new List<Frame>();
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string app, System.Text.StringBuilder command,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
        uint flags, IntPtr environment, string directory, ref StartupInfo start,
        out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WaitForDebugEventEx(IntPtr debugEvent, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ContinueDebugEvent(uint process, uint thread, uint status);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint status);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DebugActiveProcessStop(uint process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenThread(uint access, bool inherit, uint thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetThreadContext(IntPtr thread, IntPtr context);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] bytes,
        UIntPtr size, out UIntPtr read);
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationThread(IntPtr thread, int infoClass,
        IntPtr info, uint bytes, out uint returned);
    [DllImport("dbghelp.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SymInitializeW(IntPtr process, string path, bool invade);
    [DllImport("dbghelp.dll", SetLastError = true)]
    static extern bool SymCleanup(IntPtr process);
    [DllImport("dbghelp.dll")]
    static extern uint SymSetOptions(uint options);
    [DllImport("dbghelp.dll", SetLastError = true)]
    static extern bool SymFromAddr(IntPtr process, ulong address, out ulong offset,
        IntPtr symbol);
    [DllImport("dbghelp.dll", SetLastError = true)]
    static extern ulong SymGetModuleBase64(IntPtr process, ulong address);
    [DllImport("dbghelp.dll", SetLastError = true)]
    static extern IntPtr SymFunctionTableAccess64(IntPtr process, ulong address);
    delegate IntPtr FunctionTable(IntPtr process, ulong address);
    delegate ulong ModuleBase(IntPtr process, ulong address);
    [DllImport("dbghelp.dll", SetLastError = true)]
    static extern bool StackWalk64(uint machine, IntPtr process, IntPtr thread,
        IntPtr frame, IntPtr context, IntPtr readMemory, FunctionTable functions,
        ModuleBase modules, IntPtr translate);

    static string Hex(ulong value) { return "0x" + value.ToString("x"); }
    static ulong U64(IntPtr pointer, int offset) {
        return unchecked((ulong)Marshal.ReadInt64(pointer, offset));
    }
    static void Zero(IntPtr pointer, int bytes) {
        Marshal.Copy(new byte[bytes], 0, pointer, bytes);
    }
    static void Bounds(IntPtr process, IntPtr thread, Observation result) {
        IntPtr info = Marshal.AllocHGlobal(48);
        try {
            uint returned;
            int status = NtQueryInformationThread(thread, 0, info, 48, out returned);
            if (status != 0 || returned != 48) {
                result.ThreadBoundsError = status;
                return;
            }
            byte[] tib = new byte[24];
            UIntPtr read;
            if (!ReadProcessMemory(process, Marshal.ReadIntPtr(info, 8), tib,
                new UIntPtr(24), out read) || read.ToUInt64() != 24) {
                result.ThreadBoundsError = Marshal.GetLastWin32Error();
                return;
            }
            result.ThreadStackBase = Hex(BitConverter.ToUInt64(tib, 8));
            result.ThreadStackLimit = Hex(BitConverter.ToUInt64(tib, 16));
        } finally { Marshal.FreeHGlobal(info); }
    }
    static Frame Resolve(IntPtr process, ulong address, ulong stack) {
        ulong module = SymGetModuleBase64(process, address);
        Frame result = new Frame {
            Address = Hex(address), StackAddress = Hex(stack), ModuleBase = Hex(module),
            ModuleRelativeAddress = module == 0 ? null : Hex(address - module)
        };
        IntPtr symbol = Marshal.AllocHGlobal(1112);
        try {
            Zero(symbol, 1112);
            Marshal.WriteInt32(symbol, 0, 88); // sizeof(SYMBOL_INFO), x64.
            Marshal.WriteInt32(symbol, 80, 1024);
            ulong offset;
            if (SymFromAddr(process, address, out offset, symbol)) {
                int length = Marshal.ReadInt32(symbol, 76);
                if (length >= 0 && length < 1024)
                    result.Symbol = Marshal.PtrToStringAnsi(IntPtr.Add(symbol, 84), length);
                result.SymbolDisplacement = Hex(offset);
            }
        } finally { Marshal.FreeHGlobal(symbol); }
        return result;
    }
    static void Capture(IntPtr process, uint threadId, Observation result) {
        IntPtr thread = OpenThread(0x48, false, threadId);
        if (thread == IntPtr.Zero) {
            result.ContextError = Marshal.GetLastWin32Error();
            return;
        }
        IntPtr allocation = Marshal.AllocHGlobal(1248);
        IntPtr context = new IntPtr((allocation.ToInt64() + 15) & ~15L);
        IntPtr frame = Marshal.AllocHGlobal(1024);
        try {
            Zero(context, 1232);
            Marshal.WriteInt32(context, 48, 0x10000B); // AMD64 CONTEXT_FULL.
            if (!GetThreadContext(thread, context)) {
                result.ContextError = Marshal.GetLastWin32Error();
                return;
            }
            ulong pc = U64(context, 248), stack = U64(context, 152), bp = U64(context, 160);
            result.InstructionPointer = Hex(pc);
            result.StackPointer = Hex(stack);
            result.FramePointer = Hex(bp);
            Bounds(process, thread, result);
            result.Frames.Add(Resolve(process, pc, stack));
            Zero(frame, 1024);
            Marshal.WriteInt64(frame, 0, unchecked((long)pc));
            Marshal.WriteInt32(frame, 12, 3); // AddrModeFlat.
            Marshal.WriteInt64(frame, 32, unchecked((long)bp));
            Marshal.WriteInt32(frame, 44, 3);
            Marshal.WriteInt64(frame, 48, unchecked((long)stack));
            Marshal.WriteInt32(frame, 60, 3);
            FunctionTable functions = SymFunctionTableAccess64;
            ModuleBase modules = SymGetModuleBase64;
            var seen = new HashSet<string>();
            seen.Add(Hex(pc) + ":" + Hex(stack));
            for (int index = 0; index < 64; index++) {
                if (!StackWalk64(0x8664, process, thread, frame, context, IntPtr.Zero,
                    functions, modules, IntPtr.Zero)) {
                    result.StackWalkError = Marshal.GetLastWin32Error();
                    break;
                }
                pc = U64(frame, 0); stack = U64(frame, 48);
                if (pc == 0) break;
                string identity = Hex(pc) + ":" + Hex(stack);
                if (!seen.Add(identity)) {
                    if (index == 0) continue;
                    break;
                }
                result.Frames.Add(Resolve(process, pc, stack));
            }
            GC.KeepAlive(functions); GC.KeepAlive(modules);
        } finally {
            Marshal.FreeHGlobal(frame); Marshal.FreeHGlobal(allocation); CloseHandle(thread);
        }
    }
    public static Observation Observe(string binary) {
        if (IntPtr.Size != 8) throw new InvalidOperationException("An actual x64 observer is required.");
        binary = Path.GetFullPath(binary);
        if (!File.Exists(binary) || binary.IndexOf('"') >= 0)
            throw new InvalidOperationException("Invalid original executable path.");
        StartupInfo startup = new StartupInfo();
        startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfo));
        ProcessInfo child;
        // DEBUG_ONLY_THIS_PROCESS; zero env pointer inherits the unchanged environment.
        if (!CreateProcessW(binary, new System.Text.StringBuilder("\"" + binary + "\" --version"),
            IntPtr.Zero, IntPtr.Zero, false, 2, IntPtr.Zero, null, ref startup, out child))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        var result = new Observation { ProcessId = child.ProcessId };
        IntPtr debugEvent = Marshal.AllocHGlobal(192);
        bool loaderBreakpoint = true;
        Stopwatch time = Stopwatch.StartNew();
        try {
            while (time.ElapsedMilliseconds < 45000 && !result.SawExit) {
                Zero(debugEvent, 192);
                if (!WaitForDebugEventEx(debugEvent, 250)) {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 121) continue; // ERROR_SEM_TIMEOUT.
                    throw new Win32Exception(error);
                }
                uint code = unchecked((uint)Marshal.ReadInt32(debugEvent, 0));
                uint processId = unchecked((uint)Marshal.ReadInt32(debugEvent, 4));
                uint threadId = unchecked((uint)Marshal.ReadInt32(debugEvent, 8));
                uint disposition = Continue;
                if (code == 3) result.MainModuleBase = Hex(U64(debugEvent, 40));
                if (code == 3 || code == 6) {
                    IntPtr file = Marshal.ReadIntPtr(debugEvent, 16);
                    if (file != IntPtr.Zero && file != new IntPtr(-1)) CloseHandle(file);
                }
                if (code == 1) {
                    uint exception = unchecked((uint)Marshal.ReadInt32(debugEvent, 16));
                    disposition = NotHandled;
                    if (exception == Breakpoint && loaderBreakpoint) {
                        loaderBreakpoint = false; disposition = Continue;
                    }
                    if (exception == StackOverflow && !result.SawStackOverflow) {
                        result.SawStackOverflow = true; result.ThreadId = threadId;
                        result.FirstChance = unchecked((uint)Marshal.ReadInt32(debugEvent, 168));
                        result.ExceptionAddress = Hex(U64(debugEvent, 32));
                        SymSetOptions(Symbols);
                        result.SymbolsInitialized = SymInitializeW(child.Process, Path.GetDirectoryName(binary), true);
                        if (!result.SymbolsInitialized)
                            result.SymbolInitializationError = Marshal.GetLastWin32Error();
                        Capture(child.Process, threadId, result);
                    }
                }
                if (code == 5) {
                    result.SawExit = true;
                    result.ExitCode = unchecked((uint)Marshal.ReadInt32(debugEvent, 16));
                }
                if (!ContinueDebugEvent(processId, threadId, disposition))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            result.TimedOut = !result.SawExit;
            return result;
        } finally {
            if (!result.SawExit) {
                TerminateProcess(child.Process, 0xDEAD);
                DebugActiveProcessStop(child.ProcessId);
            }
            if (result.SymbolsInitialized) SymCleanup(child.Process);
            Marshal.FreeHGlobal(debugEvent);
            CloseHandle(child.Thread); CloseHandle(child.Process);
        }
    }
}
'@

[NativeStartupObserver]::Observe($Binary) | ConvertTo-Json -Depth 8
