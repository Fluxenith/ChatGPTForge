import {lstat, mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {isPathInsideRoot} from './roots.js';
import {captureGoTree, goHash, readGoInput, verifyGoTree, type GoTree} from './go-project.js';

interface Entry {
  owned: string;
  parent: string;
  identity: {dev: number; ino: number; birthtimeMs: number};
  root: string;
  version: string;
  tree?: GoTree;
  key?: string;
  references: number;
  retired: boolean;
}

export interface GoToolchainLease {
  tree: GoTree;
  key: string;
  verifyCached(signal?: AbortSignal): Promise<void>;
  release(): Promise<void>;
}
export type GoToolchainPhase='toolchain_capture'|'toolchain_source_verify'|'toolchain_cache_verify';

// Only directories created by this instance are tracked. Never sweep old temp
// directories: an interrupted process or a host-rejected cleanup is not ours.
export class GoToolchainCache {
  private readonly entries = new Set<Entry>();
  private active?: Entry;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly idleWaiters = new Set<() => void>();

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  private retire(entry: Entry) {
    entry.retired = true;
    if (this.active === entry) this.active = undefined;
  }

  private async prune() {
    for (const entry of this.entries) {
      if (!entry.retired || entry.references) continue;
      let stat;
      try { stat = await lstat(entry.owned); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.entries.delete(entry);
        continue;
      }
      const canonical = await realpath(entry.owned);
      if (stat.isSymbolicLink() || !stat.isDirectory() || canonical !== entry.owned ||
          !isPathInsideRoot(canonical, entry.parent) ||
          stat.dev !== entry.identity.dev || stat.ino !== entry.identity.ino ||
          stat.birthtimeMs !== entry.identity.birthtimeMs) {
        throw new Error('Refusing cleanup of a changed Go toolchain cache directory');
      }
      await rm(entry.owned, {recursive: true, force: true, maxRetries: 5, retryDelay: 50});
      this.entries.delete(entry);
    }
  }

  private check(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('Go toolchain cache is closed');
  }

  acquire(root: string, version: string, signal?: AbortSignal, onPhase?: (phase:GoToolchainPhase)=>void): Promise<GoToolchainLease> {
    return this.serialize(async () => {
      this.check(signal);
      const canonical = await realpath(root);
      if (canonical.toLowerCase() !== resolve(root).toLowerCase()) throw new Error('Go toolchain cache refuses aliased roots');
      const currentVersion = (await readGoInput(join(root, 'VERSION'), 1024, signal)).toString('utf8').split(/\r?\n/)[0];
      if (currentVersion !== version) throw new Error('Go toolchain version changed; inspect again');
      await this.prune();
      if (this.active && (this.active.root !== canonical || this.active.version !== version)) this.retire(this.active);
      await this.prune();
      let entry = this.active;
      if (!entry) {
        // A leased retired entry or a failed cleanup blocks another allocation.
        if (this.entries.size) throw new Error('Go toolchain cache is still in use; wait before trying again');
        const parent = await realpath(tmpdir());
        const owned = await mkdtemp(join(parent, 'forge-go-toolchain-'));
        const stat = await lstat(owned);
        entry = {owned, parent, identity: {dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs},
          root: canonical, version, references: 0, retired: true};
        this.entries.add(entry);
        try {
          onPhase?.('toolchain_capture');
          entry.tree = await captureGoTree(canonical, join(owned, 'goroot'), {
            maxFiles: 20000, maxBytes: 512 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024, signal,
          });
          entry.key = goHash(JSON.stringify({root: canonical, version, files: entry.tree.files, directories: entry.tree.directories}));
        } catch (error) {
          try { await this.prune(); }
          catch (cleanup) { throw new AggregateError([error, cleanup], 'Go toolchain capture and cleanup failed'); }
          throw error;
        }
      }
      const held = entry;
      try {
        onPhase?.('toolchain_source_verify');
        await verifyGoTree(held.tree!, signal);
        onPhase?.('toolchain_cache_verify');
        await verifyGoTree({...held.tree!, root: held.tree!.destination}, signal);
        this.check(signal);
      } catch (error) {
        this.retire(held);
        try { await this.prune(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Go toolchain verification and cleanup failed'); }
        throw error;
      }
      held.retired = false;
      this.active = held;
      held.references++;
      let released = false;
      return {
        tree: held.tree!, key: held.key!,
        verifyCached: async (querySignal?: AbortSignal) => {
          if (released) throw new Error('Go toolchain lease is released');
          try { await verifyGoTree({...held.tree!, root: held.tree!.destination}, querySignal); }
          catch (error) {
            await this.serialize(async () => { this.retire(held); });
            throw error;
          }
        },
        release: async () => {
          if (released) return;
          released = true;
          await this.serialize(async () => {
            held.references--;
            if (![...this.entries].some(item => item.references)) {
              for (const notify of this.idleWaiters) notify();
              this.idleWaiters.clear();
            }
            await this.prune();
          });
        },
      };
    });
  }

  close(): Promise<void> {
    this.closed = true;
    this.closePromise ??= (async () => {
      await this.serialize(async () => { for (const entry of this.entries) this.retire(entry); });
      if ([...this.entries].some(entry => entry.references)) {
        await new Promise<void>(resolve => this.idleWaiters.add(resolve));
      }
      await this.serialize(() => this.prune());
    })().catch(error => { this.closePromise = undefined; throw error; });
    return this.closePromise;
  }
}
