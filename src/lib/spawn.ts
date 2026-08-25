import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export interface SpawnResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SpawnCapturedOptions {
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Called immediately after spawn so callers can track/kill the child. */
  readonly onSpawn?: (child: ChildProcess) => void;
}

export function spawnCaptured(
  command: string,
  args: readonly string[],
  options: SpawnCapturedOptions = {},
): Promise<SpawnResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise((resolve, reject) => {
    const child: ChildProcess = nodeSpawn(command, [...args], {
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    options.onSpawn?.(child);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill('SIGKILL');
      settled = true;
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}
