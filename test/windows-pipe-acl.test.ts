/**
 * The Windows control pipe's access-control contract.
 *
 * Node's IPC listener cannot express a security descriptor: libuv calls `CreateNamedPipeW`
 * with NULL attributes, and Windows then applies the default descriptor, which grants read
 * access to Everyone and the anonymous account. So the host narrows the running pipe itself
 * and refuses to publish its endpoint unless that succeeded.
 *
 * What is asserted here is that refusal contract, not the Win32 program that implements it:
 * the program needs Windows, which this checkout does not have. The behaviour that can be
 * exercised is what every caller depends on — a SID only comes back when the narrowing is
 * confirmed, and every other outcome is an error the host treats as fatal.
 */

import { describe, expect, it } from 'vitest';
import { restrictControlPipeToOwner, PipeAclError } from '../src/main/work/windows-pipe-acl.js';

const PIPE = '\\\\.\\pipe\\wgpt-fixture';

describe('Windows control pipe access control', () => {
  it('reports a failure instead of a SID when the ACL could not be established', async () => {
    await expect(
      restrictControlPipeToOwner(PIPE, async () => ({ exitCode: 1, stdout: '', stderr: 'PIPE_ACL_FAILED: denied' }))
    ).rejects.toThrow(/denied/);
    // A shell that never ran is not a success either.
    await expect(restrictControlPipeToOwner(PIPE, async () => ({ exitCode: null, stdout: '', stderr: '' }))).rejects.toThrow(
      PipeAclError
    );
  });

  it('treats exit zero without a confirmed SID as failure, not success', async () => {
    // This is the dangerous shape: the script ran but reported nothing proving what the pipe
    // now allows. Answering "done" here is how a pipe stays open by accident.
    await expect(restrictControlPipeToOwner(PIPE, async () => ({ exitCode: 0, stdout: '', stderr: '' }))).rejects.toThrow(
      /no owner SID/
    );
    await expect(
      restrictControlPipeToOwner(PIPE, async () => ({ exitCode: 0, stdout: 'Everyone', stderr: '' }))
    ).rejects.toThrow(/no owner SID/);
  });

  it('returns the SID the narrowing was confirmed against', async () => {
    await expect(
      restrictControlPipeToOwner(PIPE, async () => ({ exitCode: 0, stdout: 'S-1-5-21-1-2-3-1001\n', stderr: '' }))
    ).resolves.toBe('S-1-5-21-1-2-3-1001');
  });

  it('refuses to claim success from the real Windows program on a platform that cannot run it', async () => {
    // The default runner is a Windows program. Being asked for it elsewhere is a wiring bug,
    // and reporting success would leave a pipe that was never narrowed.
    if (process.platform === 'win32') return;
    await expect(restrictControlPipeToOwner(PIPE)).rejects.toThrow(PipeAclError);
  });
});
