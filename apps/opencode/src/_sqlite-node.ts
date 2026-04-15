// Node.js compat shim for bun:sqlite — used by tsdown at build time via resolve.alias.
// Provides `Database` as a named export to match the bun:sqlite API surface.
export { default as Database } from 'better-sqlite3';
