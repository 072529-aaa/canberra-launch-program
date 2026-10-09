import {
  BASE_UPGRADES,
  CONTRACTS,
  getContract,
  getTechNode,
  isPartUnlocked,
  getPart,
} from "./data.js";
import { DEFAULT_BLUEPRINT, compileCraft, normalizePartConfig } from "./craft.js";

const STORAGE_KEY = "canberra-launch-program-state-v1";

function createDefaultState() {
  return {
    version: 1,
    resources: {
      funds: 120000,
      science: 35,
      reputation: 0,
    },
    unlockedTech: ["start"],
    base: {
      launch_pad: 0,
      assembly: 0,
      research_lab: 0,
      recovery: 0,
    },
    blueprint: [...DEFAULT_BLUEPRINT],
    partConfigs: DEFAULT_BLUEPRINT.map((id) => normalizePartConfig(id)),
    activeContractId: "sounding_one",
    completedContracts: [],
    missionHistory: [],
    launchReservations: [],
    settings: {
      tutorialEnabled: true,
      soundEnabled: false,
      theme: "light",
      guide: {
        command: false,
        hangar: false,
        mission: false,
        flight: false,
      },
    },
  };
}

function mergeState(raw) {
  const defaults = createDefaultState();
  if (!raw || typeof raw !== "object") return defaults;
  return {
    ...defaults,
    ...raw,
    resources: { ...defaults.resources, ...(raw.resources || {}) },
    base: { ...defaults.base, ...(raw.base || {}) },
    settings: {
      ...defaults.settings,
      ...(raw.settings || {}),
      guide: {
        ...defaults.settings.guide,
        ...(raw.settings?.guide || {}),
      },
    },
    unlockedTech: Array.isArray(raw.unlockedTech)
      ? [...new Set(raw.unlockedTech)]
      : defaults.unlockedTech,
    blueprint: Array.isArray(raw.blueprint)
      ? raw.blueprint
      : defaults.blueprint,
    partConfigs: (Array.isArray(raw.blueprint) ? raw.blueprint : defaults.blueprint)
      .map((id, index) => normalizePartConfig(id, raw.partConfigs?.[index])),
    completedContracts: Array.isArray(raw.completedContracts)
      ? raw.completedContracts
      : [],
    missionHistory: Array.isArray(raw.missionHistory)
      ? raw.missionHistory
      : [],
    launchReservations: Array.isArray(raw.launchReservations)
      ? raw.launchReservations
      : [],
  };
}

