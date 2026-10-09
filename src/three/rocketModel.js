import * as THREE from "three";

import { getPart } from "../data.js";
import { compileCraft, massProperties } from "../craft.js";

const PALETTE = {
  body: 0xf0ece4,
  bodyDark: 0x36322e,
  accent: 0xc96442,
  accentDark: 0x8f3f2a,
  metal: 0x9a958b,
  glass: 0x6e9cc6,
  solar: 0x466b8e,
  recovery: 0xd0a04b,
  payload: 0x6fae8f,
};

function material(color, options = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.62,
    metalness: options.metalness ?? 0.15,
    side: options.side ?? THREE.FrontSide,
    transparent: options.transparent ?? false,
    opacity: options.opacity ?? 1,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 0,
  });
}

function cylinder(radiusTop, radiusBottom, height, mat, segments = 28) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments),
    mat,
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function box(width, height, depth, mat) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function addFins(group, radius, color) {
  const mat = material(color, { roughness: 0.72, metalness: 0.02 });
  for (let index = 0; index < 4; index += 1) {
    const fin = box(0.12, 0.62, 0.72, mat.clone());
    const angle = (Math.PI * 2 * index) / 4;
    fin.position.set(
      Math.cos(angle) * radius,
      -0.08,
      Math.sin(angle) * radius,
    );
    fin.rotation.y = -angle;
    group.add(fin);
  }
}

function createCommand(part) {
  const group = new THREE.Group();
  const body = cylinder(0.34, 0.42, 0.72, material(PALETTE.body));
  group.add(body);
  const cap = new THREE.Mesh(
    new THREE.ConeGeometry(0.34, 0.52, 24),
    material(PALETTE.bodyDark, { roughness: 0.42, metalness: 0.22 }),
  );
  cap.position.y = 0.62;
  group.add(cap);
  if (!part.probe) {
    const windowMat = material(PALETTE.glass, {
      roughness: 0.25,
      metalness: 0.35,
    });
    const window = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 18, 12),
      windowMat,
    );
    window.position.set(0, 0.22, 0.31);
    window.scale.set(1, 0.72, 0.35);
    group.add(window);
  }
  return group;
}

function createEngine(part) {
  const group = new THREE.Group();
  const size = part.thrust > 150000 ? 1.25 : part.thrust > 70000 ? 0.95 : 0.8;
  const body = cylinder(
    0.38 * size,
    0.34 * size,
    0.46 * size,
    material(PALETTE.bodyDark, { roughness: 0.42, metalness: 0.45 }),
  );
  body.position.y = 0.12;
  group.add(body);
  const nozzle = cylinder(
    0.24 * size,
    0.48 * size,
    0.38 * size,
    material(PALETTE.metal, { roughness: 0.36, metalness: 0.72 }),
  );
  nozzle.position.y = -0.3 * size;
  group.add(nozzle);
  return group;
}

function createTank(part) {
  const ratio = Math.min(1.2, Math.max(0.72, part.fuelMass / 3600));
  const group = new THREE.Group();
  const body = cylinder(
    0.43 * ratio,
    0.43 * ratio,
    0.75 + ratio * 0.45,
    material(PALETTE.accent, { roughness: 0.5, metalness: 0.18 }),
  );
  group.add(body);
  const stripe = cylinder(
    0.445 * ratio,
    0.445 * ratio,
    0.1,
    material(PALETTE.body, { roughness: 0.5 }),
  );
  stripe.position.y = 0.18;
  group.add(stripe);
  return group;
}

function createStructure(part) {
  const group = new THREE.Group();
  const body = cylinder(
    part.splitStage ? 0.38 : 0.34,
    part.splitStage ? 0.38 : 0.34,
    0.48,
    material(part.splitStage ? PALETTE.recovery : PALETTE.metal, {
      roughness: 0.54,
      metalness: part.splitStage ? 0.24 : 0.5,
    }),
  );
  group.add(body);
  if (part.splitStage) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.37, 0.035, 8, 28),
      material(PALETTE.bodyDark, { metalness: 0.6 }),
    );
    ring.rotation.x = Math.PI / 2;
    group.add(ring);
  }
  return group;
}

function createAero(part) {
  const group = new THREE.Group();
  if (part.liftArea) {
    const wingMat = material(PALETTE.accentDark, {
      roughness: 0.66,
      metalness: 0.04,
    });
    for (const direction of [-1, 1]) {
      const wing = box(1.5, 0.08, 0.34, wingMat.clone());
      wing.position.x = direction * 0.78;
      wing.rotation.z = direction * -0.08;
      group.add(wing);
    }
  } else {
    addFins(group, 0.38, PALETTE.accentDark);
  }
  return group;
}

function createControl() {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.34, 0.07, 10, 28),
    material(PALETTE.metal, { roughness: 0.34, metalness: 0.65 }),
  );
  ring.rotation.x = Math.PI / 2;
  group.add(ring);
  return group;
}

