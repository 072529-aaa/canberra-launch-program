async (page) => {
  const siteUrl = new URL("./", page.url()).href;
  const context = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mobile = await context.newPage();
  const errors = [];
  mobile.on("pageerror", (error) => errors.push(error.message));
  const require = (value, message) => { if (!value) throw new Error(message); };
  try {
    await mobile.goto(siteUrl);
    await mobile.waitForFunction(() => window.gameApp?.assemblyScene?.renderer);
    await mobile.screenshot({ path: "output/playwright/assembly-v1-touch.png" });
    await mobile.getByRole("button", { name: "ENG K-1", exact: true }).tap();
    const slider = mobile.getByRole("slider", { name: "横向安装", exact: true });
    await slider.scrollIntoViewIfNeeded();
    const box = await slider.boundingBox();
    await mobile.touchscreen.tap(box.x + box.width * 0.75, box.y + box.height / 2);
    const offset = await mobile.evaluate(() => window.gameApp.game.state.partConfigs[3].x);
    require(offset > 0.2, "Touch slider failed");
    await mobile.getByRole("button", { name: "镜像安装发动机", exact: true }).tap();
    require(await mobile.evaluate(() => document.querySelector("#assembly-torque").textContent) === "0 N·m", "Touch mirror failed");
    await mobile.getByRole("button", { name: "撤销", exact: true }).tap();
    await mobile.getByRole("button", { name: "恢复基础构型", exact: true }).tap();
    await mobile.locator("#sheet-confirm").tap();
    await mobile.getByRole("button", { name: "试飞检查", exact: true }).tap();
    await mobile.getByRole("button", { name: "批准发射", exact: true }).tap();
    await mobile.waitForFunction(() => window.gameApp.flight?.started);
    const throttle = mobile.locator("#throttle-input");
    const throttleBox = await throttle.boundingBox();
    await mobile.touchscreen.tap(throttleBox.x + throttleBox.width - 1, throttleBox.y + throttleBox.height / 2);
    await mobile.getByRole("button", { name: "×20", exact: true }).tap();
    await mobile.waitForFunction(() => window.gameApp.flight?.sim.time > 3);
    await mobile.screenshot({ path: "output/playwright/assembly-v1-flight-touch.png" });
    const pixelCheck = await mobile.evaluate(() => {
      const scene = window.gameApp.flightScene;
      scene.render();
      const gl = scene.renderer.getContext();
      const values = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, values);
      let nonBackground = 0;
      for (let index = 0; index < values.length; index += 4 * 23) {
        if (Math.abs(values[index] - values[0]) + Math.abs(values[index + 1] - values[1]) + Math.abs(values[index + 2] - values[2]) > 25) nonBackground += 1;
      }
      return nonBackground;
    });
    require(pixelCheck > 100, "Blank touch flight canvas");
    let opened = false;
    for (let pass = 0; pass < 200; pass += 1) {
      const flight = await mobile.evaluate(() => window.gameApp.flight?.sim.snapshot() || null);
      if (!flight) break;
      if (!opened && flight.altitude < 7500 && flight.verticalSpeed < 0) {
        await mobile.getByRole("button", { name: "开伞", exact: true }).tap();
        opened = true;
      }
      await mobile.evaluate(() => window.gameApp.flight?.sim.runSteps(80));
      await mobile.waitForTimeout(15);
    }
    await mobile.waitForFunction(() => !window.gameApp.flight);
    const result = await mobile.evaluate(() => ({ status: window.gameApp.lastMission.snapshot.status, success: window.gameApp.lastMission.settlement.success }));
    require(result.status === "landed" && result.success, "Touch recovery failed");
    require(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Touch result overflow");
    await mobile.screenshot({ path: "output/playwright/assembly-v1-result-mobile.png", fullPage: true });
    require(errors.length === 0, `Page errors: ${errors.join("; ")}`);
    await page.goto(siteUrl);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForFunction(() => window.gameApp?.assemblyScene?.renderer);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "output/playwright/assembly-v1-desktop.png" });
    return { offset, pixelCheck, result, errors };
  } finally {
    await context.close();
  }
}
