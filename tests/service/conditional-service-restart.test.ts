import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ConditionalRestartError,
  conditionalServiceRestart,
  stableLauncherEntry,
  type ConditionalRestartDeps,
} from "../../src/service";
import type { RuntimePortState } from "../../src/config/process-state";
import type { PackageIdentity } from "../../src/lib/package-tree-integrity";
import type { ServiceDiagnostic } from "../../src/service/diagnostics";
import type { ServiceInstallState } from "../../src/service/state";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const packageA: PackageIdentity = {
  packagePath: "/mise/installs/opencodex/1.0.0",
  version: "1.0.0",
  packageDevice: "1",
  packageInode: "9",
  packageContentTimeNs: "90",
  packageSize: "4096",
  device: "1",
  inode: "10",
  contentTimeNs: "100",
  size: "1000",
};

const packageB: PackageIdentity = {
  packagePath: "/mise/installs/opencodex/2.0.0",
  version: "2.0.0",
  packageDevice: "1",
  packageInode: "19",
  packageContentTimeNs: "190",
  packageSize: "4096",
  device: "1",
  inode: "20",
  contentTimeNs: "200",
  size: "1000",
};

const state: ServiceInstallState = {
  version: 2,
  codexHome: "/state/codex",
  opencodexHome: "/state/opencodex",
  launcherPath: "/mise/shims/ocx",
  backend: "scheduler",
};

test("a verified mise package launcher is replaced with its stable shim", () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "ocx-mise-launcher-"));
  const toolRoot = join(root, "installs", "local-opencodex");
  const packageBin = join(toolRoot, "90.0.1", "node_modules", ".bin", "ocx");
  const shim = join(root, "shims", "ocx");
  mkdirSync(dirname(packageBin), { recursive: true });
  mkdirSync(dirname(shim), { recursive: true });
  writeFileSync(join(toolRoot, ".mise.backend.toml"), 'short = "local-opencodex"\nfull = "npm:@bitkyc08/opencodex"\n');
  writeFileSync(packageBin, "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(shim, "#!/bin/sh\n", { mode: 0o755 });
  try {
    expect(stableLauncherEntry({
      state: { version: 2, backend: "scheduler", launcherPath: packageBin } as never,
      env: { PATH: "" },
    })).toBe(shim);
  } finally {
    removeTreeWithRetry(root);
  }
});

function diagnostic(overrides: Partial<ServiceDiagnostic> = {}): ServiceDiagnostic {
  return {
    supported: true,
    installed: true,
    enabled: true,
    running: true,
    viable: true,
    startable: true,
    stale: false,
    conflict: false,
    backend: "systemd",
    summary: "installed and running",
    ...overrides,
  };
}

function runtime(pid: number, identity: PackageIdentity | undefined = packageA): RuntimePortState {
  return {
    pid,
    port: 18181,
    hostname: "127.0.0.1",
    packageIdentity: identity,
    serviceManaged: true,
  };
}

function deps(overrides: Partial<ConditionalRestartDeps> = {}): Partial<ConditionalRestartDeps> {
  return {
    diagnose: () => diagnostic(),
    assertOwnership: () => {},
    readState: () => state,
    inspectRunning: async () => ({ runtime: runtime(101), packageTreeChanged: false }),
    inspectTarget: () => packageA,
    restart: async () => {},
    waitForReplacement: async () => runtime(202, packageB),
    withLock: operation => operation(),
    ...overrides,
  };
}

describe("conditional service restart", () => {
  test("an absent or intentionally stopped service is an explicit no-op", async () => {
    let inspected = false;
    const absent = await conditionalServiceRestart(deps({
      diagnose: () => diagnostic({ installed: false, running: false }),
      inspectRunning: async () => { inspected = true; throw new Error("unexpected"); },
    }));
    expect(absent).toEqual({ ok: true, action: "skipped", reason: "service_absent" });

    const stopped = await conditionalServiceRestart(deps({
      diagnose: () => diagnostic({ running: false }),
      inspectRunning: async () => { inspected = true; throw new Error("unexpected"); },
    }));
    expect(stopped).toEqual({ ok: true, action: "skipped", reason: "service_stopped" });
    expect(inspected).toBe(false);
  });

  test("a healthy matching package keeps the existing PID", async () => {
    let restarted = false;
    const result = await conditionalServiceRestart(deps({
      restart: async () => { restarted = true; },
    }));
    expect(result).toEqual({
      ok: true,
      action: "unchanged",
      restarted: false,
      pid: 101,
      port: 18181,
      version: "1.0.0",
    });
    expect(restarted).toBe(false);
  });

  test("a different target restarts once and reports the supervised replacement", async () => {
    let restarts = 0;
    const result = await conditionalServiceRestart(deps({
      inspectTarget: () => packageB,
      restart: async () => { restarts += 1; },
    }));
    expect(result).toEqual({
      ok: true,
      action: "restarted",
      restarted: true,
      previousPid: 101,
      pid: 202,
      port: 18181,
      version: "2.0.0",
    });
    expect(restarts).toBe(1);
  });

  test("a same-version reinstall and package-tree failure both require refresh", async () => {
    const replacement = { ...packageA, packageInode: "99", packageContentTimeNs: "999" };
    let restarts = 0;
    await conditionalServiceRestart(deps({
      inspectTarget: () => replacement,
      restart: async () => { restarts += 1; },
      waitForReplacement: async () => runtime(202, replacement),
    }));
    await conditionalServiceRestart(deps({
      inspectRunning: async () => ({ runtime: runtime(202, replacement), packageTreeChanged: true }),
      inspectTarget: () => replacement,
      restart: async () => { restarts += 1; },
      waitForReplacement: async () => runtime(303, replacement),
    }));
    expect(restarts).toBe(2);
  });

  test("an older runtime without package identity receives one conservative restart", async () => {
    let restarts = 0;
    const legacyRuntime: RuntimePortState = {
      pid: 101,
      port: 18181,
      hostname: "127.0.0.1",
      serviceManaged: true,
    };
    await conditionalServiceRestart(deps({
      inspectRunning: async () => ({ runtime: legacyRuntime, packageTreeChanged: false }),
      restart: async () => { restarts += 1; },
    }));
    expect(restarts).toBe(1);
  });

  test("invalid replacement evidence fails before service mutation", async () => {
    let restarted = false;
    await expect(conditionalServiceRestart(deps({
      inspectTarget: () => {
        throw new ConditionalRestartError("replacement_invalid", "invalid replacement");
      },
      restart: async () => { restarted = true; },
    }))).rejects.toMatchObject({ reason: "replacement_invalid" });
    expect(restarted).toBe(false);
  });

  test("an unavailable manager or ambiguous owner fails without activation", async () => {
    await expect(conditionalServiceRestart(deps({
      diagnose: () => diagnostic({ supported: false, installed: false, running: false }),
    }))).rejects.toMatchObject({ reason: "service_manager_unavailable" });
    await expect(conditionalServiceRestart(deps({
      readState: () => null,
    }))).rejects.toMatchObject({ reason: "service_ownership_ambiguous" });
  });
});
