import { PARTS, getPart, partGeometry, ASSEMBLY_LIMITS } from "./data.js";

export const G0 = 9.80665;

export const DEFAULT_BLUEPRINT = [
  "cmd_mk1",
  "parachute",
  "tank_s",
  "engine_kestrel",
  "fins",
];

function itemDryMass(part) {
  return Number.isFinite(part.dryMass) ? part.dryMass : part.mass || 0;
}

function itemFuelMass(part) {
  return Number.isFinite(part.fuelMass) ? part.fuelMass : 0;
}

export function normalizePartConfig(partId, raw = {}) {
  raw = raw && typeof raw === "object" ? raw : {};
  const part = getPart(partId);
  const bounded = (value, min, max, fallback = 0) => Number.isFinite(Number(value))
    ? Math.min(max, Math.max(min, Number(value))) : fallback;
  return {
    x: part?.thrust ? bounded(raw.x, -ASSEMBLY_LIMITS.engineOffset, ASSEMBLY_LIMITS.engineOffset) : 0,
    y: part?.category === "aero" ? bounded(raw.y, -ASSEMBLY_LIMITS.finTravel, ASSEMBLY_LIMITS.finTravel) : 0,
    angle: part?.thrust ? bounded(raw.angle, -ASSEMBLY_LIMITS.engineAngle, ASSEMBLY_LIMITS.engineAngle) : 0,
    fuelFraction: part?.fuelMass ? bounded(raw.fuelFraction ?? 1, 0, 1, 1) : 1,
  };
}

function splitIntoStages(blueprint) {
  const topToBottomSegments = [];
  let segment = [];

  for (const partId of blueprint) {
    const part = getPart(partId);
    segment.push(partId);
    if (part?.splitStage) {
      topToBottomSegments.push(segment);
      segment = [];
    }
  }
  if (segment.length) {
    topToBottomSegments.push(segment);
  }

  let first = 0;
  const segments = topToBottomSegments.map((parts) => {
    const indices = parts.map((_, index) => first + index);
    first += parts.length;
    return { parts, indices };
  });
  return segments.reverse().map(({ parts, indices }, index) => ({
    id: index,
    parts,
    indices,
  }));
}

