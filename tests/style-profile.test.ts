import { test } from "node:test";
import assert from "node:assert/strict";
import { styleProfile, styleRows } from "../src/style-profile.ts";
test("style evidence preserves real zero shares and excludes invalid or unmeasured values", () => {
  const profile = styleProfile({
    function_count: 42,
    sample_threshold: 20,
    by_language: {
      typescript: {
        function_count: 30,
        ratios: {
          const_share: 1,
          ternary_share: 0,
          await_share: null,
          bad: 1.5,
          negative: -1,
        },
      },
      rust: { function_count: null, ratios: { try_op_share: 0.9 } },
    },
  })!;
  assert.equal(profile.samples, 42);
  assert.equal(profile.sampleThreshold, 20);
  assert.deepEqual(profile.languages[0].ratios, {
    const_share: 1,
    ternary_share: 0,
  });
  assert.equal(profile.languages[1].samples, null);
  assert.equal(styleProfile(undefined), undefined);
});
test("language cards choose the dominant naming convention without inventing complementary ratios", () => {
  const rows = styleRows({
    naming_variables_camel_share: 0.8,
    naming_variables_snake_share: 0.2,
    const_share: 0.7,
    ternary_share: 0,
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].label, "variables · camelCase");
  assert.equal(rows[0].share, 0.8);
  assert.equal(rows.at(-1)!.share, 0);
  assert.equal(
    rows.some((row) => row.key === "naming_variables_snake_share"),
    false,
  );
});
