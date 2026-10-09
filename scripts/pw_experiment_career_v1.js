async (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const require = (value, message) => { if (!value) throw new Error(message); };
  await page.goto(new URL("./", page.url()).href);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForFunction(() => window.gameApp?.assemblyScene?.renderer);
  await page.getByRole("button", { name: "恢复基础构型", exact: true }).click();
  await page.locator("#sheet-confirm").click();
  const before = await page.evaluate(() => ({ ...window.gameApp.game.state.resources }));
  const fly = async () => {
    await page.getByRole("button", { name: "试飞检查", exact: true }).click();
    await page.getByRole("button", { name: "批准发射", exact: true }).click();
    await page.waitForFunction(() => window.gameApp.flight?.started);
    await page.locator("#throttle-input").focus();
    await page.keyboard.press("End");
    await page.getByRole("button", { name: "×20", exact: true }).click();
    const deadline = Date.now() + 45000;
    let opened = false;
    while (Date.now() < deadline) {
      const flight = await page.evaluate(() => window.gameApp.flight?.sim.snapshot() || null);
      if (!flight) break;
      if (!opened && flight.altitude < 7500 && flight.verticalSpeed < 0) {
        await page.getByRole("button", { name: "开伞", exact: true }).click();
        opened = true;
      }
      // The real-time desktop/mobile flight is covered separately. Advance the
      // same fixed-step core here so three settlement checks are not GPU-bound.
      await page.evaluate(() => window.gameApp.flight?.sim.runSteps(80));
      await page.waitForTimeout(15);
    }
    require(await page.evaluate(() => !window.gameApp.flight), `Flight did not terminate: ${JSON.stringify(await page.evaluate(() => window.gameApp.flight?.sim.snapshot()))}`);
    return page.evaluate(() => ({
      altitude: window.gameApp.lastMission.snapshot.maxAltitude,
      status: window.gameApp.lastMission.snapshot.status,
      success: window.gameApp.lastMission.settlement.success,
      resources: { ...window.gameApp.game.state.resources },
      mass: window.gameApp.lastMission.metrics.mass,
      lab: window.gameApp.lastMission.labMode,
    }));
  };
  const full = await fly();
  require(full.status === "landed" && full.success && full.lab, "First experiment failed");
  await page.getByRole("button", { name: "继续组装", exact: true }).click();
  await page.getByRole("button", { name: "FUEL LT-900", exact: true }).click();
  await page.getByRole("slider", { name: "燃料装填", exact: true }).focus();
  await page.keyboard.press("Home");
  for (let index = 0; index < 10; index += 1) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Tab");
  const half = await fly();
  require(half.status === "landed" && half.mass === 2045 && half.altitude < full.altitude, "Half-fuel experiment failed");
  require(await page.getByRole("heading", { name: "与上次试飞对照", exact: true }).count() === 1, "Comparison not displayed");
  require(await page.getByText("探空高度未达标", { exact: true }).count() > 0, "Sounding failure diagnosis is incorrect");
  require(JSON.stringify(before) === JSON.stringify(half.resources), "Experiments changed career resources");
  await page.screenshot({ path: "output/playwright/assembly-v1-comparison.png", fullPage: true });

  await page.getByRole("button", { name: "继续组装", exact: true }).click();
  await page.getByRole("button", { name: "发动机 3/3", exact: true }).click();
  await page.getByRole("button", { name: /ENG 极光 V-6/ }).click();
  await page.getByRole("button", { name: "经营", exact: true }).click();
  require(await page.getByRole("button", { name: "试飞检查", exact: true }).isDisabled(), "Career accepted locked part or overlapping engine");
  await page.getByRole("button", { name: "恢复基础构型", exact: true }).click();
  await page.locator("#sheet-confirm").click();
  const career = await fly();
  require(career.status === "landed" && career.success && !career.lab, "Career sounding path failed");
  const expectedFunds = await page.evaluate(() => window.gameApp.lastMission.settlement.funds);
  require(career.resources.funds === before.funds - 14100 + expectedFunds, "Career launch deduction or reward is incorrect");
  const history = await page.evaluate(() => ({ reservations: window.gameApp.game.state.launchReservations.length, missions: window.gameApp.game.state.missionHistory.length }));
  require(history.reservations === 1 && history.missions === 1, "Career did not record exactly one flight");
  await page.screenshot({ path: "output/playwright/assembly-v1-career-result.png", fullPage: true });
  require(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  return { full, half, career, history, errors };
}
