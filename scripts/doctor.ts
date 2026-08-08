import { getCiphers } from 'node:crypto';
import { loadDotEnv } from '../src/config/load-dotenv.js';
import { spawnCaptured } from '../src/lib/spawn.js';

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly fatal: boolean;
}

async function checkBinary(name: string, command: string, args: string[]): Promise<CheckResult> {
  try {
    const result = await spawnCaptured(command, args, { timeoutMs: 10_000 });
    if (result.code === 0 || result.stdout.length > 0 || result.stderr.length > 0) {
      const versionLine = (result.stdout || result.stderr).split(/\r?\n/)[0]?.trim() ?? 'ok';
      return { name, ok: true, detail: versionLine, fatal: false };
    }
    return {
      name,
      ok: false,
      detail: `exited with code ${result.code}`,
      fatal: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name, ok: false, detail: message, fatal: false };
  }
}

async function main(): Promise<void> {
  loadDotEnv();

  const ffmpegPath = process.env['FFMPEG_PATH'] ?? 'ffmpeg';
  const ytdlpPath = process.env['YTDLP_PATH'] ?? 'yt-dlp';

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const checks: CheckResult[] = [
    {
      name: 'node',
      ok: nodeMajor >= 24,
      detail: `v${process.versions.node} (need >= 24)`,
      fatal: true,
    },
    {
      name: 'aes-256-gcm',
      ok: getCiphers().includes('aes-256-gcm'),
      detail: getCiphers().includes('aes-256-gcm')
        ? 'available via node:crypto'
        : 'missing — voice encryption may need an extra library',
      fatal: true,
    },
    await checkBinary('ffmpeg', ffmpegPath, ['-version']),
    await checkBinary('yt-dlp', ytdlpPath, ['--version']),
  ];

  let failedFatal = false;
  for (const check of checks) {
    const icon = check.ok ? 'OK' : check.fatal ? 'FAIL' : 'WARN';
    console.log(`[${icon}] ${check.name}: ${check.detail}`);
    if (!check.ok && check.fatal) {
      failedFatal = true;
    }
  }

  if (failedFatal) {
    process.exitCode = 1;
    return;
  }

  console.log('Doctor finished. Missing ffmpeg/yt-dlp are warnings until you need voice/music.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
