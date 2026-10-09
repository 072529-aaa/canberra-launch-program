import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BLUEPRINT, compileCraft, getStageTWR, getTotalDeltaV, massProperties, normalizePartConfig, validateCraft } from "../src/craft.js";
import { FlightSimulation } from "../src/physics.js";
import { FixedStepClock } from "../src/clock.js";
import { GameState } from "../src/state.js";
import { analyzeFailure } from "../src/missions.js";
import { CONTRACTS } from "../src/data.js";

const storage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
};

test("fuel configuration changes mass, TWR and delta-v without changing hardware", () => {
  const configs = DEFAULT_BLUEPRINT.map((id) => normalizePartConfig(id));
  const full = compileCraft(DEFAULT_BLUEPRINT);
  configs[2].fuelFraction = 0.5;
  const half = compileCraft(DEFAULT_BLUEPRINT, [], configs);
  assert.equal(half.totalMass, full.totalMass - 450);
  assert.equal(half.totalCost, full.totalCost);
  assert.ok(getStageTWR(half, 0) > getStageTWR(full, 0));
  assert.ok(getTotalDeltaV(half) < getTotalDeltaV(full));
});

test("offset engine has torque and changes angular velocity in actual flight", () => {
  const configs = DEFAULT_BLUEPRINT.map((id) => normalizePartConfig(id));
  configs[3].x = 0.5;
  const craft = compileCraft(DEFAULT_BLUEPRINT, [], configs);
  assert.ok(massProperties(craft).thrustTorque > 10000);
  const sim = new FlightSimulation(DEFAULT_BLUEPRINT, { partConfigs: configs });
  sim.update();
  assert.ok(sim.angularVelocity > 0);
});

test("mirror mounting balances torque and undo restores the complete configuration", () => {
  const game = new GameState(storage());
  game.configurePart(3, { x: 0.5, angle: 7 });
  assert.equal(game.mirrorEngine(3, true), true);
  assert.ok(Math.abs(massProperties(game.craft).thrustTorque) < 1e-8);
  assert.equal(game.craft.stages[0].engines.length, 2);
  assert.equal(game.restoreEdit("undo"), true);
  assert.equal(game.state.blueprint.length, 5);
  assert.equal(game.state.partConfigs[3].x, 0.5);
  assert.equal(game.restoreEdit("redo"), true);
  assert.equal(game.state.blueprint.length, 6);
});

test("fins do not extend the stack and their placement changes stability geometry", () => {
  const full = compileCraft(DEFAULT_BLUEPRINT);
  const noFins = compileCraft(DEFAULT_BLUEPRINT.slice(0, -1));
  assert.equal(full.height, noFins.height);
  const configs = DEFAULT_BLUEPRINT.map((id) => normalizePartConfig(id));
  configs[4].y = 1;
  assert.ok(massProperties(compileCraft(DEFAULT_BLUEPRINT, [], configs)).stabilityLever < massProperties(full).stabilityLever);
});

test("legacy saves get default configs and launch freezes edited configs", () => {
  const memory = storage();
  memory.setItem("canberra-launch-program-state-v1", JSON.stringify({ blueprint: DEFAULT_BLUEPRINT, resources: { funds: 120000 } }));
  const game = new GameState(memory);
  assert.equal(game.state.partConfigs[2].fuelFraction, 1);
  game.configurePart(2, { fuelFraction: 0.5 });
  const launch = game.reserveLaunch();
  game.configurePart(2, { fuelFraction: 1 });
  assert.equal(launch.reservation.partConfigs[2].fuelFraction, 0.5);
  assert.equal(new GameState(memory).state.partConfigs[2].fuelFraction, 1);
});

test("frame rate does not change tick count or final flight state", () => {
  const results = [30, 60, 144].map((fps) => {
    const sim = new FlightSimulation(DEFAULT_BLUEPRINT);
    const clock = new FixedStepClock();
    let ticks = 0;
    for (let index = 0; index < fps * 10; index += 1) clock.advance(1 / fps, 1, (dt) => { sim.update(dt); ticks += 1; });
    return { ticks, position: sim.position, fuel: sim.stageFuel };
  });
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
  assert.equal(results[0].ticks, 200);
});

test("clock retains overflow and pause does not advance the simulation", () => {
  const clock = new FixedStepClock(0.05, 2);
  let ticks = 0;
  const step = () => { ticks += 1; };
  assert.equal(clock.advance(0.25, 1, step), 2);
  assert.ok(Math.abs(clock.accumulator - 0.15) < 1e-8);
  clock.advance(0, 1, step);
  clock.advance(0, 1, step);
  assert.equal(ticks, 5);
  clock.reset();
  clock.advance(1, 0, step);
  assert.equal(ticks, 5);
});

test("tiny remaining fuel cannot produce a full tick of thrust", () => {
  const full = new FlightSimulation(DEFAULT_BLUEPRINT);
  const tiny = new FlightSimulation(DEFAULT_BLUEPRINT);
  tiny.stageFuel[0] = 0.002;
  full.update(); tiny.update();
  assert.equal(tiny.stageFuel[0], 0);
  assert.ok(tiny.velocity[1] < full.velocity[1] * 0.1);
});

test("overlapping engine cluster is rejected", () => {
  const blueprint = [...DEFAULT_BLUEPRINT.slice(0, 4), "engine_kestrel", "fins"];
  const validation = validateCraft(blueprint);
  assert.equal(validation.valid, false);
  assert.ok(validation.checks.some((check) => check.label === "发动机安装重叠"));
});

test("config normalization handles corrupt values and bounds geometry", () => {
  assert.equal(normalizePartConfig("tank_s", null).fuelFraction, 1);
  assert.equal(normalizePartConfig("engine_kestrel", { x: 100, angle: -900 }).x, 0.7);
  assert.equal(normalizePartConfig("tank_s", { fuelFraction: -1 }).fuelFraction, 0);
  const game = new GameState(storage());
  assert.equal(game.addPart("unknown", true), false);
  assert.equal(game.state.blueprint.length, 5);
});

test("sounding experiment failure is analyzed against its actual goal", () => {
  const result = analyzeFailure({ status: "landed", maxAltitude: 4500, maxSpeed: 200, maxPeriapsis: -600000 }, {}, CONTRACTS[0]);
  assert.equal(result.cause, "探空高度未达标");
  assert.ok(!result.recommendations.some((text) => text.includes("轨道")));
});

test("sounding recovery telemetry preserves ascent and apogee for comparison", () => {
  const sim = new FlightSimulation(DEFAULT_BLUEPRINT);
  for (let tick = 0; tick < 12000 && sim.status === "flying"; tick += 1) {
    sim.update();
    const snapshot = sim.snapshot();
    if (!sim.parachuteDeployed && snapshot.altitude < 7500 && snapshot.verticalSpeed < 0) sim.deployParachute();
  }
  assert.equal(sim.status, "landed");
  assert.ok(sim.telemetry[0].time < 1);
  assert.ok(Math.max(...sim.telemetry.map((sample) => sample.altitude)) > 10000);
  assert.ok(sim.telemetry.length <= 2400);
});
