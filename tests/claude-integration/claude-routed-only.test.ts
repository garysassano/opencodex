/**
 * claudeCode.routedOnly: official Anthropic models are refused on the claude Messages surface.
 *
 * Every Anthropic-bound home of a native selector refuses (devlog/_plan/261002_claude_ux):
 * - the caller-credential passthrough, before it forwards anything to api.anthropic.com;
 * - the routed path, when the selector resolves onto the built-in Anthropic account pool
 *   (the managed native Messages lane and its bridge twin alike).
 * A selector claimed by alias or model interaction keeps routing — including a mapped target
 * that still lands on the Anthropic pool, which is refused where the route settles — and
 * count_tokens keeps its local estimate for non-Anthropic selectors.
 *
 * The harness mirrors messages-native-oauth.test.ts: the OAuth account store is seeded
 * synthetically, the provider carries an in-process transport, and global fetch is stubbed
 * to throw so any real network call fails the case.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetchServer } from "../helpers/management-auth";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, validateConfigCandidate } from "../../src/config";
import { saveCredential, setActiveAccount, getAccountSet } from "../../src/oauth/store";
import { clearAnthropicAccountPoolState, forgetAnthropicFailoverQuorum } from "../../src/oauth/anthropic-routing";
import { clearUpstreamHostHealth } from "../../src/codex/upstream-host-health";
import { handleClaudeCountTokens, handleClaudeMessages } from "../../src/server/claude-messages";
import { startServer } from "../../src/server";
import { getRequestLogEntries, clearRequestLogsForTests } from "../../src/server/request-log";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const SIGNATURE = "fixture-signature-CCCCCCCCCCCCCCCCCCCC";

const CALLER_HEADERS = {
  authorization: "Bearer fixture-admission-token",
  "x-api-key": "fixture-caller-key",
  "anthropic-beta": "interleaved-thinking-2025-05-14",
};

const NATIVE_BODY = {
  model: "claude-sonnet-4-5",
  max_tokens: 64,
  stream: false,
  messages: [{ role: "user", content: "fixture question" }],
};

const PREFIXED_BODY = { ...NATIVE_BODY, model: "anthropic/claude-sonnet-4-5" };

const EXPECTED_REFUSAL = {
  type: "error",
  error: {
    type: "permission_error",
    code: "claude_routed_only",
    message: "Routed-only: official Anthropic models are disabled, so \"claude-sonnet-4-5\" cannot be served from Anthropic. Aim it at a routed model (tier defaults, model interception, or a provider-prefixed id), or turn routed-only off.",
  },
};

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

let sent: Sent[] = [];
let home = "";
let previousHome: string | undefined;
let originalFetch: typeof globalThis.fetch;
let unexpectedFetches = 0;
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-claude-routed-only-"));
  process.env.OPENCODEX_HOME = home;
  sent = [];
  clearRequestLogsForTests();
  originalFetch = globalThis.fetch;
  unexpectedFetches = 0;
  globalThis.fetch = (async () => {
    unexpectedFetches += 1;
    throw new Error("unexpected global fetch in the routed-only test");
  }) as unknown as typeof fetch;
  clearAnthropicAccountPoolState();
  clearUpstreamHostHealth();
  forgetAnthropicFailoverQuorum();
  releaseSpendHome = acquireOwnedSpendHome();
});

afterEach(() => {
  try {
    expect(unexpectedFetches).toBe(0);
  } finally {
    // Release the ledger lease first: an open SQLite lease inside a directory being
    // deleted fails the removal (the helper's stated ordering).
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    clearAnthropicAccountPoolState();
    forgetAnthropicFailoverQuorum();
    clearUpstreamHostHealth();
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (home) removeTreeWithRetry(home);
    home = "";
  }
});

const MESSAGE = {
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "fixture reply" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 9, output_tokens: 4 },
};

const transport = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
  return Response.json(MESSAGE, { headers: { "content-type": "application/json" } });
}) as typeof fetch;

function fixtureConfig(claudeCode: OcxConfig["claudeCode"] = {}): OcxConfig {
  const provider: OcxProviderConfig & { fetch: typeof fetch } = {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authMode: "oauth",
    models: ["claude-sonnet-4-5"],
    fetch: transport,
  };
  const config = {
    port: 0,
    defaultProvider: "anthropic",
    anthropicAccountPool: { enabled: false },
    providers: { anthropic: provider },
    protocols: { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } },
    ...(Object.keys(claudeCode).length > 0 ? { claudeCode } : {}),
  } as OcxConfig;
  saveConfig(config);
  return config;
}

async function seed(): Promise<void> {
  await saveCredential("anthropic", {
    access: "synthetic-routed-only-access",
    refresh: "synthetic-routed-only-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "synthetic-routed-only-account",
    source: "oauth",
  });
  const ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", ids[0]!);
  forgetAnthropicFailoverQuorum();
}

async function send(config: OcxConfig, body: Record<string, unknown>, headers: Record<string, string> = CALLER_HEADERS) {
  const requestId = `routed-only-${crypto.randomUUID()}`;
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), config, { model: "", provider: "" }, { requestId, start: Date.now() });
  const text = await response.text();
  const rows = getRequestLogEntries().filter(entry => entry.requestId === requestId);
  expect(rows).toHaveLength(1);
  return { response, text, row: rows[0]! };
}

async function count(config: OcxConfig, model: string): Promise<Response> {
  return handleClaudeCountTokens(new Request("http://localhost/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json", ...CALLER_HEADERS },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "fixture question" }] }),
  }), config);
}

describe("routed-only on the Messages surface", () => {
  test("refuses the ids Claude Code sends for official Anthropic models before any send", async () => {
    await seed();
    const config = fixtureConfig({ routedOnly: true });

    const bare = await send(config, NATIVE_BODY);
    expect(bare.response.status).toBe(403);
    expect(JSON.parse(bare.text)).toEqual(EXPECTED_REFUSAL);
    expect(bare.row.errorCode).toBe("claude_routed_only");
    expect(sent).toHaveLength(0);

    // The provider-qualified form names the same official pool.
    const prefixed = await send(config, PREFIXED_BODY);
    expect(prefixed.response.status).toBe(403);
    expect(JSON.parse(prefixed.text).error.code).toBe("claude_routed_only");
    expect(sent).toHaveLength(0);
  });

  test("without the flag the oauth route keeps serving a bare native id", async () => {
    await seed();
    const { response, row } = await send(fixtureConfig({}), NATIVE_BODY);
    expect(response.status).toBe(200);
    expect(row.protocolTrace?.mode).toBe("native");
    expect(row.errorCode).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  test("model interaction that still lands on the Anthropic pool is refused where the route settles", async () => {
    await seed();
    const config = fixtureConfig({ routedOnly: true, modelMap: { "claude-sonnet-4-5": "anthropic/claude-sonnet-4-5" } });
    const { response, text, row } = await send(config, NATIVE_BODY);
    // No claim hit here: the mapped target resolves onto a built-in Anthropic account, so the
    // settled route refuses even though the alias stage passed it on.
    expect(response.status).toBe(403);
    expect(JSON.parse(text).error.code).toBe("claude_routed_only");
    expect(row.errorCode).toBe("claude_routed_only");
    expect(sent).toHaveLength(0);
  });

  test("the caller passthrough hole stays closed even with an sk-ant credential", async () => {
    await seed();
    const headers = { authorization: "Bearer sk-ant-synthetic-fixture-token" };
    const refused = await send(fixtureConfig({ routedOnly: true }), NATIVE_BODY, headers);
    expect(refused.response.status).toBe(403);
    expect(JSON.parse(refused.text).error.code).toBe("claude_routed_only");
    expect(sent).toHaveLength(0);

    const open = await send(fixtureConfig({}), NATIVE_BODY, headers);
    expect(open.response.status).not.toBe(403);
    expect(sent).toHaveLength(0);
    // Without the flag the verbatim forward is attempted against api.anthropic.com. That
    // attempt is expected here, so the fetch-stub counter returns to zero for the cleanup
    // assertion.
    expect(unexpectedFetches).toBe(1);
    unexpectedFetches = 0;
  });

  test("count_tokens refuses a native id and keeps the estimate for a routed selector", async () => {
    await seed();
    const config = fixtureConfig({ routedOnly: true });
    const refused = await count(config, "claude-sonnet-4-5");
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { type: string } }).error.type).toBe("permission_error");
    expect(sent).toHaveLength(0);

    const estimate = await count(config, "kiro/claude-sonnet-4.5");
    expect(estimate.status).toBe(200);
    expect(((await estimate.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
  });
});

describe("routed-only settings surfaces", () => {
  let testDir = "";
  let previousDesktopConfigDir: string | undefined;

  test("the management API round-trips routedOnly and the file reads as off when cleared", async () => {
    // The round-trip exercises no network; restore real fetch so server startup's localhost
    // probes (model discovery fallback) behave as in the other server-based tests.
    globalThis.fetch = originalFetch;
    previousDesktopConfigDir = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
    process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(home, "claude-desktop");
    saveConfig({
      port: 0,
      defaultProvider: "anthropic",
      providers: { anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" } },
      anthropicAccountPool: { enabled: false },
    } as OcxConfig);
    const server = startServer(0);
    try {
      const read = async () => (await (await fetchServer(new URL("/api/claude-code", server.url))).json()) as Record<string, unknown>;
      expect((await read()).routedOnly).toBe(false);

      const on = await fetchServer(new URL("/api/claude-code", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ routedOnly: true }),
      });
      expect(on.status).toBe(200);
      expect((await read()).routedOnly).toBe(true);
      expect(loadConfig().claudeCode?.routedOnly).toBe(true);

      const cleared = await fetchServer(new URL("/api/claude-code", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ routedOnly: false }),
      });
      expect(cleared.status).toBe(200);
      expect((await read()).routedOnly).toBe(false);
      expect(Object.hasOwn(loadConfig().claudeCode ?? {}, "routedOnly")).toBe(false);

      const bad = await fetchServer(new URL("/api/claude-code", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ routedOnly: "on" }),
      });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toBe("routedOnly must be a boolean");
    } finally {
      await server.stop(true);
      if (previousDesktopConfigDir === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
      else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktopConfigDir;
      previousDesktopConfigDir = undefined;
    }
  });

  test("the config schema refuses a non-boolean hand edit", () => {
    const candidate = {
      port: 0,
      defaultProvider: "anthropic",
      providers: { anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" } },
      claudeCode: { routedOnly: "on" },
    };
    const result = validateConfigCandidate(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("claudeCode.routedOnly");
      expect(result.error).toContain("routedOnly must be a boolean");
    }
  });
});
