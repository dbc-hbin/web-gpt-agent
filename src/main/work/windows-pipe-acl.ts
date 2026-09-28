/**
 * The Windows named pipe's access control, which Node's IPC listener cannot express.
 *
 * The control socket is a same-user boundary. On POSIX that boundary is a filesystem fact: a
 * 0600 socket inside a 0700 directory, checked by `assertPrivateSocket`. On Windows there is
 * no file to check, and the boundary Node creates by default is *not* the same-user one.
 *
 * Windows gives a named pipe a default security descriptor whenever `CreateNamedPipe` is
 * passed NULL attributes — which is exactly what libuv does (`src/win/pipe.c`,
 * `pipe_alloc_accept`: `CreateNamedPipeW(handle->name, …, NULL)`), and Node exposes no way to
 * pass a descriptor of its own. Per Microsoft's *Named Pipe Security and Access Rights*: "The
 * ACLs in the default security descriptor for a named pipe grant full control to the
 * LocalSystem account, administrators, and the creator owner. They also grant read access to
 * members of the Everyone group and the anonymous account." So on a machine with more than
 * one account, any other logged-in user can enumerate `\\.\pipe\wgpt-*`, open one with
 * `GENERIC_READ` — a documented, permitted request against a `PIPE_ACCESS_DUPLEX` pipe — and
 * hold it. Sixteen such handles fill the host's whole client budget before a single `hello`
 * is sent, and none of them needs the installation id, the descriptor or the token.
 *
 * So the pipe is tightened immediately after it starts listening and *before* the descriptor
 * that tells a CLI where to find it is published. The tightening is:
 *
 *   - a **protected** DACL — no inherited entries, so nothing the parent namespace would have
 *     contributed survives;
 *   - containing **exactly one** entry: an allow for this process token's user SID with
 *     `FILE_ALL_ACCESS`. The owner needs `FILE_CREATE_PIPE_INSTANCE` (part of that mask) for
 *     libuv to create the pipe's further instances. There is deliberately no Everyone,
 *     Authenticated Users or anonymous entry, and `uv_pipe_chmod`/`readableAll`/`writableAll`
 *     are never used, because those *widen* the descriptor rather than narrow it;
 *   - **read back and verified** — protected, non-null, one entry, an allow entry, that mask,
 *     that SID. A descriptor that cannot be confirmed is treated as absent.
 *
 * Every failure is fatal and happens before `runtime.json` is written: a host that cannot
 * prove its pipe is private must not publish a rendezvous file pointing at it. The caller
 * closes the listener on the way out, so a failed startup leaves nothing listening.
 *
 * The descriptor belongs to the named pipe *object*, not to one instance, and this fix depends
 * on that: libuv creates its further instances with NULL attributes, so if a later instance
 * could re-derive the default descriptor the pipe would reopen. Two sources support the
 * shared-object reading. Microsoft's `CreateNamedPipe` remarks distinguish creating a new pipe
 * from creating an instance of an existing one — "If a new named pipe is being created, the
 * access control list (ACL) from the security attributes parameter defines the discretionary
 * access control for the named pipe" — and state that creating an instance requires
 * `FILE_CREATE_PIPE_INSTANCE` on the existing object, i.e. an access check against it rather
 * than a redefinition of it. Microsoft's own `go-winio` library relies on exactly this: its
 * `makeServerPipeHandle` comments "The security descriptor is only needed for the first pipe"
 * and passes the descriptor only when `first` is true, with `makeServerPipe` (every later
 * instance) passing nil.
 *
 * That is source support, not native verification: there is no Windows host in this checkout,
 * so the behaviour is not executed here. The ordering below is what keeps the residual risk
 * bounded regardless — connections accepted while the default descriptor was still in force
 * are dropped before the ACL is trusted, and the descriptor that was verified is the one the
 * published endpoint has.
 *
 * This is deliberately not `runPowerShell` from `exec.ts`. That helper exists for
 * model-supplied scripts, with a script-length bound and a working directory; this script is
 * app-owned, larger than that bound, and must run before any user-facing state exists. It is
 * instead invoked via a UTF-8 BOM file passed with `-File` and child-scoped
 * `-ExecutionPolicy Bypass`, without dragging the exec surface into the CLI bundle
 * (which also imports `control-socket.js`).
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A failure to establish or verify the pipe's access control.
 *
 * Deliberately its own type rather than the control socket's error: this module is called by
 * `control-socket.ts`, and importing back from it would make the two modules circular. The
 * caller converts this into its own error at the boundary, where the control protocol's
 * vocabulary lives.
 */
export class PipeAclError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipeAclError';
  }
}

