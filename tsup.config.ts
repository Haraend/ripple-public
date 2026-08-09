import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
  minify: false,
  // Native / Node-bound packages must stay external so the Pi loads its own prebuilds.
  external: ['better-sqlite3', 'discord.js', '@discordjs/voice', 'drizzle-orm', 'pino'],
});