export function compileCraft(blueprint, unlockedTech = [], partConfigs = []) {
  const configs = blueprint.map((partId, index) => normalizePartConfig(partId, partConfigs[index]));
  const stages = splitIntoStages(blueprint).map((stage) => {
    const defs = stage.parts.map((id, index) => {
      const part = getPart(id);
      return part ? { ...part, fuelMass: itemFuelMass(part) * configs[stage.indices[index]].fuelFraction } : null;
    }).filter(Boolean);
    const engines = defs.filter((part) => part.thrust);
    const dryMass =
      defs.reduce((sum, part) => sum + itemDryMass(part), 0) +
      engines.reduce((sum, part) => sum + (part.propellantMass || 0), 0);
    const fuelMass = defs.reduce((sum, part) => sum + itemFuelMass(part), 0);
    const totalThrust = engines.reduce((sum, part) => sum + part.thrust, 0);
    const equivalentIsp = engines.length
      ? totalThrust / engines.reduce((sum, part) => sum + part.thrust / part.isp, 0)
      : 0;
    const structuralLimit = defs.length
      ? Math.min(...defs.map((part) => part.structuralLimit || 18000))
      : 18000;

    return {
      id: stage.id,
      parts: stage.parts,
      indices: stage.indices,
      defs,
      engines,
      dryMass,
      fuelMass,
      maxFuel: fuelMass,
      totalThrust,
      equivalentIsp,
      dragArea: defs.reduce((sum, part) => sum + (part.dragArea || 0), 0),
      torque: defs.reduce((sum, part) => sum + (part.torque || 0), 0),
      stability: defs.reduce((sum, part) => sum + (part.stability || 0), 0),
      liftArea: defs.reduce((sum, part) => sum + (part.liftArea || 0), 0),
      structuralLimit,
      parachuteArea: defs.reduce((sum, part) => sum + (part.parachuteArea || 0), 0),
      impactTolerance: defs.reduce(
        (sum, part) => sum + (part.impactTolerance || 0),
        0,
      ),
      powerCapacity: defs.reduce((sum, part) => sum + (part.powerCapacity || 0), 0),
      powerGeneration: defs.reduce(
        (sum, part) => sum + (part.powerGeneration || 0),
        0,
      ),
      hasCommand: defs.some((part) => part.command),
      hasParachute: defs.some((part) => part.parachuteArea),
      hasLegs: defs.some((part) => part.impactTolerance),
      hasPayload: defs.some((part) => part.contractPayload),
      length: Math.max(2, defs.length * 2.4),
    };
  });

  const totalDryMass = stages.reduce((sum, stage) => sum + stage.dryMass, 0);
  const totalFuelMass = stages.reduce((sum, stage) => sum + stage.fuelMass, 0);
  const totalCost = blueprint.reduce(
    (sum, partId) => sum + (getPart(partId)?.cost || 0),
    0,
  );

  // Multiple engines share one mounting plane; fins attach to the lower body.
  let height = 0;
  const layout = [];
  for (const stage of stages) {
    const engineHeight = Math.max(0, ...stage.engines.map((part) => partGeometry(part).height));
    const base = height;
    for (const index of [...stage.indices].reverse()) {
      const part = getPart(blueprint[index]);
      if (!part) continue;
      const geometry = partGeometry(part);
      const config = configs[index];
      if (part.thrust || part.category === "aero") {
        layout.push({ index, stageIndex: stage.id, part, config, x: config.x,
          y: base + (part.thrust ? engineHeight / 2 : engineHeight + 0.1 + config.y), ...geometry });
      }
    }
    height += engineHeight;
    for (const index of [...stage.indices].reverse()) {
      const part = getPart(blueprint[index]);
      if (!part || part.thrust || part.category === "aero") continue;
      const geometry = partGeometry(part);
      layout.push({ index, stageIndex: stage.id, part, config: configs[index], x: 0,
        y: height + geometry.height / 2, ...geometry });
      height += geometry.height + 0.035;
    }
  }

  return {
    blueprint: [...blueprint],
    stages,
    totalDryMass,
    totalFuelMass,
    totalMass: totalDryMass + totalFuelMass,
    totalCost,
    partCount: blueprint.length,
    compiledAt: Date.now(),
    unlockedTech: [...unlockedTech],
    partConfigs: configs,
    layout: layout.sort((a, b) => a.index - b.index),
    height: Math.max(1, height),
  };
}

export function massProperties(craft, stageIndex = 0, stageFuel = null) {
  const entries = craft.layout.filter((entry) => entry.stageIndex >= stageIndex).map((entry) => {
    const stage = craft.stages[entry.stageIndex];
    const ratio = stageFuel && stage.fuelMass > 0 ? stageFuel[entry.stageIndex] / stage.fuelMass : 1;
    const mass = itemDryMass(entry.part) + itemFuelMass(entry.part) * entry.config.fuelFraction * ratio;
    return { ...entry, mass };
  });
  const mass = entries.reduce((sum, entry) => sum + entry.mass, 0);
  const centerX = entries.reduce((sum, entry) => sum + entry.mass * entry.x, 0) / Math.max(1, mass);
  const centerY = entries.reduce((sum, entry) => sum + entry.mass * entry.y, 0) / Math.max(1, mass);
  const inertia = entries.reduce((sum, entry) => sum + entry.mass * (
    (entry.width ** 2 + entry.height ** 2) / 12 + (entry.x - centerX) ** 2 + (entry.y - centerY) ** 2), 0);
  const activeEngines = entries.filter((entry) => entry.stageIndex === stageIndex && entry.part.thrust);
  let thrustX = 0, thrustY = 0, thrustTorque = 0;
  for (const engine of activeEngines) {
    const angle = engine.config.angle * Math.PI / 180;
    const fx = -Math.sin(angle) * engine.part.thrust;
    const fy = Math.cos(angle) * engine.part.thrust;
    thrustX += fx;
    thrustY += fy;
    thrustTorque += (engine.x - centerX) * fy - (engine.y - centerY) * fx;
  }
  const fins = entries.filter((entry) => entry.part.category === "aero");
  const aeroArea = fins.reduce((sum, entry) => sum + entry.part.dragArea, 0);
  const aeroCenter = aeroArea ? fins.reduce((sum, entry) => sum + entry.y * entry.part.dragArea, 0) / aeroArea : centerY;
  return { mass, centerX, centerY, inertia: Math.max(1, inertia), thrustX, thrustY, thrustTorque,
    aeroArea, aeroCenter, stabilityLever: centerY - aeroCenter };
}

