import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { getConfigDir } from "../config";
import { readRuntimePort, verifyPidIdentity, type RuntimePortState } from "../config/process-state";
import {
  samePackageIdentity,
  type PackageIdentity,
} from "../lib/package-tree-integrity";
import { probeHostname, proxyIdentityAt, probeReadiness } from "../server/proxy-liveness";
import { diagnoseService, type ServiceDiagnostic } from "./diagnostics";
import { assertServiceEnvironmentMatchesInstall } from "./guards";
import { serviceInstallHealthMs } from "./health";
import { repairService } from "./repair";
import { readServiceInstallState, type ServiceInstallState } from "./state";

export type ConditionalRestartResult =
  | { ok: true; action: "skipped"; reason: "service_absent" | "service_stopped" }
  | { ok: true; action: "unchanged"; restarted: false; pid: number; port: number; version: string }
  | { ok: true; action: "restarted"; restarted: true; previousPid: number; pid: number; port: number; version: string };

export class ConditionalRestartError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = "ConditionalRestartError";
  }
}

interface RunningService {
  runtime: RuntimePortState;
  packageTreeChanged: boolean;
}

export interface ConditionalRestartDeps {
  diagnose: () => ServiceDiagnostic;
  assertOwnership: () => void;
  readState: () => ServiceInstallState | null;
  inspectRunning: (diag: ServiceDiagnostic) => Promise<RunningService>;
  inspectTarget: (state: ServiceInstallState) => PackageIdentity;
  restart: () => Promise<void>;
  waitForReplacement: (previous: RunningService, target: PackageIdentity) => Promise<RuntimePortState>;
  withLock: <T>(operation: () => Promise<T>) => Promise<T>;
}

function parsePackageIdentity(value: unknown): PackageIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const identity = value as Record<string, unknown>;
  const keys = ["packagePath", "version", "packageDevice", "packageInode", "packageContentTimeNs", "packageSize", "device", "inode", "contentTimeNs", "size"] as const;
  if (!keys.every(key => typeof identity[key] === "string" && identity[key].length > 0)) return null;
  if (!isAbsolute(identity.packagePath as string)) return null;
  if (!["packageDevice", "packageInode", "packageContentTimeNs", "packageSize", "device", "inode", "contentTimeNs", "size"]
    .every(key => /^\d+$/.test(identity[key] as string))) return null;
  return identity as unknown as PackageIdentity;
}

function inspectTargetPackage(state: ServiceInstallState): PackageIdentity {
  const launcher = state.launcherPath;
  if (!launcher || !isAbsolute(launcher)) {
    throw new ConditionalRestartError(
      "stable_launcher_unavailable",
      "The installed service has no recorded stable launcher. Run 'ocx service repair' before using --if-needed.",
    );
  }
  const result = spawnSync(launcher, ["system", "package-identity", "--json"], {
    encoding: "utf8",
    cwd: dirname(launcher),
    timeout: 15_000,
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_HOME: state.codexHome,
      OPENCODEX_HOME: state.opencodexHome,
      ...(state.codexSqliteHome ? { CODEX_SQLITE_HOME: state.codexSqliteHome } : {}),
    },
  });
  if (result.status !== 0) {
    throw new ConditionalRestartError(
      "replacement_invalid",
      `The recorded service launcher could not inspect its target installation (exit ${result.status ?? "unknown"}).`,
    );
  }
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout.trim()); } catch { parsed = null; }
  const identity = parsePackageIdentity(parsed);
  if (!identity) {
    throw new ConditionalRestartError(
      "replacement_invalid",
      "The recorded service launcher did not resolve to a valid OpenCodex package.",
    );
  }
  return identity;
}

