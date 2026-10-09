async (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const require = (value, message) => { if (!value) throw new Error(message); };
  const fresh = async () => {
    await page.waitForFunction(() => window.gameApp?.assemblyScene?.renderer);
    await page.waitForTimeout(250);
  };
  const pixels = () => page.evaluate(() => {
    const scene = window.gameApp.assemblyScene || window.gameApp.flightScene;
    if (scene.model) scene.renderer.render(scene.scene, scene.camera); else scene.render();
    const gl = scene.renderer.getContext();
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const values = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, values);
    let different = 0;
    const colors = new Set();
    for (let index = 0; index < values.length; index += 4 * 19) {
      const r = values[index], g = values[index + 1], b = values[index + 2];
      if (Math.abs(r - values[0]) + Math.abs(g - values[1]) + Math.abs(b - values[2]) > 25) different += 1;
      colors.add(`${r >> 3}:${g >> 3}:${b >> 3}`);
    }
    return { width, height, different, colors: colors.size };
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(new URL("./", page.url()).href);
  await fresh();
  await page.getByRole("button", { name: "恢复基础构型", exact: true }).click();
  await page.locator(".sheet-panel").getByRole("button", { name: "确认", exact: true }).click();
  await fresh();
  const baselineResources = await page.evaluate(() => ({ ...window.gameApp.game.state.resources }));
  await page.getByRole("button", { name: "ENG K-1", exact: true }).click();
  await page.getByRole("slider", { name: "横向安装", exact: true }).focus();
  await page.keyboard.press("Home");
  for (let index = 0; index < 24; index += 1) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Tab");
  const offsetTorque = await page.locator("#assembly-torque").textContent();
  require(Number.parseInt(offsetTorque.replaceAll(",", "")) > 10000, "Offset engine did not change torque");
  await page.getByRole("button", { name: "镜像安装发动机", exact: true }).click();
  await fresh();
  const mirrored = await page.evaluate(() => ({ count: window.gameApp.game.state.blueprint.length, torque: document.querySelector("#assembly-torque").textContent }));
  require(mirrored.count === 6 && mirrored.torque === "0 N·m", "Mirror engines did not balance");
  await page.screenshot({ path: "output/playwright/assembly-v1-mirror.png" });
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await fresh();
  require(await page.evaluate(() => window.gameApp.game.state.blueprint.length) === 5, "Undo did not restore blueprint");

  const point = await page.evaluate(() => {
    const scene = window.gameApp.assemblyScene;
    scene.scene.updateMatrixWorld(true);
    const entry = scene.model.parts.find((part) => part.part.thrust);
    const vector = entry.object.position.clone();
    entry.object.parent.localToWorld(vector);
    vector.project(scene.camera);
    const box = scene.renderer.domElement.getBoundingClientRect();
    return { x: box.left + (vector.x + 1) * box.width / 2, y: box.top + (1 - vector.y) * box.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x - 25, point.y, { steps: 8 });
  await page.mouse.up();
  await fresh();
  const dragged = await page.evaluate(() => window.gameApp.game.state.partConfigs[3].x);
  require(dragged !== 0.5, "Dragging engine did not change saved position");

  await page.getByRole("button", { name: "恢复基础构型", exact: true }).click();
  await page.locator(".sheet-panel").getByRole("button", { name: "确认", exact: true }).click();
  await fresh();
  await page.getByRole("button", { name: "FUEL LT-900", exact: true }).click();
  await page.getByRole("slider", { name: "燃料装填", exact: true }).focus();
  await page.keyboard.press("Home");
  for (let index = 0; index < 10; index += 1) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Tab");
  const halfMass = await page.evaluate(() => window.gameApp.game.craft.totalMass);
  require(halfMass === 2045, "Fuel slider did not change actual mass");
  await page.screenshot({ path: "output/playwright/assembly-v1-desktop.png" });
  const desktopPixels = await pixels();
  require(desktopPixels.different > 100 && desktopPixels.colors > 20, "Blank desktop canvas");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await fresh();
  await page.evaluate(() => window.scrollTo(0, 0));
  require(await page.evaluate(() => window.gameApp.game.state.partConfigs[2].fuelFraction) === 1, "Fuel undo did not restore full tank");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  require(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Mobile horizontal overflow");
  await page.screenshot({ path: "output/playwright/assembly-v1-mobile.png" });
  const mobilePixels = await pixels();
  require(mobilePixels.different > 100, "Blank mobile canvas");
  await page.getByRole("button", { name: "ENG K-1", exact: true }).click();
  await page.getByRole("slider", { name: "发动机倾角", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Tab");
  require(await page.evaluate(() => window.gameApp.game.state.partConfigs[3].angle) === 1, "Mobile angle control failed");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await fresh();

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "试飞检查", exact: true }).click();
  await page.getByRole("button", { name: "批准发射", exact: true }).click();
  await page.waitForFunction(() => window.gameApp.flight?.started === true);
  await page.getByRole("slider", { name: /节流阀/ }).focus();
  await page.keyboard.press("End");
  await page.getByRole("button", { name: "×20", exact: true }).click();
  await page.waitForFunction(() => window.gameApp.flight?.sim.time > 3);
  const initialPosition = await page.evaluate(() => [...window.gameApp.flight.sim.position]);
  await page.screenshot({ path: "output/playwright/assembly-v1-flight-desktop.png" });
  const flightPixels = await pixels();
  require(flightPixels.different > 100 && flightPixels.colors > 20, "Blank flight canvas");
  await page.waitForTimeout(400);
  require(await page.evaluate((position) => window.gameApp.flight.sim.position[1] !== position[1], initialPosition), "Flight is not moving");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: "output/playwright/assembly-v1-flight-mobile.png" });
  const deadline = Date.now() + 65000;
  let opened = false;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.gameApp.flight ? {
      altitude: window.gameApp.flight.sim.snapshot().altitude,
      verticalSpeed: window.gameApp.flight.sim.snapshot().verticalSpeed,
      status: window.gameApp.flight.sim.status,
      parachute: window.gameApp.flight.sim.parachuteDeployed,
    } : null);
    if (!state) break;
    if (!opened && state.altitude < 7500 && state.verticalSpeed < 0) {
      await page.getByRole("button", { name: "开伞", exact: true }).click();
      opened = true;
    }
    await page.waitForTimeout(60);
  }
  await page.waitForFunction(() => !window.gameApp.flight, { timeout: 1000 });
  const result = await page.evaluate(() => ({
    snapshot: window.gameApp.lastMission.snapshot,
    success: window.gameApp.lastMission.settlement.success,
    lab: window.gameApp.lastMission.labMode,
    resources: window.gameApp.game.state.resources,
    reservations: window.gameApp.game.state.launchReservations.length,
    history: window.gameApp.game.state.missionHistory.length,
  }));
  require(result.snapshot.status === "landed" && result.success && result.snapshot.maxAltitude > 10000, `Default rocket did not recover: ${JSON.stringify(result)}`);
  require(JSON.stringify(baselineResources) === JSON.stringify(result.resources) && result.reservations === 0 && result.history === 0, "Experiment changed career resources");
  await page.screenshot({ path: "output/playwright/assembly-v1-result-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: "output/playwright/assembly-v1-result-desktop.png", fullPage: true });
  require(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  return { desktopPixels, mobilePixels, flightPixels, offsetTorque, mirrored, dragged, halfMass,
    recovery: { status: result.snapshot.status, altitude: result.snapshot.maxAltitude, time: result.snapshot.time, success: result.success },
    resourcesUnchanged: true, errors };
}