/** The shell that ships with every supported Windows version. */
const POWERSHELL_CANDIDATES: readonly string[] = ['powershell.exe', 'pwsh.exe'];
const MAX_PIPE_ACL_OUTPUT_BYTES = 8 * 1024;
const PIPE_ACL_TIMEOUT_MS = 20_000;

/**
 * The Win32 program that narrows a named pipe to its owner.
 *
 * `Restrict` returns the user SID's string form on success and throws `PIPE_ACL_FAILED: …` on
 * every failure, so a caller can never mistake a partial job for a finished one. Written in
 * C# rather than PowerShell so the Win32 calls, their error codes and the verification are
 * all in one place; `Add-Type` is the same mechanism the computer-use helper uses.
 *
 * This checkout has no Windows host and no C# compiler, so the source below is reviewed but
 * not compiled here. What is exercised without Windows is the contract every caller depends
 * on: a SID comes back only when the narrowing is confirmed, everything else is an error, and
 * the host treats that error as fatal before it publishes the endpoint.
 */
const WINDOWS_PIPE_ACL_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;

public static class CosControlPipeAcl {
  const int SE_KERNEL_OBJECT = 6;
  const uint DACL_SECURITY_INFORMATION = 0x00000004;
  const uint PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
  const uint READ_CONTROL = 0x00020000;
  const uint WRITE_DAC = 0x00040000;
  const uint OPEN_EXISTING = 3;
  const uint TOKEN_QUERY = 0x0008;
  const int TokenUser = 1;
  const uint SET_ACCESS = 2;
  const uint NO_INHERITANCE = 0;
  const uint TRUSTEE_IS_SID = 0;
  const uint TRUSTEE_IS_USER = 1;
  const uint FILE_ALL_ACCESS = 0x001F01FF;
  const ushort SE_DACL_PRESENT = 0x0004;
  const ushort SE_DACL_PROTECTED = 0x1000;
  const int AclSizeInformation = 2;
  const byte ACCESS_ALLOWED_ACE_TYPE = 0x00;
  const int ERROR_PIPE_BUSY = 231;
  const int ATTEMPTS = 40;
  const int RETRY_MS = 25;