export class GameState {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.listeners = new Set();
    this.state = this.load();
    this.undoStack = [];
    this.redoStack = [];
  }

  load() {
    try {
      return mergeState(JSON.parse(this.storage?.getItem(STORAGE_KEY) || "null"));
    } catch {
      return createDefaultState();
    }
  }

  save() {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // The game remains playable if storage is disabled.
    }
    this.listeners.forEach((listener) => listener(this.state));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset() {
    this.state = createDefaultState();
    this.undoStack = [];
    this.redoStack = [];
    this.save();
  }

  isPartUnlocked(partId) {
    return isPartUnlocked(partId, this.state.unlockedTech);
  }

  get activeContract() {
    return getContract(this.state.activeContractId) || CONTRACTS[0];
  }

  get availableContracts() {
    return CONTRACTS.filter(
      (contract) =>
        this.state.resources.reputation >= (contract.unlock?.reputation || 0),
    );
  }

  get craft() {
    return compileCraft(this.state.blueprint, this.state.unlockedTech, this.state.partConfigs);
  }

  get limits() {
    const launchPad = BASE_UPGRADES.launch_pad.levels[this.state.base.launch_pad];
    const assembly = BASE_UPGRADES.assembly.levels[this.state.base.assembly];
    return {
      maxMass: launchPad.value,
      maxParts: assembly.value,
      researchMultiplier:
        BASE_UPGRADES.research_lab.levels[this.state.base.research_lab].value,
      recoveryRate:
        BASE_UPGRADES.recovery.levels[this.state.base.recovery].value,
    };
  }

  rememberEdit() {
    this.undoStack.push({ blueprint: [...this.state.blueprint], partConfigs: this.state.partConfigs.map((config) => ({ ...config })) });
    this.undoStack = this.undoStack.slice(-40);
    this.redoStack = [];
  }

  restoreEdit(direction) {
    const source = direction === "undo" ? this.undoStack : this.redoStack;
    const target = direction === "undo" ? this.redoStack : this.undoStack;
    if (!source.length) return false;
    target.push({ blueprint: [...this.state.blueprint], partConfigs: this.state.partConfigs.map((config) => ({ ...config })) });
    const previous = source.pop();
    this.state.blueprint = previous.blueprint;
    this.state.partConfigs = previous.partConfigs;
    this.save();
    return true;
  }

  configurePart(index, changes, remember = true) {
    if (!this.state.blueprint[index]) return false;
    if (remember) this.rememberEdit();
    this.state.partConfigs[index] = normalizePartConfig(this.state.blueprint[index], { ...this.state.partConfigs[index], ...changes });
    this.save();
    return true;
  }

  mirrorEngine(index, lab = false) {
    const id = this.state.blueprint[index];
    if (!this.craft.layout.find((entry) => entry.index === index)?.part.thrust) return false;
    if ((!lab && !this.isPartUnlocked(id)) || this.state.blueprint.length >= (lab ? 24 : this.limits.maxParts)) return false;
    this.rememberEdit();
    const current = this.state.partConfigs[index];
    const offset = Math.max(0.5, Math.abs(current.x));
    this.state.partConfigs[index] = { ...current, x: -offset };
    this.state.blueprint.splice(index + 1, 0, id);
    this.state.partConfigs.splice(index + 1, 0, { ...current, x: offset, angle: -current.angle });
    this.save();
    return true;
  }

  addPart(partId, lab = false) {
    if (!getPart(partId)) return false;
    if (!lab && !this.isPartUnlocked(partId)) return false;
    if (this.state.blueprint.length >= (lab ? 24 : this.limits.maxParts)) return false;
    this.rememberEdit();
    this.state.blueprint.push(partId);
    this.state.partConfigs.push(normalizePartConfig(partId));
    this.save();
    return true;
  }

  removePart(index) {
    if (index < 0 || index >= this.state.blueprint.length) return false;
    this.rememberEdit();
    this.state.blueprint.splice(index, 1);
    this.state.partConfigs.splice(index, 1);
    this.save();
    return true;
  }

  movePart(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= this.state.blueprint.length) return false;
    this.rememberEdit();
    const [partId] = this.state.blueprint.splice(index, 1);
    const [config] = this.state.partConfigs.splice(index, 1);
    this.state.blueprint.splice(target, 0, partId);
    this.state.partConfigs.splice(target, 0, config);
    this.save();
    return true;
  }

  setBlueprint(blueprint) {
    this.rememberEdit();
    this.state.blueprint = [...blueprint];
    this.state.partConfigs = blueprint.map((id) => normalizePartConfig(id));
    this.save();
  }

  resetBlueprint() {
    this.rememberEdit();
    this.state.blueprint = [...DEFAULT_BLUEPRINT];
    this.state.partConfigs = DEFAULT_BLUEPRINT.map((id) => normalizePartConfig(id));
    this.save();
  }

  unlockTech(nodeId) {
    const node = getTechNode(nodeId);
    if (!node || this.state.unlockedTech.includes(nodeId)) {
      return { ok: false, reason: "该技术不存在或已解锁。" };
    }
    const prerequisiteMissing = node.prerequisites.some(
      (prerequisite) => !this.state.unlockedTech.includes(prerequisite),
    );
    if (prerequisiteMissing) {
      return { ok: false, reason: "前置技术尚未完成。" };
    }
    if (this.state.resources.science < node.cost) {
      return { ok: false, reason: `还需要 ${node.cost - this.state.resources.science} 科研点。` };
    }
    this.state.resources.science -= node.cost;
    this.state.unlockedTech.push(nodeId);
    this.save();
    return { ok: true, node };
  }

  upgradeBase(upgradeId) {
    const definition = BASE_UPGRADES[upgradeId];
    if (!definition) return { ok: false, reason: "升级项目不存在。" };
    const currentLevel = this.state.base[upgradeId] || 0;
    const nextLevel = currentLevel + 1;
    const next = definition.levels[nextLevel];
    if (!next) return { ok: false, reason: "该设施已达到最高等级。" };
    if (this.state.resources.funds < next.cost) {
      return {
        ok: false,
        reason: `还需要 ${(next.cost - this.state.resources.funds).toLocaleString()} 信用点。`,
      };
    }
    this.state.resources.funds -= next.cost;
    this.state.base[upgradeId] = nextLevel;
    this.save();
    return { ok: true, upgrade: definition, level: nextLevel };
  }

  chooseContract(contractId) {
    const contract = getContract(contractId);
    if (!contract || !this.availableContracts.includes(contract)) {
      return { ok: false, reason: "合同尚未解锁。" };
    }
    if (this.state.completedContracts.includes(contractId)) {
      return { ok: false, reason: "该合同已经完成。" };
    }
    this.state.activeContractId = contractId;
    this.save();
    return { ok: true, contract };
  }

  reserveLaunch() {
    const cost = this.craft.totalCost;
    if (this.state.resources.funds < cost) {
      return { ok: false, reason: "信用点不足以支付本次发射。" };
    }
    const reservation = {
      id: `launch_${Date.now()}`,
      cost,
      contractId: this.state.activeContractId,
      blueprint: [...this.state.blueprint],
      partConfigs: this.state.partConfigs.map((config) => ({ ...config })),
      createdAt: Date.now(),
    };
    this.state.resources.funds -= cost;
    this.state.launchReservations.push(reservation);
    this.state.launchReservations = this.state.launchReservations.slice(-10);
    this.save();
    return { ok: true, reservation };
  }

  settleMission(result) {
    if (!result?.contractId) return;
    const contract = getContract(result.contractId);
    if (!contract) return;

    this.state.resources.funds += result.funds || 0;
    this.state.resources.science += result.science || 0;
    this.state.resources.reputation += result.reputation || 0;

    const historyEntry = {
      id: `mission_${Date.now()}`,
      contractId: result.contractId,
      success: Boolean(result.success),
      status: result.status,
      funds: result.funds || 0,
      science: result.science || 0,
      reputation: result.reputation || 0,
      completedAt: Date.now(),
    };
    this.state.missionHistory.unshift(historyEntry);
    this.state.missionHistory = this.state.missionHistory.slice(0, 20);

    if (result.success && !this.state.completedContracts.includes(contract.id)) {
      this.state.completedContracts.push(contract.id);
      const nextContract = CONTRACTS.find(
        (candidate) =>
          !this.state.completedContracts.includes(candidate.id) &&
          this.state.resources.reputation >= (candidate.unlock?.reputation || 0),
      );
      if (nextContract) this.state.activeContractId = nextContract.id;
    }

    this.save();
  }
}

export function getBaseUpgradeState(state, upgradeId) {
  const definition = BASE_UPGRADES[upgradeId];
  const currentLevel = state.base[upgradeId] || 0;
  const next = definition.levels[currentLevel + 1] || null;
  return {
    definition,
    currentLevel,
    next,
  };
}
