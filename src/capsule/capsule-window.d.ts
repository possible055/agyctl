// The capsule registers itself on the Host window for reload/dispose. The
// assembled bundle typechecks this access without inline casts, which esbuild
// would reorder into a shape TypeScript cannot bind.
declare interface Window {
  __AGYCTL_CAPSULE__?: { dispose: () => void };
}
