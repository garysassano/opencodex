import {
  createRuntimePackageTreeIntegrityGuard,
  type PackageTreeIntegrityGuard,
} from "../../lib/package-tree-integrity";
import { createPackageTreeRetargetWatch } from "../../lib/package-tree-retarget";
import { acceptSystemRestart } from "../management/system-restart";
import { inspectNativeCodexOwnership } from "../../integrations/native/ownership-preflight";
import { detectInstall } from "../../update/index";
import { planMiseLauncherTargetWatch } from "../../update/mise-launcher-target";
import type { StartServerDeps } from "./startup-warnings";

// Production guard wiring for the package-tree integrity fence. Tests inject
// deps.packageTreeIntegrity and never reach this path; everything else is the
// same default the inline construction used to build.
export function createPackageTreeIntegrityGuardForServer(
  deps: StartServerDeps,
  serviceHomeOwned: () => boolean = deps.packageTreeServiceHomeOwned
    ?? (() => inspectNativeCodexOwnership().ownership === "owned"),
  isServiceChild: () => boolean = deps.packageTreeServiceChild ?? (() => process.env.OCX_SERVICE === "1"),
): PackageTreeIntegrityGuard {
  if (deps.packageTreeIntegrity) {
    return deps.packageTreeIntegrity;
  }
  const acceptPackageTreeRestart = deps.acceptSystemRestart ?? acceptSystemRestart;
  let vetoAcceptedRestart: (() => void) | undefined;
  // An out-of-band install replaced or retargeted the package this live process runs. Let the
  // standard drain-and-restart path bring the new tree up instead of refusing traffic until a
  // manual restart. acceptSystemRestart is idempotent and supervisor-aware. Throwing tells the
  // caller to retry after its own debounce.
  const restartOntoNewPackageTree = () => {
    const beforeScheduledDrain = () => !isServiceChild() || serviceHomeOwned();
    if (!beforeScheduledDrain()) throw new Error("service home ownership changed");
    acceptPackageTreeRestart(undefined, {
      onAccepted: veto => { vetoAcceptedRestart = veto; },
      beforeScheduledDrain,
    });
  };
  const guard = createRuntimePackageTreeIntegrityGuard(
    deps.packageTreeInstaller ?? detectInstall(),
    deps.observePackageTree,
    undefined,
    { ...deps.packageTreeIntegrityOptions, onReplaced: restartOntoNewPackageTree },
  );
  // mise installs each version beside the last and repoints a floating link, so the manifest
  // above never changes on `mise upgrade`. The managed service follows its launcher instead.
  const plan = deps.packageTreeLauncherTarget === undefined
    ? planMiseLauncherTargetWatch()
    : deps.packageTreeLauncherTarget;
  const retarget = plan
    ? createPackageTreeRetargetWatch(
      plan.runningRoot,
      plan.resolveTarget,
      restartOntoNewPackageTree,
      deps.packageTreeRetargetOptions,
    )
    : null;
  return {
    status: () => guard.status(),
    installedVersion: () => guard.installedVersion?.() ?? retarget?.settledVersion(),
    dispose: () => {
      guard.dispose();
      retarget?.dispose();
      vetoAcceptedRestart?.();
      vetoAcceptedRestart = undefined;
    },
  };
}
