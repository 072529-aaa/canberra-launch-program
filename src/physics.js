import { compileCraft, G0, massProperties } from "./craft.js";

export const PLANET_RADIUS = 600000;
export const PLANET_MU = 3.5316e12;
export const ATMOSPHERE_HEIGHT = 70000;
export const SEA_LEVEL_DENSITY = 1.225;
export const SCALE_HEIGHT = 5600;
export const DRAG_COEFFICIENT = 0.42;
export const DEFAULT_TIME_STEP = 0.05;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function magnitude(vector) {
  return Math.hypot(vector[0], vector[1]);
}

export function normalize(vector, fallback = [0, 1]) {
  const length = magnitude(vector);
  if (length < 1e-9) return [...fallback];
  return [vector[0] / length, vector[1] / length];
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1];
}

export function wrapAngle(angle) {
  let result = angle;
  while (result > Math.PI) result -= Math.PI * 2;
  while (result < -Math.PI) result += Math.PI * 2;
  return result;
}

export function atmosphereDensity(altitude) {
  if (altitude >= ATMOSPHERE_HEIGHT || altitude < 0) return 0;
  return SEA_LEVEL_DENSITY * Math.exp(-altitude / SCALE_HEIGHT);
}

export function gravityAtPosition(position) {
  const radius = Math.max(1, magnitude(position));
  const scale = -PLANET_MU / (radius ** 3);
  return [position[0] * scale, position[1] * scale];
}

export function orbitalElements(position, velocity) {
  const radius = Math.max(1, magnitude(position));
  const speedSquared = velocity[0] ** 2 + velocity[1] ** 2;
  const angularMomentum = position[0] * velocity[1] - position[1] * velocity[0];
  const specificEnergy = speedSquared / 2 - PLANET_MU / radius;
  const semiMajorAxis =
    Math.abs(specificEnergy) < 1e-12 ? Infinity : -PLANET_MU / (2 * specificEnergy);
  const radialVelocity = dot(position, velocity) / radius;

  const eccentricityVector = [
    ((speedSquared - PLANET_MU / radius) * position[0] -
      dot(position, velocity) * velocity[0]) /
      PLANET_MU,
    ((speedSquared - PLANET_MU / radius) * position[1] -
      dot(position, velocity) * velocity[1]) /
      PLANET_MU,
  ];
  const eccentricity = magnitude(eccentricityVector);

  let apoapsisAltitude = Infinity;
  let periapsisAltitude = -PLANET_RADIUS;
  let period = Infinity;
  if (Number.isFinite(semiMajorAxis) && semiMajorAxis > 0) {
    apoapsisAltitude = semiMajorAxis * (1 + eccentricity) - PLANET_RADIUS;
    periapsisAltitude = semiMajorAxis * (1 - eccentricity) - PLANET_RADIUS;
    period = 2 * Math.PI * Math.sqrt(semiMajorAxis ** 3 / PLANET_MU);
  }

  return {
    radius,
    altitude: radius - PLANET_RADIUS,
    speed: Math.sqrt(speedSquared),
    radialVelocity,
    tangentialVelocity: angularMomentum / Math.max(radius, 1),
    angularMomentum,
    specificEnergy,
    semiMajorAxis,
    eccentricity,
    apoapsisAltitude,
    periapsisAltitude,
    period,
    isElliptic: Number.isFinite(semiMajorAxis) && semiMajorAxis > 0,
    isOrbit: periapsisAltitude > 0,
  };
}

export function circularOrbitSpeed(altitude) {
  const radius = PLANET_RADIUS + altitude;
  return Math.sqrt(PLANET_MU / radius);
}

export function estimateTimeToApoapsis(position, velocity) {
  const elements = orbitalElements(position, velocity);
  if (!elements.isElliptic) return Infinity;
  const meanMotion = Math.sqrt(PLANET_MU / Math.abs(elements.semiMajorAxis) ** 3);
  const radialMomentum = dot(position, velocity);
  const eccentricAnomaly = Math.atan2(
    radialMomentum /
      Math.sqrt(PLANET_MU * Math.abs(elements.semiMajorAxis)),
    ((magnitude(position) / Math.abs(elements.semiMajorAxis)) - 1) /
      Math.max(0.0001, elements.eccentricity),
  );
  const meanAnomaly = eccentricAnomaly + elements.eccentricity * Math.sin(eccentricAnomaly);
  const timeSincePeriapsis = meanAnomaly / meanMotion;
  return (Math.PI - meanAnomaly) / meanMotion;
}

