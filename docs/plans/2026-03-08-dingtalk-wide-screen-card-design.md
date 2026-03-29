# DingTalk Wide-Screen Card Design

**Goal:** Make all DingTalk AI cards created by this plugin request wide-screen PC rendering by default.

**Decision:** Do not add a new config flag. When `messageType` is `card`, `createAICard()` will always inject a `config` template variable with `{"autoLayout":true}` into `cardData.cardParamMap`.

**Why:** The user has already deployed the template-side `config.autoLayout` parameter. Always-on behavior matches the requested rollout, avoids new onboarding/config surface area, and keeps the change isolated to card creation.

**Files:**
- Modify `src/card-service.ts` to add the wide-screen parameter.
- Modify `tests/unit/card-service.test.ts` to assert the payload.
- Modify `README.md` to document the new default behavior and template requirement.

**Validation:**
- Add a failing unit test for the `createAndDeliver` payload.
- Run the focused unit test.
- Run type-check and lint.

**Out of Scope:**
- Adding a user-facing toggle.
- Supporting arbitrary `config` passthrough fields.
- Changing streaming behavior or card template keys.
