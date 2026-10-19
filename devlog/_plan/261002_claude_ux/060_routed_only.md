# Routed-only: refuse official Anthropic models (060)

`claudeCode.routedOnly` (branch `feat/claude-routed-only`) closes the residual hole left after
the first-party posture work: `authMode: auto` + subscription-mode detection forwards native
Claude model requests — through the caller-credential passthrough (pf/pierce), and after
translation through the built-in Anthropic account pool — so a proxied session can still
produce Anthropic-bound traffic even with every first-party switch off.

## Evidence

- `wantsNativePassthrough` forwards unmapped `claude*`/`anthropic*` selectors verbatim with the
  caller's `sk-ant-` credential (claude-messages.ts, "Native Anthropic passthrough" banner).
- With no caller credential the same selector translates and `routeModel` settles it on the
  builtin `anthropic` pool (or pool 2 reached through `anthropic2/<model>`), served with the
  proxy's own detected OAuth account.

## Design

- Server-side refusal, not launcher-env: `authMode`/`markerMode` only govern the launch env,
  so they cannot guarantee routing. Refusal points live in the Messages surface so both the
  real send and a preview disagree never:
  1. before the caller-credential passthrough, for a native selector no alias or `modelMap`
     entry claims (`nativeClaudeModelId` in messages-native-eligibility.ts);
  2. where the route settles, when it lands on a built-in Anthropic pool
     (`isBuiltinAnthropicRoute`), which also catches interaction targets that map into the
     pool;
  3. in `count_tokens`, the passthrough branch only — the estimate path is local.
- Response: 403 `permission_error`, error code `claude_routed_only`, message naming the
  resolve paths. Custom anthropic-wire relay providers are not refused.
- No auto-selection of routed defaults for unset tier slots: the refusal message and the GUI
  reminder tell the user to map them.

## Surfaces

- Config: `claudeCode.routedOnly` (absent = off), schema refinement, GET/PUT `/api/claude-code`.
- CLI: `ocx claude config set --routed-only <on|off>`, capability registry.
- GUI: Claude page settings card toggle (draft+Save like the other card fields) with an
  active/defaults notice; locale catalogs in all 11 locales.
- Tests: tests/claude-integration/claude-routed-only.test.ts (refusal at both homes, claimed
  selectors keep serving, count_tokens, management round-trip, schema rejection).
