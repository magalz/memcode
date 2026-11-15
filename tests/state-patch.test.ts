import test from "node:test";
import assert from "node:assert/strict";
import { applyStatePatch, type StatePatch } from "../src/state-patch.ts";

test("a streamed text update retains unchanged stories and message history", () => {
  const history = Object.freeze({ text: "Large earlier context" });
  const untouched = Object.freeze({ id: "other", messages: [] });
  const previous = Object.freeze({
    tasks: Object.freeze([
      Object.freeze({
        id: "active",
        messages: Object.freeze([history, Object.freeze({ text: "Hello" })]),
      }),
      untouched,
    ]),
    project: "local",
  });
  const patch: StatePatch = {
    kind: "object",
    remove: [],
    set: [
      [
        "tasks",
        {
          kind: "array",
          length: 2,
          set: [
            [
              0,
              {
                kind: "object",
                remove: [],
                set: [
                  [
                    "messages",
                    {
                      kind: "array",
                      length: 2,
                      set: [
                        [
                          1,
                          {
                            kind: "object",
                            remove: [],
                            set: [
                              [
                                "text",
                                { kind: "replace", value: "Hello world" },
                              ],
                            ],
                          },
                        ],
                      ],
                    },
                  ],
                ],
              },
            ],
          ],
        },
      ],
    ],
  };
  const next = applyStatePatch(previous, patch);
  assert.equal(next.tasks[0].messages[1].text, "Hello world");
  assert.equal(next.tasks[0].messages[0], history);
  assert.equal(next.tasks[1], untouched);
  assert.equal(previous.tasks[0].messages[1].text, "Hello");
});

test("Rust wire contract covers deletion, array append and null-to-object replacement", () => {
  const patch = JSON.parse(
    '{"kind":"object","remove":["gone"],"set":[["list",{"kind":"array","length":3,"set":[[1,{"kind":"replace","value":3}],[2,{"kind":"replace","value":4}]]}],["value",{"kind":"replace","value":{"__proto__":5}}]]}',
  );
  const next = applyStatePatch(
    { gone: true, list: [1, 2], value: null },
    patch,
  );
  assert.deepEqual(
    next,
    JSON.parse('{"list":[1,3,4],"value":{"__proto__":5}}'),
  );
  assert.equal(Object.getPrototypeOf(next.value), Object.prototype);
  assert.equal(Object.hasOwn(next.value!, "__proto__"), true);
});

test("object patches preserve literal prototype keys without prototype mutation", () => {
  const previous = Object.freeze({ keep: 1 });
  const next = applyStatePatch<Record<string, unknown>>(previous, {
    kind: "object",
    remove: [],
    set: [["__proto__", { kind: "replace", value: { marker: true } }]],
  });
  assert.equal(Object.getPrototypeOf(next), Object.prototype);
  assert.equal(Object.hasOwn(next, "__proto__"), true);
  assert.deepEqual(next["__proto__"], { marker: true });
  assert.equal(({} as Record<string, unknown>).marker, undefined);
});

test("replacement initializes a document; truncation works; missing baseline is rejected", () => {
  assert.deepEqual(
    applyStatePatch(undefined, { kind: "replace", value: { a: [1, 2] } }),
    { a: [1, 2] },
  );
  assert.deepEqual(
    applyStatePatch([1, 2, 3], { kind: "array", length: 1, set: [] }),
    [1],
  );
  assert.throws(
    () => applyStatePatch(undefined, { kind: "object", set: [], remove: [] }),
    /baseline/,
  );
  assert.throws(
    () =>
      applyStatePatch([], {
        kind: "array",
        length: 1,
        set: [[2, { kind: "replace", value: 1 }]],
      }),
    /bounds/,
  );
});
