// Orbital layout, appearance and interaction adapted from SAG-main-V2
// orbital-graph-3d.tsx (ec26707), MIT. See universe/LICENSE.
import * as React from "react";
import * as THREE from "three";
import { Globe2, Orbit, RotateCcw } from "lucide-react";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { useI18n } from "../i18n";
import type { SceneLink, SceneNode } from "../lib/graph-scene-data";

type EventEntityGraphKind = "event" | "entity";
type EventEntityGraphSlice = {
  events: Array<{ id: string; title: string; category?: string }>;
  entities: Array<{ id: string; name: string; type?: string; kind: "entity" | "chunk" }>;
  relations: Array<{ id: string; eventId: string; entityId: string }>;
};
type Camera = { x: number; y: number; z: number; target?: [number, number, number] };
type Props = {
  data: { nodes: SceneNode[]; links: SceneLink[] };
  selectedId: string | null;
  camera: React.RefObject<Camera | null>;
  onSelect: (id: string) => void;
  onClear: () => void;
  onUnavailable: () => void;
};

function eventEntityNodeId(kind: EventEntityGraphKind, id: string) {
  return `${kind}:${id}`;
}

function resolveOrbitalSelection(slice: EventEntityGraphSlice, id: string | null) {
  return id ? eventEntityNodeId(slice.events.some((event) => event.id === id) ? "event" : "entity", id) : null;
}

function toOrbitalSlice(data: Props["data"]): EventEntityGraphSlice {
  const events = data.nodes.flatMap((node) => node.kind === "event" ? [{ id: node.id, title: node.label, category: node.category }] : []);
  const entities = data.nodes.flatMap((node) => node.kind !== "event" ? [{ id: node.id, name: node.label, kind: node.kind }] : []);
  const eventIds = new Set(events.map((event) => event.id));
  const relations = data.links.flatMap(({ source, target }) => {
    const eventId = eventIds.has(source) ? source : eventIds.has(target) ? target : undefined;
    return eventId ? [{ id: JSON.stringify([source, target]), eventId, entityId: eventId === source ? target : source }] : [];
  });
  return { events, entities, relations };
}

interface OrbitalLayout {
  positions: Map<string, THREE.Vector3>;
  innerRadius: number;
  outerRadius: number;
}

interface OrbitalSceneNode {
  id: string;
  kind: EventEntityGraphKind;
  object: THREE.Group;
  position: THREE.Vector3;
  visual: THREE.Sprite | THREE.Mesh;
  visualMaterial: THREE.SpriteMaterial | THREE.MeshStandardMaterial;
  visualKind: "disc" | "plate";
  baseColor: THREE.Color;
  ring: THREE.Sprite;
  ringMaterial: THREE.SpriteMaterial;
  label: HTMLDivElement;
  size: number;
}

interface OrbitalSceneEdge {
  eventId: string;
  entityId: string;
  curve: THREE.CubicBezierCurve3;
  material: THREE.LineBasicMaterial;
  pulse: THREE.Sprite;
  offset: number;
}

interface OrbitalSceneApi {
  resetCamera: () => void;
  setAutoRotate: (enabled: boolean) => void;
  setSelected: (nodeId: string | null) => void;
}

type OrbitalRenderer = {
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
};

const BASE_HOME_POSITION = new THREE.Vector3(0, 54, 1250);
const INNER_RADIUS = 158;
const OUTER_RADIUS = 424;
const ENTITY_SIZE_RATIO = 0.6;
const BASE_EDGE_OPACITY = 0.085;

const EVENT_COLORS = ["#ff6b7f", "#ec82ad", "#f4a261", "#ff8f70", "#f3c86a"];
const ENTITY_COLORS = ["#5577ff", "#6b9cff", "#8d76ff", "#58c5d8", "#d7def2"];
const PLATE_COLORS = [
  "#f05d7b",
  "#f48c68",
  "#f2c45e",
  "#53c6a5",
  "#4eb3d3",
  "#6289e8",
  "#8d6ed4",
  "#d96fa5",
];

type EventSurfaceMode = "nodes" | "plates";

function hashValue(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nodeColor(kind: EventEntityGraphKind, key: string) {
  const colors = kind === "event" ? EVENT_COLORS : ENTITY_COLORS;
  return colors[hashValue(key) % colors.length];
}

function plateColor(key: string, index: number) {
  return PLATE_COLORS[(hashValue(key) + index * 3) % PLATE_COLORS.length];
}

function fibonacciDirection(index: number, count: number, phase = 0) {
  const safeCount = Math.max(1, count);
  const y = 1 - ((index + 0.5) / safeCount) * 2;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const angle = (index + phase) * Math.PI * (3 - Math.sqrt(5));
  return new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius)
    .applyAxisAngle(new THREE.Vector3(1, 0, 0), -0.16)
    .normalize();
}