export class FlightSimulation {
  constructor(blueprint, options = {}) {
    this.craft = compileCraft(blueprint, options.unlockedTech || [], options.partConfigs || []);
    this.timeStep = options.timeStep || DEFAULT_TIME_STEP;
    this.clearance =
      1.2 + Math.max(...this.craft.stages.map((stage) => stage.impactTolerance));
    this.position = [0, PLANET_RADIUS + this.clearance];
    this.velocity = [0, 0];
    this.angle = Math.PI / 2;
    this.angularVelocity = 0;
    this.time = 0;
    this.status = "flying";
    this.failureReason = null;
    this.stageIndex = 0;
    this.stageFuel = this.craft.stages.map((stage) => stage.fuelMass);
    this.usedFuel = 0;
    this.throttle = 1;
    this.rotationInput = 0;
    this.sasEnabled = false;
    this.sasMode = "prograde";
    this.heldAngle = this.angle;
    this.parachuteDeployed = false;
    this.payloadDeployed = false;
    this.events = [];
    this.telemetry = [];
    this.lastTelemetryAt = -1;
    this.maxAltitude = 0;
    this.maxSpeed = 0;
    this.maxDynamicPressure = 0;
    this.maxGForce = 1;
    this.stableOrbitSeconds = 0;
    this.maxStableOrbitSeconds = 0;
    this.maxPeriapsis = -PLANET_RADIUS;
    this.maxApoapsis = -PLANET_RADIUS;
    this.overstressSeconds = 0;
    this.aoaStressSeconds = 0;
    this.ignitionTimeReached = false;
    this.log(`任务时钟启动，${this.craft.stages.length} 级火箭已通电。`);
  }

  log(message) {
    this.events.unshift({ time: this.time, message });
    this.events = this.events.slice(0, 40);
  }

  currentStage() {
    return this.craft.stages[this.stageIndex];
  }

  remainingMass() {
    return this.craft.stages
      .slice(this.stageIndex)
      .reduce(
        (sum, stage, index) =>
          sum + stage.dryMass + this.stageFuel[this.stageIndex + index],
        0,
      );
  }

  setThrottle(value) {
    this.throttle = clamp(value, 0, 1);
  }

  setRotation(value) {
    this.rotationInput = clamp(value, -1, 1);
  }

  toggleSas(force) {
    this.sasEnabled = typeof force === "boolean" ? force : !this.sasEnabled;
    this.heldAngle = this.angle;
    this.log(this.sasEnabled ? "SAS 已接通。" : "SAS 已关闭。");
  }

  cycleSasMode() {
    const modes = ["prograde", "radial", "stability"];
    const index = modes.indexOf(this.sasMode);
    this.sasMode = modes[(index + 1) % modes.length];
    this.heldAngle = this.angle;
    if (!this.sasEnabled) this.sasEnabled = true;
    this.log(`SAS 模式：${this.sasModeLabel()}。`);
  }

  sasModeLabel() {
    return {
      prograde: "速度方向",
      radial: "径向",
      stability: "姿态保持",
    }[this.sasMode];
  }

  separateStage() {
    if (this.status !== "flying" || this.stageIndex >= this.craft.stages.length - 1) {
      this.log("没有可激活的上一级。");
      return false;
    }
    this.stageIndex += 1;
    this.throttle = 0;
    this.log(`第 ${this.stageIndex + 1} 级已激活，推力自动归零。`);
    return true;
  }

  deployParachute() {
    if (this.status !== "flying") return false;
    const hasParachute = this.craft.stages.slice(this.stageIndex).some((stage) => stage.hasParachute);
    if (!hasParachute) {
      this.log("当前火箭没有安装降落伞。");
      return false;
    }
    const altitude = magnitude(this.position) - PLANET_RADIUS;
    if (altitude > 8000) {
      this.log("展开高度过高，降落伞被气流撕裂。");
      this.destroy("parachute", "降落伞在高动压下过早展开。");
      return false;
    }
    if (!this.parachuteDeployed) {
      this.parachuteDeployed = true;
      this.throttle = 0;
      this.log(`高度 ${Math.round(altitude)} m，降落伞已展开。`);
    }
    return true;
  }

  deployPayload() {
    if (!this.craft.stages.some((stage) => stage.hasPayload)) {
      this.log("没有合同载荷可部署。");
      return false;
    }
    if (this.status !== "flying") return false;
    const elements = orbitalElements(this.position, this.velocity);
    if (elements.periapsisAltitude < 70000) {
      this.log("轨道尚未稳定，载荷部署被拒绝。");
      return false;
    }
    this.payloadDeployed = true;
    this.log("合同载荷已部署并建立遥测链路。");
    return true;
  }