async function inspectRunningService(diag: ServiceDiagnostic): Promise<RunningService> {
  const runtime = readRuntimePort();
  if (!runtime || verifyPidIdentity(runtime.pid) !== runtime.pid) {
    throw new ConditionalRestartError(
      "service_process_ambiguous",
      "The installed service's live OpenCodex process could not be verified. Check 'ocx service status' and retry.",
    );
  }
  if (runtime.serviceManaged === false) {
    throw new ConditionalRestartError(
      "foreign_process",
      "The live OpenCodex process reports that it was not started by the installed service.",
    );
  }
  const identity = await proxyIdentityAt(runtime.port, {
    hostname: runtime.hostname,
    expectedPid: runtime.pid,
  });
  if (identity) return { runtime, packageTreeChanged: false };

  try {
    const response = await fetch(`http://${probeHostname(runtime.hostname)}:${runtime.port}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    const body = await response.json().catch(() => null) as { error?: { code?: unknown } } | null;
    if (response.status === 503 && body?.error?.code === "package_tree_changed") {
      return { runtime, packageTreeChanged: true };
    }
  } catch {
    // The actionable ownership error below covers an unreachable or malformed process.
  }
  throw new ConditionalRestartError(
    "service_process_ambiguous",
    `The service manager reports ${diag.backend ?? "a service"} running, but its process did not answer with a valid OpenCodex identity.`,
  );
}

async function waitForReplacement(
  previous: RunningService,
  target: PackageIdentity,
): Promise<RuntimePortState> {
  const deadline = Date.now() + serviceInstallHealthMs();
  do {
    const runtime = readRuntimePort();
    if (
      runtime
      && runtime.pid !== previous.runtime.pid
      && runtime.port === previous.runtime.port
      && runtime.serviceManaged === true
      && runtime.packageIdentity
      && samePackageIdentity(runtime.packageIdentity, target)
      && verifyPidIdentity(runtime.pid) === runtime.pid
    ) {
      const health = await proxyIdentityAt(runtime.port, {
        hostname: runtime.hostname,
        expectedPid: runtime.pid,
      });
      const ready = await probeReadiness(runtime.port, {
        hostname: runtime.hostname,
        expectedPid: runtime.pid,
      });
      if (health?.version === target.version && ready?.ready && diagnoseService().running) return runtime;
    }
    await Bun.sleep(250);
  } while (Date.now() < deadline);
  throw new ConditionalRestartError(
    "replacement_unhealthy",
    `The service did not produce a healthy, ready ${target.version} replacement on port ${previous.runtime.port}. Check the service log and 'ocx service status'.`,
  );
}

async function withConditionalRestartLock<T>(operation: () => Promise<T>): Promise<T> {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "service-refresh.sqlite");
  const database = new Database(path, { create: true });
  try {
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    database.exec(`PRAGMA busy_timeout = ${serviceInstallHealthMs() + 10_000}; BEGIN IMMEDIATE`);
    return await operation();
  } catch (error) {
    if (/database (?:is|table is) locked/i.test(error instanceof Error ? error.message : String(error))) {
      throw new ConditionalRestartError(
        "refresh_busy",
        "Another conditional service refresh is still running. Wait for it to finish and retry.",
      );
    }
    throw error;
  } finally {
    try { database.exec("ROLLBACK"); } catch { /* closing still releases the lock */ }
    database.close();
  }
}

const defaultDeps: ConditionalRestartDeps = {
  diagnose: diagnoseService,
  assertOwnership: assertServiceEnvironmentMatchesInstall,
  readState: readServiceInstallState,
  inspectRunning: inspectRunningService,
  inspectTarget: inspectTargetPackage,
  restart: () => repairService({ verb: "restart" }),
  waitForReplacement,
  withLock: withConditionalRestartLock,
};

export async function conditionalServiceRestart(
  deps: Partial<ConditionalRestartDeps> = {},
): Promise<ConditionalRestartResult> {
  const io = { ...defaultDeps, ...deps };
  return io.withLock(async () => {
    const diag = io.diagnose();
    if (!diag.supported) {
      throw new ConditionalRestartError(
        "service_manager_unavailable",
        `The service manager is unavailable: ${diag.summary}`,
      );
    }
    if (!diag.installed) return { ok: true, action: "skipped", reason: "service_absent" };
    io.assertOwnership();
    const state = io.readState();
    if (!state || diag.conflict) {
      throw new ConditionalRestartError(
        "service_ownership_ambiguous",
        "The installed service ownership could not be established. Check 'ocx service status' before retrying.",
      );
    }
    if (!diag.running) return { ok: true, action: "skipped", reason: "service_stopped" };

    const running = await io.inspectRunning(diag);
    const target = io.inspectTarget(state);
    if (
      !running.packageTreeChanged
      && running.runtime.packageIdentity
      && samePackageIdentity(running.runtime.packageIdentity, target)
    ) {
      return {
        ok: true,
        action: "unchanged",
        restarted: false,
        pid: running.runtime.pid,
        port: running.runtime.port,
        version: target.version,
      };
    }

    await io.restart();
    const replacement = await io.waitForReplacement(running, target);
    return {
      ok: true,
      action: "restarted",
      restarted: true,
      previousPid: running.runtime.pid,
      pid: replacement.pid,
      port: replacement.port,
      version: target.version,
    };
  });
}
