import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { resolve } from "node:path";
import { jiti, root } from "./test-helpers.mjs";

const { importWithoutReportNetwork } = await jiti.import(resolve(root, "src/native-import.ts"));
const report = process.report;
const initialExcludeNetwork = report.excludeNetwork;
const originalGetReport = report.getReport;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

try {
  if (process.platform === "linux" && typeof initialExcludeNetwork === "boolean") {
    for (const initial of [false, true]) {
      report.excludeNetwork = initial;
      assert.equal(await importWithoutReportNetwork(async () => {
        assert.equal(report.excludeNetwork, true);
        await Promise.resolve();
        assert.equal(report.excludeNetwork, true);
        return "loaded";
      }), "loaded");
      assert.equal(report.excludeNetwork, initial, "successful import must restore the host setting");

      const failure = new Error("module failed to load");
      await assert.rejects(importWithoutReportNetwork(async () => {
        assert.equal(report.excludeNetwork, true);
        throw failure;
      }), (error) => error === failure);
      assert.equal(report.excludeNetwork, initial, "rejected import must restore the host setting");
      await assert.rejects(importWithoutReportNetwork(() => {
        assert.equal(report.excludeNetwork, true);
        throw failure;
      }), (error) => error === failure);
      assert.equal(report.excludeNetwork, initial, "synchronous failure must restore the host setting");
    }

    // Either import can finish first; neither may restore a stale setting while
    // the other still needs protection, including when that other one rejects.
    for (const reverse of [false, true]) {
      report.excludeNetwork = false;
      const first = deferred();
      const second = deferred();
      const loads = [
        importWithoutReportNetwork(() => first.promise),
        importWithoutReportNetwork(() => second.promise),
      ];
      const early = reverse ? 1 : 0;
      [first, second][early].resolve("early");
      assert.equal(await loads[early], "early");
      assert.equal(report.excludeNetwork, true, "overlapping import must remain protected");
      const lateFailure = new Error("late import failed");
      const rejected = assert.rejects(loads[1 - early], (error) => error === lateFailure);
      [first, second][1 - early].reject(lateFailure);
      await rejected;
      assert.equal(report.excludeNetwork, false);
    }

    // A runtime without this API should still be able to import modules.
    delete report.excludeNetwork;
    try {
      assert.equal(await importWithoutReportNetwork(async () => {
        assert.equal(Object.hasOwn(report, "excludeNetwork"), false);
        return "unsupported runtime";
      }), "unsupported runtime");
    } finally {
      report.excludeNetwork = false;
    }

    // Real recorder import, with an existing TCP connection. Reject any report
    // that would query DNS instead of waiting for an actual resolver timeout.
    // Only read permission status: never open/capture the microphone or use the
    // public network. The guard must work through Pi's jiti TypeScript loader.
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    let client;
    let peer;
    try {
      const accepted = once(server, "connection");
      client = net.createConnection({ host: "127.0.0.1", port: server.address().port });
      await once(client, "connect");
      [peer] = await accepted;
      let calls = 0;
      report.getReport = (...args) => {
        assert.equal(report.excludeNetwork, true, "native libc probe would block Pi on reverse DNS");
        calls++;
        return originalGetReport.apply(report, args);
      };
      assert.throws(() => report.getReport(), /native libc probe would block Pi/);
      const audio = await jiti.import(resolve(root, "src/audio.ts"));
      assert.equal(calls, 0, "importing audio helpers must not eagerly load the recorder");
      assert.equal(audio.findMicrophone([], { name: "missing", occurrence: 0 }), undefined);
      await audio.microphonePermission();
      assert.ok(calls > 0, "exercise the real recorder's libc detection");
      assert.equal(report.excludeNetwork, false, "recorder import must not leave the host setting changed");
      const afterFirstLoad = calls;
      await audio.microphonePermission();
      assert.equal(calls, afterFirstLoad, "reuse the safely loaded recorder");
      console.log("PASS: real recorder libc probe protected with live TCP sockets; audio stays lazy and memoized");
    } finally {
      client?.destroy();
      peer?.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } else {
    assert.equal(await importWithoutReportNetwork(async () => {
      assert.equal(report.excludeNetwork, initialExcludeNetwork);
      return "other platform";
    }), "other platform");
  }
} finally {
  report.getReport = originalGetReport;
  report.excludeNetwork = initialExcludeNetwork;
}

console.log("PASS: scoped native imports restore report settings on success/failure, overlap safely, and tolerate missing API");