  abort(reason = "任务由地面控制中心中止。") {
    if (this.status === "flying") {
      this.status = "aborted";
      this.failureReason = reason;
      this.throttle = 0;
      this.log(reason);
    }
  }

  destroy(code, reason) {
    if (this.status !== "flying") return;
    this.status = "destroyed";
    this.failureReason = reason;
    this.failureCode = code;
    this.throttle = 0;
    this.log(reason);
    this.recordTelemetry(true);
  }

  update(dt = this.timeStep, controls = {}) {
    if (this.status !== "flying") return this.snapshot();
    const step = clamp(dt, 0.005, 0.2);
    if (Number.isFinite(controls.throttle)) this.setThrottle(controls.throttle);
    if (Number.isFinite(controls.rotation)) this.setRotation(controls.rotation);

    const stage = this.currentStage();
    const radiusBefore = magnitude(this.position);
    const altitudeBefore = radiusBefore - PLANET_RADIUS;
    const velocityBefore = magnitude(this.velocity);
    const radialUnitBefore = normalize(this.position);
    const verticalVelocityBefore = dot(this.velocity, radialUnitBefore);
    const rho = atmosphereDensity(altitudeBefore);
    const q = 0.5 * rho * velocityBefore ** 2;
    const velocityAngle = velocityBefore > 2 ? Math.atan2(this.velocity[1], this.velocity[0]) : this.angle;
    const angleOfAttack = clamp(wrapAngle(this.angle - velocityAngle), -Math.PI, Math.PI);

    this.maxAltitude = Math.max(this.maxAltitude, altitudeBefore);
    this.maxSpeed = Math.max(this.maxSpeed, velocityBefore);
    this.maxDynamicPressure = Math.max(this.maxDynamicPressure, q);

    const structuralLimit = stage.structuralLimit || 22000;
    if (q > structuralLimit * 1.8) {
      this.destroy("overstress", `结构解体：动压 ${Math.round(q / 1000)} kPa，超过极限。`);
      return this.snapshot();
    }
    if (q > structuralLimit) {
      this.overstressSeconds += step;
      if (this.overstressSeconds > 2.4) {
        this.destroy("overstress", "结构持续超载，箭体在最大动压区断裂。");
        return this.snapshot();
      }
    } else {
      this.overstressSeconds = Math.max(0, this.overstressSeconds - step * 0.7);
    }

    if (q > structuralLimit * 0.45 && Math.abs(angleOfAttack) > (62 * Math.PI) / 180) {
      this.aoaStressSeconds += step;
      if (this.aoaStressSeconds > 3) {
        this.destroy("tumble", "大攻角失控导致气动扭矩超过控制能力。");
        return this.snapshot();
      }
    } else {
      this.aoaStressSeconds = Math.max(0, this.aoaStressSeconds - step * 0.9);
    }

    const fuelAvailable = this.stageFuel[this.stageIndex] > 0.001;
    let activeThrottle = this.throttle;
    if (fuelAvailable && activeThrottle > 0 && stage.engines.length) {
      const minThrottle = Math.min(
        ...stage.engines.map((engine) => engine.minThrottle ?? 0),
      );
      activeThrottle = Math.max(minThrottle, activeThrottle);
      if (!this.ignitionTimeReached && this.time > 0) {
        this.ignitionTimeReached = true;
        this.log(`第 ${this.stageIndex + 1} 级发动机点火。`);
      }
    } else {
      activeThrottle = 0;
    }

    const massBefore = Math.max(1, this.remainingMass());
    let thrustMagnitude = stage.totalThrust * activeThrottle;
    const burnRate = stage.equivalentIsp
      ? thrustMagnitude / (stage.equivalentIsp * G0)
      : 0;
    const consumed = Math.min(
      this.stageFuel[this.stageIndex],
      burnRate * step,
    );
    const fuelScale = burnRate > 0 ? consumed / (burnRate * step) : 0;
    thrustMagnitude *= fuelScale;
    const properties = massProperties(this.craft, this.stageIndex, this.stageFuel);
    this.stageFuel[this.stageIndex] -= consumed;
    this.usedFuel += consumed;

    const radialUnit = normalize(this.position);
    const gravity = gravityAtPosition(this.position);
    const force = [
      gravity[0] * massBefore,
      gravity[1] * massBefore,
    ];

    if (thrustMagnitude > 0) {
      const rotation = this.angle - Math.PI / 2;
      const tx = properties.thrustX * activeThrottle * fuelScale;
      const ty = properties.thrustY * activeThrottle * fuelScale;
      force[0] += Math.cos(rotation) * tx - Math.sin(rotation) * ty;
      force[1] += Math.sin(rotation) * tx + Math.cos(rotation) * ty;
    }

    if (velocityBefore > 0.1 && rho > 0) {
      const dragArea =
        stage.dragArea +
        (this.parachuteDeployed ? stage.parachuteArea : 0);
      const dragMagnitude =
        0.5 * rho * velocityBefore ** 2 * DRAG_COEFFICIENT * dragArea;
      force[0] -= (this.velocity[0] / velocityBefore) * dragMagnitude;
      force[1] -= (this.velocity[1] / velocityBefore) * dragMagnitude;

      if (stage.liftArea > 0 && velocityBefore > 15) {
        const liftCoefficient = clamp(2.2 * Math.sin(2 * angleOfAttack), -2, 2);
        const liftMagnitude = q * stage.liftArea * liftCoefficient;
        force[0] += -Math.sin(velocityAngle) * liftMagnitude;
        force[1] += Math.cos(velocityAngle) * liftMagnitude;
      }
    }

    const inertia = properties.inertia;
    const torqueLimit = this.craft.stages.slice(this.stageIndex).reduce((sum, attached) => sum + attached.torque, 0);
    let controlTorque = this.rotationInput * torqueLimit;
    if (this.sasEnabled) {
      let targetAngle = this.heldAngle;
      if (this.sasMode === "prograde" && velocityBefore > 8) {
        targetAngle = velocityAngle;
      } else if (this.sasMode === "radial") {
        targetAngle = Math.atan2(this.position[1], this.position[0]);
      }
      const difference = wrapAngle(targetAngle - this.angle);
      controlTorque += clamp(
        difference * inertia * 6 - this.angularVelocity * inertia * 4,
        -torqueLimit,
        torqueLimit,
      );
    }
    const aerodynamicTorque =
      rho > 0 && velocityBefore > 10
        ? -q * properties.aeroArea * 2 * properties.stabilityLever * Math.sin(angleOfAttack)
          - q * properties.aeroArea * properties.stabilityLever ** 2 * this.angularVelocity / Math.max(20, velocityBefore)
        : 0;
    const angularAcceleration = (controlTorque + aerodynamicTorque + properties.thrustTorque * activeThrottle * fuelScale) / inertia;
    this.angularVelocity += angularAcceleration * step;
    this.angularVelocity *= Math.exp(-(rho > 0 ? 1.4 : 0.12) * step);
    this.angle = wrapAngle(this.angle + this.angularVelocity * step);

    const acceleration = [force[0] / massBefore, force[1] / massBefore];
    this.velocity[0] += acceleration[0] * step;
    this.velocity[1] += acceleration[1] * step;
    this.position[0] += this.velocity[0] * step;
    this.position[1] += this.velocity[1] * step;
    this.time += step;

    const gForce =
      magnitude(acceleration) / G0 +
      (dot(acceleration, radialUnit) / G0 > 0 ? 0 : 0);
    this.maxGForce = Math.max(this.maxGForce, gForce);

    const elements = orbitalElements(this.position, this.velocity);
    this.maxPeriapsis = Math.max(this.maxPeriapsis, elements.periapsisAltitude);
    this.maxApoapsis = Math.max(this.maxApoapsis, elements.apoapsisAltitude);
    if (
      this.stageIndex === this.craft.stages.length - 1 &&
      elements.periapsisAltitude >= 70000 &&
      elements.apoapsisAltitude >= 70000
    ) {
      this.stableOrbitSeconds += step;
      this.maxStableOrbitSeconds = Math.max(
        this.maxStableOrbitSeconds,
        this.stableOrbitSeconds,
      );
    } else {
      this.stableOrbitSeconds = Math.max(0, this.stableOrbitSeconds - step * 0.25);
    }

    const radiusAfter = magnitude(this.position);
    if (
      this.parachuteDeployed &&
      this.stageFuel[this.stageIndex] <= 0 &&
      this.throttle > 0
    ) {
      this.throttle = 0;
    }

    if (
      this.stageFuel.every((fuel) => fuel <= 0.001) &&
      this.throttle > 0 &&
      this.stageIndex === this.craft.stages.length - 1
    ) {
      this.throttle = 0;
    }

    const groundRadius = PLANET_RADIUS + this.clearance;
    if (radiusAfter <= groundRadius) {
      const radialUnitAfter = normalize(this.position);
      const impactVelocity = magnitude(this.velocity);
      const verticalSpeed = dot(this.velocity, radialUnitAfter);
      const horizontalSpeed = Math.sqrt(
        Math.max(0, impactVelocity ** 2 - verticalSpeed ** 2),
      );
      const impactLimit =
        5 + stage.impactTolerance + (this.parachuteDeployed ? 24 : 0);
      const horizontalLimit = this.parachuteDeployed ? 28 : 12;

      if (
        Math.abs(verticalSpeed) <= impactLimit &&
        horizontalSpeed <= horizontalLimit &&
        Math.abs(wrapAngle(this.angle - Math.atan2(this.position[1], this.position[0]))) < Math.PI / 3
      ) {
        this.position = [
          radialUnitAfter[0] * groundRadius,
          radialUnitAfter[1] * groundRadius,
        ];
        this.velocity = [0, 0];
        this.angularVelocity = 0;
        this.status = "landed";
        this.throttle = 0;
        this.log(
          `安全着陆，垂直接触速度 ${Math.abs(verticalSpeed).toFixed(1)} m/s。`,
        );
      } else {
        this.destroy(
          "ground_impact",
          `坠毁：触地速度 ${impactVelocity.toFixed(0)} m/s，超过 ${impactLimit.toFixed(0)} m/s 容忍值。`,
        );
      }
    }

    this.recordTelemetry(false);
    return this.snapshot();
  }