function createPower(part) {
  const group = new THREE.Group();
  const core = box(0.62, 0.48, 0.62, material(PALETTE.bodyDark));
  group.add(core);
  if (part.powerGeneration) {
    const panelMat = material(PALETTE.solar, {
      roughness: 0.28,
      metalness: 0.42,
    });
    for (const direction of [-1, 1]) {
      const panel = box(1.15, 0.06, 0.46, panelMat.clone());
      panel.position.x = direction * 0.86;
      panel.rotation.z = direction * -0.08;
      group.add(panel);
    }
  }
  return group;
}

function createPayload(part) {
  const group = new THREE.Group();
  const core = part.contractPayload
    ? box(0.72, 0.62, 0.72, material(PALETTE.payload))
    : cylinder(0.34, 0.34, 0.62, material(PALETTE.glass, { metalness: 0.42 }));
  group.add(core);
  if (part.contractPayload) {
    const panel = box(1.1, 0.05, 0.38, material(PALETTE.solar));
    panel.position.x = -0.85;
    group.add(panel);
    const panelTwo = panel.clone();
    panelTwo.position.x = 0.85;
    panelTwo.material = panel.material.clone();
    group.add(panelTwo);
  }
  return group;
}

function createRecovery(part) {
  const group = new THREE.Group();
  if (part.parachuteArea) {
    const pack = cylinder(
      0.34,
      0.38,
      0.36,
      material(PALETTE.body, { roughness: 0.65 }),
    );
    group.add(pack);
  } else if (part.impactTolerance) {
    const legMat = material(PALETTE.metal, { metalness: 0.52 });
    const base = cylinder(0.34, 0.34, 0.24, legMat.clone());
    group.add(base);
    for (let index = 0; index < 4; index += 1) {
      const angle = (Math.PI * 2 * index) / 4;
      const leg = cylinder(0.04, 0.05, 0.8, legMat.clone(), 10);
      leg.position.set(Math.cos(angle) * 0.36, -0.26, Math.sin(angle) * 0.36);
      leg.rotation.z = Math.cos(angle) * 0.42;
      leg.rotation.x = -Math.sin(angle) * 0.42;
      group.add(leg);
    }
  } else {
    const shield = cylinder(
      0.48,
      0.62,
      0.22,
      material(PALETTE.bodyDark, { roughness: 0.5, metalness: 0.4 }),
    );
    group.add(shield);
  }
  return group;
}

function createPartObject(part) {
  if (part.category === "command") return createCommand(part);
  if (part.category === "engine") return createEngine(part);
  if (part.category === "fuel") return createTank(part);
  if (part.category === "structure") return createStructure(part);
  if (part.category === "aero") return createAero(part);
  if (part.category === "control") return createControl(part);
  if (part.category === "power") return createPower(part);
  if (part.category === "payload") return createPayload(part);
  if (part.category === "recovery") return createRecovery(part);
  return box(0.5, 0.5, 0.5, material(PALETTE.body));
}

function partHeight(part) {
  if (part.category === "engine") return part.thrust > 150000 ? 1.35 : 1.05;
  if (part.category === "fuel") {
    return 0.85 + Math.min(1.2, Math.max(0.72, part.fuelMass / 3600)) * 0.78;
  }
  if (part.category === "aero") return part.liftArea ? 0.55 : 0.82;
  if (part.category === "power") return part.powerGeneration ? 0.62 : 0.58;
  if (part.category === "payload") return part.contractPayload ? 0.72 : 0.68;
  if (part.category === "recovery") return part.impactTolerance ? 0.62 : 0.5;
  if (part.category === "structure") return part.splitStage ? 0.65 : 0.55;
  return 0.72;
}

function buildStageMap(blueprint) {
  const result = new Map();
  let stage = 0;
  for (let index = blueprint.length - 1; index >= 0; index -= 1) {
    result.set(index, stage);
    if (getPart(blueprint[index])?.splitStage && index > 0) stage += 1;
  }
  return result;
}

export class RocketModel {
  constructor(blueprint, partConfigs = []) {
    this.group = new THREE.Group();
    this.body = null;
    this.parts = [];
    this.flame = null;
    this.chute = null;
    this.rebuild(blueprint, partConfigs);
  }

