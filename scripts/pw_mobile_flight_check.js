async (page) => {
  if ((await page.getByRole("button", { name: "发射前检查" }).count()) === 0) {
    await page.getByRole("button", { name: "总装车间", exact: true }).click();
  }
  await page.getByRole("button", { name: "发射前检查" }).click();
  await page.getByRole("button", { name: "批准发射" }).click();
  await page.waitForSelector("#flight-canvas");
  await page.waitForTimeout(350);

  return page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    };
    const overlaps = (a, b) =>
      a &&
      b &&
      a.left < b.right &&
      a.right > b.left &&
      a.top < b.bottom &&
      a.bottom > b.top;
    const hud = rect(".flight-hud");
    const mission = rect(".mission-chip");
    const log = rect(".flight-log");
    const controls = rect(".flight-controls");
    const canvas = document.querySelector("#flight-canvas");
    const context = canvas?.getContext("2d");
    const pixels =
      context && canvas.width && canvas.height
        ? context.getImageData(0, 0, canvas.width, canvas.height).data
        : null;
    let nonBlank = 0;
    if (pixels) {
      for (let index = 0; index < pixels.length; index += 64) {
        if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 30) {
          nonBlank += 1;
        }
      }
    }

    return {
      viewport: [innerWidth, innerHeight],
      bodyWidth: document.body.scrollWidth,
      canvas: canvas ? [canvas.width, canvas.height] : null,
      nonBlankSamples: nonBlank,
      overlaps: {
        hudMission: overlaps(hud, mission),
        missionLog: overlaps(mission, log),
        logControls: overlaps(log, controls),
        hudControls: overlaps(hud, controls),
      },
      controls: controls,
    };
  });
}