  runSteps(count, controls = {}) {
    for (let index = 0; index < count && this.status === "flying"; index += 1) {
      this.update(this.timeStep, controls);
    }
    return this.snapshot();
  }

  recordTelemetry(force) {
    if (!force && this.time - this.lastTelemetryAt < 0.5) return;
    const elements = orbitalElements(this.position, this.velocity);
    this.telemetry.push({
      time: this.time,
      altitude: elements.altitude,
      speed: elements.speed,
      apoapsis: elements.apoapsisAltitude,
      periapsis: elements.periapsisAltitude,
      q: 0.5 * atmosphereDensity(elements.altitude) * elements.speed ** 2,
      mass: this.remainingMass(),
    });
    if (this.telemetry.length > 2400) this.telemetry.shift();
    this.lastTelemetryAt = this.time;
  }

  snapshot() {
    const elements = orbitalElements(this.position, this.velocity);
    const radialUnit = normalize(this.position);
    const verticalSpeed = dot(this.velocity, radialUnit);
    const horizontalSpeed = Math.sqrt(
      Math.max(0, elements.speed ** 2 - verticalSpeed ** 2),
    );
    const mass = this.remainingMass();
    const stage = this.currentStage();
    const localGravity = PLANET_MU / Math.max(PLANET_RADIUS, magnitude(this.position)) ** 2;
    const fuelAvailable = this.stageFuel[this.stageIndex] > 0.001;

    return {
      status: this.status,
      failureReason: this.failureReason,
      failureCode: this.failureCode,
      time: this.time,
      position: [...this.position],
      velocity: [...this.velocity],
      angle: this.angle,
      angularVelocity: this.angularVelocity,
      altitude: elements.altitude,
      radius: elements.radius,
      speed: elements.speed,
      verticalSpeed,
      horizontalSpeed,
      downrange: Math.atan2(this.position[0], this.position[1]) * PLANET_RADIUS,
      apoapsisAltitude: elements.apoapsisAltitude,
      periapsisAltitude: elements.periapsisAltitude,
      orbitalPeriod: elements.period,
      eccentricity: elements.eccentricity,
      specificEnergy: elements.specificEnergy,
      mass,
      throttle: this.throttle,
      stageIndex: this.stageIndex,
      stageCount: this.craft.stages.length,
      stageFuel: this.stageFuel[this.stageIndex],
      stageMaxFuel: stage.maxFuel,
      totalFuel: this.stageFuel.reduce((sum, fuel) => sum + fuel, 0),
      thrust:
        fuelAvailable && stage.engines.length
          ? stage.totalThrust * this.throttle
          : 0,
      twr:
        fuelAvailable && stage.engines.length
          ? (stage.totalThrust * this.throttle) / Math.max(1, mass * localGravity)
          : 0,
      dynamicPressure: 0.5 *
        atmosphereDensity(elements.altitude) *
        elements.speed ** 2,
      maxDynamicPressure: this.maxDynamicPressure,
      maxGForce: this.maxGForce,
      maxAltitude: this.maxAltitude,
      maxSpeed: this.maxSpeed,
      stableOrbitSeconds: this.stableOrbitSeconds,
      maxStableOrbitSeconds: this.maxStableOrbitSeconds,
      maxPeriapsis: this.maxPeriapsis,
      maxApoapsis: this.maxApoapsis,
      parachuteDeployed: this.parachuteDeployed,
      payloadDeployed: this.payloadDeployed,
      sasEnabled: this.sasEnabled,
      sasMode: this.sasMode,
      events: [...this.events],
    };
  }
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "--:--";
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
