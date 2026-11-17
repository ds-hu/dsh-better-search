#!/usr/bin/env node
/**
 * Maintenance CLI for @ds-hu/dsh-better-search.
 *
 * The plugin keeps exactly one directory (`$DSH_HOME/better-search/`) holding the
 * service list and credentials. Removing the bundle clears every runtime
 * registration and restores the profile's provider fields; this command removes
 * the last byte of residue — the store itself.
 *
 * ```sh
 * dsh-better-search status
 * dsh-better-search path
 * dsh-better-search clean --yes
 * ```
 *
 * `status` never prints credentials: it reports counts, the selection and the
 * fetch mode only.
 *
 * @module @ds-hu/dsh-better-search/bin/better-search
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** `$DSH_HOME` or `~/.dsh`. */
function dataRoot() {
  const env = process.env.DSH_HOME;
  return typeof env === 'string' && env.length > 0 ? env : join(homedir(), '.dsh');
}

/** Directory the plugin owns. */
function dataDir() {
  return join(dataRoot(), 'better-search');
}

/** Store file inside the owned directory. */
function storeFile() {
  return join(dataDir(), 'store.json');
}

/**
 * Render a size for humans.
 * @param {number} bytes - size.
 * @returns {string} rendered size.
 */
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Print `status`. */
function status() {
  const dir = dataDir();
  if (!existsSync(dir)) {
    console.log(`dsh-better-search: no store at ${dir}`);
    return;
  }
  let document = null;
  try {
    document = JSON.parse(readFileSync(storeFile(), 'utf8'));
  } catch {
    document = null;
  }
  const services = Array.isArray(document?.services) ? document.services : [];
  const keys = services.reduce((total, service) => total + (Array.isArray(service.keys) ? service.keys.length : 0), 0);
  console.log(`store:     ${storeFile()}`);
  console.log(`version:   ${document?.version ?? 'unknown'}`);
  console.log(`services:  ${services.length} (${new Set(services.map((service) => service.type)).size} types, ${keys} keys)`);
  console.log(`selected:  ${document?.selectedId ?? '(none)'}`);
  console.log(`fetch:     ${document?.fetch?.mode ?? 'official'}`);
  console.log(`size:      ${humanSize(statSync(storeFile()).size)}`);
  const backups = readdirSync(dir).filter((name) => name.includes('.bak'));
  if (backups.length > 0) console.log(`backups:   ${backups.length} file(s) in ${dir}`);
}

/** Resolve the directory and print it. */
function path() {
  console.log(dataDir());
}

/**
 * Remove the owned directory.
 * @param {boolean} confirmed - whether `--yes` was passed.
 */
function clean(confirmed) {
  const dir = dataDir();
  if (!existsSync(dir)) {
    console.log(`dsh-better-search: nothing to clean at ${dir}`);
    return;
  }
  if (!confirmed) {
    const target = resolve(dir);
    console.error(`This deletes ${target} (service list and stored API keys).`);
    console.error('Re-run with --yes to confirm.');
    process.exitCode = 1;
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`dsh-better-search: removed ${dir}`);
  console.log('If a provider from this plugin is still pinned in a profile, select a built-in provider first.');
}

const [command, ...flags] = process.argv.slice(2);
switch (command) {
  case 'status':
    status();
    break;
  case 'path':
    path();
    break;
  case 'clean':
    clean(flags.includes('--yes') || flags.includes('-y'));
    break;
  case undefined:
  case '-h':
  case '--help':
  case 'help':
    console.log('Usage: dsh-better-search <status|path|clean --yes>');
    break;
  default:
    console.error(`dsh-better-search: unknown command "${command}"`);
    console.error('Usage: dsh-better-search <status|path|clean --yes>');
    process.exitCode = 1;
}
