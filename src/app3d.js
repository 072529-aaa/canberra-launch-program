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
  massProperties,
} from "./craft.js";
import {
  ATMOSPHERE_HEIGHT,
  DEFAULT_TIME_STEP,
  FlightSimulation,
  PLANET_RADIUS,
  circularOrbitSpeed,
  formatDuration,
} from "./physics.js";
import {
  analyzeFailure,
  evaluateObjectives,
  settleMission,
  statusLabel,
} from "./missions.js";
import { GameState, getBaseUpgradeState } from "./state.js";
import { AssemblyScene, FlightScene } from "./three/scenes.js";
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

const NAV_ITEMS = [
  { id: "home", label: "任务中心", short: "任务" },
  { id: "hangar", label: "总装车间", short: "装配" },
  { id: "preflight", label: "发射准备", short: "准备" },
  { id: "research", label: "研发基地", short: "研发" },
];

const SCREEN_TITLES = {
  home: "任务中心",
  hangar: "总装车间",
  preflight: "发射准备",
  flight: "飞行控制",
  results: "任务结算",
  analysis: "失败分析",
  research: "研发与基地",
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
    this.navRail = document.querySelector("#nav-rail");
    this.mobileNav = document.querySelector("#mobile-nav");
    this.headerContext = document.querySelector("#header-context");
    this.resourceStrip = document.querySelector("#resource-strip");
    this.toastRegion = document.querySelector("#toast-region");
    this.sheetRegion = document.querySelector("#sheet-region");
    this.themeButton = document.querySelector("#theme-toggle");
    this.screen = "hangar";
    this.labMode = true;
    this.editMode = true;
    this.previousExperiment = null;
    this.techTab = "research";
    this.hangarCategory = "command";
    this.selectedPartIndex = 0;
    this.assemblyScene = null;
    this.preflightScene = null;
    this.flightScene = null;
    this.flight = null;
    this.flightMetrics = null;
    this.activeLaunch = null;
    this.lastMission = null;
    this.animationFrame = null;
    this.lastFrameAt = 0;
    this.keys = new Set();
    this.pointerRotation = 0;
    this.bindEvents();
    this.applyTheme();
    this.render();
  }

  bindEvents() {
    document.querySelector("#brand-home").addEventListener("click", () => {
      if (this.screen === "flight") {
        this.toast("飞行中无法离开发射控制。", "warn");
        return;
      }
      this.navigate("home");
    });
    this.themeButton.addEventListener("click", () => this.toggleTheme());
    this.navRail.addEventListener("click", (event) => {
      const button = event.target.closest("[data-nav]");
      if (button) {
        this.navigate(button.dataset.nav);
        return;
      }
      this.handleClick(event);
    });
    this.mobileNav.addEventListener("click", (event) => {
      const button = event.target.closest("[data-nav]");
      if (button) this.navigate(button.dataset.nav);
    });
    this.view.addEventListener("click", (event) => this.handleClick(event));
    this.view.addEventListener("input", (event) => this.handleInput(event));
    this.view.addEventListener("focusout", (event) => {
      if (event.target.dataset.partConfig) this.editingKey = null;
    });
    this.view.addEventListener("pointerdown", (event) => this.handlePointerDown(event));
    this.sheetRegion.addEventListener("click", (event) => this.handleSheetClick(event));
    window.addEventListener("pointerup", () => this.releasePointerControls());
    window.addEventListener("keydown", (event) => this.handleKeyDown(event));
    window.addEventListener("keyup", (event) => this.handleKeyUp(event));
  }

  applyTheme() {
    const theme = this.game.state.settings.theme === "dark" ? "dark" : "light";
    document.body.dataset.theme = theme;
    this.themeButton.textContent = theme === "dark" ? "浅色" : "深色";
    this.themeButton.setAttribute(
      "aria-label",
      theme === "dark" ? "切换到浅色主题" : "切换到深色主题",
    );
  }

  toggleTheme() {
    this.game.state.settings.theme =
      this.game.state.settings.theme === "dark" ? "light" : "dark";
    this.game.save();
    this.applyTheme();
    this.render();
  }

  navigate(screen) {
    if (this.screen === "flight" && screen !== "flight") {
      this.toast("请先结束当前飞行任务。", "warn");
      return;
    }
    this.screen = screen;
    this.render();
  }

  render() {
    this.editingKey = null;
    this.disposeScenes();
    this.renderChrome();
    if (this.screen === "home") this.renderHome();
    if (this.screen === "hangar") this.renderHangar();
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
    if (this.labMode) this.resourceStrip.innerHTML = `<div class="resource-chip"><span>实验室</span><strong>自由试飞</strong></div>`;
    this.headerContext.innerHTML = `
      <span class="context-kicker">CANBERRA / ${escapeHtml(SCREEN_TITLES[this.screen])}</span>
      <strong>${escapeHtml(this.game.activeContract.name)}</strong>
    `;
    const navMarkup = NAV_ITEMS.map(
      (item) => `
        <button class="nav-item ${this.screen === item.id ? "active" : ""}" type="button" data-nav="${item.id}">
          <span class="nav-dot"></span>
          <span>${item.label}</span>
        </button>
      `,
    ).join("");
    this.navRail.innerHTML = `
      <div class="nav-section-label">工作台</div>
      ${navMarkup}
      <div class="nav-spacer"></div>
      <button class="nav-item quiet" type="button" data-action="open-help">
        <span class="nav-dot"></span><span>操作与设定</span>
      </button>
    `;
    this.mobileNav.innerHTML = NAV_ITEMS.map(
      (item) => `
        <button class="mobile-nav-item ${this.screen === item.id ? "active" : ""}" type="button" data-nav="${item.id}">
          <span class="mobile-nav-mark">${item.short.slice(0, 1)}</span>
          <span>${item.short}</span>
        </button>
      `,
    ).join("");
  }

  guideCard(key, index, title, body, action = "知道了") {
    if (this.game.state.settings.guide[key]) return "";
    return `
      <article class="coach-card" data-guide-card="${key}">
        <span class="coach-index">${String(index).padStart(2, "0")}</span>
        <div>
          <strong>${escapeHtml(title)}</strong>
          <p>${escapeHtml(body)}</p>
        </div>
        <button class="button small" type="button" data-action="guide-step" data-guide="${key}">${escapeHtml(action)}</button>
      </article>
    `;
  }

  markGuide(key) {
    this.game.state.settings.guide[key] = true;
    this.game.save();
    document.querySelector(`[data-guide-card="${key}"]`)?.remove();
  }

  renderHome() {
    const contract = this.game.activeContract;
    const metrics = craftSummary(this.game.state.blueprint, this.game.state.unlockedTech, this.game.state.partConfigs);
    const validation = this.getValidation({
      requirePayload: contract.id === "satellite_one",
    });
    const lastMission = this.game.state.missionHistory[0];
    const completed = new Set(this.game.state.completedContracts);
    const objectives = contract.objectives
      .map((objective) => `<li><span class="status-mark neutral">○</span><span>${escapeHtml(objective.label)}</span></li>`)
      .join("");

    this.view.innerHTML = `
      <section class="screen home-screen">
        ${this.guideCard("command", 1, "先读合同，再决定火箭", "任务中心只保留决策信息。点开合同可查看目标与奖励，然后进入总装车间配置火箭。", "开始任务")}
        <div class="home-layout">
          <article class="mission-brief">
            <div class="mission-brief-main">
              <p class="eyebrow">当前合同 · ${escapeHtml(contract.client)}</p>
              <h1>${escapeHtml(contract.name)}</h1>
              <p class="lead">${escapeHtml(contract.summary)}</p>
              <ul class="objective-list">${objectives}</ul>
              <div class="button-row">
                <button class="button primary" type="button" data-nav="hangar">进入总装车间</button>
                <button class="button" type="button" data-action="open-mission">查看合同详情</button>
              </div>
            </div>
            <div class="mission-orbit-visual" aria-hidden="true">
              <span class="orbit-ring ring-a"></span>
              <span class="orbit-ring ring-b"></span>
              <span class="planet-disc"></span>
              <span class="orbit-craft"></span>
            </div>
          </article>

          <aside class="home-side">
            <section class="surface-card readiness-card">
              <div class="card-heading">
                <div><span class="eyebrow">READINESS</span><h2>发射准备度</h2></div>
                <span class="status-pill ${validation.valid ? "ok" : "warn"}">${validation.valid ? "可发射" : "需调整"}</span>
              </div>
              <div class="readiness-score">
                <strong>${validation.valid ? "READY" : "CHECK"}</strong>
                <span>${validation.valid ? "系统检查无阻断项" : "存在必须处理的检查项"}</span>
              </div>
              <div class="data-list">
                <div><span>湿重</span><strong>${formatMass(metrics.mass)}</strong></div>
                <div><span>估算速度增量</span><strong>${integer(metrics.deltaV)} m/s</strong></div>
                <div><span>起飞推重比</span><strong>${number(metrics.twr, 2)}</strong></div>
                <div><span>硬件成本</span><strong>${money(metrics.cost)}</strong></div>
              </div>
              <button class="button full" type="button" data-nav="preflight">进行发射检查</button>
            </section>

            <section class="surface-card compact-card">
              <div class="card-heading">
                <div><span class="eyebrow">PROGRAM</span><h2>项目状态</h2></div>
              </div>
              <div class="data-list">
                <div><span>完成合同</span><strong>${completed.size}/${CONTRACTS.length}</strong></div>
                <div><span>已解锁技术</span><strong>${this.game.state.unlockedTech.length}/${TECH_NODES.length}</strong></div>
                <div><span>回收率</span><strong>${Math.round(this.game.limits.recoveryRate * 100)}%</strong></div>
                <div><span>最近任务</span><strong>${lastMission ? (lastMission.success ? "成功" : "待分析") : "尚未发射"}</strong></div>
              </div>
              <button class="button ghost full" type="button" data-nav="research">查看研发路线</button>
            </section>
          </aside>
        </div>

        <section class="contract-section">
          <div class="section-heading-inline">
            <div><span class="eyebrow">CONTRACT BOARD</span><h2>合同板</h2></div>
            <span class="muted">${this.game.availableContracts.length} 个可用合同</span>
          </div>
          <div class="contract-grid">
            ${CONTRACTS.map((item) => {
              const isAvailable = this.game.availableContracts.includes(item);
              const isCompleted = completed.has(item.id);
              const isActive = item.id === contract.id;
              return `
                <article class="contract-card ${isActive ? "active" : ""} ${!isAvailable && !isCompleted ? "locked" : ""}">
                  <div class="contract-card-top">
                    <span class="contract-client">${escapeHtml(item.client)}</span>
                    <span class="status-pill ${isCompleted ? "ok" : isActive ? "active" : ""}">${isCompleted ? "已完成" : isActive ? "当前" : isAvailable ? "可接受" : "未解锁"}</span>
                  </div>
                  <h3>${escapeHtml(item.name)}</h3>
                  <p>${escapeHtml(item.summary)}</p>
                  <div class="contract-rewards">
                    <span>${money(item.reward.funds)}</span>
                    <span>${item.reward.science} SP</span>
                    <span>+${item.reward.reputation} 声誉</span>
                  </div>
                  <div class="button-row">
                    <button class="button small ghost" type="button" data-action="open-contract" data-contract="${item.id}">目标详情</button>
                    ${
                      isAvailable && !isCompleted && !isActive
                        ? `<button class="button small" type="button" data-action="choose-contract" data-contract="${item.id}">接受</button>`
                        : ""
                    }
                  </div>
                </article>
              `;
            }).join("")}
          </div>
        </section>
      </section>
    `;
  }
  renderHangar() {
    const blueprint = this.game.state.blueprint;
    const validation = this.getValidation();
    const metrics = craftSummary(blueprint, this.game.state.unlockedTech, this.game.state.partConfigs);
    const properties = massProperties(this.game.craft);
    const categories = CATEGORY_ORDER.map((category) => {
      const parts = Object.values(PARTS).filter((part) => part.category === category);
      const unlockedCount = parts.filter((part) => this.labMode || this.game.isPartUnlocked(part.id)).length;
      return `
        <button class="category-tab ${this.hangarCategory === category ? "active" : ""}" type="button" data-action="hangar-category" data-category="${category}">
          <span>${escapeHtml(CATEGORY_LABELS[category])}</span><small>${unlockedCount}/${parts.length}</small>
        </button>
      `;
    }).join("");
    const parts = Object.values(PARTS)
      .filter((part) => part.category === this.hangarCategory)
      .map((part) => {
        const unlocked = this.labMode || this.game.isPartUnlocked(part.id);
        const requiredTech = requiredTechForPart(part.id);
        const atLimit = blueprint.length >= (this.labMode ? 24 : this.game.limits.maxParts);
        const selected = blueprint[this.selectedPartIndex] === part.id;
        return `
          <button class="catalog-part ${selected ? "selected" : ""}" type="button" data-action="add-part" data-part="${part.id}" ${!unlocked || atLimit ? "disabled" : ""}>
            <span class="part-symbol">${iconForPart(part)}</span>
            <span class="catalog-part-copy">
              <strong>${escapeHtml(part.name)}</strong>
              <small>${unlocked ? `${formatMass(part.mass)} · ${money(part.cost)}` : `需研发：${escapeHtml(requiredTech?.name || "未知")}`}</small>
            </span>
            <span class="part-add-mark">+</span>
          </button>
        `;
      }).join("");

    this.view.innerHTML = `
      <section class="screen hangar-screen">
        <div class="workspace-heading">
          <div>
            <p class="eyebrow">3D ASSEMBLY</p>
            <h1>总装车间</h1>
          </div>
          <div class="button-row">
            <div class="assembly-segment" aria-label="游戏模式">
              <button type="button" data-action="game-mode" data-mode="lab" aria-pressed="${this.labMode}">实验室</button>
              <button type="button" data-action="game-mode" data-mode="career" aria-pressed="${!this.labMode}">经营</button>
            </div>
            <button class="button" type="button" data-action="edit-undo" title="撤销" aria-label="撤销" ${this.game.undoStack.length ? "" : "disabled"}>↶</button>
            <button class="button" type="button" data-action="edit-redo" title="重做" aria-label="重做" ${this.game.redoStack.length ? "" : "disabled"}>↷</button>
            <button class="button" type="button" data-action="reset-blueprint">恢复基础构型</button>
            <button class="button primary" id="assembly-ready" type="button" data-nav="preflight" ${validation.valid ? "" : "disabled"}>试飞检查</button>
          </div>
        </div>

        <div class="hangar-layout">
          <aside class="catalog-panel surface-card">
            <div class="catalog-heading">
              <div><span class="eyebrow">PARTS</span><h2>零件目录</h2></div>
              <span class="capacity-pill">${blueprint.length}/${this.labMode ? 24 : this.game.limits.maxParts}</span>
            </div>
            <div class="category-tabs">${categories}</div>
            <div class="catalog-list">${parts}</div>
          </aside>

          <section class="assembly-stage surface-card">
            <div id="assembly-viewport" class="three-viewport" aria-label="三维航天器装配区"></div>
            <div class="viewport-topbar">
              <span class="live-dot"></span>
              <span>实时装配预览</span>
              <div class="assembly-segment">
                <button type="button" data-action="assembly-view" data-mode="edit" aria-pressed="${this.editMode}">装配</button>
                <button type="button" data-action="assembly-view" data-mode="inspect" aria-pressed="${!this.editMode}">观察</button>
              </div>
              <button class="icon-text-button" type="button" data-action="reset-camera" title="重置视角" aria-label="重置视角">↺</button>
            </div>
            <div class="viewport-caption">
              <strong id="assembly-validity">${escapeHtml(validation.valid ? "构型可发射" : "构型需要调整")}</strong>
              <span id="assembly-caption">${metrics.parts} 个零件 · ${formatMass(metrics.mass)} · ${integer(metrics.deltaV)} m/s</span>
            </div>
            <div class="stage-badge">STAGE ${metrics.stageCount}</div>
          </section>

          <aside class="inspector-panel">
            <section class="surface-card inspector-summary">
              <div class="card-heading">
                <div><span class="eyebrow">PERFORMANCE</span><h2>性能摘要</h2></div>
                <span id="assembly-status" class="status-pill ${validation.valid ? "ok" : "warn"}">${validation.valid ? "有效" : "检查"}</span>
              </div>
              <div class="metric-grid">
                <div><span>湿重</span><strong id="assembly-mass">${formatMass(metrics.mass)}</strong></div>
                <div><span>理想 Δv</span><strong id="assembly-dv">${integer(metrics.deltaV)} m/s</strong></div>
                <div><span>TWR</span><strong id="assembly-twr">${number(metrics.twr, 2)}</strong></div>
                <div><span>成本</span><strong>${money(metrics.cost)}</strong></div>
              </div>
            </section>
              <div class="assembly-properties"><span>● 质心</span><strong id="assembly-com">${number(properties.centerX, 2)}, ${number(properties.centerY, 2)} m</strong><span>推力力矩</span><strong id="assembly-torque">${integer(properties.thrustTorque)} N·m</strong><button class="button small" type="button" data-action="physics-notes">物理笔记</button></div>
            <section class="surface-card part-inspector" id="part-inspector">
              ${this.renderPartInspector()}
            </section>
          </aside>
        </div>

        <section class="stack-strip surface-card">
          <div class="stack-strip-head">
            <div><span class="eyebrow">STACK ORDER</span><h2>构型顺序</h2></div>
            <span class="muted">顶部 → 底部</span>
          </div>
          <div class="stack-items">
            ${blueprint.map((partId, index) => {
              const part = getPart(partId);
              return `
                <button class="stack-chip ${index === this.selectedPartIndex ? "selected" : ""}" type="button" data-action="select-part" data-index="${index}">
                  <span>${iconForPart(part)}</span>
                  <strong>${escapeHtml(part.short)}</strong>
                </button>
              `;
            }).join("")}
            ${blueprint.length === 0 ? `<p class="muted">当前没有零件，请从目录添加。</p>` : ""}
          </div>
        </section>
      </section>
    `;

    requestAnimationFrame(() => this.mountAssembly());
  }

  renderPartInspector() {
    const index = this.selectedPartIndex;
    const partId = this.game.state.blueprint[index];
    if (!partId) {
      return `
        <div class="empty-inspector">
          <span class="eyebrow">SELECTION</span>
          <h2>选择一个零件</h2>
          <p>点击 3D 模型或构型顺序，查看零件参数、安装位置和可用操作。</p>
        </div>
      `;
    }
    const part = getPart(partId);
    const config = this.game.state.partConfigs[index];
    const slider = (key, label, min, max, step, value, unit) => `<label class="assembly-field"><span>${label}<output data-config-value="${key}">${number(value, key === "fuelFraction" ? 0 : 2)} ${unit}</output></span><input aria-label="${label}" data-part-config="${key}" data-index="${index}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" /></label>`;
    const stageMap = this.getStageMap(this.game.state.blueprint);
    const features = [
      part.thrust ? `推力 ${integer(part.thrust)} N` : null,
      part.isp ? `比冲 ${integer(part.isp)} s` : null,
      part.fuelMass ? `燃料 ${formatMass(part.fuelMass)}` : null,
      part.torque ? `控制力矩 ${integer(part.torque)}` : null,
      part.parachuteArea ? `伞面积 ${integer(part.parachuteArea)} m²` : null,
      part.liftArea ? `升力面积 ${number(part.liftArea, 1)} m²` : null,
      part.powerGeneration ? `发电 ${integer(part.powerGeneration)} W` : null,
      part.powerCapacity ? `容量 ${integer(part.powerCapacity)} J` : null,
      part.impactTolerance ? `触地容忍 +${number(part.impactTolerance, 1)} m/s` : null,
      part.structuralLimit ? `结构极限 ${integer(part.structuralLimit)} Pa` : null,
    ].filter(Boolean).slice(0, 4);

    return `
      <div class="card-heading">
        <div><span class="eyebrow">SELECTED PART</span><h2>${escapeHtml(part.name)}</h2></div>
        <span class="part-symbol large">${iconForPart(part)}</span>
      </div>
      <p>${escapeHtml(part.description)}</p>
      <div class="selection-meta">
        <span>第 ${(stageMap.get(index) || 0) + 1} 级</span>
        <span>${formatMass(part.mass)}</span>
        <span>${money(part.cost)}</span>
      </div>
      <div class="feature-list">
        ${features.map((feature) => `<span>${escapeHtml(feature)}</span>`).join("")}
      </div>
      <div class="assembly-fields">
        ${part.fuelMass ? slider("fuelFraction", "燃料装填", 0, 100, 5, config.fuelFraction * 100, "%") : ""}
        ${part.thrust ? slider("x", "横向安装", -0.7, 0.7, 0.05, config.x, "m") + slider("angle", "发动机倾角", -15, 15, 1, config.angle, "°") : ""}
        ${part.category === "aero" ? slider("y", "尾翼高度偏移", -1.2, 1.2, 0.05, config.y, "m") : ""}
      </div>
      ${part.thrust ? `<button class="button" type="button" data-action="mirror-engine">镜像安装发动机</button>` : ""}
      <div class="button-row">
        <button class="button small" type="button" data-action="move-part" data-index="${index}" data-direction="-1" ${index === 0 ? "disabled" : ""}>上移</button>
        <button class="button small" type="button" data-action="move-part" data-index="${index}" data-direction="1" ${index === this.game.state.blueprint.length - 1 ? "disabled" : ""}>下移</button>
        <button class="button small" type="button" data-action="open-part">详细参数</button>
        <button class="button small danger" type="button" data-action="remove-part" data-index="${index}">移除</button>
      </div>
    `;
  }

  refreshAssembly() {
    const craft = this.game.craft;
    const properties = massProperties(craft);
    const set = (id, value) => { const element = document.querySelector(`#${id}`); if (element) element.textContent = value; };
    set("assembly-mass", formatMass(craft.totalMass));
    set("assembly-dv", `${integer(getTotalDeltaV(craft))} m/s`);
    set("assembly-twr", number(getStageTWR(craft, 0), 2));
    set("assembly-com", `${number(properties.centerX, 2)}, ${number(properties.centerY, 2)} m`);
    set("assembly-torque", `${integer(properties.thrustTorque)} N·m`);
    set("assembly-caption", `${craft.partCount} 个零件 · ${formatMass(craft.totalMass)} · ${integer(getTotalDeltaV(craft))} m/s`);
    const ready = document.querySelector("#assembly-ready");
    const validation = this.getValidation();
    if (ready) ready.disabled = !validation.valid;
    set("assembly-validity", validation.valid ? "构型可发射" : "构型需要调整");
    set("assembly-status", validation.valid ? "有效" : "检查");
    const status = document.querySelector("#assembly-status");
    if (status) status.className = `status-pill ${validation.valid ? "ok" : "warn"}`;
    this.assemblyScene.partConfigs = this.game.state.partConfigs;
    this.assemblyScene.setBlueprint(this.game.state.blueprint);
    this.assemblyScene.setSelected(this.selectedPartIndex);
    for (const action of ["edit-undo", "edit-redo"]) {
      const button = this.view.querySelector(`[data-action="${action}"]`);
      if (button) button.disabled = !(action === "edit-undo" ? this.game.undoStack : this.game.redoStack).length;
    }
  }

  renderExperiment() {
    const { snapshot, settlement, analysis, previous, metrics } = this.lastMission;
    const comparison = previous ? `<div class="experiment-comparison">
      <h2>与上次试飞对照</h2><div class="metric-grid">
      <div><span>高度变化</span><strong>${snapshot.maxAltitude >= previous.snapshot.maxAltitude ? "+" : ""}${distance(snapshot.maxAltitude - previous.snapshot.maxAltitude)}</strong></div>
      <div><span>湿重变化</span><strong>${integer(metrics.mass - previous.metrics.mass)} kg</strong></div>
      <div><span>最大动压变化</span><strong>${number((snapshot.maxDynamicPressure - previous.snapshot.maxDynamicPressure) / 1000, 1)} kPa</strong></div>
      <div><span>起飞 TWR 变化</span><strong>${number(metrics.twr - previous.metrics.twr, 2)}</strong></div></div></div>` : "";
    this.view.innerHTML = `<section class="screen experiment-screen">
      <div class="workspace-heading"><div><p class="eyebrow">FLIGHT EXPERIMENT</p><h1>试飞记录</h1><p>${statusLabel(snapshot.status)} · ${formatDuration(snapshot.time)}</p></div>
      <div class="button-row"><button class="button primary" data-nav="hangar">继续组装</button><button class="button" data-action="physics-notes">物理笔记</button></div></div>
      <div class="metric-grid experiment-metrics"><div><span>最高高度</span><strong>${distance(snapshot.maxAltitude)}</strong></div>
      <div><span>最高速度</span><strong>${integer(snapshot.maxSpeed)} m/s</strong></div><div><span>最大动压</span><strong>${number(snapshot.maxDynamicPressure / 1000, 1)} kPa</strong></div>
      <div><span>经营资金变化</span><strong>0</strong></div></div>
      <div class="experiment-layout"><section><h2>飞行遥测</h2><canvas id="telemetry-chart" class="telemetry-chart" height="260"></canvas>${comparison}</section>
      <section><h2>探空目标核验</h2><ul class="check-list">${settlement.objectives.map((objective) => `<li><span class="status-mark ${objective.passed ? "pass" : "fail"}">${objective.passed ? "✓" : "×"}</span><span><strong>${escapeHtml(objective.label)}</strong><small>${escapeHtml(objective.actual)}</small></span></li>`).join("")}</ul>
      ${!settlement.success ? `<div class="analysis-box"><strong>${escapeHtml(analysis.cause)}</strong><span>${escapeHtml(analysis.evidence)}</span></div><ol>${analysis.recommendations.slice(0, 2).map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ol>` : ""}
      </section></div></section>`;
    requestAnimationFrame(() => this.drawTelemetryChart(this.lastMission.telemetry));
  }

  mountAssembly(targetId = "assembly-viewport") {
    const target = document.querySelector(`#${targetId}`);
    if (!target) return null;
    const scene = new AssemblyScene(target, {
      blueprint: this.game.state.blueprint,
      partConfigs: this.game.state.partConfigs,
      editMode: targetId === "assembly-viewport" && this.editMode,
      theme: this.game.state.settings.theme,
      onSelect: (index) => this.selectPart(index),
      onMove: (index, config) => {
        this.game.configurePart(index, config);
        this.selectedPartIndex = index;
        this.render();
      },
    });
    scene.setSelected(this.selectedPartIndex);
    if (targetId === "assembly-viewport") this.assemblyScene = scene;
    if (targetId === "preflight-viewport") this.preflightScene = scene;
    return scene;
  }

  selectPart(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.game.state.blueprint.length) return;
    this.selectedPartIndex = index;
    this.assemblyScene?.setSelected(index);
    document.querySelectorAll(".stack-chip").forEach((element) => {
      element.classList.toggle("selected", Number(element.dataset.index) === index);
    });
    const inspector = document.querySelector("#part-inspector");
    if (inspector) {
      inspector.innerHTML = this.renderPartInspector();
      inspector.classList.remove("pulse");
      void inspector.offsetWidth;
      inspector.classList.add("pulse");
    }
  }

  resetCamera() {
    this.assemblyScene?.resetView();
    this.preflightScene?.resetView();
  }
  renderPreflight() {
    const contract = this.labMode ? CONTRACTS[0] : this.game.activeContract;
    const requirePayload = contract.id === "satellite_one";
    const validation = this.getValidation({ requirePayload });
    const metrics = craftSummary(this.game.state.blueprint, this.game.state.unlockedTech, this.game.state.partConfigs);
    const orbitSpeed = circularOrbitSpeed(80000);
    const costAfter = this.game.state.resources.funds - validation.craft.totalCost;
    const blockerCount = validation.checks.filter((check) => check.level === "fail").length;

    this.view.innerHTML = `
      <section class="screen preflight-screen">
        ${this.guideCard("mission", 3, "检查不只是确认按钮", "左侧列出结构、质量、推重比与任务载荷。红色项目会阻止发射，黄色项目允许继续但存在风险。", "进入检查")}
        <div class="workspace-heading">
          <div><p class="eyebrow">PRE-FLIGHT</p><h1>${escapeHtml(contract.name)}</h1><p class="muted">${escapeHtml(contract.summary)}</p></div>
          <div class="button-row">
            <button class="button" type="button" data-nav="hangar">返回车间</button>
            <button class="button primary" type="button" data-action="launch" ${validation.valid ? "" : "disabled"}>批准发射</button>
          </div>
        </div>

        <div class="preflight-layout">
          <section class="surface-card preflight-preview">
            <div class="card-heading">
              <div><span class="eyebrow">VEHICLE</span><h2>飞行器预览</h2></div>
              <span class="status-pill ${validation.valid ? "ok" : "warn"}">${validation.valid ? "放行" : `${blockerCount} 项阻断`}</span>
            </div>
            <div id="preflight-viewport" class="three-viewport preview-viewport"></div>
            <div class="preview-footer">
              <span>${formatMass(metrics.mass)}</span><span>${integer(metrics.deltaV)} m/s</span><span>${money(metrics.cost)}</span>
            </div>
          </section>

          <section class="surface-card checklist-card">
            <div class="card-heading">
              <div><span class="eyebrow">SYSTEMS</span><h2>系统检查</h2></div>
              <span class="muted">${validation.checks.filter((check) => check.level === "pass").length}/${validation.checks.length} 通过</span>
            </div>
            <ul class="check-list">
              ${validation.checks.map((check) => `
                <li>
                  <span class="status-mark ${check.level}">${check.level === "pass" ? "✓" : check.level === "warn" ? "!" : "×"}</span>
                  <span><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail)}</small></span>
                </li>
              `).join("")}
            </ul>
          </section>

          <aside class="preflight-side">
            <section class="surface-card">
              <div class="card-heading"><div><span class="eyebrow">OBJECTIVES</span><h2>任务目标</h2></div></div>
              <ul class="objective-list">${contract.objectives.map((objective) => `<li><span class="status-mark neutral">○</span><span>${escapeHtml(objective.label)}</span></li>`).join("")}</ul>
            </section>
            <section class="surface-card">
              <div class="card-heading"><div><span class="eyebrow">BUDGET</span><h2>${this.labMode ? "实验室试飞" : "发射预算"}</h2></div></div>
              <div class="data-list">
                <div><span>${this.labMode ? "试飞费用" : "硬件支出"}</span><strong class="accent">${money(this.labMode ? 0 : metrics.cost)}</strong></div>
                <div><span>当前余额</span><strong>${money(this.game.state.resources.funds)}</strong></div>
                <div><span>发射后余额</span><strong class="${costAfter < 0 && !this.labMode ? "danger-text" : "ok-text"}">${money(this.labMode ? this.game.state.resources.funds : costAfter)}</strong></div>
                <div><span>80 km 圆轨道速度</span><strong>${integer(orbitSpeed)} m/s</strong></div>
              </div>
            </section>
          </aside>
        </div>
      </section>
    `;
    requestAnimationFrame(() => this.mountAssembly("preflight-viewport"));
  }

  renderFlight() {
    const contract = this.activeLaunch.contract;
    const snapshot = this.flight.sim.snapshot();
    this.view.innerHTML = `
      <section class="flight-screen">
        <div id="flight-viewport" class="flight-viewport" aria-label="三维飞行视图"></div>
        <div class="flight-top-hud">
          <div class="flight-mission">
            <span class="live-dot"></span>
            <div><small>当前任务</small><strong>${escapeHtml(contract.name)}</strong></div>
          </div>
          <div class="flight-clock"><small>任务时间</small><strong id="hud-time">${formatDuration(snapshot.time)}</strong></div>
        </div>

        <div class="flight-telemetry">
          <div><span>高度</span><strong id="hud-altitude">${distance(snapshot.altitude)}</strong></div>
          <div><span>速度</span><strong id="hud-speed">${integer(snapshot.speed)} m/s</strong></div>
          <div><span>垂直速度</span><strong id="hud-vertical">${integer(snapshot.verticalSpeed)} m/s</strong></div>
          <div><span>动压</span><strong id="hud-q">${number(snapshot.dynamicPressure / 1000, 1)} kPa</strong></div>
          <div><span>远地点</span><strong id="hud-apoapsis">${orbitalDistance(snapshot.apoapsisAltitude)}</strong></div>
          <div><span>近地点</span><strong id="hud-periapsis">${orbitalDistance(snapshot.periapsisAltitude)}</strong></div>
          <div><span>质量</span><strong id="hud-mass">${formatMass(snapshot.mass)}</strong></div>
          <div><span>TWR</span><strong id="hud-twr">${number(snapshot.twr, 2)}</strong></div>
        </div>

        <aside class="flight-objectives">
          <span class="eyebrow">MISSION STATUS</span>
          <div id="flight-progress">
            ${objectiveStatus(contract, snapshot).map((objective) => `<span class="${objective.passed ? "passed" : ""}">${objective.passed ? "✓" : "○"} ${escapeHtml(objective.label)}</span>`).join("")}
          </div>
          <div class="flight-stage-line" id="flight-stage">推进级 ${snapshot.stageIndex + 1}/${snapshot.stageCount} · 燃料 ${formatMass(snapshot.stageFuel)}</div>
        </aside>

        <div class="flight-log" id="flight-log"></div>

        ${this.guideCard("flight", 4, "先点火，再轻轻转向", "把节流阀推到 100%。离地后松开垂直爬升，按住左转或右转让火箭逐渐贴近水平。返回时在 5 km 以下打开降落伞。", "收到")}

        <div class="countdown-overlay" id="countdown-overlay"><span>发射序列</span><strong>3</strong><small>等待点火指令</small></div>

        <div class="flight-control-dock">
          <div class="control-cluster">
            <button class="control-button" type="button" data-flight-control="rotate-left" title="向左转向">←</button>
            <button class="control-button" type="button" data-flight-control="rotate-right" title="向右转向">→</button>
            <button class="control-button wide" type="button" data-action="flight-sas" id="sas-button">SAS</button>
            <button class="control-button" type="button" data-action="flight-sas-mode" id="sas-mode-button">速度</button>
          </div>
          <label class="throttle-control">
            <span>节流阀 <strong id="throttle-label">${Math.round(snapshot.throttle * 100)}%</strong></span>
            <input id="throttle-input" type="range" min="0" max="100" value="${Math.round(snapshot.throttle * 100)}" />
          </label>
          <div class="control-cluster dock-actions">
            <button class="control-button wide" type="button" data-action="flight-stage" id="stage-button">分级</button>
            <button class="control-button wide" type="button" data-action="flight-chute" id="chute-button">开伞</button>
            <button class="control-button wide" type="button" data-action="flight-payload" id="payload-button">部署</button>
            ${[1, 5, 20].map((warp) => `<button class="control-button" type="button" data-action="flight-warp" data-warp="${warp}" id="warp-${warp}">×${warp}</button>`).join("")}
            <button class="control-button danger" type="button" data-action="flight-abort">中止</button>
          </div>
        </div>
      </section>
    `;
    this.lastFrameAt = performance.now();
    this.flightScene = new FlightScene(document.querySelector("#flight-viewport"), {
      blueprint: this.activeLaunch.reservation.blueprint,
      partConfigs: this.activeLaunch.reservation.partConfigs,
    });
    this.flightScene.update(snapshot);
    this.flightScene.render();
    this.startFlightLoop();
    this.syncFlightInputs();
  }

  startFlight() {
    const contract = this.labMode ? CONTRACTS[0] : this.game.activeContract;
    const requirePayload = contract.id === "satellite_one";
    const validation = this.getValidation({ requirePayload });
    if (!validation.valid) {
      this.toast("发射前检查未通过。", "error");
      return;
    }
    const reservation = this.labMode ? { ok: true, reservation: {
      id: `experiment_${Date.now()}`, cost: 0, blueprint: [...this.game.state.blueprint],
      partConfigs: this.game.state.partConfigs.map((config) => ({ ...config })),
    } } : this.game.reserveLaunch();
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
      labMode: this.labMode,
    };
    const sim = new FlightSimulation(reservation.reservation.blueprint, {
      unlockedTech: this.game.state.unlockedTech,
      partConfigs: reservation.reservation.partConfigs,
    });
    sim.setThrottle(0);
    this.flight = {
      sim,
      warp: 1,
      completed: false,
      started: false,
      ignited: false,
      countdown: 3.2,
      lastHudUpdate: 0,
      clock: new FixedStepClock(DEFAULT_TIME_STEP),
    };
    this.screen = "flight";
    this.render();
  }

  startFlightLoop() {
    cancelAnimationFrame(this.animationFrame);
    this.lastFrameAt = performance.now();
    const loop = (now) => {
      if (!this.flight || this.screen !== "flight") return;
      const realDelta = Math.min(0.12, Math.max(0, (now - this.lastFrameAt) / 1000));
      this.lastFrameAt = now;

      if (!this.flight.started) {
        this.flight.countdown -= realDelta;
        this.updateCountdown();
        if (this.flight.countdown <= 0) {
          this.flight.started = true;
          this.updateCountdown();
        }
      } else {
        const sim = this.flight.sim;
        const waitingForIgnition = !this.flight.ignited && sim.throttle < 0.02;
        if (!waitingForIgnition) {
          this.flight.ignited = true;
          this.flight.clock.advance(realDelta, this.flight.warp, (step) => {
            sim.update(step, {
              throttle: sim.throttle,
              rotation: sim.rotationInput,
            });
            return sim.status === "flying";
          });
        }
      }

      const snapshot = this.flight.sim.snapshot();
      this.flightScene?.update(snapshot);
      this.flightScene?.render();
      this.updateFlightHud(now, snapshot);

      const needsLanding = this.activeLaunch.contract.objectives.some(
        (objective) => objective.type === "safeLanding",
      );
      const objectives = objectiveStatus(this.activeLaunch.contract, snapshot);
      if (
        snapshot.status === "flying" &&
        this.flight.started &&
        this.flight.ignited &&
        !needsLanding &&
        objectives.every((objective) => objective.passed)
      ) {
        this.endFlight();
        return;
      }
      if (snapshot.status !== "flying") {
        this.endFlight();
        return;
      }
      this.animationFrame = requestAnimationFrame(loop);
    };
    this.animationFrame = requestAnimationFrame(loop);
  }

  updateCountdown() {
    const overlay = document.querySelector("#countdown-overlay");
    if (!overlay) return;
    if (this.flight?.started && !this.flight.ignited) {
      overlay.classList.remove("hidden");
      const label = overlay.querySelector("span");
      const strong = overlay.querySelector("strong");
      const hint = overlay.querySelector("small");
      if (label) label.textContent = "等待点火";
      if (strong) strong.textContent = "↑";
      if (hint) hint.textContent = "将节流阀推到 100%";
      return;
    }
    if (this.flight?.started) {
      overlay.classList.add("hidden");
      return;
    }
    const value = Math.max(1, Math.ceil(this.flight?.countdown || 0));
    const numberElement = overlay.querySelector("strong");
    if (numberElement && numberElement.textContent !== String(value)) {
      numberElement.textContent = String(value);
      numberElement.classList.remove("tick");
      void numberElement.offsetWidth;
      numberElement.classList.add("tick");
    }
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
    const scienceMultiplier = compileCraft(
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
    );
    const settlement = settleMission({
      contract: this.activeLaunch.contract,
      snapshot,
      craftCost: this.flightMetrics.cost,
      recoveryRate: this.game.limits.recoveryRate,
      researchMultiplier: this.game.limits.researchMultiplier,
      scienceMultiplier,
    });
    const analysis = analyzeFailure(snapshot, this.flightMetrics, this.activeLaunch.contract);
    if (!this.activeLaunch.labMode) this.game.settleMission(settlement);
    const previous = this.lastMission?.labMode ? this.lastMission : this.previousExperiment;
    this.lastMission = {
      contract: this.activeLaunch.contract,
      snapshot,
      settlement,
      analysis,
      telemetry: [...this.flight.sim.telemetry],
      metrics: this.flightMetrics,
      labMode: this.activeLaunch.labMode,
      blueprint: this.activeLaunch.reservation.blueprint,
      partConfigs: this.activeLaunch.reservation.partConfigs,
      previous: previous ? { snapshot: previous.snapshot, metrics: previous.metrics } : null,
    };
    if (this.activeLaunch.labMode) this.previousExperiment = this.lastMission;
    this.flight = null;
    this.screen = settlement.success ? "results" : "analysis";
    this.render();
  }
  renderResults() {
    const mission = this.lastMission;
    if (mission?.labMode) { this.renderExperiment(); return; }
    if (!mission) {
      this.navigate("home");
      return;
    }
    const result = mission.settlement;
    const snapshot = mission.snapshot;
    this.view.innerHTML = `
      <section class="screen result-screen">
        <article class="result-hero ${result.success ? "success" : "failure"}">
          <div class="result-seal">${result.success ? "PASS" : "REVIEW"}</div>
          <div>
            <p class="eyebrow">MISSION REPORT</p>
            <h1>${result.success ? "任务完成" : "任务未完成"}</h1>
            <p>${escapeHtml(mission.contract.name)} · ${statusLabel(snapshot.status)} · ${formatDuration(snapshot.time)}</p>
          </div>
          <div class="result-score"><strong>${result.completedObjectives}/${result.objectiveCount}</strong><span>目标完成</span></div>
        </article>

        <div class="result-layout">
          <section class="surface-card">
            <div class="card-heading"><div><span class="eyebrow">VERIFICATION</span><h2>目标核验</h2></div></div>
            <ul class="check-list">
              ${result.objectives.map((objective) => `
                <li><span class="status-mark ${objective.passed ? "pass" : "fail"}">${objective.passed ? "✓" : "×"}</span><span><strong>${escapeHtml(objective.label)}</strong><small>实测：${escapeHtml(objective.actual)}</small></span></li>
              `).join("")}
            </ul>
            <div class="button-row">
              <button class="button primary" type="button" data-nav="research">投入研发</button>
              <button class="button" type="button" data-action="open-telemetry">查看遥测</button>
              <button class="button" type="button" data-nav="home">任务中心</button>
            </div>
          </section>

          <section class="surface-card">
            <div class="card-heading"><div><span class="eyebrow">SETTLEMENT</span><h2>资源结算</h2></div><span class="status-pill ok">已入账</span></div>
            <div class="ledger">
              <div><span>合同奖励</span><strong>${money(result.success ? Math.max(0, result.funds - result.salvage) : result.failureGrant)}</strong></div>
              <div><span>硬件回收</span><strong>${money(result.salvage)}</strong></div>
              <div><span>科研点数</span><strong class="accent">+${result.science} SP</strong></div>
              <div><span>声誉变化</span><strong>${result.reputation >= 0 ? "+" : ""}${result.reputation}</strong></div>
            </div>
            <div class="result-statline"><span>峰值高度 ${distance(snapshot.maxAltitude)}</span><span>峰值速度 ${integer(snapshot.maxSpeed)} m/s</span><span>最大动压 ${number(snapshot.maxDynamicPressure / 1000, 1)} kPa</span></div>
          </section>
        </div>
      </section>
    `;
  }

  renderAnalysis() {
    const mission = this.lastMission;
    if (mission?.labMode) { this.renderExperiment(); return; }
    if (!mission) {
      this.navigate("home");
      return;
    }
    const analysis = mission.analysis;
    const snapshot = mission.snapshot;
    this.view.innerHTML = `
      <section class="screen result-screen">
        <article class="result-hero failure">
          <div class="result-seal">DIAGNOSE</div>
          <div><p class="eyebrow">FLIGHT ANALYSIS</p><h1>${escapeHtml(analysis.cause)}</h1><p>${escapeHtml(analysis.evidence)}</p></div>
          <div class="result-score"><strong>${statusLabel(snapshot.status)}</strong><span>飞行结果</span></div>
        </article>

        <div class="result-layout">
          <section class="surface-card">
            <div class="card-heading"><div><span class="eyebrow">TELEMETRY</span><h2>飞行遥测</h2></div><button class="button small" type="button" data-action="open-telemetry">放大图表</button></div>
            <canvas id="telemetry-chart" class="telemetry-chart" height="260"></canvas>
            <div class="result-statline"><span>最高高度 ${distance(snapshot.maxAltitude)}</span><span>最高速度 ${integer(snapshot.maxSpeed)} m/s</span><span>最大过载 ${number(snapshot.maxGForce, 1)} g</span></div>
          </section>

          <section class="surface-card diagnosis-card">
            <div class="card-heading"><div><span class="eyebrow">NEXT ITERATION</span><h2>下一次怎么改</h2></div></div>
            <div class="analysis-box"><strong>主要故障</strong><span>${escapeHtml(analysis.cause)}</span></div>
            <ol class="recommendation-list">
              ${analysis.recommendations.map((recommendation) => `<li>${escapeHtml(recommendation)}</li>`).join("")}
            </ol>
            <div class="button-row">
              <button class="button primary" type="button" data-nav="hangar">修改火箭</button>
              <button class="button" type="button" data-nav="preflight">重新检查</button>
              <button class="button ghost" type="button" data-nav="home">任务中心</button>
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
          <div class="tier-heading"><span>Tier ${tier}</span><small>${nodes.length} 个节点</small></div>
          ${nodes.map((node) => {
            const unlocked = this.game.state.unlockedTech.includes(node.id);
            const prereqMet = node.prerequisites.every((id) => this.game.state.unlockedTech.includes(id));
            const available = !unlocked && prereqMet && science >= node.cost;
            const stateLabel = unlocked ? "已解锁" : prereqMet ? `${node.cost} SP` : "前置未完成";
            return `
              <article class="tech-node ${unlocked ? "unlocked" : available ? "available" : "locked"}">
                <div class="tech-node-top"><span class="tech-tier-mark">${String(tier).padStart(2, "0")}</span><span class="status-pill ${unlocked ? "ok" : available ? "active" : ""}">${stateLabel}</span></div>
                <h3>${escapeHtml(node.name)}</h3>
                <p>${escapeHtml(node.description)}</p>
                <div class="unlock-tags">${node.parts.map((partId) => `<span class="tag">${escapeHtml(getPart(partId).short)}</span>`).join("")}</div>
                <div class="button-row">
                  <button class="button small ghost" type="button" data-action="open-tech" data-tech="${node.id}">技术详情</button>
                  ${!unlocked && prereqMet ? `<button class="button small" type="button" data-action="unlock-tech" data-tech="${node.id}" ${science < node.cost ? "disabled" : ""}>研发</button>` : ""}
                </div>
              </article>
            `;
          }).join("")}
        </div>
      `;
    }).join("");

    const upgrades = Object.values(BASE_UPGRADES).map((definition) => {
      const status = getBaseUpgradeState(this.game.state, definition.id);
      const next = status.next;
      return `
        <article class="facility-card">
          <div class="facility-icon">${definition.name.slice(0, 1)}</div>
          <div class="facility-copy">
            <div class="card-heading"><div><span class="eyebrow">LV.${status.currentLevel + 1}</span><h3>${escapeHtml(definition.name)}</h3></div>${next ? `<strong>${money(next.cost)}</strong>` : `<span class="status-pill ok">满级</span>`}</div>
            <p>${escapeHtml(definition.description)}</p>
            <div class="level-pips">${definition.levels.map((_, index) => `<span class="${index <= status.currentLevel ? "active" : ""}"></span>`).join("")}</div>
            <div class="facility-footer"><span>${next ? `下一等级：${next.value}` : "设施性能已达上限"}</span>${next ? `<button class="button small" type="button" data-action="upgrade-base" data-upgrade="${definition.id}" ${funds < next.cost ? "disabled" : ""}>升级设施</button>` : ""}</div>
          </div>
        </article>
      `;
    }).join("");

    this.view.innerHTML = `
      <section class="screen research-screen">
        <div class="workspace-heading">
          <div><p class="eyebrow">RESEARCH & BASE</p><h1>研发基地</h1><p class="muted">合同带来资金与科研点；科研解锁零件；基地升级扩大下一次任务的设计空间。</p></div>
          <div class="segmented-control">
            <button class="${this.techTab === "research" ? "active" : ""}" type="button" data-action="tech-tab" data-tab="research">科技树</button>
            <button class="${this.techTab === "base" ? "active" : ""}" type="button" data-action="tech-tab" data-tab="base">基地设施</button>
          </div>
        </div>

        ${this.techTab === "research" ? `
          <section class="surface-card research-board">
            <div class="card-heading"><div><span class="eyebrow">TECHNOLOGY</span><h2>技术路线</h2></div><span class="science-balance">${integer(science)} SP 可用</span></div>
            <div class="tech-columns">${techColumns}</div>
          </section>
        ` : `
          <section class="facility-grid">${upgrades}</section>
        `}
      </section>
    `;
  }

  getValidation(extra = {}) {
    return validateCraft(this.game.state.blueprint, {
      unlockedTech: this.game.state.unlockedTech,
      partConfigs: this.game.state.partConfigs,
      isUnlocked: (partId) => this.labMode || this.game.isPartUnlocked(partId),
      maxMass: this.labMode ? 140000 : this.game.limits.maxMass,
      maxParts: this.labMode ? 24 : this.game.limits.maxParts,
      funds: this.labMode ? Infinity : this.game.state.resources.funds,
      ...extra,
    });
  }

  getStageMap(blueprint) {
    const map = new Map();
    let stageIndex = 0;
    for (let index = blueprint.length - 1; index >= 0; index -= 1) {
      map.set(index, stageIndex);
      if (getPart(blueprint[index])?.splitStage && index > 0) stageIndex += 1;
    }
    return map;
  }
  handleClick(event) {
    if (event.target.closest("[data-flight-control]")) return;
    const navButton = event.target.closest("[data-nav]");
    if (navButton && !navButton.disabled) {
      this.navigate(navButton.dataset.nav);
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === "physics-notes") {
      this.openSheet({ kicker: "ENGINEERING", title: "组装中的物理", body: `
        <h3>燃料也是重量</h3><p>增加装填会延长燃烧时间，同时降低起飞推重比。理想 Δv 不扣阻力与重力损失，不等于实测高度。</p>
        <h3>推力不穿过质心，就会转动</h3><p>力矩 = 作用力 × 垂直力臂。偏置发动机产生转动；镜像发动机可以抵消偏心力矩，但也增加质量和耗油。</p>
        <h3>尾翼位置会改变恢复力矩</h3><p>小攻角、向前飞行时，质心后方的尾翼通常有助于恢复姿态。没有空气时尾翼不起作用。</p>
        <h3>上太空不等于入轨</h3><p>轨道需要足够的横向速度；飞船在引力下持续自由落体。本原型使用二维小行星、简化大气和刚体，不是现实发射参数表。</p>` });
    }
    if (action === "game-mode") {
      this.labMode = button.dataset.mode === "lab";
      this.render();
    }
    if (action === "assembly-view") {
      this.editMode = button.dataset.mode === "edit";
      this.render();
    }
    if (action === "edit-undo" || action === "edit-redo") {
      this.game.restoreEdit(action === "edit-undo" ? "undo" : "redo");
      this.selectedPartIndex = Math.min(this.selectedPartIndex, Math.max(0, this.game.state.blueprint.length - 1));
      this.render();
    }
    if (action === "mirror-engine") {
      if (this.game.mirrorEngine(this.selectedPartIndex, this.labMode)) this.render();
      else this.toast("当前容量不足。", "warn");
    }

    if (action === "guide-step") {
      this.markGuide(button.dataset.guide);
      return;
    }
    if (action === "open-mission") this.openMissionSheet();
    if (action === "open-contract") this.openContractSheet(button.dataset.contract);
    if (action === "open-part") this.openPartSheet();
    if (action === "open-tech") this.openTechSheet(button.dataset.tech);
    if (action === "open-help") this.openHelpSheet();
    if (action === "open-telemetry") this.openTelemetrySheet();
    if (action === "reset-camera") this.resetCamera();

    if (action === "choose-contract") {
      const result = this.game.chooseContract(button.dataset.contract);
      this.toast(result.ok ? "合同已接受。" : result.reason, result.ok ? "info" : "warn");
      if (result.ok) this.render();
    }
    if (action === "hangar-category") {
      this.hangarCategory = button.dataset.category;
      this.render();
    }
    if (action === "add-part") {
      const part = getPart(button.dataset.part);
      if (this.game.addPart(button.dataset.part, this.labMode)) {
        this.selectedPartIndex = this.game.state.blueprint.length - 1;
        this.toast(`${part.name} 已加入构型。`);
        this.render();
      }
    }
    if (action === "select-part") this.selectPart(Number(button.dataset.index));
    if (action === "remove-part") {
      const index = Number(button.dataset.index);
      if (this.game.removePart(index)) {
        this.selectedPartIndex = Math.max(0, Math.min(index, this.game.state.blueprint.length - 1));
        this.toast("零件已移除。");
        this.render();
      }
    }
    if (action === "move-part") {
      const index = Number(button.dataset.index);
      if (this.game.movePart(index, Number(button.dataset.direction))) {
        this.selectedPartIndex = index + Number(button.dataset.direction);
        this.render();
      }
    }
    if (action === "reset-blueprint") {
      this.confirmSheet("恢复基础构型", "当前构型会被替换为可完成探空任务的基础火箭。", () => {
        this.game.resetBlueprint();
        this.selectedPartIndex = 0;
        this.render();
      });
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
    if (action === "flight-warp" && this.flight) {
      this.flight.warp = Number(button.dataset.warp);
      this.syncFlightInputs();
    }
    if (action === "flight-abort") {
      this.confirmSheet("中止任务？", "火箭将保留当前遥测并立即进入任务结算。", () => {
        this.flight?.sim.abort();
      });
    }
    if (action === "unlock-tech") {
      const result = this.game.unlockTech(button.dataset.tech);
      this.toast(result.ok ? `已解锁 ${result.node.name}。` : result.reason, result.ok ? "info" : "warn");
      if (result.ok) this.render();
    }
    if (action === "upgrade-base") {
      const result = this.game.upgradeBase(button.dataset.upgrade);
      this.toast(result.ok ? `${result.upgrade.name} 已升级到 Lv.${result.level + 1}。` : result.reason, result.ok ? "info" : "warn");
      if (result.ok) this.render();
    }
    if (action === "tech-tab") {
      this.techTab = button.dataset.tab;
      this.render();
    }
    if (action === "reset-game") {
      this.confirmSheet("重置全部进度", "资金、科研、合同和构型都会恢复初始状态。", () => {
        this.game.reset();
        this.selectedPartIndex = 0;
        this.closeSheet();
        this.screen = "home";
        this.render();
      });
    }
  }

  handleInput(event) {
    if (event.target.dataset.partConfig) {
      const key = event.target.dataset.partConfig;
      const index = Number(event.target.dataset.index);
      const editingKey = `${index}:${key}`;
      if (this.editingKey !== editingKey) { this.game.rememberEdit(); this.editingKey = editingKey; }
      const value = Number(event.target.value);
      this.game.configurePart(index, { [key]: key === "fuelFraction" ? value / 100 : value }, false);
      const output = this.view.querySelector(`[data-config-value="${key}"]`);
      if (output) output.textContent = `${number(value, key === "fuelFraction" ? 0 : 2)} ${key === "fuelFraction" ? "%" : key === "angle" ? "°" : "m"}`;
      this.refreshAssembly();
    }
    if (event.target.id === "throttle-input" && this.flight) {
      const value = Number(event.target.value) / 100;
      this.flight.sim.setThrottle(value);
      const label = document.querySelector("#throttle-label");
      if (label) label.textContent = `${Math.round(value * 100)}%`;
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
    if (["arrowleft", "arrowright", " ", "shift", "control"].includes(key)) event.preventDefault();
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
    if (["arrowleft", "arrowright", "a", "d"].includes(key) && this.pointerRotation === 0) {
      this.flight.sim.setRotation(0);
    }
  }

  syncFlightInputs() {
    if (!this.flight) return;
    const sim = this.flight.sim;
    const throttleInput = document.querySelector("#throttle-input");
    const throttleLabel = document.querySelector("#throttle-label");
    if (throttleInput) throttleInput.value = String(Math.round(sim.throttle * 100));
    if (throttleLabel) throttleLabel.textContent = `${Math.round(sim.throttle * 100)}%`;
    document.querySelector("#sas-button")?.classList.toggle("active", sim.sasEnabled);
    const modeButton = document.querySelector("#sas-mode-button");
    if (modeButton) {
      modeButton.textContent = { prograde: "速度", radial: "径向", stability: "保持" }[sim.sasMode];
    }
    const stageButton = document.querySelector("#stage-button");
    if (stageButton) stageButton.disabled = sim.stageIndex >= sim.craft.stages.length - 1;
    const chuteButton = document.querySelector("#chute-button");
    if (chuteButton) chuteButton.disabled = sim.parachuteDeployed || !sim.craft.stages.some((stage) => stage.hasParachute);
    const payloadButton = document.querySelector("#payload-button");
    if (payloadButton) payloadButton.disabled = sim.payloadDeployed || !sim.craft.stages.some((stage) => stage.hasPayload);
    [1, 5, 20].forEach((warp) => document.querySelector(`#warp-${warp}`)?.classList.toggle("active", this.flight.warp === warp));
  }

  updateFlightHud(now, snapshot) {
    if (!this.flight) return;
    const set = (selector, text, className) => {
      const element = document.querySelector(selector);
      if (!element) return;
      element.textContent = text;
      if (className !== undefined) element.className = className;
    };
    set("#hud-time", formatDuration(snapshot.time));
    set("#hud-altitude", distance(snapshot.altitude));
    set("#hud-speed", `${integer(snapshot.speed)} m/s`);
    set("#hud-vertical", `${integer(snapshot.verticalSpeed)} m/s`);
    set("#hud-q", `${number(snapshot.dynamicPressure / 1000, 1)} kPa`, snapshot.dynamicPressure > 18000 ? "danger-text" : "");
    set("#hud-apoapsis", orbitalDistance(snapshot.apoapsisAltitude));
    set("#hud-periapsis", orbitalDistance(snapshot.periapsisAltitude));
    set("#hud-mass", formatMass(snapshot.mass));
    set("#hud-twr", number(snapshot.twr, 2));
    const progress = document.querySelector("#flight-progress");
    if (progress) {
      progress.innerHTML = objectiveStatus(this.activeLaunch.contract, snapshot)
        .map((objective) => `<span class="${objective.passed ? "passed" : ""}">${objective.passed ? "✓" : "○"} ${escapeHtml(objective.label)}</span>`)
        .join("");
    }
    const stage = document.querySelector("#flight-stage");
    if (stage) stage.textContent = `推进级 ${snapshot.stageIndex + 1}/${snapshot.stageCount} · 燃料 ${formatMass(snapshot.stageFuel)}`;
    if (!this.flight.started || !this.flight.ignited) {
      document.querySelector("#countdown-overlay")?.classList.remove("hidden");
    } else {
      document.querySelector("#countdown-overlay")?.classList.add("hidden");
    }
    if (now - this.flight.lastHudUpdate > 180) {
      const log = document.querySelector("#flight-log");
      if (log) {
        log.innerHTML = snapshot.events.slice(0, 5).map((event) => `<div><span>${formatDuration(event.time)}</span>${escapeHtml(event.message)}</div>`).join("");
      }
      this.flight.lastHudUpdate = now;
    }
  }
  openSheet({ kicker, title, body, size = "medium" }) {
    this.sheetRegion.innerHTML = `
      <div class="sheet-backdrop" data-sheet-close>
        <aside class="sheet-panel ${size}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
          <header class="sheet-header">
            <div><span class="eyebrow">${escapeHtml(kicker)}</span><h2>${escapeHtml(title)}</h2></div>
            <button class="sheet-close" type="button" data-sheet-close aria-label="关闭">×</button>
          </header>
          <div class="sheet-body">${body}</div>
        </aside>
      </div>
    `;
  }

  closeSheet() {
    this.sheetRegion.innerHTML = "";
  }

  handleSheetClick(event) {
    const close = event.target.closest("[data-sheet-close]");
    if (close && (close.classList.contains("sheet-backdrop") || close.classList.contains("sheet-close"))) {
      this.closeSheet();
      return;
    }
    const navButton = event.target.closest("[data-nav]");
    if (navButton) {
      this.closeSheet();
      this.navigate(navButton.dataset.nav);
      return;
    }
    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    const action = actionButton.dataset.action;
    if (!["reset-game", "open-part", "open-tech"].includes(action)) this.closeSheet();
    this.handleClick(event);
  }

  confirmSheet(title, body, onConfirm) {
    this.openSheet({
      kicker: "CONFIRM",
      title,
      size: "small",
      body: `
        <p>${escapeHtml(body)}</p>
        <div class="button-row sheet-actions">
          <button class="button" type="button" data-sheet-close>取消</button>
          <button class="button primary" type="button" id="sheet-confirm">确认</button>
        </div>
      `,
    });
    document.querySelector("#sheet-confirm")?.addEventListener("click", () => {
      this.closeSheet();
      onConfirm();
    });
  }

  openMissionSheet() {
    const contract = this.game.activeContract;
    const metrics = craftSummary(this.game.state.blueprint, this.game.state.unlockedTech, this.game.state.partConfigs);
    this.openSheet({
      kicker: "MISSION BRIEF",
      title: contract.name,
      size: "medium",
      body: `
        <p>${escapeHtml(contract.summary)}</p>
        <div class="sheet-section"><span class="eyebrow">委托方</span><strong>${escapeHtml(contract.client)}</strong></div>
        <div class="sheet-section"><span class="eyebrow">任务目标</span><ul class="objective-list">${contract.objectives.map((objective) => `<li><span class="status-mark neutral">○</span><span>${escapeHtml(objective.label)}</span></li>`).join("")}</ul></div>
        <div class="sheet-section"><span class="eyebrow">奖励</span><div class="contract-rewards"><span>${money(contract.reward.funds)}</span><span>${contract.reward.science} SP</span><span>+${contract.reward.reputation} 声誉</span></div></div>
        <div class="sheet-section"><span class="eyebrow">当前火箭</span><div class="data-list"><div><span>湿重</span><strong>${formatMass(metrics.mass)}</strong></div><div><span>估算 Δv</span><strong>${integer(metrics.deltaV)} m/s</strong></div><div><span>发射成本</span><strong>${money(metrics.cost)}</strong></div></div></div>
        <div class="button-row sheet-actions"><button class="button primary" type="button" data-nav="hangar">配置火箭</button></div>
      `,
    });
  }

  openContractSheet(contractId) {
    const contract = CONTRACTS.find((item) => item.id === contractId);
    if (!contract) return;
    const available = this.game.availableContracts.includes(contract);
    const completed = this.game.state.completedContracts.includes(contract.id);
    this.openSheet({
      kicker: "CONTRACT DETAIL",
      title: contract.name,
      body: `
        <p>${escapeHtml(contract.summary)}</p>
        <div class="sheet-section"><span class="eyebrow">委托方</span><strong>${escapeHtml(contract.client)}</strong></div>
        <div class="sheet-section"><span class="eyebrow">验收条件</span><ul class="objective-list">${contract.objectives.map((objective) => `<li><span class="status-mark neutral">○</span><span>${escapeHtml(objective.label)}</span></li>`).join("")}</ul></div>
        <div class="sheet-section"><span class="eyebrow">合同奖励</span><div class="contract-rewards"><span>${money(contract.reward.funds)}</span><span>${contract.reward.science} SP</span><span>+${contract.reward.reputation} 声誉</span></div></div>
        ${available && !completed ? `<div class="button-row sheet-actions"><button class="button primary" type="button" data-action="choose-contract" data-contract="${contract.id}">接受合同</button></div>` : ""}
      `,
    });
  }

  openPartSheet() {
    const part = getPart(this.game.state.blueprint[this.selectedPartIndex]);
    if (!part) return;
    const rows = [
      ["类别", CATEGORY_LABELS[part.category]],
      ["质量", formatMass(part.mass)],
      ["价格", money(part.cost)],
      ["阻力面积", number(part.dragArea || 0, 1)],
      ["结构极限", part.structuralLimit ? `${integer(part.structuralLimit)} Pa` : "未定义"],
      ["推力", part.thrust ? `${integer(part.thrust)} N` : "无"],
      ["比冲", part.isp ? `${integer(part.isp)} s` : "无"],
      ["燃料", part.fuelMass ? formatMass(part.fuelMass) : "无"],
      ["控制力矩", part.torque ? integer(part.torque) : "无"],
      ["发电", part.powerGeneration ? `${integer(part.powerGeneration)} W` : "无"],
      ["降落伞面积", part.parachuteArea ? `${integer(part.parachuteArea)} m²` : "无"],
      ["触地容忍", part.impactTolerance ? `+${number(part.impactTolerance, 1)} m/s` : "无"],
    ].filter(([, value]) => value !== "无");
    this.openSheet({
      kicker: "PART DATA",
      title: part.name,
      body: `
        <p>${escapeHtml(part.description)}</p>
        <div class="data-list detailed">${rows.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("")}</div>
      `,
    });
  }

  openTechSheet(nodeId) {
    const node = TECH_NODES.find((item) => item.id === nodeId);
    if (!node) return;
    const unlocked = this.game.state.unlockedTech.includes(node.id);
    const prereqMet = node.prerequisites.every((id) => this.game.state.unlockedTech.includes(id));
    const prerequisites = node.prerequisites.length
      ? node.prerequisites.map((id) => TECH_NODES.find((nodeItem) => nodeItem.id === id)?.name || id).join("、")
      : "无";
    this.openSheet({
      kicker: "TECHNOLOGY",
      title: node.name,
      body: `
        <p>${escapeHtml(node.description)}</p>
        <div class="data-list detailed">
          <div><span>研发成本</span><strong>${node.cost} SP</strong></div>
          <div><span>前置技术</span><strong>${escapeHtml(prerequisites)}</strong></div>
          <div><span>解锁零件</span><strong>${node.parts.map((id) => escapeHtml(getPart(id).name)).join("、")}</strong></div>
        </div>
        <div class="button-row sheet-actions">${!unlocked && prereqMet ? `<button class="button primary" type="button" data-action="unlock-tech" data-tech="${node.id}" ${this.game.state.resources.science < node.cost ? "disabled" : ""}>消耗 ${node.cost} SP 研发</button>` : ""}</div>
      `,
    });
  }

  openHelpSheet() {
    this.openSheet({
      kicker: "FIELD MANUAL",
      title: "操作与模拟说明",
      size: "large",
      body: `
        <div class="manual-grid">
          <section><span class="eyebrow">组装</span><h3>3D 总装</h3><p>拖拽旋转视角，滚轮缩放，点击箭体选择零件。零件顺序从上到下写入真实构型，分离器会切分推进级。</p></section>
          <section><span class="eyebrow">飞行</span><h3>控制</h3><p>节流阀控制推力；左右键或 A/D 控制转向；空格分级；P 开伞；T 切换 SAS。触屏设备可使用底部控制台。</p></section>
          <section><span class="eyebrow">物理</span><h3>模拟边界</h3><p>质量、燃料、推力、阻力、升力、重力和连续轨道积分均为实时计算。3D 场景只负责显示，不会修改物理结果。</p></section>
          <section><span class="eyebrow">失败</span><h3>诊断</h3><p>任务结束后会保存遥测，并指出触地速度、动压、失稳或速度增量等最可能原因。</p></section>
        </div>
        <div class="sheet-danger-zone"><div><strong>开发存档</strong><span>清除本机浏览器中的全部任务进度。</span></div><button class="button danger" type="button" data-action="reset-game">重置进度</button></div>
      `,
    });
  }

  openTelemetrySheet() {
    if (!this.lastMission) {
      this.toast("当前没有可查看的飞行遥测。", "warn");
      return;
    }
    this.openSheet({
      kicker: "FLIGHT DATA",
      title: `${this.lastMission.contract.name} · 遥测`,
      size: "large",
      body: `
        <canvas id="telemetry-sheet-chart" class="telemetry-chart sheet-chart" height="320"></canvas>
        <div class="result-statline"><span>任务时间 ${formatDuration(this.lastMission.snapshot.time)}</span><span>最高高度 ${distance(this.lastMission.snapshot.maxAltitude)}</span><span>最高速度 ${integer(this.lastMission.snapshot.maxSpeed)} m/s</span></div>
      `,
    });
    requestAnimationFrame(() => this.drawTelemetryChart(this.lastMission.telemetry, "telemetry-sheet-chart"));
  }

  drawTelemetryChart(telemetry, canvasId = "telemetry-chart") {
    const canvas = document.querySelector(`#${canvasId}`);
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(bounds.width));
    const height = canvasId === "telemetry-sheet-chart" ? 320 : 260;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const source = telemetry?.length > 1 ? telemetry : [
      { time: 0, altitude: 0, speed: 0 },
      { time: 1, altitude: 0, speed: 0 },
    ];
    const padding = { left: 52, right: 18, top: 24, bottom: 30 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const maxTime = Math.max(1, ...source.map((point) => point.time));
    const maxAltitude = Math.max(1000, ...source.map((point) => point.altitude));
    const maxSpeed = Math.max(100, ...source.map((point) => point.speed));
    ctx.strokeStyle = "rgba(35, 34, 30, 0.14)";
    ctx.lineWidth = 1;
    for (let line = 0; line <= 4; line += 1) {
      const y = padding.top + (plotHeight * line) / 4;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
    }
    const drawLine = (key, maxValue, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      source.forEach((point, index) => {
        const x = padding.left + (point.time / maxTime) * plotWidth;
        const y = padding.top + plotHeight - (Math.max(0, point[key]) / maxValue) * plotHeight;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    drawLine("altitude", maxAltitude, "#c96442");
    drawLine("speed", maxSpeed, "#416f77");
    ctx.fillStyle = "#706d65";
    ctx.font = '11px "IBM Plex Mono", "Cascadia Mono", monospace';
    ctx.fillText("高度 / 速度", padding.left, 14);
    ctx.fillText("0", 26, height - padding.bottom + 4);
    ctx.fillText(`${Math.round(maxAltitude / 1000)} km`, 8, padding.top + 4);
    ctx.fillStyle = "#c96442";
    ctx.fillText("高度", width - 78, 14);
    ctx.fillStyle = "#416f77";
    ctx.fillText("速度", width - 40, 14);
  }

  toast(message, type = "info") {
    const element = document.createElement("div");
    element.className = `toast ${type}`;
    element.textContent = message;
    this.toastRegion.append(element);
    window.setTimeout(() => element.remove(), 3400);
  }

  disposeScenes() {
    this.assemblyScene?.dispose();
    this.preflightScene?.dispose();
    this.flightScene?.dispose();
    this.assemblyScene = null;
    this.preflightScene = null;
    this.flightScene = null;
  }
}

window.gameApp = new GameApp();
