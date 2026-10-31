const paths: Record<string, string> = {
  settings:
    "M9 3h6l1 4 4 1v6l-4 1-1 5H9l-1-5-4-1V8l4-1zM9 11a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
  back: "M20 12H4m7-7-7 7 7 7",
  play: "m8 4 12 8-12 8z",
  pause: "M8 5v14M16 5v14",
  previous: "M5 5v14M19 5 7 12l12 7z",
  next: "M19 5v14M5 5l12 7-12 7z",
  up: "m6 15 6-6 6 6",
  down: "m6 9 6 6 6-6",
  right: "M4 12h16M14 6l6 6-6 6",
  grip: "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01",
  more: "M12 5h.01M12 12h.01M12 19h.01",
  close: "m6 6 12 12M6 18 18 6",
  minus: "M5 12h14",
  creature:
    "M7 12c-4-6 1-10 3-3M14 9c2-7 7-3 3 3M7 16c0-5 10-5 10 0 0 6-4 2-5 2s-5 4-5-2",
  skull:
    "M7 16H5v-6a7 7 0 0 1 14 0v6h-2v5H7zM9 18v3M15 18v3M8 10h2v2H8zM14 10h2v2h-2z",
  guild: "M12 3 3 6v6c0 5 9 9 9 9s9-4 9-9V6zM8 10h8M12 7v9",
  refresh: "M20 8a8 8 0 1 0 0 8M20 3v6h-6",
  search: "m21 21-6-6M17 10a7 7 0 1 1-14 0a7 7 0 1 1 14 0",
  logs: "M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6",
  plus: "M12 4v16M4 12h16",
  copy: "M8 8h13v13H8zM16 8V3H3v13h5",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  upload: "M12 16V3M7 8l5-5 5 5M3 15v6h18v-6",
  download: "M12 3v13M7 11l5 5 5-5M3 15v6h18v-6",
  device: "M3 4h18v13H3zM8 21h8M12 17v4",
  undo: "M3 10h11a6 6 0 0 1 0 12M3 10l6-6M3 10l6 6",
  check: "m4 12 5 5L21 5",
  snap: "M4 3v8a8 8 0 0 0 16 0V3h-5v8a3 3 0 0 1-6 0V3z",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
  lock: "M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4",

  move: "M12 2v20M2 12h20M8 6l4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4",
  rotate: "M20 7a9 9 0 1 0 1 9M20 2v6h-6",
  scale: "M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6M3 3l6 6M21 21l-6-6",
  pan: "M8 12V6a2 2 0 0 1 4 0v5M12 11V4a2 2 0 0 1 4 0v8M16 12V7a2 2 0 0 1 4 0v9l-4 6H8l-5-8a2 2 0 0 1 3-2l2 2",
  orbit: "M4 12c0-9 16-9 16 0s-16 9-16 0M12 3c-6 0-6 18 0 18s6-18 0-18M2 12h20",
  actors: "M8 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4 21a8 8 0 0 1 16 0",

  plan: "M5 3h14v18H5zM8 7h8M8 12h8M8 17h5",
  arrow: "M3 21 21 3M10 3h11v11",
  circle: "M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0",
  cone: "m3 21 5-18a19 19 0 0 1 13 13z",
  polygon: "M4 5 18 3 22 15 10 21 2 14z",
  drawing: "M3 20c12-20 0-20 2-6s8-12 10-10-5 16 6 8",
  label: "M4 4h16M12 4v17M8 21h8",
  pointer: "m4 3 15 9-7 1-3 7z",
  pin: "M12 21v-7M8 3h8l-1 5 3 4H6l3-4z",
  route: "M5 5h9a4 4 0 0 1 0 8H9a4 4 0 0 0 0 8h10M3 3h4v4H3zM17 19h4v4h-4z",
  chart: "M3 3v18h18M7 17v-5M12 17V8M17 17V5",
  heal: "M3 3v18h18M7 13h4V9h4v4h4v4h-4v4h-4v-4H7z",
  timeline: "M3 5h18M3 12h18M3 19h18M7 3v4M13 10v4M17 17v4",
  table: "M3 4h18v16H3zM3 9h18M9 4v16M15 4v16",
  resource: "M3 5h18v5H3zM3 14h18v5H3zM3 5h12v5M3 14h7v5",
  events: "M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1",
  person: "M8 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4 21a8 8 0 0 1 16 0",
  inspect: "m8 3-5 3 3 5 2-1v11h8V10l2 1 3-5-5-3c0 4-8 4-8 0z",
  sword: "m4 20 12-12 4-5-5 4L3 19M3 14l7 7M3 21l-1 1",
  camera: "M3 7h13v12H3zM16 11l5-3v10l-5-3",
  home: "m3 11 9-8 9 8M6 10v11h12V10",
  raid: "M3 5h5v5H3zM10 5h5v5h-5zM17 5h5v5h-5zM3 13h5v5H3zM10 13h5v5h-5zM17 13h5v5h-5z",
  focus: "M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 12h8M12 8v8",
};
export function EditorIcon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "grip" || name === "more" ? "2.8" : "1.6"}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.table} />
    </svg>
  );
}