function buildOrbitalLayout(slice: EventEntityGraphSlice): OrbitalLayout {
  const positions = new Map<string, THREE.Vector3>();
  const eventDirections = new Map<string, THREE.Vector3>();

  slice.events.forEach((event, index) => {
    const direction = fibonacciDirection(index, slice.events.length, 0.24);
    eventDirections.set(event.id, direction);
    positions.set(eventEntityNodeId("event", event.id), direction.clone().multiplyScalar(INNER_RADIUS));
  });

  const linkedEvents = new Map<string, string[]>();
  slice.relations.forEach((relation) => {
    const values = linkedEvents.get(relation.entityId) ?? [];
    values.push(relation.eventId);
    linkedEvents.set(relation.entityId, values);
  });

  const anchors = slice.entities.map((entity, index) => {
    const spread = fibonacciDirection(index, slice.entities.length, 0.71);
    const linked = linkedEvents.get(entity.id) ?? [];
    const relatedDirection = linked.reduce((sum, eventId) => {
      const direction = eventDirections.get(eventId);
      return direction ? sum.add(direction) : sum;
    }, new THREE.Vector3());
    if (relatedDirection.lengthSq() < 0.0001) return spread;
    return relatedDirection.normalize().multiplyScalar(0.7).addScaledVector(spread, 0.3).normalize();
  });

  let entityDirections = anchors.map((anchor, index) =>
    anchor
      .clone()
      .multiplyScalar(0.82)
      .addScaledVector(fibonacciDirection(index, anchors.length, 1.13), 0.18)
      .normalize(),
  );
  const minimumDistance = Math.max(0.26, Math.min(0.42, 2.45 / Math.sqrt(Math.max(1, anchors.length))));

  const relaxationIterations = anchors.length > 320 ? 0 : anchors.length > 180 ? 18 : 90;
  for (let iteration = 0; iteration < relaxationIterations; iteration += 1) {
    entityDirections = entityDirections.map((direction, index, values) => {
      const force = new THREE.Vector3();
      values.forEach((other, otherIndex) => {
        if (index === otherIndex) return;
        const delta = direction.clone().sub(other);
        const distance = delta.length();
        if (distance >= minimumDistance || distance < 0.00001) return;
        const tangent = delta.addScaledVector(direction, -delta.dot(direction));
        if (tangent.lengthSq() < 0.00001) return;
        force.addScaledVector(tangent.normalize(), (minimumDistance - distance) * 0.13);
      });
      const anchorTangent = anchors[index]
        .clone()
        .addScaledVector(direction, -anchors[index].dot(direction));
      force.addScaledVector(anchorTangent, 0.012);
      return direction.clone().add(force).normalize();
    });
  }

  slice.entities.forEach((entity, index) => {
    positions.set(
      eventEntityNodeId("entity", entity.id),
      entityDirections[index].clone().multiplyScalar(OUTER_RADIUS),
    );
  });

  return { positions, innerRadius: INNER_RADIUS, outerRadius: OUTER_RADIUS };
}

function makeAdjacency(slice: EventEntityGraphSlice) {
  const adjacency = new Map<string, string[]>();
  slice.relations.forEach((relation) => {
    const eventId = eventEntityNodeId("event", relation.eventId);
    const entityId = eventEntityNodeId("entity", relation.entityId);
    adjacency.set(eventId, [...(adjacency.get(eventId) ?? []), entityId]);
    adjacency.set(entityId, [...(adjacency.get(entityId) ?? []), eventId]);
  });
  return adjacency;
}

function makeDegreeMap(slice: EventEntityGraphSlice) {
  const degrees = new Map<string, number>();
  slice.relations.forEach((relation) => {
    const eventId = eventEntityNodeId("event", relation.eventId);
    const entityId = eventEntityNodeId("entity", relation.entityId);
    degrees.set(eventId, (degrees.get(eventId) ?? 0) + 1);
    degrees.set(entityId, (degrees.get(entityId) ?? 0) + 1);
  });
  return degrees;
}

