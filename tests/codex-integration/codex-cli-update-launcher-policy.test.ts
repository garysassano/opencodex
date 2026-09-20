import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isCodexCliUpdateInspectionArgv } from "../../src/update/codex-cli-update-launch-policy.mjs";
import { repoPath } from "../helpers/repo-root";

describe("Codex CLI updater launcher policy", () => {
  test("covers the whole exact namespace including malformed actions", () => {
    expect(isCodexCliUpdateInspectionArgv(["node", "ocx", "system", "codex-cli-update", "check"])).toBe(true);
    expect(isCodexCliUpdateInspectionArgv(["node", "ocx", "system", "codex-cli-update", "bad"])).toBe(true);
    expect(isCodexCliUpdateInspectionArgv([
      "node", "ocx", "--ocx-internal-launch-proof=bad", "system", "codex-cli-update", "check",
    ])).toBe(true);
    expect(isCodexCliUpdateInspectionArgv([
      "node", "ocx", "--ocx-internal-launch-proof=bad", "system", "codex-cli-update", "bad",
    ])).toBe(true);
    expect(isCodexCliUpdateInspectionArgv(["node", "ocx", "system", "update"])).toBe(false);
  });

  test("launcher skips boot repair and lazy Bun installation for this namespace", () => {
    const source = readFileSync(repoPath("bin", "ocx.mjs"), "utf8");
    // Read the guard that actually wraps the probe rather than a fixed pair of adjacent
    // clauses. The boot probe is npm's transactional layout (stage/swap/backup) and pnpm
    // rolls back through its own global path, so the condition list grows; what must not
    // change is that this namespace is excluded from it.
    const probeCall = source.indexOf("const probe = bootRestoreProbe(");
    expect(probeCall).toBeGreaterThan(0);
    const guard = source.slice(source.lastIndexOf("if (", probeCall), probeCall);
    expect(guard).toContain("!readOnlyInspection");
    expect(guard).toContain("isNodeModulesInstall()");
    expect(source).toContain("resolveBun({ allowInstall: !readOnlyInspection })");
    expect(source).toContain("if (allowInstall && existsSync(installJs))");
  });

  test("package identity inspection also skips launcher and shim mutation", () => {
    const launcher = readFileSync(repoPath("bin", "ocx.mjs"), "utf8");
    const root = readFileSync(repoPath("src", "cli", "root.ts"), "utf8");
    expect(launcher).toContain('const packageIdentityInspection = process.argv[2] === "system" && process.argv[3] === "package-identity"');
    expect(launcher).toContain("const readOnlyInspection = codexCliUpdateInspection || packageIdentityInspection");
    expect(launcher).toContain("resolveBun({ allowInstall: !readOnlyInspection })");
    expect(root).toContain('head.command === "system" && head.args[1] === "package-identity"');
  });
});
