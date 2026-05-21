/**
 * Ambient shim for `proper-lockfile`. `@shemma/spaces/src/registry.ts` imports
 * this package for filesystem locking; the package ships JS only and there is
 * no `@types/proper-lockfile` on npm. Frontend never uses it at runtime (we
 * only consume `import type` symbols from `@shemma/spaces`), but TypeScript
 * still walks the module graph and complains. Declaring a minimal shape here
 * silences TS7016 without pulling in a runtime dep.
 */
declare module "proper-lockfile";
