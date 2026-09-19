import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectInstallFromPath,
  detectInstallOwnershipFromPath,
} from "../../src/update/install-detection.mjs";
import { checkForUpdate, startUpdateJob, UpdateJobError } from "../../src/update/job";
import { readUpdateBadge } from "../../src/update/badge";
import type { InstallOwnership } from "../../src/update/index";

const BACKEND = 'short = "ocx-local"\nfull = "npm:@bitkyc08/opencodex"\nexplicit_backend = false\n';

function misePackage(root: string, version = "2.59.0"): string {
  const toolRoot = join(root, "custom mise data", "installs", "ocx-local");
  const packagePath = join(
    toolRoot,
    version,
    "node_modules",
    ".mise",
    "@bitkyc08+opencodex@2.59.0",
    "node_modules",
    "@bitkyc08",
    "opencodex",
    "bin",
  );
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(join(toolRoot, ".mise.backend.toml"), BACKEND);
  return packagePath;
}

describe("mise installation ownership", () => {
  test("recognises a custom data directory, local alias, and nested aube package", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-mise-owner-"));
    try {
      const packagePath = misePackage(root);
      expect(detectInstallOwnershipFromPath(packagePath)).toEqual({
        installer: "mise",
        owner: {
          tool: "ocx-local",
          backend: "npm:@bitkyc08/opencodex",
          installPath: join(root, "custom mise data", "installs", "ocx-local", "2.59.0"),
          toolRoot: join(root, "custom mise data", "installs", "ocx-local"),
        },
      });
      expect(detectInstallFromPath(packagePath)).toBe("mise");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the resolved exact version behind a floating link", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-mise-link-"));
    try {
      const exact = misePackage(root);
      const toolRoot = join(root, "custom mise data", "installs", "ocx-local");
      symlinkSync("2.59.0", join(toolRoot, "latest"), "dir");
      const floating = join(toolRoot, "latest", exact.slice(join(toolRoot, "2.59.0").length + 1));
      expect(detectInstallOwnershipFromPath(floating)).toMatchObject({
        installer: "mise",
        owner: { tool: "ocx-local", installPath: join(toolRoot, "2.59.0") },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not infer mise ownership from a .mise path or mise on PATH", () => {
    const path = "/tmp/.mise/node_modules/@bitkyc08/opencodex/bin";
    expect(detectInstallOwnershipFromPath(path, {
      exists: () => false,
      realpath: value => value,
    })).toEqual({ installer: "npm" });
  });

  test("finds the install boundary when the custom data directory contains node_modules", () => {
    const path = "/tmp/node_modules/mise-data/installs/ocx-local/2.59.0/node_modules/@bitkyc08/opencodex/bin";
    const metadata = "/tmp/node_modules/mise-data/installs/ocx-local/.mise.backend.toml";
    expect(detectInstallOwnershipFromPath(path, {
      exists: value => value === metadata,
      readFile: () => BACKEND,
      realpath: value => value,
    })).toMatchObject({
      installer: "mise",
      owner: { installPath: "/tmp/node_modules/mise-data/installs/ocx-local/2.59.0" },
    });
  });

  test("fails closed when adjacent ownership metadata is unreadable or contradictory", () => {
    const path = "/data/installs/ocx-local/2.59.0/node_modules/@bitkyc08/opencodex/bin";
    const metadata = "/data/installs/ocx-local/.mise.backend.toml";
    expect(detectInstallOwnershipFromPath(path, {
      exists: value => value === metadata,
      readFile: () => { throw new Error("denied"); },
      realpath: value => value,
    })).toEqual({ installer: "mise", owner: null, error: "metadata_unreadable" });

    expect(detectInstallOwnershipFromPath(path, {
      exists: value => value === metadata,
      readFile: () => 'short = "different-alias"\nfull = "npm:@bitkyc08/opencodex"\n',
      realpath: value => value,
    })).toEqual({ installer: "mise", owner: null, error: "metadata_inconsistent" });
  });

  test("fails closed when lexical and resolved ownership evidence disagree", () => {
    const lexical = "/data/installs/ocx-local/latest/node_modules/@bitkyc08/opencodex/bin";
    const resolved = "/other/installs/opencodex/2.59.0/node_modules/@bitkyc08/opencodex/bin";
    expect(detectInstallOwnershipFromPath(lexical, {
      exists: value => value.endsWith("/.mise.backend.toml"),
      readFile: value => value.startsWith("/data/")
        ? BACKEND
        : 'short = "opencodex"\nfull = "npm:@bitkyc08/opencodex"\n',
      realpath: () => resolved,
    })).toEqual({ installer: "mise", owner: null, error: "metadata_inconsistent" });
  });

  test("keeps a broken ownership boundary authoritative when the other path verifies", () => {
    const lexical = "/data/installs/ocx-local/latest/node_modules/@bitkyc08/opencodex/bin";
    const resolved = "/other/installs/opencodex/2.59.0/node_modules/@bitkyc08/opencodex/bin";
    expect(detectInstallOwnershipFromPath(lexical, {
      exists: value => value.endsWith("/.mise.backend.toml"),
      readFile: value => {
        if (value.startsWith("/other/")) throw new Error("denied");
        return BACKEND;
      },
      realpath: () => resolved,
    })).toEqual({ installer: "mise", owner: null, error: "metadata_unreadable" });
  });

  test("handles Windows spelling without treating path case as an ownership mismatch", () => {
    const path = "C:\\Data Root\\mise\\installs\\OpenCodex\\2.59.0\\node_modules\\@bitkyc08\\opencodex\\bin";
    const metadata = "C:/Data Root/mise/installs/OpenCodex/.mise.backend.toml";
    expect(detectInstallOwnershipFromPath(path, {
      exists: value => value === metadata,
      readFile: () => 'short = "opencodex"\nfull = "npm:@bitkyc08/opencodex"\n',
      realpath: value => value,
    })).toMatchObject({ installer: "mise", owner: { tool: "opencodex" } });
  });
});

describe("mise update refusal", () => {
  const ownership: InstallOwnership = {
    installer: "mise",
    owner: {
      tool: "ocx-local",
      backend: "npm:@bitkyc08/opencodex",
      installPath: "/data/installs/ocx-local/2.59.0",
      toolRoot: "/data/installs/ocx-local",
    },
  };

  test("read-only checks succeed with actionable external-management guidance", () => {
    const result = checkForUpdate("preview", {
      currentVersion: () => "2.59.0",
      detectInstall: () => "npm",
      detectInstallOwnership: () => ownership,
      latestVersion: () => "2.60.0-preview.1",
      miseUpdateCommand: value => value.installer === "mise" && value.owner
        ? `mise upgrade ${value.owner.tool}`
        : null,
    });

    expect(result).toMatchObject({
      installer: "mise",
      canUpdate: false,
      reason: "externally_managed",
      command: "mise upgrade ocx-local",
      channel: "preview",
    });
  });

  test("invalid metadata never invents a tool name", () => {
    const result = checkForUpdate("latest", {
      currentVersion: () => "2.59.0",
      detectInstall: () => "mise",
      detectInstallOwnership: () => ({
        installer: "mise",
        owner: null,
        error: "metadata_inconsistent",
      }),
      latestVersion: () => "2.60.0",
      miseUpdateCommand: () => null,
    });
    expect(result).toMatchObject({
      installer: "mise",
      canUpdate: false,
      reason: "external_ownership_invalid",
      command: "",
    });
  });

  test("the sidebar badge can report availability without offering mutation", () => {
    const badge = readUpdateBadge({
      currentVersion: () => "2.59.0",
      detectInstall: () => "mise",
      readCache: () => ({
        latest_version: "2.60.0",
        last_checked_at: new Date().toISOString(),
        tag: "latest",
      }),
    });
    expect(badge.updateAvailable).toBe(true);
    expect(badge.canUpdate).toBe(false);
    expect(badge.installer).toBe("mise");
  });

  test("dashboard update requests are rejected before a worker is created", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-mise-job-"));
    const previousHome = process.env.OPENCODEX_HOME;
    let spawned = false;
    process.env.OPENCODEX_HOME = root;
    try {
      let thrown: unknown;
      try {
        startUpdateJob("latest", true, {
          checkForUpdateFn: () => ({
            currentVersion: "2.59.0",
            latestVersion: "2.60.0",
            channel: "latest",
            installer: "mise",
            updateAvailable: true,
            canUpdate: false,
            reason: "externally_managed",
            command: "mise upgrade ocx-local",
            releaseNotesUrl: "https://github.com/lidge-jun/opencodex/releases/latest",
          }),
          spawnWorkerFn: () => {
            spawned = true;
            throw new Error("must not spawn");
          },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UpdateJobError);
      expect(thrown).toMatchObject({ code: "externally_managed", status: 409 });
      expect(spawned).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("the published Node launcher refuses before npm or Bun update handling", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-mise-launcher-"));
    try {
      const toolRoot = join(root, "data root", "installs", "ocx-local");
      const packageParent = join(toolRoot, "2.59.0", "node_modules", "@bitkyc08");
      const packagePath = join(packageParent, "opencodex");
      const fakeBin = join(root, "fake-bin");
      mkdirSync(packageParent, { recursive: true });
      mkdirSync(fakeBin);
      symlinkSync(join(import.meta.dir, "..", ".."), packagePath, "dir");
      writeFileSync(join(toolRoot, ".mise.backend.toml"), BACKEND);
      const fakeNpm = join(fakeBin, "npm");
      writeFileSync(fakeNpm, "#!/bin/sh\nprintf '%s\\n' 2.59.0\n");
      chmodSync(fakeNpm, 0o755);

      const result = spawnSync(
        "node",
        ["--preserve-symlinks-main", join(packagePath, "bin", "ocx.mjs"), "update", "--tag", "preview"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCODEX_HOME: join(root, "state"),
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("externally managed by mise");
      expect(result.stderr).toContain("mise upgrade ocx-local");
      expect(result.stderr).not.toContain("tag preview");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
