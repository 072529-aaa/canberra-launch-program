export class FixedStepClock {
  constructor(step = 0.05, budget = 80) {
    this.step = step;
    this.budget = budget;
    this.accumulator = 0;
  }

  reset() { this.accumulator = 0; }

  advance(delta, warp, update) {
    if (!Number.isFinite(delta) || !Number.isFinite(warp)) return 0;
    this.accumulator += Math.max(0, delta) * Math.max(0, warp);
    let count = 0;
    while (this.accumulator + 1e-10 >= this.step && count < this.budget) {
      this.accumulator = Math.max(0, this.accumulator - this.step);
      count += 1;
      if (update(this.step) === false) { this.reset(); break; }
    }
    return count;
  }
}
