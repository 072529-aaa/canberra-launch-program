export function evaluateObjectives(contract, snapshot) {
  return contract.objectives.map((objective) => {
    let passed = false;
    let actual = "";

    if (objective.type === "minAltitude") {
      passed = snapshot.maxAltitude >= objective.value;
      actual = `${Math.round(snapshot.maxAltitude)} m`;
    } else if (objective.type === "safeLanding") {
      passed = snapshot.status === "landed";
      actual = statusLabel(snapshot.status);
    } else if (objective.type === "minPeriapsis") {
      passed = snapshot.maxPeriapsis >= objective.value;
      actual = `${Math.round(snapshot.maxPeriapsis)} m`;
    } else if (objective.type === "stableOrbit") {
      passed = snapshot.maxStableOrbitSeconds >= objective.value;
      actual = `${snapshot.maxStableOrbitSeconds.toFixed(1)} s`;
    } else if (objective.type === "payloadOrbit") {
      passed =
        snapshot.maxPeriapsis >= objective.value && snapshot.payloadDeployed;
      actual = `${Math.round(snapshot.maxPeriapsis)} m`;
    } else if (objective.type === "payloadDeployed") {
      passed = snapshot.payloadDeployed;
      actual = snapshot.payloadDeployed ? "已部署" : "未部署";
    }

    return {
      id: objective.id,
      label: objective.label,
      passed,
      actual,
    };
  });
}

export function settleMission({
  contract,
  snapshot,
  craftCost,
  recoveryRate,
  researchMultiplier,
  scienceMultiplier = 0,
}) {
  const objectives = evaluateObjectives(contract, snapshot);
  const success = objectives.every((objective) => objective.passed);
  const completedObjectives = objectives.filter((objective) => objective.passed).length;
  const objectiveRatio = objectives.length ? completedObjectives / objectives.length : 0;

  let funds = 0;
  let science = 0;
  let reputation = 0;
  let salvage = 0;
  let failureGrant = 0;

  if (success) {
    funds += contract.reward.funds;
    science += contract.reward.science * researchMultiplier;
    reputation += contract.reward.reputation;
    if (snapshot.status === "landed") {
      salvage = Math.round(craftCost * recoveryRate * 0.45);
      funds += salvage;
    }
  } else if (snapshot.status === "landed" || snapshot.status === "aborted") {
    science += Math.round(contract.reward.science * objectiveRatio * 0.3);
    failureGrant = Math.max(2500, Math.round(craftCost * 0.08));
    funds += failureGrant;
    salvage = Math.round(craftCost * recoveryRate * 0.55);
    funds += salvage;
  } else {
    science += Math.round(contract.reward.science * objectiveRatio * 0.2);
    failureGrant = Math.max(1500, Math.round(craftCost * 0.05));
    funds += failureGrant;
  }

  if (snapshot.payloadDeployed) science *= 1 + scienceMultiplier;
  science = Math.round(science);

  return {
    contractId: contract.id,
    success,
    status: snapshot.status,
    objectives,
    funds,
    science,
    reputation,
    salvage,
    failureGrant,
    craftCost,
    completedObjectives,
    objectiveCount: objectives.length,
  };
}

export function analyzeFailure(snapshot, craftMetrics = {}, contract = null) {
  const recommendations = [];
  let cause = "任务目标未完成";
  let evidence = `最高高度 ${Math.round(snapshot.maxAltitude)} m，最高速度 ${Math.round(snapshot.maxSpeed)} m/s。`;

  if (snapshot.failureCode === "ground_impact") {
    cause = "回收阶段触地速度过高";
    evidence = snapshot.failureReason || evidence;
    recommendations.push("增加降落伞，并在 1,000-5,000 m 高度展开。");
    recommendations.push("保留少量燃料执行着陆前反推，或安装着陆支腿。");
  } else if (snapshot.failureCode === "overstress") {
    cause = "最大动压区结构超载";
    evidence = `峰值动压 ${Math.round(snapshot.maxDynamicPressure / 1000)} kPa。`;
    recommendations.push("降低起飞 TWR，避免在稠密大气中层高速急转。");
    recommendations.push("使用更平滑的重力转向曲线，并检查零件结构上限。");
  } else if (snapshot.failureCode === "tumble") {
    cause = "大攻角气动失稳";
    evidence = `峰值动压 ${Math.round(snapshot.maxDynamicPressure / 1000)} kPa。`;
    recommendations.push("增加稳定尾翼，并把质心前移。");
    recommendations.push("起飞后先保持垂直，再以小角度连续转向。");
  } else if (snapshot.failureCode === "parachute") {
    cause = "降落伞过早展开";
    evidence = snapshot.failureReason || evidence;
    recommendations.push("等待动压下降后再展开，通常不高于 5 km。");
  } else if (snapshot.status === "destroyed") {
    cause = "箭体在飞行中损毁";
  } else if (contract?.objectives.some((objective) => objective.type === "safeLanding")) {
    const altitudeGoal = contract.objectives.find((objective) => objective.type === "minAltitude");
    if (altitudeGoal && snapshot.maxAltitude < altitudeGoal.value) {
      cause = "探空高度未达标";
      recommendations.push("对比燃料装填与起飞推重比，逐步增加有效燃烧时间。");
      recommendations.push("先保持垂直，检查是否过早关机或转向。");
    } else {
      cause = "尚未完成安全回收";
      recommendations.push("等待越过顶点，在下降且高度低于 8 km 时开伞。");
    }
  } else if (snapshot.maxAltitude < 70000) {
    cause = "速度增量不足以进入轨道";
    recommendations.push("增加燃料箱或采用两级结构。");
    recommendations.push("优化重力转向，避免把燃料花在垂直爬升上。");
  } else if (snapshot.maxPeriapsis < 70000) {
    cause = "远地点达标，但近地点仍在大气层内";
    recommendations.push("在接近远地点时水平加速，抬高近地点。");
    recommendations.push("保留更多上面级燃料，避免过早分离。");
  }

  if ((craftMetrics.twr || 0) > 3.2) {
    recommendations.push(`起飞 TWR ${craftMetrics.twr.toFixed(2)} 偏高，可降低节流或减少发动机。`);
  }
  if ((craftMetrics.deltaV || 0) < 3400 && snapshot.maxAltitude > 50000) {
    recommendations.push(`估算速度增量 ${Math.round(craftMetrics.deltaV)} m/s，近地轨道通常需要约 3,400 m/s。`);
  }
  if (!recommendations.length) {
    recommendations.push("对比遥测中的远地点、近地点和剩余燃料，再调整上面级工作时间。");
  }

  return {
    cause,
    evidence,
    recommendations: [...new Set(recommendations)].slice(0, 3),
  };
}

export function statusLabel(status) {
  return {
    flying: "飞行中",
    landed: "安全着陆",
    crashed: "坠毁",
    destroyed: "箭体损毁",
    aborted: "任务中止",
  }[status] || status;
}
