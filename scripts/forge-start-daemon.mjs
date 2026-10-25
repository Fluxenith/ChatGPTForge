import { Console } from 'node:console';
import { appendFileSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const state = resolve(process.argv[2]);
const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '../runtime');
const stderrPath = join(state, 'stderr.log');
const stdout = createWriteStream(join(state, 'stdout.log'), { flags: 'a' });
const stderr = createWriteStream(stderrPath, { flags: 'a' });
globalThis.console = new Console({ stdout, stderr });
// ShellExecute does not redirect handles. The coordinator owns its own logs.
process.on('uncaughtExceptionMonitor', error => appendFileSync(stderrPath, String(error.stack ?? error) + '\n'));
process.env.CHATGPTFORGE_CONFIG_DIR = state;
process.env.CHATGPTFORGE_MANAGER_PORT = process.argv[3] ?? '8768';
const entrypoint = join(runtime, 'dist', 'forge-cli.js');
process.argv = [process.execPath, entrypoint, 'serve'];
try {
  await import(pathToFileURL(entrypoint).href);
} catch (error) {
  appendFileSync(stderrPath, String(error.stack ?? error) + '\n');
  process.exitCode = 1;
}