  [StructLayout(LayoutKind.Sequential)]
  struct TRUSTEE {
    public IntPtr pMultipleTrustee;
    public uint MultipleTrusteeOperation;
    public uint TrusteeForm;
    public uint TrusteeType;
    public IntPtr ptstrName;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct EXPLICIT_ACCESS {
    public uint grfAccessPermissions;
    public uint grfAccessMode;
    public uint grfInheritance;
    public TRUSTEE Trustee;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct ACL_SIZE_INFORMATION {
    public uint AceCount;
    public uint AclBytesInUse;
    public uint AclBytesFree;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr attributes, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, uint length, out uint needed);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern uint SetEntriesInAclW(uint count, ref EXPLICIT_ACCESS entries, IntPtr oldAcl, out IntPtr newAcl);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern uint SetSecurityInfo(IntPtr handle, int objectType, uint securityInfo, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern uint GetSecurityInfo(IntPtr handle, int objectType, uint securityInfo, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetSecurityDescriptorControl(IntPtr descriptor, out ushort control, out uint revision);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetAclInformation(IntPtr acl, out ACL_SIZE_INFORMATION info, uint length, int infoClass);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetAce(IntPtr acl, uint index, out IntPtr ace);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool EqualSid(IntPtr first, IntPtr second);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);

  static System.Exception Failed(string what, uint code) {
    uint error = code != 0 ? code : (uint)Marshal.GetLastWin32Error();
    return new System.InvalidOperationException("PIPE_ACL_FAILED: " + what + " failed (win32 " + error + ")");
  }

  // A handle to the running pipe, used only to change and read its descriptor. Opening it
  // connects one instance as a client; the host drops that connection, which is why the
  // caller must not publish the endpoint until this has returned.
  static IntPtr Connect(string pipeName) {
    for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
      IntPtr handle = CreateFileW(pipeName, READ_CONTROL | WRITE_DAC, 0, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
      if (handle != new IntPtr(-1)) return handle;
      if (Marshal.GetLastWin32Error() != ERROR_PIPE_BUSY) throw Failed("CreateFile on the control pipe", 0);
      System.Threading.Thread.Sleep(RETRY_MS);
    }
    throw new System.InvalidOperationException("PIPE_ACL_FAILED: the control pipe stayed busy");
  }

  static IntPtr UserSid(IntPtr token) {
    uint needed = 0;
    GetTokenInformation(token, TokenUser, IntPtr.Zero, 0, out needed);
    if (needed == 0) throw Failed("GetTokenInformation", 0);
    IntPtr info = Marshal.AllocHGlobal((int)needed);
    if (!GetTokenInformation(token, TokenUser, info, needed, out needed)) {
      Marshal.FreeHGlobal(info);
      throw Failed("GetTokenInformation", 0);
    }
    IntPtr sid = Marshal.ReadIntPtr(info, 0);
    if (sid == IntPtr.Zero) {
      Marshal.FreeHGlobal(info);
      throw new System.InvalidOperationException("PIPE_ACL_FAILED: the process token has no user SID");
    }
    // The SID lives inside the token buffer, which the caller frees; copy it into its own
    // allocation so verification cannot read freed memory.
    int length = 8 + 4 * Marshal.ReadByte(sid, 1);
    IntPtr copy = Marshal.AllocHGlobal(length);
    for (int at = 0; at < length; at++) Marshal.WriteByte(copy, at, Marshal.ReadByte(sid, at));
    Marshal.FreeHGlobal(info);
    return copy;
  }

  static void Verify(IntPtr handle, IntPtr expectedSid) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint status = GetSecurityInfo(handle, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, out owner, out group, out dacl, out sacl, out descriptor);
    if (status != 0 || descriptor == IntPtr.Zero) throw Failed("GetSecurityInfo", status);
    try {
      ushort control;
      uint revision;
      if (!GetSecurityDescriptorControl(descriptor, out control, out revision)) throw Failed("GetSecurityDescriptorControl", 0);
      if ((control & SE_DACL_PRESENT) == 0) throw new System.InvalidOperationException("PIPE_ACL_FAILED: the control pipe has no DACL");
      if ((control & SE_DACL_PROTECTED) == 0) throw new System.InvalidOperationException("PIPE_ACL_FAILED: the control pipe's DACL still inherits entries");
      if (dacl == IntPtr.Zero) throw new System.InvalidOperationException("PIPE_ACL_FAILED: the control pipe has a null DACL, which grants everyone full access");
      ACL_SIZE_INFORMATION size;
      if (!GetAclInformation(dacl, out size, (uint)Marshal.SizeOf(typeof(ACL_SIZE_INFORMATION)), AclSizeInformation)) throw Failed("GetAclInformation", 0);
      if (size.AceCount != 1) throw new System.InvalidOperationException("PIPE_ACL_FAILED: the control pipe's DACL holds " + size.AceCount + " entries, not one");
      IntPtr ace;
      if (!GetAce(dacl, 0, out ace)) throw Failed("GetAce", 0);
      if (Marshal.ReadByte(ace, 0) != ACCESS_ALLOWED_ACE_TYPE) throw new System.InvalidOperationException("PIPE_ACL_FAILED: the control pipe's only entry is not an allow entry");
      if ((uint)Marshal.ReadInt32(ace, 4) != FILE_ALL_ACCESS) throw new System.InvalidOperationException("PIPE_ACL_FAILED: the control pipe's only entry is not FILE_ALL_ACCESS");
      if (!EqualSid(new IntPtr(ace.ToInt64() + 8), expectedSid)) throw new System.InvalidOperationException("PIPE_ACL_FAILED: the control pipe's only entry is not this user");
    } finally {
      LocalFree(descriptor);
    }
  }

  public static string Restrict(string pipeName) {
    if (pipeName == null || pipeName.Trim().Length == 0) throw new System.InvalidOperationException("PIPE_ACL_FAILED: no pipe name was given");
    IntPtr token = IntPtr.Zero;
    IntPtr sid = IntPtr.Zero;
    IntPtr newAcl = IntPtr.Zero;
    IntPtr handle = IntPtr.Zero;
    IntPtr text = IntPtr.Zero;
    try {
      if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token)) throw Failed("OpenProcessToken", 0);
      sid = UserSid(token);

      EXPLICIT_ACCESS entry = new EXPLICIT_ACCESS();
      entry.grfAccessPermissions = FILE_ALL_ACCESS;
      entry.grfAccessMode = SET_ACCESS;
      entry.grfInheritance = NO_INHERITANCE;
      entry.Trustee.pMultipleTrustee = IntPtr.Zero;
      entry.Trustee.MultipleTrusteeOperation = 0;
      entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
      entry.Trustee.TrusteeType = TRUSTEE_IS_USER;
      entry.Trustee.ptstrName = sid;
      uint aclError = SetEntriesInAclW(1, ref entry, IntPtr.Zero, out newAcl);
      if (aclError != 0 || newAcl == IntPtr.Zero) throw Failed("SetEntriesInAcl", aclError);

      handle = Connect(pipeName);
      uint status = SetSecurityInfo(handle, SE_KERNEL_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        IntPtr.Zero, IntPtr.Zero, newAcl, IntPtr.Zero);
      if (status != 0) throw Failed("SetSecurityInfo", status);

      Verify(handle, sid);
      if (!ConvertSidToStringSidW(sid, out text)) throw Failed("ConvertSidToStringSidW", 0);
      return Marshal.PtrToStringUni(text);
    } finally {
      if (text != IntPtr.Zero) LocalFree(text);
      if (handle != IntPtr.Zero) CloseHandle(handle);
      if (newAcl != IntPtr.Zero) LocalFree(newAcl);
      if (sid != IntPtr.Zero) Marshal.FreeHGlobal(sid);
      if (token != IntPtr.Zero) CloseHandle(token);
    }
  }
}
`;

export interface PipeAclOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs one ACL script and reports what it printed.
 *
 * Injected in tests so the fail-closed ordering can be exercised without a Windows host; the
 * default is the real PowerShell invocation.
 */
export type PipeAclRunner = (script: string) => Promise<PipeAclOutput>;

/** Quotes a value as a PowerShell single-quoted literal. */
function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The script that restricts one pipe.
 *
 * The C# program above, the pipe name as a PowerShell single-quoted literal, and the single
 * call that runs it. Not exported: what a caller depends on is `restrictControlPipeToOwner`'s
 * outcome, and a test that pinned this text would be asserting the implementation rather than
 * the behaviour.
 */
function pipeAclScript(pipeName: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    // Non-ASCII never appears here, but the reply is read as UTF-8 like every other child.
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "Add-Type -TypeDefinition @'",
    WINDOWS_PIPE_ACL_SOURCE,
    "'@",
    `[Console]::Out.Write([CosControlPipeAcl]::Restrict(${powerShellLiteral(pipeName)}))`
  ].join('\n');
}

function spawnOnce(shell: string, args: string[]): Promise<PipeAclOutput> {
  return new Promise<PipeAclOutput>((resolve, reject) => {
    const child = spawn(shell, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ exitCode: child.exitCode, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`${shell} did not finish the control pipe ACL within ${PIPE_ACL_TIMEOUT_MS}ms`));
    }, PIPE_ACL_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(0, MAX_PIPE_ACL_OUTPUT_BYTES);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(0, MAX_PIPE_ACL_OUTPUT_BYTES);
    });
    child.on('error', (error) => finish(error));
    child.on('close', () => finish());
  });
}

/**
 * Runs the script from a temporary file rather than an `-EncodedCommand`.
 *
 * The same choice the computer-use helper makes, for the same reason: the Win32 source is
 * ~19 KB of UTF-16, and a command line is the wrong place for it — base64 would sit within a
 * few kilobytes of the 32,767-character limit, and inherited environment blocks are worse
 * still. A BOM makes Windows PowerShell 5.1 read the file as UTF-8 regardless of the machine's
 * ANSI code page, and `-ExecutionPolicy Bypass` is scoped to this one child.
 */
async function runPipeAclScript(script: string): Promise<PipeAclOutput> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wgpt-pipe-acl-'));
  const file = path.join(directory, 'pipe-acl.ps1');
  try {
    await fs.writeFile(file, `\uFEFF${script}`, 'utf8');
    let lastError: unknown = null;
    for (const shell of POWERSHELL_CANDIDATES) {
      try {
        return await spawnOnce(shell, [
          '-NoProfile',
          '-NonInteractive',
          '-NoLogo',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          file
        ]);
      } catch (error) {
        // ENOENT here means this shell is not on the machine; the next candidate may be.
        lastError = error;
      }
    }
    throw new PipeAclError(
      `no PowerShell could run the control pipe ACL: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Narrows a running Windows named pipe to the user that owns this process.
 *
 * Resolves with the SID the pipe now allows, and throws `PipeAclError` for every other
 * outcome: a non-zero exit, a shell that never ran, output that does not name the SID it
 * restricted to, or a verification failure inside the script. There is no partial success —
 * the caller publishes its endpoint only after this resolves.
 */
export async function restrictControlPipeToOwner(
  pipeName: string,
  run: PipeAclRunner = runPipeAclScript
): Promise<string> {
  if (process.platform !== 'win32' && run === runPipeAclScript) {
    // The real runner is a Windows program; reaching here on another platform is a wiring
    // bug, not a condition to work around.
    throw new PipeAclError('the control pipe ACL is a Windows-only step');
  }
  const output = await run(pipeAclScript(pipeName));
  const sid = output.stdout.trim();
  if (output.exitCode !== 0) {
    const detail = output.stderr.trim() || `exit code ${String(output.exitCode)}`;
    throw new PipeAclError(`the control pipe could not be restricted to this user: ${detail}`);
  }
  // A script that printed nothing did not report a SID, so it did not finish the job even
  // though it exited zero. Treating that as success is how a pipe stays open by accident.
  if (!/^S-1-[0-9-]+$/.test(sid)) {
    throw new PipeAclError(
      `the control pipe ACL reported no owner SID (${JSON.stringify(sid.slice(0, 120))})`
    );
  }
  return sid;
}
