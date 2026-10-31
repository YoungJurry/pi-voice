// Some native loaders detect libc with process.report.getReport(). Its default
// libuv walk performs synchronous reverse DNS for open sockets, which can freeze
// Pi for a minute on a proxy/Fake-IP network. Only the libc header is needed.
// Keep this scoped to imports, not a permanent change to the host's reports.
let pendingImports = 0;
let previousExcludeNetwork = false;

export async function importWithoutReportNetwork<T>(load: () => Promise<T>): Promise<T> {
  // Older type definitions and non-Node runtimes may not expose this option.
  const report = process.report as (NodeJS.ProcessReport & { excludeNetwork?: boolean }) | undefined;
  if (process.platform !== "linux" || typeof report?.excludeNetwork !== "boolean") return load();

  if (pendingImports++ === 0) previousExcludeNetwork = report.excludeNetwork;
  report.excludeNetwork = true;
  try {
    return await load();
  } finally {
    // Overlapping imports must not re-enable DNS while another is loading.
    if (--pendingImports === 0) report.excludeNetwork = previousExcludeNetwork;
  }
}
