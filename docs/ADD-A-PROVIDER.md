# Add a provider

Add one provider at a time. Start from its real authentication, model listing, usage response, headless flags, and event output. Keep shared runners and configuration defaults small.

## Choose its shape

- **Subscription CLI:** add one spec to `core/providers/vendors.mjs`. Confirm flags with the installed binary, including login, model listing, headless output, resume, long prompts, and read-only mode. The shared `core/workers/vendor-cli.mjs` runs it.
- **OpenAI-compatible API:** add an entry to `CATALOG` in `core/providers/openai-compat.mjs` and a key default in `core/config.mjs`. The shared chat-completions worker stays in place.
- **Native adapter:** add a provider module like `anthropic.mjs` or `codex.mjs`, and a worker only when the existing runners cannot speak its protocol.

Register the provider in `core/providers/index.mjs` if its shape does not register it automatically. Implement `id`, `label`, `kind`, `auth`, `detect()`, `listModels()`, and `pollLimits()`. Add model family detection in `core/models.mjs` and its budget class or weight in `core/config.mjs` and `core/scorecard.mjs` where the auth-derived class is insufficient. The `free` class can be empty; granted DeepSeek credit already uses it.

Parse real usage or limit responses into scoped windows in `pollLimits()`. Map read-only and writable task modes to actual CLI flags or tool restrictions; for a vendor CLI, check whether `readOnlyViaSnapshot` is needed. Add a settings field only if configuration is required.

Test model listing, auth, limit parsing, stream events, read-only behavior, and dispatch in the adjacent `test/` files. Run `npm test`, then run `smoke_test` on the new model before trusting its automatic routing.

## Restore a removed provider

The parent of the provider-removal change is `d55fc7ddcb489ba0ac0e2af8c5dfbf9d06588a3e`. Use `git show d55fc7ddcb489ba0ac0e2af8c5dfbf9d06588a3e:core/providers/<file>` (and the corresponding worker, config, UI, docs, and tests) as reference. Copy only the parts the one provider needs, then adapt and test them against its current binary or API. Do not restore the old whole catalog.

## Checklist

- [ ] One provider spec or adapter is registered and its config loads.
- [ ] Detection, model listing, and usage/limits use current response shapes.
- [ ] Worker output, errors, resume, long prompts, and read-only behavior are tested.
- [ ] Family, budget class, price or prior, and UI settings are accurate.
- [ ] Relevant `CONTEXT.md` and product docs are updated.
- [ ] `npm test` passes and `smoke_test` passes on the new model.