  rebuild(blueprint, partConfigs = []) {
    this.disposeChildren();
    this.parts = [];
    this.totalHeight = 0;
    this.body = new THREE.Group();
    this.group.add(this.body);
    const craft = compileCraft(blueprint, [], partConfigs);
    this.totalHeight = craft.height;
    this.flames = [];
    const ordered = craft.layout;

    for (const entry of ordered) {
      const part = entry.part;
      if (!part) continue;
      const object = createPartObject(part);
      const bounds = new THREE.Box3().setFromObject(object);
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      for (const child of object.children) child.position.y -= center.y;
      object.scale.y = entry.height / Math.max(0.01, size.y);
      object.userData.baseScale = object.scale.clone();
      object.position.set(entry.x, entry.y, 0);
      object.rotation.z = entry.config.angle * Math.PI / 180;
      object.userData.partId = part.id;
      object.userData.partIndex = entry.index;
      object.userData.stageIndex = entry.stageIndex;
      object.userData.assemblyObject = true;
      object.userData.materials = [];
      object.traverse((child) => {
        if (!child.isMesh) return;
        child.userData.partIndex = entry.index;
        child.userData.assemblyObject = true;
        child.userData.materials = [];
        if (child.material) {
          const list = Array.isArray(child.material)
            ? child.material
            : [child.material];
          child.userData.materials.push(...list);
        }
      });
      this.body.add(object);
      this.parts.push({
        index: entry.index,
        part,
        object,
        baseY: object.position.y,
        config: entry.config,
      });
      if (part.thrust) {
        const plume = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.8, 18, 1, true),
          material(0xf4ba53, { transparent: true, opacity: 0.9, emissive: 0xff8b45, emissiveIntensity: 2 }));
        plume.rotation.z = Math.PI;
        plume.position.y = -1.1;
        plume.visible = false;
        object.add(plume);
        this.flames.push({ plume, stageIndex: entry.stageIndex });
      }
    }

    const properties = massProperties(craft);
    this.massMarker = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x189784, depthTest: false }));
    this.massMarker.position.set(properties.centerX, properties.centerY, 0.65);
    this.massMarker.renderOrder = 20;
    this.body.add(this.massMarker);
    this.thrustArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(properties.centerX, 0, 0.7), Math.min(2.5, this.totalHeight * 0.55), 0xe5a42a, 0.2, 0.12);
    if (properties.thrustY > 0) {
      const angle = Math.atan2(properties.thrustX, properties.thrustY);
      this.thrustArrow.setDirection(new THREE.Vector3(Math.sin(angle), Math.cos(angle), 0));
      this.thrustArrow.position.x += properties.thrustTorque / properties.thrustY;
    }
    this.body.add(this.thrustArrow);

    this.flame = new THREE.Group();
    this.flame.visible = false;
    this.flame.position.y = -0.22;
    const plumeMat = material(PALETTE.recovery, {
      transparent: true,
      opacity: 0.9,
      emissive: 0xff8b45,
      emissiveIntensity: 2.2,
      roughness: 0.18,
    });
    const plume = new THREE.Mesh(
      new THREE.ConeGeometry(0.25, 1.8, 18, 1, true),
      plumeMat,
    );
    plume.rotation.z = Math.PI;
    plume.position.y = -0.9;
    this.flame.add(plume);
    this.body.add(this.flame);

    this.chute = new THREE.Group();
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(1.15, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      material(PALETTE.recovery, {
        side: THREE.DoubleSide,
        roughness: 0.72,
      }),
    );
    canopy.rotation.x = Math.PI;
    canopy.position.y = 1;
    this.chute.add(canopy);
    const lineMat = material(PALETTE.body, { metalness: 0.1 });
    for (let index = 0; index < 8; index += 1) {
      const angle = (Math.PI * 2 * index) / 8;
      const line = cylinder(0.008, 0.008, 1.7, lineMat.clone(), 6);
      line.position.set(Math.cos(angle) * 0.42, 0.2, Math.sin(angle) * 0.42);
      line.rotation.z = Math.cos(angle) * 0.46;
      line.rotation.x = -Math.sin(angle) * 0.46;
      this.chute.add(line);
    }
    this.chute.position.y = this.totalHeight + 0.4;
    this.chute.visible = false;
    this.body.add(this.chute);

    this.body.position.y = -this.totalHeight / 2;
  }

  setSelected(index) {
    this.parts.forEach((part) => {
      const selected = part.index === index;
      part.object.scale.copy(part.object.userData.baseScale).multiplyScalar(selected ? 1.04 : 1);
      for (const mat of part.object.userData.materials || []) {
        mat.emissive.setHex(selected ? 0x9c4a2f : 0x000000);
        mat.emissiveIntensity = selected ? 0.42 : 0;
      }
    });
  }

  setActiveStage(stageIndex) {
    this.parts.forEach((part) => {
      part.object.visible = part.object.userData.stageIndex >= stageIndex;
    });
  }

  updateFlight(snapshot) {
    if (!this.flame || !this.chute) return;
    const burning =
      snapshot.status === "flying" &&
      snapshot.thrust > 0 &&
      snapshot.stageFuel > 0.01;
    this.flame.visible = false;
    this.massMarker.visible = false;
    this.thrustArrow.visible = false;
    for (const { plume, stageIndex } of this.flames) {
      plume.visible = burning && stageIndex === snapshot.stageIndex;
      plume.scale.y = 0.5 + snapshot.throttle;
    }
    this.flame.scale.set(
      0.75 + snapshot.throttle * 0.25,
      0.6 + snapshot.throttle * 1.5,
      0.75 + snapshot.throttle * 0.25,
    );
    this.chute.visible = snapshot.parachuteDeployed;
    this.setActiveStage(snapshot.stageIndex);
  }

  disposeChildren() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.traverse((object) => {
        object.geometry?.dispose?.();
        if (Array.isArray(object.material)) {
          object.material.forEach((item) => item.dispose?.());
        } else {
          object.material?.dispose?.();
        }
      });
    }
  }

  dispose() {
    this.disposeChildren();
  }
}
