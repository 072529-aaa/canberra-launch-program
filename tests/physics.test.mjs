import test from "node:test";
import assert from "node:assert/strict";

import {
  ATMOSPHERE_HEIGHT,
  FlightSimulation,
  PLANET_MU,
  PLANET_RADIUS,
  atmosphereDensity,
  circularOrbitSpeed,
  orbitalElements,
} from "../src/physics.js";

test("atmosphere density decreases with altitude and ends at vacuum", () => {
  const seaLevel = atmosphereDensity(0);
  const tenKm = atmosphereDensity(10000);
  assert.ok(seaLevel > tenKm);
  assert.equal(atmosphereDensity(ATMOSPHERE_HEIGHT), 0);
});

test("circular orbit has nearly equal apoapsis and periapsis", () => {
  const altitude = 80000;
  const speed = circularOrbitSpeed(altitude);
  const elements = orbitalElements(
    [0, PLANET_RADIUS + altitude],
    [speed, 0],
  );

  assert.ok(Math.abs(elements.apoapsisAltitude - altitude) < 5);
  assert.ok(Math.abs(elements.periapsisAltitude - altitude) < 5);
  assert.ok(elements.period > 1000);
  assert.ok(Math.abs(elements.specificEnergy + (PLANET_MU / (2 * (PLANET_RADIUS + altitude)))) < 1);
});

test("default rocket clears the pad under full throttle", () => {
  const blueprint = [
    "cmd_mk1",
    "parachute",
    "tank_s",
    "engine_kestrel",
    "fins",
  ];
  const simulation = new FlightSimulation(blueprint);
  simulation.runSteps(200, { throttle: 1 });
  const snapshot = simulation.snapshot();

  assert.equal(snapshot.status, "flying");
  assert.ok(snapshot.altitude > 100);
  assert.ok(snapshot.verticalSpeed > 20);
  assert.ok(snapshot.mass < simulation.craft.totalMass);
});

test("fixed-step integration remains finite during a long ascent", () => {
  const blueprint = [
    "cmd_mk1",
    "parachute",
    "tank_l",
    "engine_falcon",
    "fins",
  ];
  const simulation = new FlightSimulation(blueprint);
  simulation.runSteps(4000, { throttle: 1 });
  const snapshot = simulation.snapshot();

  assert.ok(Number.isFinite(snapshot.position[0]));
  assert.ok(Number.isFinite(snapshot.position[1]));
  assert.ok(Number.isFinite(snapshot.speed));
  assert.ok(snapshot.maxAltitude > 10000);
});

test("default sounding rocket can reach 10 km and recover under parachute", () => {
  const simulation = new FlightSimulation([
    "cmd_mk1",
    "parachute",
    "tank_s",
    "engine_kestrel",
    "fins",
  ]);
  let deployed = false;
  for (let index = 0; index < 12000 && simulation.status === "flying"; index += 1) {
    simulation.update(0.05, { throttle: 1, rotation: 0 });
    const snapshot = simulation.snapshot();
    if (!deployed && snapshot.altitude < 8000 && snapshot.verticalSpeed < 0) {
      simulation.deployParachute();
      deployed = true;
    }
  }
  const snapshot = simulation.snapshot();
  assert.equal(snapshot.status, "landed");
  assert.ok(snapshot.maxAltitude > 10000);
  assert.equal(deployed, true);
});
