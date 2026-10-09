import test from "node:test";
import assert from "node:assert/strict";

import { GameState } from "../src/state.js";

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }
}

test("launch reservation deducts hardware cost and records the build", () => {
  const game = new GameState(new MemoryStorage());
  const before = game.state.resources.funds;
  const result = game.reserveLaunch();

  assert.equal(result.ok, true);
  assert.equal(game.state.resources.funds, before - game.craft.totalCost);
  assert.equal(game.state.launchReservations.length, 1);
});

test("successful mission settlement advances to the next unlocked contract", () => {
  const game = new GameState(new MemoryStorage());
  game.settleMission({
    contractId: "sounding_one",
    success: true,
    status: "landed",
    funds: 20000,
    science: 14,
    reputation: 4,
  });

  assert.ok(game.state.completedContracts.includes("sounding_one"));
  assert.equal(game.state.activeContractId, "orbit_one");
  assert.equal(game.state.resources.reputation, 4);
  assert.equal(game.state.missionHistory.length, 1);
});

test("research and base upgrades enforce and spend their costs", () => {
  const game = new GameState(new MemoryStorage());
  const scienceBefore = game.state.resources.science;
  const research = game.unlockTech("engineering");
  assert.equal(research.ok, true);
  assert.equal(game.state.resources.science, scienceBefore - 18);

  const fundsBefore = game.state.resources.funds;
  const upgrade = game.upgradeBase("launch_pad");
  assert.equal(upgrade.ok, true);
  assert.equal(game.state.base.launch_pad, 1);
  assert.equal(game.state.resources.funds, fundsBefore - 22000);
});
