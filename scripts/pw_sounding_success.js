async (page) => {
  const parseDistance = (text) => {
    const value = Number.parseFloat(text);
    if (!Number.isFinite(value)) return Number.NaN;
    return text.includes("km") ? value * 1000 : value;
  };

  await page.getByRole("button", { name: "总装车间", exact: true }).click();
  await page.getByRole("button", { name: "发射前检查" }).click();
  await page.getByRole("button", { name: "批准发射" }).click();
  await page.waitForSelector("#flight-canvas");
  await page.getByRole("button", { name: "×20" }).click();

  for (let index = 0; index < 1600; index += 1) {
    const altitude = parseDistance(
      await page.locator("#hud-altitude").textContent(),
    );
    const vertical = Number.parseFloat(
      await page.locator("#hud-vertical").textContent(),
    );
    if (altitude < 8000 && vertical < 0) {
      await page.getByRole("button", { name: "降落伞" }).click();
      break;
    }
    if ((await page.locator("#flight-canvas").count()) === 0) break;
    await page.waitForTimeout(40);
  }

  for (let index = 0; index < 800; index += 1) {
    const heading = await page
      .locator("h1")
      .first()
      .textContent()
      .catch(() => "");
    if (
      heading === "任务完成" ||
      heading === "回收阶段触地速度过高" ||
      heading === "箭体在飞行中损毁"
    ) {
      break;
    }
    await page.waitForTimeout(40);
  }

  return {
    heading: await page.locator("h1").first().textContent(),
    body: await page.locator("body").textContent(),
  };
}