export function validateCraft(blueprint, options = {}) {
  const craft = compileCraft(blueprint, options.unlockedTech || [], options.partConfigs || []);
  const {
    unlockedTech = [],
    maxMass = Number.POSITIVE_INFINITY,
    maxParts = Number.POSITIVE_INFINITY,
    funds = Number.POSITIVE_INFINITY,
    requirePayload = false,
  } = options;
  const checks = [];

  const add = (level, label, detail) => checks.push({ level, label, detail });
  if (blueprint.some((id) => !getPart(id))) add("fail", "未知零件", "构型包含无法识别的零件。");
  const properties = massProperties(craft);
  if (Math.abs(properties.thrustTorque) > 500) add("warn", "推力偏离质心", `全节流力矩 ${Math.round(properties.thrustTorque)} N·m，可能旋转。`);
  if (properties.aeroArea && properties.stabilityLever < 0) add("warn", "尾翼位于质心前方", "小攻角下气动力可能放大姿态扰动。");
  for (const stage of craft.stages) {
    const engines = craft.layout.filter((entry) => entry.stageIndex === stage.id && entry.part.thrust);
    if (engines.some((engine, index) => engines.slice(index + 1).some((other) => Math.abs(engine.x - other.x) < 0.75))) {
      add("fail", "发动机安装重叠", "请分开发动机安装位置，或使用镜像安装。");
    }
  }

  if (!blueprint.length) {
    add("fail", "火箭为空", "至少需要一个指令舱和一台发动机。");
  }

  const lockedParts = blueprint.filter(
    (partId) => !craft.unlockedTech.includes("__all__") && !options.isUnlocked?.(partId),
  );
  if (options.isUnlocked && lockedParts.length) {
    add("fail", "存在未解锁零件", `请先研发：${lockedParts.join(", ")}`);
  }

  if (craft.partCount > maxParts) {
    add("fail", "零件数量超限", `当前 ${craft.partCount}，上限 ${maxParts}。`);
  } else if (craft.partCount > maxParts * 0.85) {
    add("warn", "接近车间容量", `当前 ${craft.partCount}/${maxParts} 个零件。`);
  } else {
    add("pass", "车间容量正常", `${craft.partCount}/${maxParts} 个零件。`);
  }

  if (craft.totalMass > maxMass) {
    add("fail", "湿重超过发射台限制", `当前 ${formatMass(craft.totalMass)}，上限 ${formatMass(maxMass)}。`);
  } else if (craft.totalMass > maxMass * 0.9) {
    add("warn", "接近发射台载荷上限", `当前 ${formatMass(craft.totalMass)}。`);
  } else {
    add("pass", "发射台载荷正常", `${formatMass(craft.totalMass)}。`);
  }

  if (craft.totalCost > funds) {
    add("fail", "预算不足", `需要 ${formatMoney(craft.totalCost)}，可用 ${formatMoney(funds)}。`);
  } else {
    add("pass", "预算充足", `硬件成本 ${formatMoney(craft.totalCost)}。`);
  }

  if (!craft.stages.some((stage) => stage.hasCommand)) {
    add("fail", "缺少指令单元", "需要座舱或无人探针核心。");
  } else {
    add("pass", "指令单元已安装", "飞行计算机可以控制姿态与事件。");
  }

  for (const stage of craft.stages) {
    const suffix = craft.stages.length > 1 ? `第 ${stage.id + 1} 级` : "主级";
    if (!stage.engines.length) {
      add("fail", `${suffix}缺少发动机`, "每个分离段都必须保留一台发动机。");
    }
    const firstPart = getPart(stage.parts[0]);
    const engineIndex = stage.parts.findIndex((partId) => getPart(partId)?.thrust);
    const trailingParts = engineIndex >= 0 ? stage.parts.slice(engineIndex + 1) : [];
    const invalidTrailing = trailingParts.some((partId) => {
      const category = getPart(partId)?.category;
      return !["aero", "recovery", "control"].includes(category);
    });
    if (invalidTrailing) {
      add("warn", `${suffix}发动机位置异常`, "发动机下方只能放置尾翼、控制或回收附件。");
    }
    if (firstPart?.thrust) {
      add("warn", `${suffix}顶部是发动机`, "发动机通常应位于分离段底部。");
    }
  }

  const firstStageTwr = getStageTWR(craft, 0);
  if (firstStageTwr < 1.05) {
    add("fail", "起飞推重比不足", `第一级 TWR ${firstStageTwr.toFixed(2)}，需要大于 1.05。`);
  } else if (firstStageTwr < 1.25) {
    add("warn", "起飞推重比偏低", `第一级 TWR ${firstStageTwr.toFixed(2)}。`);
  } else if (firstStageTwr > 3.2) {
    add("warn", "起飞推重比过高", `第一级 TWR ${firstStageTwr.toFixed(2)}，低空气动压力会升高。`);
  } else {
    add("pass", "起飞推重比合理", `第一级 TWR ${firstStageTwr.toFixed(2)}。`);
  }

  const totalDeltaV = getTotalDeltaV(craft);
  if (totalDeltaV < 1200) {
    add("warn", "总速度增量偏低", `估算 ${Math.round(totalDeltaV)} m/s，仅适合低空任务。`);
  } else {
    add("pass", "速度增量可用", `估算 ${Math.round(totalDeltaV)} m/s。`);
  }

  if (!craft.stages.some((stage) => stage.hasParachute || stage.hasLegs)) {
    add("warn", "没有回收硬件", "若合同要求回收，返回阶段必须安全减速。");
  } else {
    add("pass", "回收硬件已安装", "具备降落伞或着陆支腿。");
  }

  if (requirePayload && !craft.stages.some((stage) => stage.hasPayload)) {
    add("fail", "缺少合同载荷", "该任务要求安装通信卫星载荷。");
  }

  const hasFail = checks.some((check) => check.level === "fail");
  return {
    checks,
    valid: !hasFail,
    craft,
  };
}

