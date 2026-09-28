/**
 * Reaps vitest processes that outlived the run that started them.
 *
 * Cancelling `npm test` — Ctrl-C in a terminal, or a tool stopping the shell it was
 * launched from — kills the shell, not the worker tree vitest forked. Each survivor keeps
 * a core at 100%, so the next run is slower than the last and the one after that slower
 * still. Eight of them were found on 2026-08-21, the oldest holding 3502 CPU-seconds
 * between them pegging nine of sixteen cores, which is what a "the test suite takes ten
 * minutes" afternoon actually was.
 *
 * Matches on the command line containing "vitest", never on the bare process name: this
 * must not touch the app, the tunnel client, or any other node the developer is running.
 * Its own pid is excluded, because this file's path contains "vitest" and the first version
 * of it duly killed itself before printing anything.
 */
import { execFileSync } from 'node:child_process';

function windowsVictims() {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
        "Where-Object { $_.CommandLine -like '*vitest*' } | " +
        'Select-Object -ExpandProperty ProcessId'
    ],
    { encoding: 'utf8' }
  );
  return out
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
}

function posixVictims() {
  let out = '';
  try {
    out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter((line) => line.includes('vitest'))
    .map((line) => Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
}

const victims = process.platform === 'win32' ? windowsVictims() : posixVictims();
if (victims.length === 0) {
  console.log('no stray vitest processes');
} else {
  let killed = 0;
  for (const pid of victims) {
    try {
      process.kill(pid, 'SIGKILL');
      killed++;
    } catch {
      // Already gone, or not ours to kill. Either way there is nothing to report.
    }
  }
  console.log(`killed ${killed} stray vitest process(es)`);
}
