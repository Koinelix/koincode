// Untrusted parsing runs in a separate OS process: a fatal V8 OOM must not kill the wallet.
process.once("message", async (input) => {
  let result;
  try {
    const module = input.moduleUrl.endsWith(".ts")
      ? await (await import("tsx/esm/api")).tsImport(input.moduleUrl, import.meta.url)
      : await import(input.moduleUrl);
    result = module.executeJob(input.job);
    process.send({ ok: true, result }, () => {
      result.body.fill(0);
      input.job.body.fill(0);
      input.job.secrets.length = 0;
      process.exit(0);
    });
  } catch {
    // JSON and process errors can contain response fragments. Send fixed facts only.
    process.send?.({ ok: false }, () => process.exit(1));
  }
});
process.once("disconnect", () => process.exit(1));