export function getCumulativeMass(craft, stageIndex) {
  return craft.stages
    .slice(stageIndex)
    .reduce((sum, stage) => sum + stage.dryMass + stage.fuelMass, 0);
}

export function getStageTWR(craft, stageIndex) {
  const stage = craft.stages[stageIndex];
  if (!stage?.engines.length) return 0;
  const mass = getCumulativeMass(craft, stageIndex);
  return stage.totalThrust / Math.max(1, mass * G0);
}

export function getTotalDeltaV(craft) {
  let deltaV = 0;
  for (let index = 0; index < craft.stages.length; index += 1) {
    const stage = craft.stages[index];
    if (!stage.engines.length || !stage.fuelMass) continue;
    const wetMass = getCumulativeMass(craft, index);
    const dryMass = wetMass - stage.fuelMass;
    deltaV += stage.equivalentIsp * G0 * Math.log(wetMass / dryMass);
  }
  return deltaV;
}

export function getStageDeltaV(craft, stageIndex) {
  const stage = craft.stages[stageIndex];
  if (!stage?.engines.length || !stage.fuelMass) return 0;
  const wetMass = getCumulativeMass(craft, stageIndex);
  const dryMass = wetMass - stage.fuelMass;
  return stage.equivalentIsp * G0 * Math.log(wetMass / dryMass);
}

export function craftSummary(blueprint, unlockedTech, partConfigs = []) {
  const validation = validateCraft(blueprint, {
    unlockedTech,
    partConfigs,
    isUnlocked: () => true,
  });
  const craft = validation.craft;
  return {
    mass: craft.totalMass,
    cost: craft.totalCost,
    deltaV: getTotalDeltaV(craft),
    twr: getStageTWR(craft, 0),
    stageCount: craft.stages.length,
    parts: blueprint.length,
    valid: validation.valid,
  };
}

export function formatMass(value) {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} t`;
  return `${Math.round(value)} kg`;
}

export function formatMoney(value) {
  return `₡${Math.round(value).toLocaleString("en-US")}`;
}

export function cloneBlueprint(blueprint) {
  return [...blueprint];
}

export function summarizeParts(blueprint) {
  const map = new Map();
  for (const partId of blueprint) {
    map.set(partId, (map.get(partId) || 0) + 1);
  }
  return [...map.entries()].map(([partId, count]) => ({
    part: PARTS[partId],
    count,
  }));
}