function makeDiscTexture(fill: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 160;
  const context = canvas.getContext("2d");
  if (!context) return new THREE.CanvasTexture(canvas);

  const center = 80;
  const radius = 52;
  context.clearRect(0, 0, 160, 160);
  context.save();
  context.shadowColor = `${fill}99`;
  context.shadowBlur = 18;
  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.fillStyle = fill;
  context.fill();
  context.restore();

  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.lineWidth = 9;
  context.strokeStyle = "#101522";
  context.stroke();

  context.beginPath();
  context.arc(center, center, radius - 4.5, 0, Math.PI * 2);
  context.lineWidth = 2;
  context.strokeStyle = "rgba(255,255,255,0.72)";
  context.stroke();

  const highlight = context.createRadialGradient(59, 54, 2, 65, 60, 40);
  highlight.addColorStop(0, "rgba(255,255,255,0.42)");
  highlight.addColorStop(1, "rgba(255,255,255,0)");
  context.beginPath();
  context.arc(center, center, radius - 7, 0, Math.PI * 2);
  context.fillStyle = highlight;
  context.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function makeRingTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 160;
  const context = canvas.getContext("2d");
  if (!context) return new THREE.CanvasTexture(canvas);
  context.clearRect(0, 0, 160, 160);
  context.save();
  context.shadowColor = "rgba(255,255,255,0.9)";
  context.shadowBlur = 16;
  context.beginPath();
  context.arc(80, 80, 55, 0, Math.PI * 2);
  context.lineWidth = 4;
  context.strokeStyle = "rgba(255,255,255,0.92)";
  context.stroke();
  context.restore();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makePulseTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return new THREE.CanvasTexture(canvas);
  const glow = context.createRadialGradient(32, 32, 0, 32, 32, 28);
  glow.addColorStop(0, "rgba(255,255,255,1)");
  glow.addColorStop(0.22, "rgba(166,205,255,0.95)");
  glow.addColorStop(1, "rgba(83,119,255,0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeLabel(text: string, kind: EventEntityGraphKind, category?: string) {
  const label = document.createElement("div");
  label.className = "sag-orbital-label";
  label.dataset.kind = kind;
  if (category) {
    const tag = document.createElement("small");
    tag.dataset.eventCategory = "";
    tag.textContent = category;
    label.append(tag);
  }
  const title = document.createElement("span");
  title.textContent = text;
  label.append(title);
  return label;
}

function addOrbitRings(scene: THREE.Scene, radius: number, color: string, opacity: number) {
  const circle = (
    pointAt: (angle: number) => THREE.Vector3,
    ringOpacity = opacity,
  ) => {
    const points = Array.from({ length: 129 }, (_, index) =>
      pointAt((index / 128) * Math.PI * 2),
    );
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineDashedMaterial({
      color,
      transparent: true,
      opacity: ringOpacity,
      dashSize: radius > 200 ? 9 : 6,
      gapSize: radius > 200 ? 13 : 9,
      depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.computeLineDistances();
    line.renderOrder = 0;
    scene.add(line);
  };

  circle((angle) => new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0));
  circle((angle) => new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
  circle((angle) => new THREE.Vector3(0, Math.cos(angle) * radius, Math.sin(angle) * radius));
  [-0.48, 0.48].forEach((latitude) => {
    const y = radius * latitude;
    const ringRadius = radius * Math.sqrt(1 - latitude * latitude);
    circle(
      (angle) => new THREE.Vector3(Math.cos(angle) * ringRadius, y, Math.sin(angle) * ringRadius),
      opacity * 0.62,
    );
  });
}

function addBackgroundPoints(scene: THREE.Scene) {
  let seed = 24681357;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const positions: number[] = [];
  for (let index = 0; index < 280; index += 1) {
    const direction = new THREE.Vector3(
      random() * 2 - 1,
      random() * 2 - 1,
      random() * 2 - 1,
    ).normalize();
    direction.multiplyScalar(620 + random() * 620);
    positions.push(direction.x, direction.y, direction.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xaab6d1,
    size: 1.65,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    sizeAttenuation: true,
  });
  scene.add(new THREE.Points(geometry, material));
}

interface EventPlateSurface {
  geometries: Map<string, THREE.BufferGeometry>;
  boundaryGeometry: THREE.BufferGeometry;
}

type SurfacePoint = [number, number, number];

function surfacePointKey([x, y, z]: SurfacePoint) {
  return `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
}

function surfaceEdgeKey(first: SurfacePoint, second: SurfacePoint) {
  const firstKey = surfacePointKey(first);
  const secondKey = surfacePointKey(second);
  return firstKey < secondKey ? `${firstKey}|${secondKey}` : `${secondKey}|${firstKey}`;
}

function buildEventPlateSurface(
  slice: EventEntityGraphSlice,
  layout: OrbitalLayout,
): EventPlateSurface {
  const sourceGeometry = new THREE.IcosahedronGeometry(layout.innerRadius, 4);
  const surfaceGeometry = sourceGeometry.index
    ? sourceGeometry.toNonIndexed()
    : sourceGeometry.clone();
  sourceGeometry.dispose();

  const positions = surfaceGeometry.getAttribute("position");
  const sites = slice.events.map((event) => {
    const id = eventEntityNodeId("event", event.id);
    const position = layout.positions.get(id) ?? new THREE.Vector3(0, 1, 0);
    return { id, position, direction: position.clone().normalize() };
  });
  if (sites.length === 0) {
    surfaceGeometry.dispose();
    return {
      geometries: new Map(),
      boundaryGeometry: new THREE.BufferGeometry(),
    };
  }
  const plateVertices = sites.map(() => [] as number[]);
  const edgeOwners = new Map<
    string,
    { owner: number; first: SurfacePoint; second: SurfacePoint }
  >();
  const boundaryVertices: number[] = [];
  const center = new THREE.Vector3();

  for (let vertexIndex = 0; vertexIndex < positions.count; vertexIndex += 3) {
    const triangle: [SurfacePoint, SurfacePoint, SurfacePoint] = [
      [positions.getX(vertexIndex), positions.getY(vertexIndex), positions.getZ(vertexIndex)],
      [
        positions.getX(vertexIndex + 1),
        positions.getY(vertexIndex + 1),
        positions.getZ(vertexIndex + 1),
      ],
      [
        positions.getX(vertexIndex + 2),
        positions.getY(vertexIndex + 2),
        positions.getZ(vertexIndex + 2),
      ],
    ];
    center
      .set(
        triangle[0][0] + triangle[1][0] + triangle[2][0],
        triangle[0][1] + triangle[1][1] + triangle[2][1],
        triangle[0][2] + triangle[1][2] + triangle[2][2],
      )
      .normalize();

    let owner = 0;
    let bestMatch = -Infinity;
    sites.forEach((site, siteIndex) => {
      const match = center.dot(site.direction);
      if (match > bestMatch) {
        bestMatch = match;
        owner = siteIndex;
      }
    });

    const anchor = sites[owner].position;
    triangle.forEach(([x, y, z]) => {
      plateVertices[owner].push(x - anchor.x, y - anchor.y, z - anchor.z);
    });

    const edges: Array<[SurfacePoint, SurfacePoint]> = [
      [triangle[0], triangle[1]],
      [triangle[1], triangle[2]],
      [triangle[2], triangle[0]],
    ];
    edges.forEach(([first, second]) => {
      const key = surfaceEdgeKey(first, second);
      const existing = edgeOwners.get(key);
      if (!existing) {
        edgeOwners.set(key, { owner, first, second });
        return;
      }
      if (existing.owner === owner) return;
      [existing.first, existing.second].forEach(([x, y, z]) => {
        const scale = (layout.innerRadius + 1.15) / Math.hypot(x, y, z);
        boundaryVertices.push(x * scale, y * scale, z * scale);
      });
    });
  }

  surfaceGeometry.dispose();
  const geometries = new Map<string, THREE.BufferGeometry>();
  sites.forEach((site, index) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(plateVertices[index], 3),
    );
    geometry.computeVertexNormals();
    geometries.set(site.id, geometry);
  });
  const boundaryGeometry = new THREE.BufferGeometry();
  boundaryGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(boundaryVertices, 3),
  );
  return { geometries, boundaryGeometry };
}

function edgeCurve(start: THREE.Vector3, end: THREE.Vector3, key: string) {
  const bow = start.clone().normalize().cross(end.clone().normalize());
  if (bow.lengthSq() > 0.0001) {
    bow.normalize().multiplyScalar(hashValue(key) % 2 === 0 ? 16 : -16);
  }
  const firstControl = start.clone().multiplyScalar(1.42).add(bow);
  const secondControl = end.clone().multiplyScalar(0.78).addScaledVector(bow, 0.65);
  return new THREE.CubicBezierCurve3(start, firstControl, secondControl, end);
}

function disposeScene(scene: THREE.Scene, textures: Iterable<THREE.Texture>) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  scene.traverse((object) => {
    const renderable = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    if (renderable.geometry) geometries.add(renderable.geometry);
    const values = Array.isArray(renderable.material)
      ? renderable.material
      : renderable.material
        ? [renderable.material]
        : [];
    values.forEach((material) => materials.add(material));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  for (const texture of textures) texture.dispose();
}

export default function ProjectGraph3D(props: Props) {
  const { t } = useI18n();
  const mountRef = React.useRef<HTMLDivElement>(null);
  const sceneApiRef = React.useRef<OrbitalSceneApi | null>(null);
  const rendererRef = React.useRef<OrbitalRenderer | null>(null);
  const autoRotateRef = React.useRef(false);
  const callbacks = React.useRef(props);
  callbacks.current = props;
  const [autoRotate, setAutoRotate] = React.useState(false);
  const [eventSurfaceMode, setEventSurfaceMode] = React.useState<EventSurfaceMode>("plates");
  const topology = JSON.stringify([props.data.nodes, props.data.links]);
  const slice = React.useMemo(() => {
    const [nodes, links]: [SceneNode[], SceneLink[]] = JSON.parse(topology);
    return toOrbitalSlice({ nodes, links });
  }, [topology]);
  const layout = React.useMemo(() => buildOrbitalLayout(slice), [slice]);
  const empty = !slice.events.length && !slice.entities.length;

  React.useEffect(() => {
    autoRotateRef.current = autoRotate;
    sceneApiRef.current?.setAutoRotate(autoRotate);
  }, [autoRotate]);

  React.useEffect(() => {
    sceneApiRef.current?.setSelected(resolveOrbitalSelection(slice, props.selectedId));
  }, [props.selectedId, slice]);

  React.useEffect(() => {
    const mount = mountRef.current;
    if (!mount || empty) return;
    if (typeof window.WebGL2RenderingContext !== "function") {
      callbacks.current.onUnavailable();
      return;
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
    } catch {
      callbacks.current.onUnavailable();
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.domElement.className =
      "absolute inset-0 size-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400";
    renderer.domElement.dataset.graphCanvas = "orbital-3d";
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute("role", "application");

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.domElement.className = "pointer-events-none absolute inset-0 z-[1] overflow-hidden";
    labelRenderer.domElement.setAttribute("aria-hidden", "true");
    mount.replaceChildren(renderer.domElement, labelRenderer.domElement);

    const camera = new THREE.PerspectiveCamera(42, 1, 1, 2200);
    const savedView = callbacks.current.camera.current;
    if (savedView) camera.position.set(savedView.x, savedView.y, savedView.z);
    else camera.position.copy(BASE_HOME_POSITION);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.058;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.72;
    controls.enablePan = false;
    controls.minDistance = 650;
    controls.maxDistance = 2800;
    if (savedView?.target) controls.target.set(...savedView.target);
    controls.autoRotate = autoRotateRef.current;
    controls.autoRotateSpeed = 0.32;
    controls.update();
    rendererRef.current = { renderer, labelRenderer, camera, controls };

    const onContextLost = (event: Event) => {
      event.preventDefault();
      callbacks.current.onUnavailable();
    };
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);
    return () => {
      callbacks.current.camera.current = {
        x: camera.position.x, y: camera.position.y, z: camera.position.z,
        target: [controls.target.x, controls.target.y, controls.target.z]
      };
      rendererRef.current = null;
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      controls.dispose();
      mount.replaceChildren();
      renderer.dispose();
      renderer.forceContextLoss();
    };
  }, [empty]);

  React.useEffect(() => {
    const mount = mountRef.current;
    const current = rendererRef.current;
    if (!mount || !current || empty) return;
    const { renderer, labelRenderer, camera, controls } = current;
    renderer.domElement.setAttribute("aria-label",
      eventSurfaceMode === "plates" ? t("大陆星球图谱", "Planetary graph") : t("双轨道图谱", "Dual-orbit graph"));
    const homePosition = BASE_HOME_POSITION.clone().multiplyScalar(
      mount.clientWidth < mount.clientHeight ? Math.min(2.2, mount.clientHeight / Math.max(1, mount.clientWidth)) : 1
    );
    if (camera.position.distanceTo(BASE_HOME_POSITION) < 2) camera.position.copy(homePosition);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070a12);
    scene.fog = new THREE.Fog(0x070a12, 1400, 4200);
    addBackgroundPoints(scene);
    if (eventSurfaceMode === "nodes") {
      addOrbitRings(scene, layout.innerRadius, "#ef8b9f", 0.18);
    }
    addOrbitRings(scene, layout.outerRadius, "#6f8dff", 0.12);

    const degrees = makeDegreeMap(slice);
    const adjacency = makeAdjacency(slice);
    const nodes = new Map<string, OrbitalSceneNode>();
    const pickables: THREE.Object3D[] = [];
    const textures = new Map<string, THREE.Texture>();
    const ringTexture = makeRingTexture();
    const pulseTexture = makePulseTexture();
    textures.set("ring", ringTexture);
    textures.set("pulse", pulseTexture);

    const textureFor = (color: string) => {
      const existing = textures.get(color);
      if (existing) return existing;
      const texture = makeDiscTexture(color);
      textures.set(color, texture);
      return texture;
    };

    const eventColors = new Map(
      slice.events.map((event, index) => [
        event.id,
        eventSurfaceMode === "plates"
          ? plateColor(event.id, index)
          : nodeColor("event", event.category || event.id),
      ]),
    );

    const registerDiscNode = ({
      id,
      kind,
      labelText,
      category,
      color,
      size,
    }: {
      id: string;
      kind: EventEntityGraphKind;
      labelText: string;
      category?: string;
      color: string;
      size: number;
    }) => {
      const position = layout.positions.get(id);
      if (!position) return;
      const object = new THREE.Group();
      object.position.copy(position);

      const visualMaterial = new THREE.SpriteMaterial({
        map: textureFor(color),
        transparent: true,
        opacity: 1,
        alphaTest: 0.015,
        depthWrite: false,
      });
      const visual = new THREE.Sprite(visualMaterial);
      visual.scale.set(size, size, 1);
      visual.userData.nodeId = id;
      visual.renderOrder = 3;
      object.add(visual);
      pickables.push(visual);

      const ringMaterial = new THREE.SpriteMaterial({
        map: ringTexture,
        color,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const ring = new THREE.Sprite(ringMaterial);
      ring.scale.set(size * 1.34, size * 1.34, 1);
      ring.renderOrder = 4;
      object.add(ring);

      const label = makeLabel(labelText, kind, category);
      const labelObject = new CSS2DObject(label);
      labelObject.position.set(0, size * 0.52, 0);
      object.add(labelObject);

      nodes.set(id, {
        id,
        kind,
        object,
        position: position.clone(),
        visual,
        visualMaterial,
        visualKind: "disc",
        baseColor: new THREE.Color(color),
        ring,
        ringMaterial,
        label,
        size,
      });
      scene.add(object);
    };

    const registerPlateNode = ({
      id,
      labelText,
      category,
      color,
      geometry,
    }: {
      id: string;
      labelText: string;
      category?: string;
      color: string;
      geometry: THREE.BufferGeometry;
    }) => {
      const position = layout.positions.get(id);
      if (!position) return;
      const object = new THREE.Group();
      object.position.copy(position);
      const baseColor = new THREE.Color(color);
      const visualMaterial = new THREE.MeshStandardMaterial({
        color: baseColor,
        emissive: baseColor.clone().multiplyScalar(0.22),
        emissiveIntensity: 0.55,
        flatShading: true,
        metalness: 0.08,
        roughness: 0.68,
      });
      const visual = new THREE.Mesh(geometry, visualMaterial);
      visual.userData.nodeId = id;
      visual.renderOrder = 2;
      object.add(visual);
      pickables.push(visual);

      const normal = position.clone().normalize();
      const size = 34;
      const ringMaterial = new THREE.SpriteMaterial({
        map: ringTexture,
        color,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const ring = new THREE.Sprite(ringMaterial);
      ring.position.copy(normal.clone().multiplyScalar(5.5));
      ring.scale.set(size, size, 1);
      ring.renderOrder = 5;
      object.add(ring);

      const label = makeLabel(labelText, "event", category);
      const labelObject = new CSS2DObject(label);
      labelObject.position.copy(normal.multiplyScalar(13));
      object.add(labelObject);

      nodes.set(id, {
        id,
        kind: "event",
        object,
        position: position.clone(),
        visual,
        visualMaterial,
        visualKind: "plate",
        baseColor,
        ring,
        ringMaterial,
        label,
        size,
      });
      scene.add(object);
    };

    if (eventSurfaceMode === "plates") {
      const hemisphereLight = new THREE.HemisphereLight(0xdde7ff, 0x160d24, 1.75);
      const keyLight = new THREE.DirectionalLight(0xffe7d6, 3.1);
      keyLight.position.set(-230, 280, 360);
      scene.add(hemisphereLight, keyLight);

      const core = new THREE.Mesh(
        new THREE.SphereGeometry(layout.innerRadius - 2.4, 64, 40),
        new THREE.MeshStandardMaterial({
          color: 0x15162a,
          emissive: 0x0d1023,
          emissiveIntensity: 0.8,
          metalness: 0.12,
          roughness: 0.78,
        }),
      );
      core.renderOrder = 1;
      scene.add(core);

      const atmosphere = new THREE.Mesh(
        new THREE.SphereGeometry(layout.innerRadius + 4.5, 48, 32),
        new THREE.MeshBasicMaterial({
          color: 0xff8ba8,
          transparent: true,
          opacity: 0.045,
          depthWrite: false,
          side: THREE.BackSide,
          blending: THREE.AdditiveBlending,
        }),
      );
      atmosphere.renderOrder = 3;
      scene.add(atmosphere);

      const plateSurface = buildEventPlateSurface(slice, layout);
      slice.events.forEach((event) => {
        const id = eventEntityNodeId("event", event.id);
        const geometry = plateSurface.geometries.get(id);
        if (!geometry) return;
        registerPlateNode({
          id,
          labelText: event.title,
          category: event.category,
          color: eventColors.get(event.id) ?? PLATE_COLORS[0],
          geometry,
        });
      });
      const boundaries = new THREE.LineSegments(
        plateSurface.boundaryGeometry,
        new THREE.LineBasicMaterial({
          color: 0x17111f,
          transparent: true,
          opacity: 0.92,
          depthWrite: false,
        }),
      );
      boundaries.renderOrder = 4;
      scene.add(boundaries);
    } else {
      slice.events.forEach((event) => {
        const id = eventEntityNodeId("event", event.id);
        const degree = degrees.get(id) ?? 1;
        registerDiscNode({
          id,
          kind: "event",
          labelText: event.title,
          category: event.category,
          color: eventColors.get(event.id) ?? EVENT_COLORS[0],
          size: 42 + Math.min(21, Math.log2(degree + 1) * 6.5),
        });
      });
    }

    slice.entities.forEach((entity) => {
      const id = eventEntityNodeId("entity", entity.id);
      const degree = degrees.get(id) ?? 1;
      registerDiscNode({
        id,
        kind: "entity",
        labelText: entity.name,
        color: entity.kind === "chunk" ? "#bcabfe" : nodeColor("entity", entity.type || entity.id),
        size:
          (42 + Math.min(21, Math.log2(degree + 1) * 6.5)) * ENTITY_SIZE_RATIO,
      });
    });

    const sharedPulseMaterial = new THREE.SpriteMaterial({
      map: pulseTexture,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const edges: OrbitalSceneEdge[] = [];
    slice.relations.forEach((relation, index) => {
      const eventId = eventEntityNodeId("event", relation.eventId);
      const entityId = eventEntityNodeId("entity", relation.entityId);
      const start = layout.positions.get(eventId);
      const end = layout.positions.get(entityId);
      if (!start || !end) return;
      const curve = edgeCurve(start, end, relation.id);
      const points = curve.getPoints(slice.relations.length > 1_000 ? 10 : 26);
      const entity = slice.entities.find((value) => value.id === relation.entityId);
      const startColor = new THREE.Color(
        eventColors.get(relation.eventId) ?? nodeColor("event", relation.eventId),
      );
      const endColor = new THREE.Color(nodeColor("entity", entity?.type || relation.entityId));
      const colors = points.flatMap((_, pointIndex) => {
        const color = startColor.clone().lerp(endColor, pointIndex / Math.max(1, points.length - 1));
        return [color.r, color.g, color.b];
      });
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      const material = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: BASE_EDGE_OPACITY,
        depthWrite: false,
      });
      const line = new THREE.Line(geometry, material);
      line.renderOrder = 1;
      scene.add(line);

      const pulse = new THREE.Sprite(sharedPulseMaterial);
      pulse.scale.set(10, 10, 1);
      pulse.visible = false;
      pulse.renderOrder = 5;
      scene.add(pulse);
      edges.push({
        eventId,
        entityId,
        curve,
        material,
        pulse,
        offset: (index * 0.61803398875) % 1,
      });
    });

    let hoveredId: string | null = null;
    let selectedId = resolveOrbitalSelection(slice, callbacks.current.selectedId);
    let labelLimit = 10;
    const updateFocus = () => {
      const focusId = selectedId ?? hoveredId;
      const selectedNodes = new Set(
        selectedId ? [selectedId, ...(adjacency.get(selectedId) ?? [])] : [],
      );
      const visibleLabels = new Set(
        focusId ? [focusId, ...(adjacency.get(focusId) ?? [])].slice(0, labelLimit)
          : [...nodes.values()].filter((node) => node.kind === "event" && node.position.z > 0)
            .slice(0, 3).map((node) => node.id),
      );

      nodes.forEach((node) => {
        const selectedNeighborhood = !selectedId || selectedNodes.has(node.id);
        const active = node.id === focusId;
        if (node.visualKind === "plate") {
          const material = node.visualMaterial as THREE.MeshStandardMaterial;
          const displayColor = node.baseColor.clone();
          if (!selectedNeighborhood) displayColor.multiplyScalar(0.18);
          if (active) displayColor.offsetHSL(0, 0, 0.08);
          material.color.copy(displayColor);
          material.emissive.copy(node.baseColor).multiplyScalar(active ? 0.38 : 0.2);
          material.emissiveIntensity = active ? 1.15 : selectedNeighborhood ? 0.55 : 0.08;
        } else {
          node.visualMaterial.opacity = selectedNeighborhood ? 1 : 0.13;
        }
        node.ringMaterial.opacity = active ? 0.98 : 0;
        const scale = active ? 1.18 : 1;
        if (node.visualKind === "disc") {
          node.visual.scale.set(node.size * scale, node.size * scale, 1);
        }
        const ringBaseScale = node.visualKind === "disc" ? node.size * 1.34 : node.size;
        node.ring.scale.set(ringBaseScale * scale, ringBaseScale * scale, 1);
        node.label.dataset.visible = visibleLabels.has(node.id) ? "true" : "false";
        node.label.dataset.active = active ? "true" : "false";
      });

      edges.forEach((edge) => {
        const connectedToFocus =
          Boolean(focusId) && (edge.eventId === focusId || edge.entityId === focusId);
        const connectedToSelection =
          Boolean(selectedId) && (edge.eventId === selectedId || edge.entityId === selectedId);
        if (selectedId) {
          edge.material.opacity = connectedToSelection ? 0.78 : 0.012;
        } else if (hoveredId) {
          edge.material.opacity = connectedToFocus ? 0.68 : BASE_EDGE_OPACITY;
        } else {
          edge.material.opacity = BASE_EDGE_OPACITY;
        }
        edge.pulse.visible = connectedToFocus;
      });
    };
    updateFocus();

    type CameraTween = {
      startedAt: number;
      fromCamera: THREE.Vector3;
      toCamera: THREE.Vector3;
      fromTarget: THREE.Vector3;
      toTarget: THREE.Vector3;
    };
    let cameraTween: CameraTween | null = null;
    const animateCamera = (toCamera: THREE.Vector3, toTarget: THREE.Vector3) => {
      cameraTween = {
        startedAt: performance.now(),
        fromCamera: camera.position.clone(),
        toCamera,
        fromTarget: controls.target.clone(),
        toTarget,
      };
    };

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const raycastNode = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(pickables, false)[0];
      return hit?.object.userData.nodeId as string | undefined;
    };

    const onPointerMove = (event: PointerEvent) => {
      const next = raycastNode(event) ?? null;
      if (next === hoveredId) return;
      hoveredId = next;
      renderer.domElement.style.cursor = next ? "pointer" : "grab";
      updateFocus();
    };
    const onPointerLeave = () => {
      hoveredId = null;
      renderer.domElement.style.cursor = "grab";
      updateFocus();
    };
    let pointerDown: { x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      cameraTween = null;
      pointerDown = { x: event.clientX, y: event.clientY };
    };
    const selectNode = (id: string) => {
      callbacks.current.onSelect(id.slice(id.indexOf(":") + 1));
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!pointerDown || Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) {
        pointerDown = null;
        return;
      }
      pointerDown = null;
      const id = raycastNode(event);
      if (!id) {
        callbacks.current.onClear();
        return;
      }
      selectNode(id);
    };

    const keyboardNodeIds = [...nodes.keys()];
    let keyboardIndex = -1;
    const onKeyDown = (event: KeyboardEvent) => {
      if (keyboardNodeIds.length === 0) return;
      if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
        keyboardIndex =
          keyboardIndex < 0
            ? step > 0
              ? 0
              : keyboardNodeIds.length - 1
            : (keyboardIndex + step + keyboardNodeIds.length) % keyboardNodeIds.length;
        hoveredId = keyboardNodeIds[keyboardIndex];
        updateFocus();
      } else if (event.key === "Enter" && hoveredId) {
        event.preventDefault();
        selectNode(hoveredId);
      } else if (event.key === "Escape") {
        hoveredId = null;
        callbacks.current.onClear();
        updateFocus();
      }
    };
    const onBlur = () => {
      hoveredId = null;
      updateFocus();
    };

    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("keydown", onKeyDown);
    renderer.domElement.addEventListener("blur", onBlur);

    const renderSize = new THREE.Vector2();
    const resize = () => {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      const aspect = width / height;
      labelLimit = width < 700 ? 6 : 10;
      updateFocus();
      const previousHome = homePosition.clone();
      const portraitScale = aspect < 1 ? Math.min(2.2, 1 / aspect) : 1;
      homePosition.copy(BASE_HOME_POSITION).multiplyScalar(portraitScale);
      if (camera.position.distanceTo(previousHome) < 2) camera.position.copy(homePosition);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      renderer.getSize(renderSize);
      if (renderSize.x !== width || renderSize.y !== height) renderer.setSize(width, height, false);
      labelRenderer.setSize(width, height);
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    let frame = 0;
    let inViewport = true;
    let pageVisible = document.visibilityState !== "hidden";
    const render = (time: number) => {
      frame = 0;
      if (!inViewport || !pageVisible) return;
      if (cameraTween) {
        const progress = Math.min(1, (time - cameraTween.startedAt) / 720);
        const eased = 1 - Math.pow(1 - progress, 3);
        camera.position.lerpVectors(cameraTween.fromCamera, cameraTween.toCamera, eased);
        controls.target.lerpVectors(cameraTween.fromTarget, cameraTween.toTarget, eased);
        if (progress >= 1) cameraTween = null;
      }
      edges.forEach((edge) => {
        if (!edge.pulse.visible) return;
        const progress = (time * 0.00023 + edge.offset) % 1;
        edge.pulse.position.copy(edge.curve.getPoint(progress));
      });
      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
      frame = window.requestAnimationFrame(render);
    };
    const startRendering = () => {
      if (!frame && inViewport && pageVisible) {
        frame = window.requestAnimationFrame(render);
      }
    };
    const stopRendering = () => {
      if (!frame) return;
      window.cancelAnimationFrame(frame);
      frame = 0;
    };
    const onVisibilityChange = () => {
      pageVisible = document.visibilityState !== "hidden";
      if (pageVisible) startRendering();
      else stopRendering();
    };
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      inViewport = entry?.isIntersecting ?? true;
      if (inViewport) startRendering();
      else stopRendering();
    });
    intersectionObserver.observe(mount);
    document.addEventListener("visibilitychange", onVisibilityChange);
    startRendering();

    sceneApiRef.current = {
      resetCamera: () => animateCamera(homePosition.clone(), new THREE.Vector3()),
      setAutoRotate: (enabled) => {
        controls.autoRotate = enabled;
      },
      setSelected: (nodeId) => {
        const changed = selectedId !== nodeId;
        selectedId = nodeId;
        updateFocus();
        const node = nodeId ? nodes.get(nodeId) : null;
        if (changed && node) {
          const viewDirection = camera.position.clone().sub(controls.target).normalize();
          const target = node.object.position.clone().multiplyScalar(0.18);
          animateCamera(target.clone().addScaledVector(viewDirection, 1000), target);
        }
      },
    };

    return () => {
      sceneApiRef.current = null;
      stopRendering();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("keydown", onKeyDown);
      renderer.domElement.removeEventListener("blur", onBlur);
      scene.traverse((object) => {
        if (object instanceof CSS2DObject) object.element.remove();
      });
      disposeScene(scene, textures.values());
    };
  }, [empty, eventSurfaceMode, layout, slice, t]);


  const plates = eventSurfaceMode === "plates";
  const surfaceLabel = plates ? t("大陆星球", "Continental planet") : t("双轨道", "Dual orbit");
  const switchLabel = plates ? t("切换到双轨道", "Switch to dual orbit") : t("切换到大陆星球", "Switch to continental planet");
  const rotationLabel = autoRotate ? t("暂停旋转", "Pause rotation") : t("自动旋转", "Auto rotate");
  return (
    <div className="atlas-orbital absolute inset-0 overflow-hidden" data-graph-3d="ready" data-orbital-mode={eventSurfaceMode}>
      <div ref={mountRef} className="absolute inset-0" />
      <div className="atlas-orbital-legend">
        <span className="atlas-orbital-event-dot" />
        <span>{t("事件", "Events")} {slice.events.length}</span>
        <span className="atlas-orbital-entity-dot" />
        <span>{t("外轨节点", "Outer orbit")} {slice.entities.length}</span>
        <span>{t("关系", "Relations")} {slice.relations.length}</span>
      </div>
      <div className="atlas-orbital-tools">
        <span>{surfaceLabel}</span>
        <button type="button" disabled={empty} aria-label={switchLabel} title={switchLabel}
          onClick={() => setEventSurfaceMode(plates ? "nodes" : "plates")}><Globe2 size={15} /></button>
        <button type="button" disabled={empty} aria-label={rotationLabel} title={rotationLabel} aria-pressed={autoRotate}
          onClick={() => setAutoRotate((value) => !value)}><Orbit size={15} /></button>
        <button type="button" disabled={empty} aria-label={t("重置视角", "Reset camera")} title={t("重置视角", "Reset camera")}
          onClick={() => sceneApiRef.current?.resetCamera()}><RotateCcw size={15} /></button>
      </div>
      {empty && <span className="atlas-orbital-empty">{t("暂无关联事件", "No related events")}</span>}
    </div>
  );
}
