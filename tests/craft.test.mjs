import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BLUEPRINT,
  compileCraft,
  getStageTWR,
  getTotalDeltaV,
  validateCraft,
} from "../src/craft.js";

test("default blueprint compiles into one powered stage", () => {
  const craft = compileCraft(DEFAULT_BLUEPRINT, ["start"]);
  assert.equal(craft.stages.length, 1);
  assert.equal(craft.stages[0].engines.length, 1);
  assert.ok(craft.totalMass > 2000);
  assert.ok(getStageTWR(craft, 0) > 1.5);
  assert.ok(getTotalDeltaV(craft) > 1000);
});

test("decoupler splits a two-stage rocket bottom first", () => {
  const blueprint = [
    "cmd_mk1",
    "engine_aurora",
    "tank_m",
    "decoupler",
    "fins",
    "tank_l",
    "engine_falcon",
  ];
  const craft = compileCraft(blueprint, ["start", "engineering", "orbital", "heavy"]);
  assert.equal(craft.stages.length, 2);
  assert.equal(craft.stages[0].parts.at(-1), "engine_falcon");
  assert.equal(craft.stages[1].parts[0], "cmd_mk1");
});

test("validation rejects a rocket without an engine", () => {
  const result = validateCraft(["cmd_mk1", "tank_s"], {
    unlockedTech: ["start"],
    isUnlocked: () => true,
  });
  assert.equal(result.valid, false);
  assert.ok(result.checks.some((check) => check.label.includes("发动机")));
});
