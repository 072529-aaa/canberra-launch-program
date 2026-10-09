import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { PLANET_RADIUS } from "../physics.js";
import { RocketModel } from "./rocketModel.js";
import { normalizePartConfig } from "../craft.js";

const VISUAL_EARTH_RADIUS = 90;
const VISUAL_SCALE = VISUAL_EARTH_RADIUS / PLANET_RADIUS;

function createRenderer(container) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.domElement.setAttribute("aria-label", "三维航天器视图");
  container.append(renderer.domElement);
  return renderer;
}

function createStars(count = 850) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  let seed = 7321;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let index = 0; index < count; index += 1) {
    const radius = 190 + random() * 230;
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[index * 3 + 1] = radius * Math.cos(phi);
    positions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: 0xf4eee2,
      size: 0.65,
      transparent: true,
      opacity: 0.78,
      sizeAttenuation: true,
    }),
  );
}

function createPlanetTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "#6e94a4");
  gradient.addColorStop(0.48, "#496f79");
  gradient.addColorStop(1, "#385a65");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let seed = 44021;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let index = 0; index < 34; index += 1) {
    const x = random() * canvas.width;
    const y = 40 + random() * (canvas.height - 80);
    const radiusX = 25 + random() * 105;
    const radiusY = 16 + random() * 55;
    ctx.beginPath();
    ctx.ellipse(
      x,
      y,
      radiusX,
      radiusY,
      random() * 0.7 - 0.35,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = index % 3 === 0 ? "#9a8461" : "#7d7b56";
    ctx.fill();
  }
  ctx.globalAlpha = 0.26;
  ctx.fillStyle = "#f6f1e7";
  for (let index = 0; index < 80; index += 1) {
    ctx.beginPath();
    ctx.arc(
      random() * canvas.width,
      random() * canvas.height,
      8 + random() * 40,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  return texture;
}

function disposeObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) {
      child.material.forEach((item) => item.dispose?.());
    } else {
      child.material?.dispose?.();
    }
  });
}

