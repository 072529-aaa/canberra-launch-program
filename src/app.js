import {
  BASE_UPGRADES,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  CONTRACTS,
  PARTS,
  TECH_NODES,
  getPart,
  requiredTechForPart,
} from "./data.js";
import {
  DEFAULT_BLUEPRINT,
  compileCraft,
  craftSummary,
  formatMass,
  formatMoney,
  getStageDeltaV,
  getStageTWR,
  getTotalDeltaV,
  validateCraft,
} from "./craft.js";
import {
  ATMOSPHERE_HEIGHT,
  DEFAULT_TIME_STEP,
  FlightSimulation,
  PLANET_RADIUS,
  circularOrbitSpeed,
  formatDuration,
  orbitalElements,
} from "./physics.js";
import {
  analyzeFailure,
  evaluateObjectives,
  settleMission,
  statusLabel,
} from "./missions.js";
import { GameState, getBaseUpgradeState } from "./state.js";
import { FixedStepClock } from "./clock.js";

const PART_ABBR = {
  command: "CMD",
  engine: "ENG",
  fuel: "FUEL",
  structure: "STR",
  aero: "AER",
  control: "RCS",
  power: "PWR",
  payload: "PAY",
  recovery: "REC",
};

const STATUS_CLASS = {
  pass: "pass",
  warn: "warn",
  fail: "fail",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function number(value, digits = 1) {
  if (!Number.isFinite(value)) return value > 0 ? "∞" : "--";
  return value.toLocaleString("zh-CN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function integer(value) {
  if (!Number.isFinite(value)) return value > 0 ? "∞" : "--";
  return Math.round(value).toLocaleString("zh-CN");
}

function distance(value) {
  if (!Number.isFinite(value)) return "逃逸";
  const absolute = Math.abs(value);
  if (absolute >= 1000) {
    return `${(value / 1000).toFixed(absolute >= 100000 ? 0 : 1)} km`;
  }
  return `${Math.round(value)} m`;
}

function orbitalDistance(value) {
  if (!Number.isFinite(value)) return "逃逸";
  if (value < -PLANET_RADIUS) return "无";
  return distance(value);
}

function money(value) {
  return `₡${integer(value)}`;
}

function iconForPart(part) {
  return PART_ABBR[part.category] || "P";
}

function objectiveStatus(contract, snapshot) {
  return evaluateObjectives(contract, snapshot);
}

class GameApp {
  constructor() {
    this.game = new GameState();
    this.view = document.querySelector("#view");
    this.resourceStrip = document.querySelector("#resource-strip");
    this.topActions = document.querySelector("#top-actions");
    this.toastRegion = document.querySelector("#toast-region");
    this.modalRegion = document.querySelector("#modal-region");
    this.screen = "home";
    this.techTab = "research";
    this.flight = null;
    this.flightMetrics = null;
    this.activeLaunch = null;
    this.lastMission = null;
    this.animationFrame = null;
    this.lastFrameAt = 0;
    this.keys = new Set();
    this.pointerRotation = 0;
    this.stars = this.createStars();
    this.bindEvents();
    this.render();
  }

  bindEvents() {
    document.querySelector("#brand-home").addEventListener("click", () => {
      if (this.screen === "flight") {
        this.toast("飞行中无法返回主界面。", "warn");
        return;
      }
      this.navigate("home");
    });

    this.view.addEventListener("click", (event) => this.handleClick(event));
    this.topActions.addEventListener("click", (event) => this.handleClick(event));
    this.view.addEventListener("input", (event) => this.handleInput(event));
    this.view.addEventListener("pointerdown", (event) => this.handlePointerDown(event));
    window.addEventListener("pointerup", () => this.releasePointerControls());
    window.addEventListener("keydown", (event) => this.handleKeyDown(event));
    window.addEventListener("keyup", (event) => this.handleKeyUp(event));
    window.addEventListener("resize", () => this.resizeFlightCanvas());
  }

  createStars() {
    let seed = 90210;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    return Array.from({ length: 180 }, () => ({
      x: random(),
      y: random(),
      size: 0.4 + random() * 1.5,
      alpha: 0.35 + random() * 0.65,
    }));
  }

  navigate(screen) {
    if (this.screen === "flight" && screen !== "flight") {
      this.stopFlightLoop();
    }
    this.screen = screen;
    this.render();
  }

  render() {
    this.renderChrome();
    if (this.screen === "home") this.renderHome();
    if (this.screen === "editor") this.renderEditor();
    if (this.screen === "preflight") this.renderPreflight();
    if (this.screen === "flight") this.renderFlight();
    if (this.screen === "results") this.renderResults();
    if (this.screen === "analysis") this.renderAnalysis();
    if (this.screen === "research") this.renderResearch();
    this.view.focus({ preventScroll: true });
  }

  renderChrome() {
    const { funds, science, reputation } = this.game.state.resources;
    this.resourceStrip.innerHTML = `
      <div class="resource-chip"><span>资金</span><strong>${money(funds)}</strong></div>
      <div class="resource-chip"><span>科研</span><strong>${integer(science)} SP</strong></div>
      <div class="resource-chip"><span>声誉</span><strong>${integer(reputation)}</strong></div>
    `;

    const actions = [];
    if (this.screen !== "home") {
      actions.push(`<button class="button small" type="button" data-action="nav-home" aria-label="任务中心" title="任务中心"><span>任务</span></button>`);
    }
    if (this.screen !== "editor") {
      actions.push(`<button class="button small" type="button" data-action="nav-editor" aria-label="总装车间" title="总装车间"><span>装配</span></button>`);
    }
    if (this.screen !== "research") {
      actions.push(`<button class="button small" type="button" data-action="nav-research" aria-label="研发基地" title="研发基地"><span>研发</span></button>`);
    }
    this.topActions.innerHTML = actions.join("");
  }

  renderHome() {
    const contract = this.game.activeContract;
    const metrics = craftSummary(this.game.state.blueprint, this.game.state.unlockedTech, this.game.state.partConfigs);
    const lastMission = this.game.state.missionHistory[0];
    const completed = new Set(this.game.state.completedContracts);
    const available = this.game.availableContracts;

    this.view.innerHTML = `
      <section class="screen">
        <div class="home-grid">
          <div class="side-stack">
            <article class="mission-hero">
              <div class="mission-hero-content">
                <p class="eyebrow">当前合同 / ${escapeHtml(contract.client)}</p>
                <h1>${escapeHtml(contract.name)}</h1>
                <p class="lead">${escapeHtml(contract.summary)}</p>
                <ul class="objective-list">
                  ${contract.objectives
                    .map(
                      (objective) => `
                        <li>
                          <span class="status-mark">○</span>
                          <span>${escapeHtml(objective.label)}</span>
                        </li>
                      `,
                    )
                    .join("")}
                </ul>
                <div class="hero-actions">
                  <button class="button primary" type="button" data-action="nav-editor">进入总装车间</button>
                  <button class="button" type="button" data-action="nav-research">研发与基地</button>
                </div>
              </div>
            </article>

            <section class="panel">
              <div class="panel-header">
                <h2>合同板</h2>
                <span class="muted">${available.length} 个可用</span>
              </div>
              <div class="panel-body">
                <ul class="upgrade-list">
                  ${CONTRACTS.map((item) => {
                    const isAvailable = available.includes(item);
                    const isCompleted = completed.has(item.id);
                    const isActive = item.id === contract.id;
                    return `
                      <li class="upgrade-item">
                        <div class="upgrade-head">
                          <strong>${escapeHtml(item.name)}</strong>
                          <span class="${isCompleted ? "green" : isActive ? "cyan" : "dim"}">
                            ${isCompleted ? "已完成" : isActive ? "执行中" : isAvailable ? "可接受" : `声誉 ${item.unlock.reputation}`}
                          </span>
                        </div>
                        <p>${escapeHtml(item.summary)}</p>
                        <div class="button-row">
                          <span class="tag">${money(item.reward.funds)}</span>
                          <span class="tag">${item.reward.science} SP</span>
                          <span class="tag">+${item.reward.reputation} 声誉</span>
                          ${
                            isAvailable && !isCompleted && !isActive
                              ? `<button class="button small" type="button" data-action="choose-contract" data-contract="${item.id}">接受</button>`
                              : ""
                          }
                        </div>
                      </li>
                    `;
                  }).join("")}
                </ul>
              </div>
            </section>
          </div>

          <div class="side-stack">
            <section class="panel">
              <div class="panel-header"><h2>现役火箭</h2><span class="${metrics.valid ? "green" : "red"}">${metrics.valid ? "可发射" : "需调整"}</span></div>
              <div class="panel-body">
                <div class="stat-row"><span>湿重</span><strong>${formatMass(metrics.mass)}</strong></div>
                <div class="stat-row"><span>硬件成本</span><strong>${money(metrics.cost)}</strong></div>
                <div class="stat-row"><span>估算 Δv</span><strong>${integer(metrics.deltaV)} m/s</strong></div>
                <div class="stat-row"><span>起飞 TWR</span><strong>${number(metrics.twr, 2)}</strong></div>
                <div class="stat-row"><span>推进级</span><strong>${metrics.stageCount}</strong></div>
                <div class="stat-row"><span>零件</span><strong>${metrics.parts}</strong></div>
              </div>
            </section>

            <section class="panel">
              <div class="panel-header"><h2>项目状态</h2></div>
              <div class="panel-body">
                <div class="stat-row"><span>已解锁技术</span><strong>${this.game.state.unlockedTech.length}/${TECH_NODES.length}</strong></div>
                <div class="stat-row"><span>完成合同</span><strong>${completed.size}/${CONTRACTS.length}</strong></div>
                <div class="stat-row"><span>回收率</span><strong>${Math.round(this.game.limits.recoveryRate * 100)}%</strong></div>
                <div class="stat-row"><span>科研倍率</span><strong>${number(this.game.limits.researchMultiplier, 2)}×</strong></div>
              </div>
            </section>

            <section class="panel">
              <div class="panel-header"><h2>最近飞行</h2></div>
              <div class="panel-body">
                ${
                  lastMission
                    ? `
                      <div class="stat-row"><span>合同</span><strong>${escapeHtml(CONTRACTS.find((item) => item.id === lastMission.contractId)?.name || "--")}</strong></div>
                      <div class="stat-row"><span>结果</span><strong class="${lastMission.success ? "green" : "red"}">${lastMission.success ? "成功" : "未完成"}</strong></div>
                      <div class="stat-row"><span>科研入账</span><strong>+${lastMission.science} SP</strong></div>
                      <div class="stat-row"><span>资金入账</span><strong>${money(lastMission.funds)}</strong></div>
                    `
                    : `<p>尚未执行任务。</p>`
                }
              </div>
            </section>
          </div>
        </div>
      </section>
    `;
  }

  renderEditor() {
    const blueprint = this.game.state.blueprint;
    const validation = this.getValidation();
    const metrics = craftSummary(blueprint, this.game.state.unlockedTech, this.game.state.partConfigs);
    const stageMap = this.getStageMap(blueprint);

    const groups = CATEGORY_ORDER.map((category) => {
      const parts = Object.values(PARTS).filter((part) => part.category === category);
      return `
        <div class="category-title">${CATEGORY_LABELS[category]}</div>
        ${parts
          .map((part) => {
            const unlocked = this.game.isPartUnlocked(part.id);
            const requiredTech = requiredTechForPart(part.id);
            const atLimit = blueprint.length >= this.game.limits.maxParts;
            return `
              <button
                class="part-button"
                type="button"
                data-action="add-part"
                data-part="${part.id}"
                ${!unlocked || atLimit ? "disabled" : ""}
                title="${escapeHtml(part.description)}"
              >
                <span class="part-icon">${iconForPart(part)}</span>
                <span>
                  <strong>${escapeHtml(part.name)}</strong>
                  <small>${unlocked ? formatMass(part.mass) : `需研发：${escapeHtml(requiredTech?.name || "未知")}`}</small>
                </span>
                <span class="part-cost">${money(part.cost)}</span>
              </button>
            `;
          })
          .join("")}
      `;
    }).join("");

    this.view.innerHTML = `
      <section class="screen">
        <div class="section-head">
          <div>
            <p class="eyebrow">总装车间</p>
            <h1>航天器构型</h1>
            <p>堆叠顺序从上到下。分离器会切开推进级，并在飞行中启用下一级。</p>
          </div>
          <div class="button-row">
            <button class="button" type="button" data-action="reset-blueprint">恢复示例</button>
            <button class="button primary" type="button" data-action="nav-preflight" ${validation.valid ? "" : "disabled"}>发射前检查</button>
          </div>
        </div>

        <div class="editor-layout">
          <section class="panel catalog-panel">
            <div class="panel-header">
              <h2>零件目录</h2>
              <span class="muted">${blueprint.length}/${this.game.limits.maxParts}</span>
            </div>
            <div class="catalog-body">${groups}</div>
          </section>

          <section class="panel blueprint-panel">
            <div class="panel-header">
              <h2>堆叠视图</h2>
              <span class="${metrics.valid ? "green" : "red"}">${metrics.valid ? "构型有效" : "检查未通过"}</span>
            </div>
            <div class="blueprint-body">
              <ul class="blueprint-list">
                ${blueprint
                  .map((partId, index) => {
                    const part = getPart(partId);
                    const stage = stageMap.get(index);
                    return `
                      <li class="blueprint-item ${part.category} ${part.splitStage ? "stage" : ""}">
                        <span class="stack-icon">${iconForPart(part)}</span>
                        <span class="blueprint-copy">
                          <strong>${escapeHtml(part.name)}</strong>
                          <small>${formatMass(part.mass)} · ${money(part.cost)} · ${part.splitStage ? "分界" : `第 ${stage + 1} 级`}</small>
                        </span>
                        <span class="item-actions">
                          <button class="icon-action" type="button" data-action="move-part" data-index="${index}" data-direction="-1" title="上移" ${index === 0 ? "disabled" : ""}>↑</button>
                          <button class="icon-action" type="button" data-action="move-part" data-index="${index}" data-direction="1" title="下移" ${index === blueprint.length - 1 ? "disabled" : ""}>↓</button>
                          <button class="icon-action" type="button" data-action="remove-part" data-index="${index}" title="移除">×</button>
                        </span>
                      </li>
                    `;
                  })
                  .join("")}
              </ul>
              ${blueprint.length === 0 ? `<p class="editor-note">从左侧目录加入指令舱、燃料箱和发动机。</p>` : ""}
              <p class="editor-note">顶部需要指令单元。每个分离段底部需要发动机，质心越靠前，火箭越容易保持稳定。</p>
            </div>
          </section>

          <section class="panel performance-panel">
            <div class="panel-header"><h2>性能与检查</h2></div>
            <div class="panel-body">
              <div class="stat-row"><span>湿重</span><strong>${formatMass(validation.craft.totalMass)}</strong></div>
              <div class="stat-row"><span>干重</span><strong>${formatMass(validation.craft.totalDryMass)}</strong></div>
              <div class="stat-row"><span>燃料</span><strong>${formatMass(validation.craft.totalFuelMass)}</strong></div>
              <div class="stat-row"><span>硬件成本</span><strong>${money(validation.craft.totalCost)}</strong></div>
              <div class="stat-row"><span>估算 Δv</span><strong>${integer(metrics.deltaV)} m/s</strong></div>
              <div class="stat-row"><span>起飞 TWR</span><strong>${number(metrics.twr, 2)}</strong></div>
              <div class="stat-row"><span>推进级</span><strong>${metrics.stageCount}</strong></div>
              <ul class="check-list compact">
                ${validation.checks
                  .filter((check) => check.level !== "pass")
                  .slice(0, 5)
                  .map(
                    (check) => `
                      <li>
                        <span class="status-mark ${STATUS_CLASS[check.level]}">${check.level === "fail" ? "!" : "?"}</span>
                        <span><strong>${escapeHtml(check.label)}</strong><br>${escapeHtml(check.detail)}</span>
                      </li>
                    `,
                  )
                  .join("")}
                ${
                  validation.checks.every((check) => check.level === "pass")
                    ? `<li><span class="status-mark pass">✓</span><span>全部检查通过</span></li>`
                    : ""
                }
              </ul>
            </div>
          </section>
        </div>
      </section>
    `;
  }

  renderPreflight() {
    const contract = this.game.activeContract;
    const requirePayload = contract.id === "satellite_one";
    const validation = this.getValidation({ requirePayload });
    const metrics = craftSummary(this.game.state.blueprint, this.game.state.unlockedTech, this.game.state.partConfigs);
    const orbitSpeed = circularOrbitSpeed(80000);
    const costAfter = this.game.state.resources.funds - validation.craft.totalCost;

    this.view.innerHTML = `
      <section class="screen narrow">
        <div class="section-head">
          <div>
            <p class="eyebrow">发射前检查</p>
            <h1>${escapeHtml(contract.name)}</h1>
            <p>${escapeHtml(contract.summary)}</p>
          </div>
          <div class="button-row">
            <button class="button" type="button" data-action="nav-editor">返回修改</button>
            <button class="button primary" type="button" data-action="launch" ${validation.valid ? "" : "disabled"}>批准发射</button>
          </div>
        </div>

        <div class="preflight-grid">
          <section class="panel">
            <div class="panel-header">
              <h2>系统检查</h2>
              <span class="${validation.valid ? "green" : "red"}">${validation.valid ? "允许发射" : "禁止发射"}</span>
            </div>
            <div class="panel-body">
              <ul class="check-list">
                ${validation.checks
                  .map(
                    (check) => `
                      <li>
                        <span class="status-mark ${STATUS_CLASS[check.level]}">${check.level === "pass" ? "✓" : check.level === "warn" ? "?" : "!"}</span>
                        <span><strong>${escapeHtml(check.label)}</strong><br>${escapeHtml(check.detail)}</span>
                      </li>
                    `,
                  )
                  .join("")}
              </ul>
            </div>
          </section>

          <div class="side-stack">
            <section class="panel">
              <div class="panel-header"><h2>任务目标</h2></div>
              <div class="panel-body">
                <ul class="objective-list">
                  ${contract.objectives.map((objective) => `<li><span class="status-mark">○</span><span>${escapeHtml(objective.label)}</span></li>`).join("")}
                </ul>
              </div>
            </section>
            <section class="panel">
              <div class="panel-header"><h2>发射摘要</h2></div>
              <div class="panel-body">
                <div class="stat-row"><span>湿重</span><strong>${formatMass(metrics.mass)}</strong></div>
                <div class="stat-row"><span>估算 Δv</span><strong>${integer(metrics.deltaV)} m/s</strong></div>
                <div class="stat-row"><span>80 km 圆轨道速度</span><strong>${integer(orbitSpeed)} m/s</strong></div>
                <div class="stat-row"><span>本次支出</span><strong class="amber">${money(metrics.cost)}</strong></div>
                <div class="stat-row"><span>发射后余额</span><strong class="${costAfter < 0 ? "red" : "green"}">${money(costAfter)}</strong></div>
              </div>
            </section>
          </div>
        </div>
      </section>
    `;
  }

  renderFlight() {
    this.view.innerHTML = `
      <section class="flight-screen">
        <canvas id="flight-canvas" aria-label="飞行视图"></canvas>
        <div class="flight-hud">
          <div class="hud-cell"><span>高度</span><strong id="hud-altitude">0 m</strong></div>
          <div class="hud-cell"><span>速度</span><strong id="hud-speed">0 m/s</strong></div>
          <div class="hud-cell"><span>垂直速度</span><strong id="hud-vertical">0 m/s</strong></div>
          <div class="hud-cell"><span>动压</span><strong id="hud-q">0.0 kPa</strong></div>
          <div class="hud-cell"><span>远地点</span><strong id="hud-apoapsis">--</strong></div>
          <div class="hud-cell"><span>近地点</span><strong id="hud-periapsis">--</strong></div>
          <div class="hud-cell"><span>质量</span><strong id="hud-mass">--</strong></div>
          <div class="hud-cell"><span>当前 TWR</span><strong id="hud-twr">--</strong></div>
        </div>

        <div class="mission-chip">
          <strong id="flight-objective">${escapeHtml(this.activeLaunch.contract.name)}</strong>
          <span id="flight-progress"></span>
          <span id="flight-stage"></span>
        </div>

        <div class="flight-log" id="flight-log"></div>

        <div class="flight-controls">
          <div class="flight-control-group">
            <button class="button square" type="button" data-flight-control="rotate-left" title="向左偏航">↶</button>
            <button class="button square" type="button" data-flight-control="rotate-right" title="向右偏航">↷</button>
            <button class="button small" type="button" data-action="flight-sas" id="sas-button">SAS</button>
            <button class="button small" type="button" data-action="flight-sas-mode" id="sas-mode-button">速度</button>
          </div>
          <div class="throttle-control">
            <label><span>节流阀</span><strong id="throttle-label">100%</strong></label>
            <input id="throttle-input" type="range" min="0" max="100" value="100" />
          </div>
          <div class="flight-control-group end">
            <button class="button small" type="button" data-action="flight-stage" id="stage-button">分离</button>
            <button class="button small" type="button" data-action="flight-chute" id="chute-button">降落伞</button>
            <button class="button small" type="button" data-action="flight-payload" id="payload-button">部署载荷</button>
            <button class="button small" type="button" data-action="flight-warp" data-warp="1" id="warp-1">×1</button>
            <button class="button small" type="button" data-action="flight-warp" data-warp="5" id="warp-5">×5</button>
            <button class="button small" type="button" data-action="flight-warp" data-warp="20" id="warp-20">×20</button>
            <button class="button small danger" type="button" data-action="flight-abort">中止</button>
          </div>
        </div>
      </section>
    `;

    requestAnimationFrame(() => {
      this.resizeFlightCanvas();
      this.lastFrameAt = performance.now();
      this.startFlightLoop();
    });
  }

  renderResults() {
    const mission = this.lastMission;
    if (!mission) {
      this.navigate("home");
      return;
    }
    const result = mission.settlement;
    this.view.innerHTML = `
      <section class="result-screen">
        <article class="result-banner">
          <img src="./assets/mission-patch.svg" alt="" />
          <div>
            <p class="eyebrow">任务结算</p>
            <h1>${result.success ? "任务完成" : "任务未完成"}</h1>
            <p>${escapeHtml(mission.contract.name)} · ${statusLabel(mission.snapshot.status)} · 任务时间 ${formatDuration(mission.snapshot.time)}</p>
          </div>
        </article>

        <div class="result-grid">
          <section class="panel">
            <div class="panel-header"><h2>目标核验</h2><span>${result.completedObjectives}/${result.objectiveCount}</span></div>
            <div class="panel-body">
              <ul class="check-list">
                ${result.objectives
                  .map(
                    (objective) => `
                      <li>
                        <span class="status-mark ${objective.passed ? "pass" : "fail"}">${objective.passed ? "✓" : "×"}</span>
                        <span><strong>${escapeHtml(objective.label)}</strong><br>实测：${escapeHtml(objective.actual)}</span>
                      </li>
                    `,
                  )
                  .join("")}
              </ul>
              <div class="button-row" style="margin-top:16px">
                <button class="button primary" type="button" data-action="nav-editor">继续研发</button>
                <button class="button" type="button" data-action="nav-home">返回任务中心</button>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header"><h2>资源结算</h2></div>
            <div class="panel-body">
              <div class="stat-row"><span>合同奖励</span><strong class="${result.success ? "green" : "dim"}">${money(result.success ? result.funds - result.salvage : 0)}</strong></div>
              <div class="stat-row"><span>硬件回收</span><strong>${money(result.salvage)}</strong></div>
              <div class="stat-row"><span>失败保障补贴</span><strong>${money(result.failureGrant)}</strong></div>
              <div class="stat-row"><span>科研点数</span><strong class="cyan">+${result.science} SP</strong></div>
              <div class="stat-row"><span>声誉变化</span><strong class="${result.reputation >= 0 ? "green" : "red"}">${result.reputation >= 0 ? "+" : ""}${result.reputation}</strong></div>
              <div class="stat-row"><span>峰值高度</span><strong>${distance(mission.snapshot.maxAltitude)}</strong></div>
              <div class="stat-row"><span>峰值动压</span><strong>${number(mission.snapshot.maxDynamicPressure / 1000, 1)} kPa</strong></div>
            </div>
          </section>
        </div>
      </section>
    `;
  }

  renderAnalysis() {
    const mission = this.lastMission;
    if (!mission) {
      this.navigate("home");
      return;
    }
    const analysis = mission.analysis;
    this.view.innerHTML = `
      <section class="result-screen">
        <article class="result-banner">
          <img src="./assets/mission-patch.svg" alt="" />
          <div>
            <p class="eyebrow">失败分析</p>
            <h1>${escapeHtml(analysis.cause)}</h1>
            <p>${escapeHtml(analysis.evidence)}</p>
          </div>
        </article>

        <div class="result-grid">
          <section class="panel">
            <div class="panel-header"><h2>飞行遥测</h2><span>${formatDuration(mission.snapshot.time)}</span></div>
            <div class="panel-body">
              <canvas id="telemetry-chart" height="250" style="width:100%;display:block"></canvas>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header"><h2>改进建议</h2></div>
            <div class="panel-body">
              <div class="analysis-box">
                <strong>主要故障</strong>
                <span>${escapeHtml(analysis.cause)}</span>
              </div>
              <ul class="check-list">
                ${analysis.recommendations
                  .map(
                    (recommendation) => `
                      <li>
                        <span class="status-mark warn">→</span>
                        <span>${escapeHtml(recommendation)}</span>
                      </li>
                    `,
                  )
                  .join("")}
              </ul>
              <div class="stat-row"><span>最高高度</span><strong>${distance(mission.snapshot.maxAltitude)}</strong></div>
              <div class="stat-row"><span>最高速度</span><strong>${integer(mission.snapshot.maxSpeed)} m/s</strong></div>
              <div class="stat-row"><span>最大过载</span><strong>${number(mission.snapshot.maxGForce, 1)} g</strong></div>
              <div class="stat-row"><span>科研回收</span><strong class="cyan">+${mission.settlement.science} SP</strong></div>
              <div class="button-row" style="margin-top:16px">
                <button class="button primary" type="button" data-action="nav-editor">修改火箭</button>
                <button class="button" type="button" data-action="nav-preflight">重新检查</button>
                <button class="button" type="button" data-action="nav-home">任务中心</button>
              </div>
            </div>
          </section>
        </div>
      </section>
    `;

    requestAnimationFrame(() => this.drawTelemetryChart(mission.telemetry));
  }

  renderResearch() {
    const { science, funds } = this.game.state.resources;
    const techColumns = [1, 2, 3, 4].map((tier) => {
      const nodes = TECH_NODES.filter((node) => node.tier === tier);
      return `
        <div class="tech-column">
          <h3>第 ${tier} 阶段</h3>
          ${nodes
            .map((node) => {
              const unlocked = this.game.state.unlockedTech.includes(node.id);
              const prereqMet = node.prerequisites.every((id) =>
                this.game.state.unlockedTech.includes(id),
              );
              const available = !unlocked && prereqMet && science >= node.cost;
              const stateLabel = unlocked
                ? "已解锁"
                : prereqMet
                  ? `${node.cost} SP`
                  : "前置未完成";
              return `
                <article class="tech-node ${unlocked ? "unlocked" : available ? "available" : "locked"}">
                  <h4>${escapeHtml(node.name)}</h4>
                  <p>${escapeHtml(node.description)}</p>
                  <div class="unlock-tags">
                    ${node.parts
                      .map((partId) => `<span class="tag">${escapeHtml(getPart(partId).short)}</span>`)
                      .join("")}
                  </div>
                  <div class="upgrade-head">
                    <span class="${unlocked ? "green" : "muted"}">${stateLabel}</span>
                    ${
                      !unlocked && prereqMet
                        ? `<button class="button small" type="button" data-action="unlock-tech" data-tech="${node.id}" ${science < node.cost ? "disabled" : ""}>研发</button>`
                        : ""
                    }
                  </div>
                </article>
              `;
            })
            .join("")}
        </div>
      `;
    }).join("");

    const upgrades = Object.values(BASE_UPGRADES)
      .map((definition) => {
        const status = getBaseUpgradeState(this.game.state, definition.id);
        const next = status.next;
        return `
          <div class="upgrade-item">
            <div class="upgrade-head">
              <strong>${escapeHtml(definition.name)}</strong>
              <span class="muted">Lv.${status.currentLevel + 1}</span>
            </div>
            <p>${escapeHtml(definition.description)}</p>
            <div class="level-pips">
              ${definition.levels
                .map((_, index) => `<span class="${index <= status.currentLevel ? "active" : ""}"></span>`)
                .join("")}
            </div>
            <div class="upgrade-head">
              <span class="muted">${next ? `下一等级：${next.value}` : "最高等级"}</span>
              ${
                next
                  ? `<button class="button small" type="button" data-action="upgrade-base" data-upgrade="${definition.id}" ${funds < next.cost ? "disabled" : ""}>${money(next.cost)}</button>`
                  : ""
              }
            </div>
          </div>
        `;
      })
      .join("");

    this.view.innerHTML = `
      <section class="screen">
        <div class="section-head">
          <div>
            <p class="eyebrow">研发与基地</p>
            <h1>技术路线</h1>
            <p>科研点解锁零件，任务收益升级设施，设施再允许更重的任务。</p>
          </div>
          <div class="button-row">
            <button class="button ${this.techTab === "research" ? "primary" : ""}" type="button" data-action="tech-tab" data-tab="research">科技树</button>
            <button class="button ${this.techTab === "base" ? "primary" : ""}" type="button" data-action="tech-tab" data-tab="base">基地升级</button>
          </div>
        </div>

        ${
          this.techTab === "research"
            ? `
              <section class="panel">
                <div class="panel-header"><h2>科技树</h2><span class="cyan">${integer(science)} SP 可用</span></div>
                <div class="panel-body">
                  <div class="tech-columns">${techColumns}</div>
                </div>
              </section>
            `
            : `
              <section class="panel">
                <div class="panel-header"><h2>基地设施</h2><span>${money(funds)} 可用</span></div>
                <div class="panel-body"><ul class="upgrade-list">${upgrades}</ul></div>
              </section>
            `
        }
      </section>
    `;
  }

  getValidation(extra = {}) {
    return validateCraft(this.game.state.blueprint, {
      unlockedTech: this.game.state.unlockedTech,
      partConfigs: this.game.state.partConfigs,
      isUnlocked: (partId) => this.game.isPartUnlocked(partId),
      maxMass: this.game.limits.maxMass,
      maxParts: this.game.limits.maxParts,
      funds: this.game.state.resources.funds,
      ...extra,
    });
  }

  getStageMap(blueprint) {
    const map = new Map();
    let stageIndex = 0;
    for (let index = blueprint.length - 1; index >= 0; index -= 1) {
      map.set(index, stageIndex);
      if (getPart(blueprint[index])?.splitStage && index > 0) {
        stageIndex += 1;
      }
    }
    return map;
  }

  handleClick(event) {
    const control = event.target.closest("[data-flight-control]");
    if (control) return;

    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.action;

    if (action === "nav-home") this.navigate("home");
    if (action === "nav-editor") this.navigate("editor");
    if (action === "nav-preflight") this.navigate("preflight");
    if (action === "nav-research") this.navigate("research");

    if (action === "choose-contract") {
      const result = this.game.chooseContract(button.dataset.contract);
      this.toast(result.ok ? "合同已接受。" : result.reason, result.ok ? "info" : "warn");
      if (result.ok) this.render();
    }

    if (action === "add-part") {
      const part = getPart(button.dataset.part);
      if (this.game.addPart(button.dataset.part)) {
        this.toast(`${part.name} 已加入堆叠。`);
        this.render();
      }
    }

    if (action === "remove-part") {
      this.game.removePart(Number(button.dataset.index));
      this.render();
    }

    if (action === "move-part") {
      this.game.movePart(
        Number(button.dataset.index),
        Number(button.dataset.direction),
      );
      this.render();
    }

    if (action === "reset-blueprint") {
      this.confirm(
        "恢复示例火箭",
        "当前构型将被替换为基础探空火箭。",
        () => {
          this.game.resetBlueprint();
          this.render();
        },
      );
    }

    if (action === "unlock-tech") {
      const result = this.game.unlockTech(button.dataset.tech);
      this.toast(
        result.ok ? `已解锁 ${result.node.name}。` : result.reason,
        result.ok ? "info" : "warn",
      );
      if (result.ok) this.render();
    }

    if (action === "upgrade-base") {
      const result = this.game.upgradeBase(button.dataset.upgrade);
      this.toast(
        result.ok ? `${result.upgrade.name} 已升级到 Lv.${result.level + 1}。` : result.reason,
        result.ok ? "info" : "warn",
      );
      if (result.ok) this.render();
    }

    if (action === "tech-tab") {
      this.techTab = button.dataset.tab;
      this.render();
    }

    if (action === "launch") this.startFlight();
    if (action === "flight-stage") {
      this.flight?.sim.separateStage();
      this.syncFlightInputs();
    }
    if (action === "flight-chute") this.flight?.sim.deployParachute();
    if (action === "flight-payload") this.flight?.sim.deployPayload();
    if (action === "flight-sas") {
      this.flight?.sim.toggleSas();
      this.syncFlightInputs();
    }
    if (action === "flight-sas-mode") {
      this.flight?.sim.cycleSasMode();
      this.syncFlightInputs();
    }
    if (action === "flight-warp") {
      if (this.flight) {
        this.flight.warp = Number(button.dataset.warp);
        this.syncFlightInputs();
      }
    }
    if (action === "flight-abort") {
      this.flight?.sim.abort();
    }
  }

  handleInput(event) {
    if (event.target.id === "throttle-input" && this.flight) {
      const value = Number(event.target.value) / 100;
      this.flight.sim.setThrottle(value);
      document.querySelector("#throttle-label").textContent = `${Math.round(value * 100)}%`;
    }
  }

  handlePointerDown(event) {
    const control = event.target.closest("[data-flight-control]");
    if (!control || !this.flight) return;
    event.preventDefault();
    control.setPointerCapture?.(event.pointerId);
    this.pointerRotation = control.dataset.flightControl === "rotate-left" ? -1 : 1;
    this.flight.sim.setRotation(this.pointerRotation);
  }

  releasePointerControls() {
    this.pointerRotation = 0;
    if (this.flight) this.flight.sim.setRotation(0);
  }

  handleKeyDown(event) {
    if (this.screen !== "flight" || !this.flight) return;
    const key = event.key.toLowerCase();
    if (["arrowleft", "arrowright", " ", "shift", "control"].includes(key)) {
      event.preventDefault();
    }
    this.keys.add(key);
    if (key === "arrowleft" || key === "a") this.flight.sim.setRotation(-1);
    if (key === "arrowright" || key === "d") this.flight.sim.setRotation(1);
    if (key === "shift") this.flight.sim.setThrottle(Math.min(1, this.flight.sim.throttle + 0.1));
    if (key === "control") this.flight.sim.setThrottle(Math.max(0, this.flight.sim.throttle - 0.1));
    if (key === " ") this.flight.sim.separateStage();
    if (key === "p") this.flight.sim.deployParachute();
    if (key === "t") this.flight.sim.toggleSas();
    this.syncFlightInputs();
  }

  handleKeyUp(event) {
    const key = event.key.toLowerCase();
    this.keys.delete(key);
    if (!this.flight || this.screen !== "flight") return;
    if (
      ["arrowleft", "arrowright", "a", "d"].includes(key) &&
      this.pointerRotation === 0
    ) {
      this.flight.sim.setRotation(0);
    }
  }

  syncFlightInputs() {
    if (!this.flight) return;
    const sim = this.flight.sim;
    const throttleInput = document.querySelector("#throttle-input");
    const throttleLabel = document.querySelector("#throttle-label");
    const sasButton = document.querySelector("#sas-button");
    const sasModeButton = document.querySelector("#sas-mode-button");
    const stageButton = document.querySelector("#stage-button");
    const chuteButton = document.querySelector("#chute-button");
    const payloadButton = document.querySelector("#payload-button");
    if (throttleInput) throttleInput.value = String(Math.round(sim.throttle * 100));
    if (throttleLabel) throttleLabel.textContent = `${Math.round(sim.throttle * 100)}%`;
    if (sasButton) sasButton.classList.toggle("primary", sim.sasEnabled);
    if (sasModeButton) {
      sasModeButton.textContent = {
        prograde: "速度",
        radial: "径向",
        stability: "保持",
      }[sim.sasMode];
    }
    if (stageButton) stageButton.disabled = sim.stageIndex >= sim.craft.stages.length - 1;
    if (chuteButton) chuteButton.disabled = sim.parachuteDeployed || !sim.craft.stages.some((stage) => stage.hasParachute);
    if (payloadButton) payloadButton.disabled = sim.payloadDeployed || !sim.craft.stages.some((stage) => stage.hasPayload);
    [1, 5, 20].forEach((warp) => {
      document.querySelector(`#warp-${warp}`)?.classList.toggle("primary", this.flight.warp === warp);
    });
  }

  startFlight() {
    const contract = this.game.activeContract;
    const requirePayload = contract.id === "satellite_one";
    const validation = this.getValidation({ requirePayload });
    if (!validation.valid) {
      this.toast("发射前检查未通过。", "error");
      return;
    }
    const reservation = this.game.reserveLaunch();
    if (!reservation.ok) {
      this.toast(reservation.reason, "error");
      return;
    }
    this.flightMetrics = {
      mass: validation.craft.totalMass,
      cost: validation.craft.totalCost,
      deltaV: getTotalDeltaV(validation.craft),
      twr: getStageTWR(validation.craft, 0),
      stageCount: validation.craft.stages.length,
      parts: validation.craft.partCount,
    };
    this.activeLaunch = {
      contract,
      reservation: reservation.reservation,
      validation,
    };
    this.flight = {
      sim: new FlightSimulation(reservation.reservation.blueprint, {
        unlockedTech: this.game.state.unlockedTech,
        partConfigs: reservation.reservation.partConfigs,
      }),
      warp: 1,
      completed: false,
      canvas: null,
      context: null,
      size: { width: 0, height: 0, dpr: 1 },
      lastHudUpdate: 0,
      clock: new FixedStepClock(DEFAULT_TIME_STEP),
    };
    this.screen = "flight";
    this.render();
  }

  startFlightLoop() {
    cancelAnimationFrame(this.animationFrame);
    const loop = (now) => {
      if (!this.flight || this.screen !== "flight") return;
      const realDelta = Math.min(0.12, Math.max(0, (now - this.lastFrameAt) / 1000));
      this.lastFrameAt = now;
      this.flight.clock.advance(realDelta, this.flight.warp, (step) => {
        const sim = this.flight.sim;
        sim.update(step, {
          throttle: sim.throttle,
          rotation: sim.rotationInput,
        });
        return sim.status === "flying";
      });
      this.drawFlight(now);
      this.updateFlightHud(now);
      const objectives = objectiveStatus(
        this.activeLaunch.contract,
        this.flight.sim.snapshot(),
      );
      const needsLanding = this.activeLaunch.contract.objectives.some(
        (objective) => objective.type === "safeLanding",
      );
      if (
        this.flight.sim.status === "flying" &&
        !needsLanding &&
        objectives.every((objective) => objective.passed)
      ) {
        this.endFlight();
        return;
      }
      if (this.flight.sim.status !== "flying") {
        this.endFlight();
        return;
      }
      this.animationFrame = requestAnimationFrame(loop);
    };
    this.animationFrame = requestAnimationFrame(loop);
  }

  stopFlightLoop() {
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.keys.clear();
    this.pointerRotation = 0;
  }

  endFlight() {
    if (!this.flight || this.flight.completed) return;
    this.flight.completed = true;
    this.stopFlightLoop();
    const snapshot = this.flight.sim.snapshot();
    const settlement = settleMission({
      contract: this.activeLaunch.contract,
      snapshot,
      craftCost: this.flightMetrics.cost,
      recoveryRate: this.game.limits.recoveryRate,
      researchMultiplier: this.game.limits.researchMultiplier,
      scienceMultiplier: compileCraft(
        this.activeLaunch.reservation.blueprint,
        this.game.state.unlockedTech,
        this.activeLaunch.reservation.partConfigs,
      ).stages.reduce(
        (sum, stage) =>
          sum +
          stage.defs.reduce(
            (partSum, part) => partSum + (part.scienceMultiplier || 0),
            0,
          ),
        0,
      ),
    });
    const analysis = analyzeFailure(snapshot, this.flightMetrics);
    this.game.settleMission(settlement);
    this.lastMission = {
      contract: this.activeLaunch.contract,
      snapshot,
      settlement,
      analysis,
      telemetry: [...this.flight.sim.telemetry],
      metrics: this.flightMetrics,
    };
    this.flight = null;
    this.screen = settlement.success ? "results" : "analysis";
    this.render();
  }

  resizeFlightCanvas() {
    if (!this.flight) return;
    const canvas = document.querySelector("#flight-canvas");
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    if (
      canvas.width !== Math.round(width * dpr) ||
      canvas.height !== Math.round(height * dpr)
    ) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    this.flight.canvas = canvas;
    this.flight.context = canvas.getContext("2d");
    this.flight.size = { width, height, dpr };
    this.flight.context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  drawFlight() {
    if (!this.flight?.context) this.resizeFlightCanvas();
    const flight = this.flight;
    if (!flight?.context) return;
    const { context: ctx, size } = flight;
    const snapshot = flight.sim.snapshot();
    const width = size.width;
    const height = size.height;
    const altitude = Math.max(0, snapshot.altitude);
    const spaceFactor = Math.min(1, altitude / ATMOSPHERE_HEIGHT);

    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, this.mixColor("#06131b", "#020305", spaceFactor));
    sky.addColorStop(0.58, this.mixColor("#2e6c78", "#06101b", spaceFactor));
    sky.addColorStop(1, this.mixColor("#9a8064", "#0c1d2a", spaceFactor));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    if (spaceFactor > 0.25) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, (spaceFactor - 0.25) / 0.75);
      for (const star of this.stars) {
        ctx.globalAlpha = star.alpha * Math.min(1, (spaceFactor - 0.25) / 0.75);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(star.x * width, star.y * height * 0.72, star.size, star.size);
      }
      ctx.restore();
    }

    const scale = Math.min(0.18, Math.max(0.00032, 210 / Math.max(210, altitude + 180)));
    const rocketX = width * (width < 700 ? 0.5 : 0.39);
    const rocketY = height * (width < 700 ? 0.43 : 0.52);
    const groundY = rocketY + altitude * scale;

    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - altitude / 18000);
    ctx.fillStyle = "#263237";
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.quadraticCurveTo(width * 0.5, groundY - 16, width, groundY - 4);
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#52676d";
    ctx.stroke();
    ctx.restore();

    this.drawTrajectoryPreview(ctx, snapshot, rocketX, rocketY, width, height, scale);

    const qRatio = Math.min(1.6, snapshot.dynamicPressure / 18000);
    if (qRatio > 0.08) {
      const glow = ctx.createRadialGradient(
        rocketX,
        rocketY,
        6,
        rocketX,
        rocketY,
        60 + qRatio * 80,
      );
      glow.addColorStop(0, `rgba(255, 162, 82, ${Math.min(0.4, qRatio * 0.35)})`);
      glow.addColorStop(1, "rgba(255, 162, 82, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);
    }

    this.drawRocket(ctx, rocketX, rocketY, snapshot);

    if (snapshot.altitude < 22000) {
      ctx.fillStyle = "rgba(238,244,246,0.14)";
      ctx.fillRect(0, Math.max(0, groundY - altitude * scale * 0.42), width, 1);
    }
  }

  mixColor(a, b, factor) {
    const parse = (hex) => [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
    ];
    const first = parse(a);
    const second = parse(b);
    const channels = first.map((value, index) =>
      Math.round(value + (second[index] - value) * factor),
    );
    return `rgb(${channels.join(",")})`;
  }

  drawTrajectoryPreview(ctx, snapshot, rocketX, rocketY, width, height, scale) {
    const points = [];
    const [px, py] = snapshot.position;
    const [vx, vy] = snapshot.velocity;
    let x = px;
    let y = py;
    let sx = vx;
    let sy = vy;
    const dt = 4;
    for (let second = 0; second < 240; second += dt) {
      const radius = Math.max(1, Math.hypot(x, y));
      const ax = (-3.5316e12 * x) / radius ** 3;
      const ay = (-3.5316e12 * y) / radius ** 3;
      sx += ax * dt;
      sy += ay * dt;
      x += sx * dt;
      y += sy * dt;
      points.push([x, y]);
    }
    const radial = [px / Math.max(1, Math.hypot(px, py)), py / Math.max(1, Math.hypot(px, py))];
    const tangent = [-radial[1], radial[0]];
    const local = points.map(([xPoint, yPoint]) => {
      const dx = xPoint - px;
      const dy = yPoint - py;
      return [dx * tangent[0] + dy * tangent[1], dx * radial[0] + dy * radial[1]];
    });
    const maxSpan = Math.max(
      1200,
      ...local.map(([horizontal, vertical]) => Math.max(Math.abs(horizontal), Math.abs(vertical))),
    );
    const plotScale = Math.min(scale * 0.8, (Math.min(width, height) * 0.28) / maxSpan);
    ctx.save();
    ctx.strokeStyle = "rgba(85,214,199,0.74)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 7]);
    ctx.beginPath();
    local.forEach(([horizontal, vertical], index) => {
      const screenX = rocketX + horizontal * plotScale;
      const screenY = rocketY - vertical * plotScale;
      if (index === 0) ctx.moveTo(screenX, screenY);
      else ctx.lineTo(screenX, screenY);
    });
    ctx.stroke();
    ctx.restore();
  }

  drawRocket(ctx, x, y, snapshot) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 2 - snapshot.angle);

    if (snapshot.throttle > 0.02 && snapshot.status === "flying") {
      const flameLength = 22 + snapshot.throttle * 28;
      const flame = ctx.createLinearGradient(0, 17, 0, 17 + flameLength);
      flame.addColorStop(0, "rgba(255,244,181,0.95)");
      flame.addColorStop(0.5, "rgba(255,161,68,0.88)");
      flame.addColorStop(1, "rgba(255,84,48,0)");
      ctx.fillStyle = flame;
      ctx.beginPath();
      ctx.moveTo(-6, 17);
      ctx.lineTo(0, 18 + flameLength);
      ctx.lineTo(6, 17);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = "#e8eef0";
    ctx.beginPath();
    ctx.moveTo(0, -24);
    ctx.lineTo(8, -10);
    ctx.lineTo(8, 15);
    ctx.lineTo(-8, 15);
    ctx.lineTo(-8, -10);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#81a4ad";
    ctx.fillRect(-8, -3, 16, 5);
    ctx.fillStyle = "#ff7068";
    ctx.beginPath();
    ctx.moveTo(-8, 9);
    ctx.lineTo(-15, 20);
    ctx.lineTo(-8, 17);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(8, 9);
    ctx.lineTo(15, 20);
    ctx.lineTo(8, 17);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#6d7c82";
    ctx.fillRect(-6, 15, 12, 5);

    if (snapshot.parachuteDeployed) {
      ctx.strokeStyle = "rgba(238,244,246,0.8)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-6, -19);
      ctx.lineTo(-16, -45);
      ctx.moveTo(6, -19);
      ctx.lineTo(16, -45);
      ctx.stroke();
      ctx.fillStyle = "#ffbf5c";
      ctx.beginPath();
      ctx.arc(0, -49, 19, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#17303a";
      ctx.fillRect(-4, -49, 8, 17);
    }
    ctx.restore();
  }

  updateFlightHud(now) {
    if (!this.flight) return;
    const snapshot = this.flight.sim.snapshot();
    const set = (id, text, className) => {
      const element = document.querySelector(id);
      if (!element) return;
      element.textContent = text;
      if (className) element.className = className;
    };
    set("#hud-altitude", distance(snapshot.altitude));
    set("#hud-speed", `${integer(snapshot.speed)} m/s`);
    set("#hud-vertical", `${integer(snapshot.verticalSpeed)} m/s`);
    set(
      "#hud-q",
      `${number(snapshot.dynamicPressure / 1000, 1)} kPa`,
      snapshot.dynamicPressure > 18000 ? "red" : "",
    );
    set("#hud-apoapsis", orbitalDistance(snapshot.apoapsisAltitude));
    set("#hud-periapsis", orbitalDistance(snapshot.periapsisAltitude));
    set("#hud-mass", formatMass(snapshot.mass));
    set("#hud-twr", number(snapshot.twr, 2));

    const objectives = objectiveStatus(this.activeLaunch.contract, snapshot);
    const progress = document.querySelector("#flight-progress");
    const stage = document.querySelector("#flight-stage");
    if (progress) {
      progress.innerHTML = objectives
        .map(
          (objective) =>
            `<span class="${objective.passed ? "green" : "muted"}">${objective.passed ? "✓" : "○"} ${escapeHtml(objective.label)}</span>`,
        )
        .join("");
    }
    if (stage) {
      stage.textContent = `推进级 ${snapshot.stageIndex + 1}/${snapshot.stageCount} · 燃料 ${formatMass(snapshot.stageFuel)} · ${formatDuration(snapshot.time)}`;
    }
    if (now - this.flight.lastHudUpdate > 180) {
      const log = document.querySelector("#flight-log");
      if (log) {
        log.innerHTML = snapshot.events
          .slice(0, 5)
          .map(
            (event) =>
              `<div><span class="dim">${formatDuration(event.time)}</span> ${escapeHtml(event.message)}</div>`,
          )
          .join("");
      }
      this.flight.lastHudUpdate = now;
    }
    this.syncFlightInputs();
  }

  drawTelemetryChart(telemetry) {
    const canvas = document.querySelector("#telemetry-chart");
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(bounds.width));
    const height = 250;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const source = telemetry.length > 1
      ? telemetry
      : [
          { time: 0, altitude: 0, speed: 0, apoapsis: 0, periapsis: 0 },
          { time: 1, altitude: 0, speed: 0, apoapsis: 0, periapsis: 0 },
        ];
    const padding = { left: 46, right: 16, top: 18, bottom: 26 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const maxTime = Math.max(1, ...source.map((point) => point.time));
    const maxAltitude = Math.max(1000, ...source.map((point) => point.altitude));
    const maxSpeed = Math.max(100, ...source.map((point) => point.speed));

    ctx.strokeStyle = "#29414b";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let line = 0; line <= 4; line += 1) {
      const y = padding.top + (plotHeight * line) / 4;
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
    }
    ctx.stroke();

    const line = (key, maxValue, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      source.forEach((point, index) => {
        const x = padding.left + (point.time / maxTime) * plotWidth;
        const y =
          padding.top +
          plotHeight -
          (Math.max(0, point[key]) / maxValue) * plotHeight;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    line("altitude", maxAltitude, "#55d6c7");
    line("speed", maxSpeed, "#ffbf5c");

    ctx.fillStyle = "#9fb0b8";
    ctx.font = '11px "Cascadia Mono", monospace';
    ctx.fillText("高度 / 速度", padding.left, 12);
    ctx.fillText("0", 18, height - padding.bottom + 4);
    ctx.fillText(`${Math.round(maxAltitude / 1000)} km`, 8, padding.top + 4);
    ctx.fillStyle = "#55d6c7";
    ctx.fillText("高度", width - 72, 12);
    ctx.fillStyle = "#ffbf5c";
    ctx.fillText("速度", width - 38, 12);
  }

  confirm(title, body, onConfirm) {
    this.modalRegion.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true">
          <div class="panel-header"><h2>${escapeHtml(title)}</h2></div>
          <div class="panel-body">
            <p>${escapeHtml(body)}</p>
            <div class="button-row">
              <button class="button" type="button" data-modal="cancel">取消</button>
              <button class="button primary" type="button" data-modal="confirm">确认</button>
            </div>
          </div>
        </div>
      </div>
    `;
    this.modalRegion.querySelector('[data-modal="cancel"]').addEventListener("click", () => {
      this.modalRegion.innerHTML = "";
    });
    this.modalRegion.querySelector('[data-modal="confirm"]').addEventListener("click", () => {
      this.modalRegion.innerHTML = "";
      onConfirm();
    });
  }

  toast(message, type = "info") {
    const element = document.createElement("div");
    element.className = `toast ${type}`;
    element.textContent = message;
    this.toastRegion.append(element);
    window.setTimeout(() => element.remove(), 3200);
  }
}

new GameApp();
