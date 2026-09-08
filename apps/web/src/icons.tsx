import type { CSSProperties } from "react";

const paths: Record<string, string[]> = {
  speaker: ["M3 9h4l5-4v14l-5-4H3zM16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14"],
  play: ["m8 4 12 8-12 8V4Z"],
  pause: ["M8 5v14M16 5v14"],
  copy: ["M9 9h12v12H9zM15 9V3H3v12h6"],
  pin: ["m9 3 6 0-1 6 4 4v2H6v-2l4-4-1-6ZM12 15v7"],
  edit: ["m4 16 12-12 4 4-12 12-5 1 1-5ZM14 6l4 4"],
  archive: ["M3 3h18v5H3zM5 8v13h14V8M9 12h6"],
  trash: ["M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"],
  file: ["M6 2h8l4 4v16H6zM14 2v5h5M9 11h6M9 15h6"],
  search: ["M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM16 16l5 5"],
  "arrow-up": ["m6 10 6-6 6 6M12 4v16"],
  trackpad: ["M3 5h18v14H3zM3 15h18M12 15v4"],
  touch: ["M10 12V4a2 2 0 0 1 4 0v7l3-1 4 3-3 8H9l-5-7a2 2 0 0 1 3-2l3 3"],
  more: ["M5 12h.01M12 12h.01M19 12h.01"],
  minus: ["M5 12h14"],
  help: ["M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 4h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z"],
  menu: ["M4 6h16M4 12h16M4 18h16"],
  chat: [
    "M21 11.5a8.3 8.3 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.3 8.3 0 0 1-3.8-.9L3 21l1.9-5.7a8.3 8.3 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.3 8.3 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z",
  ],
  results: ["M7 3h10v18l-5-3-5 3V3Z"],
  "panel-right": ["M3 4h18v16H3zM15 4v16"],
  remote: ["M3 4h18v13H3zM8 21h8m-4-4v4"],
  plus: ["M12 5v14M5 12h14"],
  send: ["m5 12 7-7 7 7M12 5v15"],
  stop: ["M6 6h12v12H6z"],
  close: ["m6 6 12 12M6 18 18 6"],
  folder: ["M3 7V5h6l2 2h10v13H3V7Z"],
  chevron: ["m9 5 7 7-7 7"],
  back: ["m14 6-6 6 6 6"],
  settings: [
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
    "M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2",
  ],
  check: ["m5 12 4 4L19 6"],
  refresh: ["M20 7v5h-5M4 17v-5h5", "M6 7a7 7 0 0 1 11-1l3 6M4 12l3 6a7 7 0 0 0 11-1"],
  activity: ["m3 12 4-7 5 14 5-14 4 7"],
  image: ["M3 3h18v18H3zM3 16l5-5 4 4 3-3 6 6M15 7h.01"],
  keyboard: ["M2 5h20v14H2zM6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 15h10"],
  expand: ["M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"],
  logout: ["M9 5H4v14h5m5-14 5 7-5 7M9 12h10"],
  lock: ["M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4"],
  unlock: ["M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0"],
  pointer: ["m5 3 14 9-7 1-3 7-4-17Z"],
  moon: ["M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11Z"],
};
export function Icon({
  name,
  size = 20,
  style,
}: {
  name: string;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {(paths[name] ?? paths.chat ?? []).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
