// Adapter for the pinned wllama 3.6.1 API. Its Memory64 feature probe can
// succeed in WebKit while the worker cannot compile the Memory64 module.
// CPU profiles deliberately use the wasm32 compatibility build. GPU profiles
// keep the vendor's normal resource selection. No global WebAssembly patches.
export function configureRuntime(wllama, paths, cpuOnly) {
  wllama.setCompat(paths);
  if (cpuOnly) {
    wllama.getWorkerResources = () => ({
      wasmPath: paths.wasm,
      jsPath: paths.worker,
      compat: true,
    });
  }
}
