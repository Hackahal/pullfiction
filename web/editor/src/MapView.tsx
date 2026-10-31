import { useBufferedView } from "./ReplayLoading";
import { RANGE_COLORS } from "./range-check";
import { getLocalIcons, subscribeLocalIcons } from "./local-icons";
import { getLocalUiArt, subscribeLocalUiArt } from "./local-ui-art";
import { MapViewImages, mapActorIconKey } from "./map-view-images";
import { BrowserClient } from "./BrowserClient";
import { mapLoadProblem } from "./client-error";
import { handleCursor, handleLabel, rotateCursor } from "./edit-affordances";
import { drawsOnRelease, sceneGesture, startsDrag } from "./interaction-policy";
import {
  hitMapLabel,
  mapLabelLayout,
  type LabelRect,
} from "./map-label-layout";
import {
  raidCameraSubjects,
  raidMapFrame,
  easeMapCamera,
} from "./camera-model";
import { selectionMode, inSelectionBox } from "./selection-model";
import { annotationGeometry, visibleMarks, markHit } from "./annotation-model";
import {
  useEffect,
  useRef,
  useState,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  getLocalMaps,
  subscribeLocalMaps,
  mapAreaBounds,
  projectedFloor,
  localFloorHeight,
} from "./local-map";
import { combatStateAt, poseAt, raidByMap } from "./domain";
import type { Actor, Snapshot } from "./types";
import type { EditorController } from "./controller";
import {
  CLASS_CELLS,
  mapActorToken,
  fitMap,
  frameMapSelection,
  mapPoint,
  mapScreen,
  screenMap,
  worldPoint,
  zoomMap,
  type MapManifest,
  type MapCamera,
  type MapPoint,
} from "./map-model";
export function MapView({
  state: inputState,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  const state = useBufferedView(inputState);
  const host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const hoverGrip = useRef<{ id: string; index: number } | null>(null);
  const labelRects = useRef<(LabelRect & { id: string })[]>([]);
  const [editHover, setEditHover] = useState<{
    x: number;
    y: number;
    label: string;
  } | null>(null);
  const [selectionModifier, setSelectionModifier] = useState(false);
  const [manifest, setManifest] = useState<MapManifest | null>(null),
    [error, setError] = useState(""),
    [mapNote, setMapNote] = useState(""),
    [area, setArea] = useState("*"),
    [healthBars, setHealthBars] = useState(true);
  const [recoveryError, setRecoveryError] = useState("");
  const [recovering, setRecovering] = useState(false);
  const measured = useRef(false);
  const fitted = useRef<{ manifest: MapManifest; area: string } | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 }),
    [camera, setCamera] = useState<MapCamera>({ x: 0, y: 0, scale: 1 });
  const [art, setArt] = useState(0),
    [hover, setHover] = useState<{ actor: Actor; x: number; y: number } | null>(
      null,
    );
  const images = useRef(new Map<string, HTMLImageElement>()),
    drag = useRef<{
      x: number;
      y: number;
      camera: MapCamera;
      moved: boolean;
      mode:
        | "pan"
        | "draw"
        | "shape"
        | "place"
        | "box"
        | "mark"
        | "select"
        | "pending";
      intent?: "draw" | "transform";
      actor?: string | null;
      target?: string | null;
      handle?: number | null;
      point?: import("./types").Point;
      selection?: "replace" | "add" | "toggle";
    } | null>(null);
  const dots = useRef<
    {
      actor: Actor;
      point: MapPoint;
      radius: number;
      estimated: boolean;
      dead: boolean;
    }[]
  >([]);
  const imageLoader = useRef<MapViewImages | null>(null);
  if (!imageLoader.current)
    imageLoader.current = new MapViewImages(images.current);
  const lastDraw = useRef(0);
  const [boxRect, setBoxRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [pointer, setPointer] = useState("default");

  const marks = useMemo(
    () =>
      [
        ...controller.displayMarks().map((a) => controller.markGeometry(a)),
        ...controller.actorGizmo(),
      ].sort((a, b) => Number(a.selected) - Number(b.selected)),
    [
      state.plan,
      state.activeStep,
      state.showAllSteps,
      state.followSteps,
      state.selectedMarks,
      state.selectedActors,
      state.transform,
      state.transformActive,
      state.workspaceMode,
      state.compareRecorded,
      state.time,
      state.replay,
      controller,
    ],
  );
  useEffect(() => {
    const reset = (event: KeyboardEvent | Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape")
        return;
      drag.current = null;
      setBoxRect(null);
      setPointer("default");
      if (event.type === "blur") controller.cancelDrawing();
    };
    window.addEventListener("keydown", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", reset);
      window.removeEventListener("blur", reset);
    };
  }, [controller]);
  useEffect(() => {
    if (!state.frameRequest) return;
    const selectedMarks = controller
      .displayMarks()
      .filter(
        (a) =>
          state.workspaceMode === "plan" && state.selectedMarks.includes(a.id),
      );
    const planned =
      controller
        .snapshot()
        ?.actors.filter(
          (a) =>
            state.workspaceMode === "plan" &&
            state.selectedActors.includes(a.key),
        ) ?? [];
    const points: MapPoint[] = selectedMarks.flatMap((a) => {
      const geometry = annotationGeometry(a);
      return [geometry.anchor, ...geometry.paths.flat()].map((p) =>
        mapPoint(p[0], p[1]),
      );
    });
    for (const actor of planned)
      points.push(mapPoint(actor.position[0], actor.position[1]));
    if (!points.length) {
      const actor = state.replay?.actors.find((a) => a.key === state.selected);
      const pose = actor ? controller.actorPose(actor) : null;
      if (pose) points.push(mapPoint(pose.pos[0], pose.pos[1]));
    }
    const next = frameMapSelection(points, size.width, size.height);
    if (next) setCamera(next);
    else fit();
  }, [state.frameRequest]);
  const fitScale = useRef(1);
  const raid = raidByMap(state.plan.mapId);
  const localMaps = useSyncExternalStore(
    subscribeLocalMaps,
    getLocalMaps,
    () => undefined,
  );
  const localUiArt = useSyncExternalStore(
    subscribeLocalUiArt,
    getLocalUiArt,
    () => undefined,
  );
  const localIcons = useSyncExternalStore(
    subscribeLocalIcons,
    getLocalIcons,
    () => undefined,
  );
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      measured.current = true;
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setManifest(null);
    setError("");
    setMapNote("");
    setArea("*");
    setHover(null);
    if (state.browserAssets) {
      if (!localMaps || !raid) {
        setError(
          localMaps
            ? "Raid map unavailable"
            : "Select your local client to load the raid map",
        );
        return () => abort.abort();
      }
      const map = localMaps.load(
        state.plan.mapId,
        raid.directory,
        abort.signal,
      );
      map.ready
        .then(({ manifest, missingTiles }) => {
          if (abort.signal.aborted) return;
          setManifest(manifest);
          setMapNote(
            manifest.tiles.length
              ? missingTiles
                ? "Local minimap with floor geometry"
                : "Local minimap"
              : "Local floor geometry",
          );
        })
        .catch((error) => {
          if (!abort.signal.aborted) setError(error.message);
        });
      return () => {
        abort.abort();
        map.release();
      };
    }
    fetch(`/maps/${state.plan.mapId}.json`, { signal: abort.signal })
      .then((r) => {
        if (!r.ok)
          throw Error("Map artwork unavailable. Rebuild local map art.");
        return r.json();
      })
      .then((m) => {
        if (!abort.signal.aborted) setManifest(m);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [state.plan.mapId, state.browserAssets, localMaps]);
  useEffect(() => {
    if (state.ready) controller.requestMapPortraits();
  }, [state.replay, state.ready, controller]);
  const followGoal = useRef<MapCamera | null>(null);
  useEffect(() => {
    followGoal.current =
      state.options.followRaid && state.replay
        ? raidMapFrame(
            raidCameraSubjects(
              state.replay,
              state.time,
              state.options.smoothGaps,
            ),
            size.width,
            size.height,
          )
        : null;
  }, [
    state.options.followRaid,
    state.options.smoothGaps,
    state.replay,
    state.time,
    size,
  ]);
  useEffect(() => {
    if (!state.options.followRaid || !state.replay) return;
    let frame = 0,
      last = performance.now();
    const animate = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const goal = followGoal.current;
      if (goal && !drag.current)
        setCamera((old) => {
          if (
            Math.hypot(old.x - goal.x, old.y - goal.y) < 0.01 &&
            Math.abs(Math.log(old.scale / goal.scale)) < 0.001
          )
            return old;
          return easeMapCamera(old, goal, dt);
        });
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [state.options.followRaid, state.replay]);
  const tiles =
    manifest?.tiles.filter((t) => area === "*" || t.area === area) ?? [];
  const floorPaths = useMemo(() => {
    return (manifest?.floors ?? [])
      .map((floor) => {
        const { vertices, indices } = projectedFloor(floor);
        const path = new Path2D();
        for (let i = 0; i < indices.length; i += 3) {
          const a = vertices[indices[i]],
            b = vertices[indices[i + 1]],
            c = vertices[indices[i + 2]];
          path.moveTo(...a);
          path.lineTo(...b);
          path.lineTo(...c);
          path.closePath();
        }
        return {
          area: floor.area,
          path,
          height:
            manifest?.areas.find((area) => area.id === floor.area)?.height ?? 0,
        };
      })
      .sort((a, b) => a.height - b.height);
  }, [manifest]);
  const fit = () => {
    if (!manifest) return;
    const bounds = mapAreaBounds(manifest, area);
    const next = fitMap(bounds, size.width, size.height);
    fitScale.current = next.scale;
    setCamera(next);
  };
  useEffect(() => {
    if (!manifest || !measured.current || !size.width || !size.height) return;
    if (fitted.current?.manifest === manifest && fitted.current.area === area)
      return;
    fitted.current = { manifest, area };
    fit();
  }, [manifest, area, size.width, size.height]);
  useEffect(() => {
    const sources = new Set([
      "/game-ui/class-icons.png",
      "/game-ui/raid-icons.png",
      ...marks
        .filter((a) => !/^[1-8]$/.test(a.icon))
        .map((a) => `/game-ui/icons/${a.icon}.png`),
      ...(manifest?.tiles.map((t) => t.src) ?? []),
      ...(state.replay?.actors
        .filter((a) => a.type !== "Player")
        .flatMap((a) => [
          mapActorIconKey(a),
          ...(controller.portraitUrl(a) ? [controller.portraitUrl(a)!] : []),
        ]) ?? []),
    ]);
    imageLoader.current!.update(
      sources,
      { browser: state.browserAssets, art: localUiArt, icons: localIcons },
      () => setArt((n) => n + 1),
    );
  }, [
    manifest,
    state.replay,
    state.portraitVersion,
    state.browserAssets,
    controller,
    marks,
    localUiArt,
    localIcons,
  ]);
  useEffect(
    () => () => {
      imageLoader.current?.dispose();
    },
    [],
  );
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const dpr = window.devicePixelRatio || 1,
      width = Math.max(1, Math.round(size.width * dpr)),
      height = Math.max(1, Math.round(size.height * dpr));
    if (node.width !== width) node.width = width;
    if (node.height !== height) node.height = height;
    const ctx = node.getContext("2d");
    if (!ctx) return;
    // Match the previous resize reset, including clips, paths and styles, while
    // keeping unchanged backing dimensions. Retain the legacy path if needed.
    if (typeof ctx.reset === "function") ctx.reset();
    else node.width = width;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#13191c";
    ctx.fillRect(0, 0, size.width, size.height);
    const screen = (p: MapPoint) =>
      mapScreen(p, camera, size.width, size.height);
    ctx.strokeStyle = "#ffffff0b";
    ctx.lineWidth = 1;
    const a = screenMap([0, 0], camera, size.width, size.height),
      b = screenMap([size.width, size.height], camera, size.width, size.height);
    const step = 100;
    ctx.beginPath();
    for (let x = Math.floor(a[0] / step) * step; x < b[0]; x += step) {
      const p = screen([x, 0]);
      ctx.moveTo(p[0], 0);
      ctx.lineTo(p[0], size.height);
    }
    for (let y = Math.floor(a[1] / step) * step; y < b[1]; y += step) {
      const p = screen([0, y]);
      ctx.moveTo(0, p[1]);
      ctx.lineTo(size.width, p[1]);
    }
    ctx.stroke();
    // Geometry uses the same north-up projection as tiles and actor positions.
    // Build each group path once, then let the canvas transform pan and zoom it.
    ctx.save();
    ctx.translate(
      size.width / 2 - camera.x * camera.scale,
      size.height / 2 - camera.y * camera.scale,
    );
    ctx.scale(camera.scale, camera.scale);
    ctx.fillStyle = "#38484d";
    ctx.strokeStyle = "#6b848955";
    ctx.lineWidth = Math.min(0.8, 0.5 / camera.scale);
    for (const floor of floorPaths) {
      if (area !== "*" && floor.area !== area) continue;
      ctx.fill(floor.path);
      ctx.stroke(floor.path);
    }
    ctx.restore();
    for (const tile of tiles) {
      const image = images.current.get(tile.src);
      if (!image?.complete || !image.naturalWidth) continue;
      const points = tile.corners.map((p) => screen(mapPoint(...p))),
        [tl, tr, , bl] = points;
      if (
        points.every((p) => p[0] < 0) ||
        points.every((p) => p[0] > size.width) ||
        points.every((p) => p[1] < 0) ||
        points.every((p) => p[1] > size.height)
      )
        continue;
      ctx.save();
      ctx.transform(
        (tr[0] - tl[0]) / image.naturalWidth,
        (tr[1] - tl[1]) / image.naturalWidth,
        (bl[0] - tl[0]) / image.naturalHeight,
        (bl[1] - tl[1]) / image.naturalHeight,
        tl[0],
        tl[1],
      );
      ctx.drawImage(image, 0, 0);
      ctx.restore();
    }
    const raidIcons = images.current.get("/game-ui/raid-icons.png");
    const drawPath = (path: (typeof marks)[number]["paths"][number]) => {
      ctx.beginPath();
      path.forEach((p, i) => {
        const [x, y] = screen(mapPoint(p[0], p[1]));
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
    };
    for (const mark of marks) {
      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      if (mark.fill.length > 2 && mark.triangles.length) {
        drawPath([...mark.fill, mark.fill[0]]);
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = mark.color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      for (const path of mark.paths) {
        drawPath(path);
        ctx.strokeStyle = mark.selected ? "#fff4cd" : "#090c10cc";
        ctx.lineWidth = mark.width + (mark.selected ? 4 : 2);
        ctx.stroke();
        ctx.shadowColor = mark.color;
        ctx.shadowBlur = 5;
        ctx.strokeStyle = mark.color;
        ctx.lineWidth = mark.width;
        ctx.stroke();
        ctx.shadowBlur = 0;
        if (
          (mark.type === "route" || mark.type === "arrow") &&
          path === mark.paths[0]
        ) {
          ctx.setLineDash([5, 27]);
          ctx.lineDashOffset = -performance.now() * 0.018;
          ctx.strokeStyle = "#fff2ce99";
          ctx.lineWidth = Math.max(1, mark.width * 0.5);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      const [x, y] = screen(mapPoint(mark.anchor[0], mark.anchor[1]));
      if (mark.type === "marker") {
        const zoom = Math.max(
          0.75,
          Math.min(2, Math.sqrt(camera.scale / fitScale.current)),
        );
        const size = Math.max(20, Math.min(40, 20 + mark.size)) * zoom;
        ctx.shadowColor = mark.color;
        ctx.shadowBlur = 8;
        ctx.strokeStyle = mark.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(
          x,
          y + size * 0.42,
          size * 0.6,
          size * 0.22,
          0,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
        ctx.shadowColor = "#000";
        ctx.shadowBlur = 6;
        if (
          /^[1-8]$/.test(mark.icon) &&
          raidIcons?.complete &&
          raidIcons.naturalWidth
        ) {
          const i = Number(mark.icon) - 1,
            cell = raidIcons.naturalWidth / 4;
          ctx.drawImage(
            raidIcons,
            (i % 4) * cell,
            Math.floor(i / 4) * cell,
            cell,
            cell,
            x - size / 2,
            y - size / 2,
            size,
            size,
          );
        } else {
          const image = images.current.get(`/game-ui/icons/${mark.icon}.png`);
          if (image?.complete && image.naturalWidth)
            ctx.drawImage(image, x - size / 2, y - size / 2, size, size);
        }
        ctx.shadowBlur = 0;
        if (mark.selected) {
          ctx.strokeStyle = "#fff0be";
          ctx.lineWidth = 2;
          ctx.strokeRect(
            x - size / 2 - 3,
            y - size / 2 - 3,
            size + 6,
            size + 6,
          );
        }
      }

      ctx.restore();
    }
    for (const circle of controller.rangeCheckCircles()) {
      const [x, y] = screen(mapPoint(circle.position[0], circle.position[1]));
      const edge = screen(
        mapPoint(circle.position[0] + circle.radius, circle.position[1]),
      );
      const radius = Math.hypot(edge[0] - x, edge[1] - y);
      ctx.save();
      ctx.strokeStyle = RANGE_COLORS[circle.status];
      ctx.fillStyle = `${RANGE_COLORS[circle.status]}0a`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    dots.current = [];
    const labels = mapLabelLayout(size.width, size.height);
    labelRects.current = [];
    labels.block({ x: size.width - 220, y: 0, width: 220, height: 48 });
    for (const mark of marks.filter((m) => m.selected))
      for (const p of mark.handles) {
        const [x, y] = screen(mapPoint(p[0], p[1]));
        labels.block({ x: x - 9, y: y - 9, width: 18, height: 18 });
      }
    const actors = state.options.actors ? controller.sceneActors() : [];
    const ordered = [...actors].sort((a, b) => {
      const rank = (a: Actor) =>
        a.key === state.selected
          ? 4
          : mapActorToken(a).boss
            ? 3
            : a.type === "Player"
              ? 2
              : 1;
      return rank(a) - rank(b);
    });
    const atlas = images.current.get("/game-ui/class-icons.png");
    for (const actor of ordered) {
      const pose = controller.actorPose(actor);
      if (!pose || (pose.dead && actor.type !== "Player")) continue;
      const token = mapActorToken(actor, camera.scale / fitScale.current),
        r = token.radius;
      const [x, y] = screen(mapPoint(pose.pos[0], pose.pos[1]));
      if (x < -r || y < -r || x > size.width + r || y > size.height + r)
        continue;
      dots.current.push({
        actor,
        radius: r + 3,
        point: [x, y],
        estimated: pose.estimated,
        dead: pose.dead,
      });
      labels.block({
        x: x - r - 4,
        y: y - r - 4,
        width: 2 * r + 8,
        height: 2 * r + 22,
      });
      ctx.save();
      ctx.globalAlpha = pose.dead ? 0.45 : pose.estimated ? 0.65 : 1;
      if (state.selectedActors.includes(actor.key)) {
        ctx.strokeStyle = "#ffe09a";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
      const cell = CLASS_CELLS[actor.class];
      if (
        actor.type === "Player" &&
        cell &&
        atlas?.complete &&
        atlas.naturalWidth
      ) {
        const w = atlas.naturalWidth / 4,
          h = atlas.naturalHeight / 4;
        ctx.drawImage(
          atlas,
          cell[0] * w,
          cell[1] * h,
          w,
          h,
          x - r,
          y - r,
          r * 2,
          r * 2,
        );
      } else {
        const portrait = images.current.get(
            controller.portraitUrl(actor) ?? "",
          ),
          fallback = images.current.get(mapActorIconKey(actor));
        const image =
          portrait?.complete && portrait.naturalWidth
            ? portrait
            : fallback?.complete && fallback.naturalWidth
              ? fallback
              : null;
        ctx.fillStyle = "#171b1f";
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (image) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(x, y, r - 1, 0, Math.PI * 2);
          ctx.clip();
          const side = Math.min(image.naturalWidth, image.naturalHeight);
          ctx.drawImage(
            image,
            (image.naturalWidth - side) / 2,
            (image.naturalHeight - side) / 2,
            side,
            side,
            x - r,
            y - r,
            r * 2,
            r * 2,
          );
          ctx.restore();
        } else {
          ctx.fillStyle = "#dcc6a3";
          ctx.font = `${r}px sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText(token.boss ? "☠" : "◆", x, y + r * 0.35);
        }
        ctx.strokeStyle = token.boss
          ? "#c7a05d"
          : actor.type === "Pet"
            ? "#9cafbd"
            : "#a46c55";
        ctx.lineWidth = token.boss ? 2 : 1;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
        if (healthBars) {
          const health = combatStateAt(actor, state.time).health,
            w = r * 2 + 4,
            h = (token.boss ? 5 : 3) * token.factor,
            top = y + r + 4;
          ctx.fillStyle = "#080b0fec";
          ctx.fillRect(x - w / 2 - 1, top - 1, w + 2, h + 2);
          if (health) {
            ctx.fillStyle =
              health.percent > 0.5
                ? "#68b859"
                : health.percent > 0.2
                  ? "#d6ab49"
                  : "#d75e4f";
            ctx.fillRect(x - w / 2, top, w * health.percent, h);
          } else {
            ctx.fillStyle = "#59616a";
            ctx.fillRect(x - w / 2, top, w, h);
          }
        }
      }
      if (actor.key === state.selected || pose.estimated) {
        ctx.strokeStyle = actor.key === state.selected ? "#ffe09a" : "#c1d8e2";
        ctx.lineWidth = 2;
        if (pose.estimated) ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(x, y, r + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    for (const mark of [...marks].sort(
      (a, b) => Number(b.selected) - Number(a.selected),
    )) {
      const [x, y] = screen(mapPoint(mark.anchor[0], mark.anchor[1]));
      if (mark.label) {
        ctx.font = "13px Friz,serif";
        ctx.textAlign = "left";
        const label = mark.label,
          w = Math.min(250, ctx.measureText(label).width + 12),
          top =
            y +
            (mark.type === "marker"
              ? 18
              : mark.type === "circle"
                ? -mark.size * camera.scale - 26
                : -24);
        const box = labels.place(
          { x: x - w / 2, y: top, width: w, height: 21 },
          mark.selected || mark.type === "label",
          [x, y],
        );
        if (!box) continue;
        labelRects.current.push({ ...box, id: mark.id });
        if (Math.abs(box.x - (x - w / 2)) > 8 || Math.abs(box.y - top) > 8) {
          ctx.strokeStyle = "#c2b69088";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(box.x + box.width / 2, box.y + box.height / 2);
          ctx.stroke();
        }
        ctx.fillStyle = "#101419e8";
        ctx.fillRect(box.x, box.y, box.width, 21);
        ctx.fillStyle = mark.color;
        ctx.fillRect(box.x, box.y, 2, 21);
        ctx.fillStyle = "#f0e8d6";
        ctx.fillText(label, box.x + 6, box.y + 15, box.width - 12);
      }
    }
    for (const mark of marks) {
      if (mark.selected && !mark.locked)
        for (const [index, point] of mark.handles.entries()) {
          const [x, y] = screen(mapPoint(point[0], point[1])),
            hx = Math.round(x),
            hy = Math.round(y),
            kind = mark.handleKinds?.[index] ?? "point";
          const active =
            hoverGrip.current?.id === mark.id &&
            hoverGrip.current.index === index;
          const size =
              (kind === "move" || kind === "rotate" ? 10 : 8) +
              (active ? 2 : 0),
            accent = kind === "rotate" ? "#9cd6f2" : "#ffd46b";
          ctx.save();
          ctx.translate(hx, hy);
          if (kind === "move") ctx.rotate(Math.PI / 4);
          ctx.beginPath();
          if (kind === "rotate" || kind === "point")
            ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
          else ctx.rect(-size / 2, -size / 2, size, size);
          if (active) {
            ctx.shadowColor = accent;
            ctx.shadowBlur = 5;
          }
          ctx.fillStyle = active
            ? accent
            : kind === "move" || kind === "rotate"
              ? "#242e33"
              : "#f5e8c4";
          ctx.strokeStyle =
            kind === "move" || kind === "rotate"
              ? active
                ? "#fff2cc"
                : accent
              : "#1f2629";
          ctx.lineWidth = 1.5;
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
    }
    ctx.fillStyle = "#c9bb94";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("N ↑", size.width - 12, 20);
  }, [state, camera, size, manifest, area, art, healthBars, controller, marks]);
  const pixel = (e: { clientX: number; clientY: number }): MapPoint => {
    const r = host.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const place = (p: MapPoint, constrain = false, preview = false) => {
    const [x, y] = worldPoint(...screenMap(p, camera, size.width, size.height));
    const hint =
      drag.current?.point?.[2] ??
      manifest?.areas.find((a) => a.id === area)?.height ??
      raid?.spawn[2] ??
      0;
    const floor = manifest
      ? localFloorHeight(manifest, x, y, area, hint)
      : undefined;
    // Extracted floor triangles are available even outside the 3D camera's loaded cells.
    controller.pickMap(
      x,
      y,
      floor ?? hint,
      constrain,
      preview,
      floor !== undefined,
    );
  };
  const hitMark = (p: MapPoint) =>
    marks.find((m) => m.id === hitMapLabel(labelRects.current, p)) ??
    [...marks]
      .reverse()
      .find((m) =>
        markHit(m, p, (q) =>
          mapScreen(mapPoint(q[0], q[1]), camera, size.width, size.height),
        ),
      );
  const screenPoint = (p: import("./types").Point) =>
    mapScreen(mapPoint(p[0], p[1]), camera, size.width, size.height);
  const handleAt = (p: MapPoint) =>
    marks
      .filter((m) => m.selected && !m.locked)
      .flatMap((m) =>
        m.handles.map((point, index) => ({
          mark: m,
          index,
          screen: screenPoint(point),
        })),
      )
      .find((h) => Math.hypot(h.screen[0] - p[0], h.screen[1] - p[1]) <= 12);
  const actorAt = (p: MapPoint) =>
    state.selectionFilter !== "actors" && hitMapLabel(labelRects.current, p)
      ? undefined
      : [...dots.current]
          .reverse()
          .find(
            (d) => Math.hypot(d.point[0] - p[0], d.point[1] - p[1]) < d.radius,
          );
  const selectAt = (p: MapPoint, toggle = false) => {
    const handle = handleAt(p);
    const actor = state.selectionFilter !== "drawings" ? actorAt(p) : null;
    const mark =
      handle?.mark ??
      (actor ? null : state.selectionFilter !== "actors" ? hitMark(p) : null);
    if (mark?.id.startsWith("actor-gizmo:")) {
      controller.selectActor(mark.id.slice(12), toggle);
      return;
    }
    if (mark) {
      controller.selectMark(mark.id, toggle ? "toggle" : "replace");
      return;
    }
    if (actor) {
      controller.selectActor(actor.actor.key, toggle);
      return;
    }
    if (!toggle) {
      controller.selectMark(null);
      controller.clearActorSelection();
      controller.select(null);
    }
  };
  const hoverHealth = hover
    ? combatStateAt(hover.actor, state.time).health
    : null;
  const hoverDead =
    hover?.actor.deaths.filter(([t]) => t <= state.time).at(-1)?.[1] ?? false;
  return (
    <div className="tactical-map" ref={host}>
      {boxRect && <div className="selection-box" style={boxRect} />}
      <canvas
        ref={canvas}
        aria-label={`${raid?.name ?? "Raid"} tactical map`}
        tabIndex={0}
        style={{
          cursor:
            pointer === "grabbing"
              ? "grabbing"
              : selectionModifier
                ? "default"
                : pointer === "rotate"
                  ? rotateCursor
                  : [
                        "grabbing",
                        "move",
                        "ew-resize",
                        "nwse-resize",
                        "ns-resize",
                        "nesw-resize",
                      ].includes(pointer)
                    ? pointer
                    : !selectionModifier &&
                        state.workspaceMode === "plan" &&
                        !["explore", "move"].includes(state.tool)
                      ? "crosshair"
                      : pointer,
        }}
        onKeyDown={(e) =>
          setSelectionModifier(e.shiftKey || e.ctrlKey || e.metaKey)
        }
        onKeyUp={(e) =>
          setSelectionModifier(e.shiftKey || e.ctrlKey || e.metaKey)
        }
        onContextMenu={(e) => e.preventDefault()}
        onWheel={(e) => {
          e.preventDefault();
          setHover(null);
          controller.setOption("followRaid", false);
          setCamera((old) =>
            zoomMap(
              old,
              pixel(e),
              e.deltaY > 0 ? 0.8 : 1.25,
              size.width,
              size.height,
            ),
          );
        }}
        onPointerDown={(e) => {
          if (![0, 1, 2].includes(e.button)) return;
          e.currentTarget.focus({ preventScroll: true });
          controller.setSceneFocused(true);
          const p = pixel(e),
            h = handleAt(p),
            actor = actorAt(p),
            mark = h?.mark ?? (!actor ? hitMark(p) : null);
          const actorSelected =
            state.tool === "explore" &&
            actor &&
            (state.selected === actor.actor.key ||
              state.selectedActors.includes(actor.actor.key));
          const target =
            mark?.id ??
            (actorSelected ? `actor-gizmo:${actor!.actor.key}` : null);
          const canTransform =
            !state.compareRecorded &&
            !state.drawing &&
            (!!target?.startsWith("actor-gizmo:") ||
              (state.workspaceMode === "plan" &&
                (!!h ||
                  (state.tool === "explore" &&
                    !!mark?.selected &&
                    !mark.locked &&
                    !mark.actor))));
          const gesture = sceneGesture(
            e.button,
            e.shiftKey || e.ctrlKey || e.metaKey,
            state.tool,
            canTransform,
          );
          const base = {
            x: p[0],
            y: p[1],
            camera,
            moved: false,
            selection: selectionMode(e),
          };
          if (gesture === "camera" || gesture === "pan") {
            drag.current = { ...base, mode: "pan" };
            setPointer("grabbing");
            controller.setOption("followRaid", false);
          } else if (gesture === "draw" || gesture === "transform") {
            const [x, y] = worldPoint(
              ...screenMap(p, camera, size.width, size.height),
            );
            drag.current = {
              ...base,
              mode: "pending",
              intent: gesture,
              actor:
                controller.selectedActorForDrawing() ??
                actor?.actor.key ??
                null,
              target,
              handle: h?.index ?? null,
              point: [
                x,
                y,
                mark?.anchor[2] ??
                  (actor
                    ? controller.actorPose(actor.actor)?.pos[2]
                    : undefined) ??
                  0,
              ],
            };
          } else {
            if (state.drawing) controller.finishDrawing();
            drag.current = { ...base, mode: "box" };
          }
          e.currentTarget.setPointerCapture(e.pointerId);
          setHover(null);
          setEditHover(null);
        }}
        onPointerMove={(e) => {
          setSelectionModifier(e.shiftKey || e.ctrlKey || e.metaKey);
          const p = pixel(e),
            d = drag.current;
          if (
            !d &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            state.drawing &&
            ["circle", "cone", "arrow", "route", "polygon"].includes(
              state.tool,
            ) &&
            performance.now() - lastDraw.current > 25
          ) {
            lastDraw.current = performance.now();
            place(p, e.shiftKey, true);
          }

          if (d) {
            if (
              d.mode === "pending" &&
              d.intent === "draw" &&
              ["route", "polygon"].includes(state.tool)
            )
              return;
            if (startsDrag([d.x, d.y], p)) d.moved = true;
            if (d.mode === "pending") {
              if (!d.moved) return;
              if (d.intent === "transform") {
                if (!d.target || !d.point) return;
                const axis =
                  state.transform === "move"
                    ? d.handle === 1
                      ? 0
                      : d.handle === 2
                        ? 1
                        : undefined
                    : undefined;
                const begun = d.target.startsWith("actor-gizmo:")
                  ? controller.beginActorDrag(
                      d.target.slice(12),
                      d.point,
                      false,
                      axis,
                    )
                  : controller.beginMarkDrag(
                      d.target,
                      d.handle ?? null,
                      d.point,
                    );
                if (!begun) {
                  drag.current = null;
                  return;
                }
                d.mode = "mark";
                place(p, e.shiftKey);
                lastDraw.current = performance.now();
                return;
              }
              if (["marker", "label"].includes(state.tool)) return;
              d.mode = ["circle", "cone", "arrow"].includes(state.tool)
                ? "shape"
                : "draw";
              if (!d.actor || !controller.startActorDrawing(d.actor))
                place([d.x, d.y]);
              place(p, e.shiftKey, d.mode === "shape");
              lastDraw.current = performance.now();
              return;
            }
            if (
              d.mode === "shape" &&
              d.moved &&
              performance.now() - lastDraw.current > 25
            ) {
              lastDraw.current = performance.now();
              place(p, e.shiftKey, true);
              return;
            }
            if (d.mode === "box") {
              setBoxRect({
                left: Math.min(d.x, p[0]),
                top: Math.min(d.y, p[1]),
                width: Math.abs(d.x - p[0]),
                height: Math.abs(d.y - p[1]),
              });
              return;
            }
            if (
              d.mode === "mark" &&
              d.moved &&
              performance.now() - lastDraw.current > 40
            ) {
              lastDraw.current = performance.now();
              place(p, e.shiftKey);
              return;
            }
            if (
              d.mode === "draw" &&
              performance.now() - lastDraw.current > 40
            ) {
              lastDraw.current = performance.now();
              place(p);
            }
            if (d.moved && d.mode === "pan") {
              if (state.options.followRaid)
                controller.setOption("followRaid", false);
              setCamera({
                ...d.camera,
                x: d.camera.x - (p[0] - d.x) / d.camera.scale,
                y: d.camera.y - (p[1] - d.y) / d.camera.scale,
              });
            }
            return;
          }
          const handle = handleAt(p),
            actor = actorAt(p),
            mark = handle?.mark ?? (!actor ? hitMark(p) : null);
          const kind = handle
            ? controller.handleKind(handle.mark.id, handle.index)
            : "move";
          const [ax, ay] = handle
            ? screenPoint(handle.mark.anchor)
            : [p[0] - 1, p[1] - 1];
          const movableActor =
            actor &&
            state.tool === "explore" &&
            (state.selected === actor.actor.key ||
              state.selectedActors.includes(actor.actor.key));
          const editable =
            !state.compareRecorded &&
            !state.drawing &&
            (!!movableActor ||
              !!handle ||
              (!!mark?.selected &&
                !mark.locked &&
                !mark.actor &&
                state.tool === "explore"));
          setPointer(
            editable
              ? handleCursor(kind, p[0] - ax, p[1] - ay)
              : mark
                ? "pointer"
                : "default",
          );
          hoverGrip.current =
            editable && handle
              ? { id: handle.mark.id, index: handle.index }
              : null;
          setEditHover(
            editable ? { x: p[0], y: p[1], label: handleLabel(kind) } : null,
          );

          const found = [...dots.current]
            .reverse()
            .find(
              (dot) =>
                Math.hypot(dot.point[0] - p[0], dot.point[1] - p[1]) <
                dot.radius,
            );
          setHover(found ? { actor: found.actor, x: p[0], y: p[1] } : null);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
          setPointer("default");
          if (!d || e.button !== 0) return;
          const p = pixel(e);
          setBoxRect(null);
          if (d.mode === "pending") {
            if (
              d.intent === "draw" &&
              ["route", "polygon"].includes(state.tool)
            ) {
              if (
                state.drawing ||
                !d.actor ||
                !controller.startActorDrawing(d.actor)
              )
                place(p);
              return;
            }
            const moved = d.moved || startsDrag([d.x, d.y], p);
            if (d.intent === "draw" && drawsOnRelease(state.tool, moved)) {
              const drop = ["marker", "label"].includes(state.tool);
              const actor =
                state.tool === "marker"
                  ? (controller.selectedActorForDrawing() ??
                    actorAt(p)?.actor.key)
                  : d.actor;
              if (!actor || !controller.startActorDrawing(actor))
                place(drop ? p : [d.x, d.y]);
              if (!drop) place(p);
              controller.finishDrawing();
            } else selectAt(p, e.shiftKey || e.ctrlKey || e.metaKey);
            return;
          }
          if (d.mode === "select") return;
          if (d.mode === "mark") {
            if (d.moved) place(p, e.shiftKey);
            controller.finishDrawing();
            return;
          }
          if (d.mode === "box") {
            if (d.moved) {
              if (state.selectionFilter !== "actors")
                controller.selectMarks(
                  marks
                    .filter((m) =>
                      inSelectionBox(m, [d.x, d.y], p, screenPoint),
                    )
                    .map((m) => m.id),
                  d.selection,
                );
              if (state.selectionFilter !== "drawings")
                controller.selectActors(
                  dots.current
                    .filter(
                      (dot) =>
                        dot.point[0] >= Math.min(d.x, p[0]) &&
                        dot.point[0] <= Math.max(d.x, p[0]) &&
                        dot.point[1] >= Math.min(d.y, p[1]) &&
                        dot.point[1] <= Math.max(d.y, p[1]),
                    )
                    .map((dot) => dot.actor.key),
                  d.selection,
                );
            } else selectAt(p, e.shiftKey || e.ctrlKey || e.metaKey);
            return;
          }
          if (d.mode === "draw") {
            place(p);
            controller.finishDrawing();
            return;
          }
          if (d.mode === "shape") {
            if (d.moved) {
              place(p);
              controller.finishDrawing();
            }
            return;
          }
          if (d.mode === "pan") return;
          if (state.tool === "explore") {
            const mark = hitMark(p);
            if (mark) {
              controller.selectMark(
                mark.id,
                e.shiftKey ? "toggle" : selectionMode(e),
              );
              return;
            }
            const found = [...dots.current]
              .reverse()
              .find(
                (dot) =>
                  Math.hypot(dot.point[0] - p[0], dot.point[1] - p[1]) <
                  dot.radius,
              );
            controller.select(found?.actor.key ?? null);
          } else {
            place(p);
          }
        }}
        onDoubleClick={() => {
          if (state.tool === "route" || state.tool === "polygon")
            controller.finishDrawing();
        }}
        onPointerCancel={() => {
          if (["draw", "shape", "mark"].includes(drag.current?.mode ?? ""))
            controller.cancelDrawing();
          setBoxRect(null);
          setPointer("default");
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          if (["draw", "shape", "mark"].includes(drag.current?.mode ?? ""))
            controller.cancelDrawing();
          drag.current = null;
          setBoxRect(null);
          setPointer("default");
        }}
        onPointerLeave={() => {
          setHover(null);
          setSelectionModifier(false);
          setEditHover(null);
          if (!drag.current) hoverGrip.current = null;
        }}
      />
      {editHover && !selectionModifier && (
        <div
          className="scene-grip-hint"
          style={{ left: editHover.x + 16, top: editHover.y + 16 }}
        >
          {editHover.label} · drag
        </div>
      )}
      <div className="map-controls">
        {mapNote && (
          <span title="Read from the selected local client">{mapNote}</span>
        )}
        <button
          onClick={() => {
            controller.setOption("followRaid", false);
            fit();
          }}
        >
          Fit
        </button>
        <button
          aria-pressed={healthBars}
          onClick={() => setHealthBars((v) => !v)}
        >
          Health bars
        </button>
        <select
          aria-label="Map area"
          value={area}
          onChange={(e) => setArea(e.target.value)}
        >
          <option value="*">All areas</option>
          {manifest?.areas.map((a, i) => (
            <option key={a.id} value={a.id}>
              {a.name} · {i + 1}
            </option>
          ))}
        </select>
      </div>
      {!manifest &&
        (state.browserAssets && state.clientStatus !== "ready" ? (
          <BrowserClient state={state} controller={controller} />
        ) : error ? (
          <section className="map-message map-error" role="alert">
            <h2>{mapLoadProblem(error).title}</h2>
            <p>{mapLoadProblem(error).message}</p>
            <div className="map-recovery-actions">
              <button
                className="gold-button"
                disabled={recovering}
                onClick={async () => {
                  setRecovering(true);
                  setRecoveryError("");
                  await controller.saveProject();
                  const current = controller.getSnapshot();
                  if (current.saveStatus === "saved" && !current.dirty)
                    location.reload();
                  else {
                    setRecoveryError(
                      "Your edits could not be saved. Export a backup before reloading.",
                    );
                    setRecovering(false);
                  }
                }}
              >
                {recovering ? "Saving edits…" : "Reload client"}
              </button>
              {state.projectId && (
                <button
                  onClick={() =>
                    void controller.exportProject(state.projectId!)
                  }
                >
                  Export backup
                </button>
              )}
            </div>
            {recoveryError && <p role="status">{recoveryError}</p>}
            <details>
              <summary>Technical details</summary>
              <pre>{error}</pre>
            </details>
          </section>
        ) : (
          <div className="map-message" role="status">
            Loading map…
          </div>
        ))}
      {hover && (
        <div
          className="map-unit-tooltip"
          style={{
            left: Math.min(hover.x + 14, size.width - 190),
            top: Math.max(40, hover.y - 35),
          }}
        >
          <strong>
            {hover.actor.name}
            {mapActorToken(hover.actor).boss ? " · Boss" : ""}
          </strong>
          <span>
            {hover.actor.class ?? hover.actor.type} ·{" "}
            {hoverDead
              ? "Dead"
              : hoverHealth
                ? `${Math.round(hoverHealth.percent * 100)}% HP${hoverHealth.initial ? " · starting health" : ""}`
                : "HP not recorded"}
          </span>
        </div>
      )}
    </div>
  );
}
