import { useEffect, useRef, useState, type RefObject } from "react";
import ForceGraph3D, { type ForceGraph3DInstance, type ConfigOptions } from "3d-force-graph";
import * as THREE from "three";
import { useTheme } from "../lib/theme";
import type { SceneLink, SceneNode } from "../lib/graph-scene-data";

type Node = SceneNode & { x?: number; y?: number; z?: number };
type Scene = ForceGraph3DInstance<Node>;
type Camera = { x: number; y: number; z: number };
type Props = {
  data: { nodes: SceneNode[]; links: SceneLink[] };
  selectedId: string | null;
  camera: RefObject<Camera | null>;
  onSelect: (id: string) => void;
  onClear: () => void;
  onUnavailable: () => void;
};

const Graph = ForceGraph3D as unknown as new (element: HTMLElement, options?: ConfigOptions) => Scene;

const nodeColors = { chunk: "#2c79b9", entity: "#cf6a36", event: "#7469d5" };

function moveToSelection(scene: Scene, id: string) {
  const node = scene.graphData().nodes.find((item) => item.id === id);
  if (node?.x == null || node.y == null || node.z == null) return;
  const target = new THREE.Vector3(node.x, node.y, node.z);
  const current = scene.cameraPosition();
  const offset = new THREE.Vector3(current.x, current.y, current.z).sub(target);
  if (offset.lengthSq() < 1) offset.set(0, 0, 1);
  offset.setLength(155).add(target);
  scene.cameraPosition(offset, target, 475);
}

function starField(dark: boolean) {
  const count = 360;
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const angle = index * Math.PI * (3 - Math.sqrt(5));
    const depth = 1 - (2 * (index + 0.5)) / count;
    const ring = Math.sqrt(1 - depth * depth);
    const distance = 520 + index % 140;
    positions.set([Math.cos(angle) * ring * distance, Math.sin(angle) * ring * distance, depth * distance], index * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: dark ? "#8aa3cb" : "#7a8799",
    size: 1.6,
    transparent: true,
    opacity: dark ? 0.55 : 0.23,
    depthWrite: false
  });
  return new THREE.Points(geometry, material);
}

export default function ProjectGraph3D(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Scene | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [ready, setReady] = useState(false);
  const theme = useTheme();
  const initialTheme = useRef(theme);

  useEffect(() => {
    const element = host.current;
    if (!element || typeof window.WebGL2RenderingContext !== "function") {
      callbacks.current.onUnavailable();
      return;
    }
    let scene: Scene;
    try {
      scene = new Graph(element, {
        controlType: "orbit",
        rendererConfig: { alpha: true, antialias: true, powerPreference: "high-performance" }
      });
    } catch {
      element.replaceChildren();
      callbacks.current.onUnavailable();
      return;
    }
    engine.current = scene;
    const renderer = scene.renderer();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    const canvas = renderer.domElement;
    const stars = starField(initialTheme.current.isDark);
    scene.scene().add(stars);
    let needsInitialFit = !props.camera.current;
    const originalCamera = props.camera.current;
    if (originalCamera) scene.cameraPosition(originalCamera);
    const unavailable = (event: Event) => {
      event.preventDefault();
      callbacks.current.onUnavailable();
    };
    const updateVisibility = () => {
      if (document.hidden) scene.pauseAnimation();
      else scene.resumeAnimation();
    };
    const observer = new ResizeObserver(() => {
      scene.width(Math.max(1, element.clientWidth)).height(Math.max(1, element.clientHeight));
    });
    observer.observe(element);
    canvas.addEventListener("webglcontextlost", unavailable);
    document.addEventListener("visibilitychange", updateVisibility);
    scene
      .showNavInfo(false)
      .width(Math.max(1, element.clientWidth))
      .height(Math.max(1, element.clientHeight))
      .nodeVal((node) => node.kind === "event" ? 4 : node.kind === "entity" ? 2.3 : 1.5)
      .nodeLabel((node) => {
        const label = document.createElement("span");
        label.textContent = node.label;
        return label;
      })
      .nodeOpacity(0.92)
      .nodeResolution(12)
      .linkWidth(0.45)
      .linkOpacity(0.43)
      .cooldownTicks(90)
      .onNodeClick((node) => callbacks.current.onSelect(node.id))
      .onBackgroundClick(() => callbacks.current.onClear())
      .onEngineStop(() => {
        const id = callbacks.current.selectedId;
        if (id) moveToSelection(scene, id);
        else if (needsInitialFit && scene.graphData().nodes.length) scene.zoomToFit(420, 48);
        if (scene.graphData().nodes.length) needsInitialFit = false;
      });
    updateVisibility();
    setReady(true);
    return () => {
      engine.current = null;
      observer.disconnect();
      document.removeEventListener("visibilitychange", updateVisibility);
      canvas.removeEventListener("webglcontextlost", unavailable);
      props.camera.current = scene.cameraPosition();
      scene.scene().remove(stars);
      stars.geometry.dispose();
      stars.material.dispose();
      scene.pauseAnimation();
      scene._destructor();
      renderer.dispose();
      renderer.forceContextLoss();
      element.replaceChildren();
    };
  }, [props.camera]);

  useEffect(() => {
    if (!ready || !engine.current) return;
    const scene = engine.current;
    const previous = new Map(scene.graphData().nodes.map((node) => [node.id, node]));
    scene.graphData({
      nodes: props.data.nodes.map((node) => {
        const position = previous.get(node.id);
        return { ...node, x: position?.x, y: position?.y, z: position?.z };
      }),
      links: props.data.links.map((edge) => ({ ...edge }))
    });
  }, [props.data, ready]);

  useEffect(() => {
    if (!ready || !engine.current) return;
    const scene = engine.current;
    const selectedId = props.selectedId;
    scene
      .backgroundColor(theme.colors.background)
      .linkColor(() => theme.isDark ? "#8293ae" : "#607189")
      .nodeColor((node) => node.id === selectedId ? theme.colors.accent : node.color ?? nodeColors[node.kind]);
    if (selectedId) moveToSelection(scene, selectedId);
  }, [props.selectedId, ready, theme.colors.accent, theme.colors.background, theme.isDark]);

  return <div ref={host} className="absolute inset-0 overflow-hidden" data-graph-3d={ready ? "ready" : "loading"} />;
}