export class AssemblyScene {
  constructor(container, options = {}) {
    this.container = container;
    this.onSelect = options.onSelect || (() => {});
    this.onMove = options.onMove || (() => {});
    this.editMode = options.editMode ?? false;
    this.partConfigs = options.partConfigs || [];
    this.theme = options.theme || "light";
    this.renderer = createRenderer(container);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(
      this.theme === "dark" ? 0x1b1a18 : 0xf2eee6,
    );
    this.scene.fog = new THREE.Fog(
      this.theme === "dark" ? 0x1b1a18 : 0xf2eee6,
      13,
      28,
    );
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
    this.camera.position.set(6.4, 4.8, 8.6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 18;
    this.controls.maxPolarAngle = Math.PI * 0.78;
    this.controls.autoRotate = !this.editMode;
    this.controls.enableRotate = !this.editMode;
    this.controls.autoRotateSpeed = 0.35;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pointerStart = null;
    this.animationFrame = null;
    this.model = new RocketModel(options.blueprint || [], this.partConfigs);

    this.createEnvironment();
    this.scene.add(this.model.group);
    this.bindPointer();
    this.setBlueprint(options.blueprint || []);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.start();
  }

  createEnvironment() {
    const hemisphere = new THREE.HemisphereLight(0xfff5e8, 0x5b554d, 2.4);
    this.scene.add(hemisphere);
    const key = new THREE.DirectionalLight(0xfff0dc, 4.2);
    key.position.set(5, 8, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x7fa8c7, 1.25);
    fill.position.set(-6, 3, -4);
    this.scene.add(fill);

    const floorMat = new THREE.MeshStandardMaterial({
      color: this.theme === "dark" ? 0x272521 : 0xded8cd,
      roughness: 0.94,
      metalness: 0.02,
    });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(5.4, 72), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.03;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.3, 3.38, 72),
      new THREE.MeshBasicMaterial({
        color: 0xc96442,
        transparent: true,
        opacity: 0.55,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    this.scene.add(ring);
    const grid = new THREE.GridHelper(
      10,
      20,
      this.theme === "dark" ? 0x554f47 : 0xbfb7aa,
      this.theme === "dark" ? 0x393631 : 0xd8d1c7,
    );
    grid.position.y = 0;
    this.scene.add(grid);
  }

  bindPointer() {
    const canvas = this.renderer.domElement;
    const hitAt = (event) => {
      const bounds = canvas.getBoundingClientRect();
      this.pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      return this.raycaster.intersectObjects(this.model.parts.map((part) => part.object), true)
        .find((entry) => entry.object.userData.assemblyObject);
    };
    const planePoint = () => this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
    canvas.addEventListener("pointerdown", (event) => {
      if (!this.editMode) return;
      const hit = hitAt(event);
      if (!hit) return;
      const entry = this.model.parts.find((part) => part.index === hit.object.userData.partIndex);
      this.onSelect(entry.index);
      if (!entry.part.thrust && entry.part.category !== "aero") return;
      event.stopImmediatePropagation();
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      this.drag = { entry, start: planePoint(), original: { ...entry.config }, pointerId: event.pointerId };
    }, true);
    canvas.addEventListener("pointermove", (event) => {
      if (!this.drag) return;
      hitAt(event);
      const point = planePoint();
      if (!point || !this.drag.start) return;
      const { entry, start, original } = this.drag;
      const config = normalizePartConfig(entry.part.id, { ...original,
        x: Math.round((original.x + point.x - start.x) * 20) / 20,
        y: Math.round((original.y + point.y - start.y) * 20) / 20 });
      entry.object.position.x = config.x;
      entry.object.position.y = entry.baseY - original.y + config.y;
      this.drag.config = config;
    });
    const finish = (event) => {
      if (!this.drag) return;
      const drag = this.drag;
      this.drag = null;
      event.stopImmediatePropagation();
      if (canvas.hasPointerCapture(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId);
      if (event.type === "pointercancel") {
        drag.entry.object.position.set(drag.original.x, drag.entry.baseY, 0);
      } else if (drag.config && (drag.config.x !== drag.original.x || drag.config.y !== drag.original.y)) {
        this.onMove(drag.entry.index, drag.config);
      }
    };
    canvas.addEventListener("pointerup", finish, true);
    canvas.addEventListener("pointercancel", finish, true);
    canvas.addEventListener("pointerdown", (event) => {
      this.pointerStart = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener("pointerup", (event) => {
      if (!this.pointerStart) return;
      const moved = Math.hypot(
        event.clientX - this.pointerStart.x,
        event.clientY - this.pointerStart.y,
      );
      this.pointerStart = null;
      if (moved > 6) return;
      const bounds = canvas.getBoundingClientRect();
      this.pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      this.pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const targets = this.model.parts.map((part) => part.object);
      const hits = this.raycaster.intersectObjects(targets, true);
      const hit = hits.find((entry) => entry.object.userData.assemblyObject);
      if (hit) this.onSelect(hit.object.userData.partIndex);
    });
  }

  setBlueprint(blueprint) {
    this.model.rebuild(blueprint, this.partConfigs);
    this.model.massMarker.visible = this.editMode;
    this.model.thrustArrow.visible = this.editMode;
    this.controls.target.set(0, 0, 0);
    this.resetView();
  }

  setSelected(index) {
    this.model.setSelected(index);
  }

  resetView() {
    const distance = Math.max(8, this.model.totalHeight * 2.1);
    this.controls.maxDistance = Math.max(18, distance * 1.5);
    this.camera.position.set(this.editMode ? 0 : distance * 0.55, this.editMode ? 0 : distance * 0.4, distance);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  resize() {
    const bounds = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  start() {
    const render = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.animationFrame = requestAnimationFrame(render);
    };
    render();
  }

  dispose() {
    cancelAnimationFrame(this.animationFrame);
    this.observer?.disconnect();
    this.controls?.dispose();
    this.model?.dispose();
    this.scene?.traverse((object) => {
      if (object !== this.scene) disposeObject(object);
    });
    this.renderer?.dispose();
    this.renderer?.domElement?.remove();
  }
}

export class FlightScene {
  constructor(container, options = {}) {
    this.container = container;
    this.blueprint = options.blueprint || [];
    this.renderer = createRenderer(container);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x071015);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 900);
    this.camera.position.set(8, 98, 14);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 80;
    this.controls.target.set(0, VISUAL_EARTH_RADIUS + 2, 0);
    this.rocket = new RocketModel(this.blueprint, options.partConfigs || []);
    this.rocket.group.scale.setScalar(0.95);
    this.rocketPosition = new THREE.Vector3(
      0,
      VISUAL_EARTH_RADIUS + 2,
      0,
    );
    this.rocket.group.position.copy(this.rocketPosition);
    this.lastTrajectoryUpdate = -10;
    this.createEnvironment();
    this.scene.add(this.rocket.group);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
  }

  createEnvironment() {
    this.scene.add(new THREE.HemisphereLight(0xdcecff, 0x211d18, 1.9));
    const sun = new THREE.DirectionalLight(0xffead0, 5.2);
    sun.position.set(-38, 82, 34);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    this.scene.add(sun);
    this.scene.add(createStars());

    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(VISUAL_EARTH_RADIUS, 96, 64),
      new THREE.MeshStandardMaterial({
        map: createPlanetTexture(),
        roughness: 0.92,
        metalness: 0.02,
      }),
    );
    planet.receiveShadow = true;
    this.scene.add(planet);

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(VISUAL_EARTH_RADIUS + 2.2, 80, 48),
      new THREE.MeshBasicMaterial({
        color: 0x83b9d4,
        transparent: true,
        opacity: 0.1,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    this.scene.add(atmosphere);

    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(2.1, 2.5, 0.35, 28),
      new THREE.MeshStandardMaterial({
        color: 0x47433e,
        roughness: 0.8,
        metalness: 0.25,
      }),
    );
    pad.position.set(0, VISUAL_EARTH_RADIUS + 0.02, 0);
    pad.receiveShadow = true;
    this.scene.add(pad);
    const tower = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 3.8, 0.34),
      new THREE.MeshStandardMaterial({
        color: 0xb5aa98,
        roughness: 0.72,
        metalness: 0.24,
      }),
    );
    tower.position.set(1.8, VISUAL_EARTH_RADIUS + 1.9, 0);
    this.scene.add(tower);

    this.trajectory = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({
        color: 0xd97757,
        dashSize: 1.6,
        gapSize: 1.1,
        transparent: true,
        opacity: 0.88,
      }),
    );
    this.scene.add(this.trajectory);
  }

  update(snapshot) {
    const angle = Math.atan2(snapshot.position[0], snapshot.position[1]);
    const radius = VISUAL_EARTH_RADIUS + this.rocket.totalHeight * 0.95 / 2 + 0.2 + Math.max(0, snapshot.altitude) * VISUAL_SCALE;
    const next = new THREE.Vector3(
      Math.sin(angle) * radius,
      Math.cos(angle) * radius,
      0,
    );
    const delta = next.clone().sub(this.rocketPosition);
    this.rocket.group.position.copy(next);
    this.rocket.group.rotation.z = snapshot.angle - Math.PI / 2;
    this.rocketPosition.copy(next);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
    this.rocket.updateFlight(snapshot);
    if (snapshot.time - this.lastTrajectoryUpdate > 0.8) {
      this.updateTrajectory(snapshot);
      this.lastTrajectoryUpdate = snapshot.time;
    }
  }

  updateTrajectory(snapshot) {
    const points = [];
    let x = snapshot.position[0];
    let y = snapshot.position[1];
    let vx = snapshot.velocity[0];
    let vy = snapshot.velocity[1];
    const step = 8;
    for (let index = 0; index < 180; index += 1) {
      const radius = Math.max(1, Math.hypot(x, y));
      if (radius < PLANET_RADIUS) break;
      const ax = (-3.5316e12 * x) / radius ** 3;
      const ay = (-3.5316e12 * y) / radius ** 3;
      vx += ax * step;
      vy += ay * step;
      x += vx * step;
      y += vy * step;
      const mapAngle = Math.atan2(x, y);
      const mapRadius = VISUAL_EARTH_RADIUS + Math.max(0, radius - PLANET_RADIUS) * VISUAL_SCALE;
      points.push(
        new THREE.Vector3(
          Math.sin(mapAngle) * mapRadius,
          Math.cos(mapAngle) * mapRadius,
          0.05,
        ),
      );
    }
    this.trajectory.geometry.dispose();
    this.trajectory.geometry = new THREE.BufferGeometry().setFromPoints(points);
    this.trajectory.computeLineDistances();
  }

  resetView() {
    const target = this.rocketPosition.clone();
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(new THREE.Vector3(15, 8, 24));
    this.controls.update();
  }

  resize() {
    const bounds = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.observer?.disconnect();
    this.controls?.dispose();
    this.rocket?.dispose();
    this.scene?.traverse((object) => {
      if (object !== this.scene) disposeObject(object);
    });
    this.renderer?.dispose();
    this.renderer?.domElement?.remove();
  }
}
