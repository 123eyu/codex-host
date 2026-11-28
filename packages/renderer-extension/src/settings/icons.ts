import type { IconNode } from "lucide";
import createElement from "lucide/dist/esm/createElement.mjs";
import Smartphone from "lucide/dist/esm/icons/smartphone.mjs";
import Boxes from "lucide/dist/esm/icons/boxes.mjs";
import CalendarClock from "lucide/dist/esm/icons/calendar-clock.mjs";
import ChartColumn from "lucide/dist/esm/icons/chart-column.mjs";
import CheckMark from "lucide/dist/esm/icons/check.mjs";
import Check from "lucide/dist/esm/icons/circle-check.mjs";
import ChevronDown from "lucide/dist/esm/icons/chevron-down.mjs";
import ChevronLeft from "lucide/dist/esm/icons/chevron-left.mjs";
import ChevronRight from "lucide/dist/esm/icons/chevron-right.mjs";
import ChevronUp from "lucide/dist/esm/icons/chevron-up.mjs";
import CircleArrowUp from "lucide/dist/esm/icons/circle-arrow-up.mjs";
import CircleOff from "lucide/dist/esm/icons/circle-off.mjs";
import Copy from "lucide/dist/esm/icons/copy.mjs";
import Download from "lucide/dist/esm/icons/download.mjs";
import ExternalLink from "lucide/dist/esm/icons/external-link.mjs";
import Eye from "lucide/dist/esm/icons/eye.mjs";
import EyeOff from "lucide/dist/esm/icons/eye-off.mjs";
import Ellipsis from "lucide/dist/esm/icons/ellipsis.mjs";
import FileArchive from "lucide/dist/esm/icons/file-archive.mjs";
import FolderInput from "lucide/dist/esm/icons/folder-input.mjs";
import Globe from "lucide/dist/esm/icons/globe.mjs";
import GripVertical from "lucide/dist/esm/icons/grip-vertical.mjs";
import Info from "lucide/dist/esm/icons/info.mjs";
import Languages from "lucide/dist/esm/icons/languages.mjs";
import LayoutDashboard from "lucide/dist/esm/icons/layout-dashboard.mjs";
import LayoutGrid from "lucide/dist/esm/icons/layout-grid.mjs";
import Link from "lucide/dist/esm/icons/link.mjs";
import Network from "lucide/dist/esm/icons/network.mjs";
import Palette from "lucide/dist/esm/icons/palette.mjs";
import Play from "lucide/dist/esm/icons/play.mjs";
import Plug from "lucide/dist/esm/icons/plug.mjs";
import PlugZap from "lucide/dist/esm/icons/plug-zap.mjs";
import Puzzle from "lucide/dist/esm/icons/puzzle.mjs";
import RefreshCw from "lucide/dist/esm/icons/refresh-cw.mjs";
import RotateCcw from "lucide/dist/esm/icons/rotate-ccw.mjs";
import Route from "lucide/dist/esm/icons/route.mjs";
import Settings from "lucide/dist/esm/icons/settings.mjs";
import ShieldCheck from "lucide/dist/esm/icons/shield-check.mjs";
import SlidersHorizontal from "lucide/dist/esm/icons/sliders-horizontal.mjs";
import Sparkles from "lucide/dist/esm/icons/sparkles.mjs";
import Stethoscope from "lucide/dist/esm/icons/stethoscope.mjs";
import Star from "lucide/dist/esm/icons/star.mjs";
import TriangleAlert from "lucide/dist/esm/icons/triangle-alert.mjs";
import Ticket from "lucide/dist/esm/icons/ticket.mjs";
import Trash from "lucide/dist/esm/icons/trash-2.mjs";
import Terminal from "lucide/dist/esm/icons/terminal.mjs";
import ScrollText from "lucide/dist/esm/icons/scroll-text.mjs";
import Search from "lucide/dist/esm/icons/search.mjs";
import CircleHelp from "lucide/dist/esm/icons/circle-question-mark.mjs";
import Upload from "lucide/dist/esm/icons/upload.mjs";
import X from "lucide/dist/esm/icons/x.mjs";
import Users from "lucide/dist/esm/icons/users.mjs";
import Workflow from "lucide/dist/esm/icons/workflow.mjs";
import Plus from "lucide/dist/esm/icons/plus.mjs";
import Zap from "lucide/dist/esm/icons/zap.mjs";

export const RENDERER_SETTINGS_ICON_NAMES = [
  "settings",
  "close",
  "star",
  "github",
  "language",
  "connections",
  "delegation",
  "extensions",
  "accounts",
  "session-import",
  "add",
  "model-pool",
  "routes",
  "gateway",
  "mobile",
  "updates",
  "schedules",
  "about",
  "info",
  "external-link",
  "refresh",
  "eye",
  "eye-off",
  "unavailable",
  "alert",
  "arrow-up",
  "check",
  "check-mark",
  "diagnose",
  "copy",
  "download",
  "chevron-left",
  "chevron-right",
  "chevron-down",
  "chevron-up",
  "grip-vertical",
  "undo",
  "ticket",
  "trash",
  "terminal",
  "search",
  "help",
  "ellipsis",
  "dashboard",
  "logs",
  "play",
  "shield-check",
  "upload",
  "file-archive",
  "link",
  "globe",
  "palette",
  "layout-grid",
  "zap",
  "chart-column",
  "plug",
  "puzzle",
  "sliders",
  "sparkles",
  "category-appearance",
  "category-interface",
  "category-workflow",
  "category-analytics",
  "category-integrations",
  "category-tools",
] as const;

export type RendererSettingsIconName = (typeof RENDERER_SETTINGS_ICON_NAMES)[number];

const iconNodes = {
  settings: Settings,
  close: X,
  star: Star,
  github: [
    [
      "path",
      {
        fill: "currentColor",
        stroke: "none",
        d: "M12 .297C5.37.297 0 5.67 0 12.297c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.467-1.334-5.467-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23a11.5 11.5 0 0 1 3-.405c1.02.005 2.045.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
      },
    ],
  ],
  language: Languages,
  connections: PlugZap,
  delegation: Workflow,
  extensions: Puzzle,
  accounts: Users,
  "session-import": FolderInput,
  add: Plus,
  "model-pool": Boxes,
  routes: Route,
  gateway: Network,
  mobile: Smartphone,
  updates: CircleArrowUp,
  schedules: CalendarClock,
  about: Info,
  info: Info,
  "external-link": ExternalLink,
  refresh: RefreshCw,
  eye: Eye,
  "eye-off": EyeOff,
  unavailable: CircleOff,
  alert: TriangleAlert,
  "arrow-up": [
    ["polyline", { points: "17 11 12 6 7 11" }],
    ["line", { x1: "12", y1: "6", x2: "12", y2: "18" }],
  ],
  check: Check,
  "check-mark": CheckMark,
  diagnose: Stethoscope,
  copy: Copy,
  download: Download,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "chevron-down": ChevronDown,
  "chevron-up": ChevronUp,
  "grip-vertical": GripVertical,
  undo: RotateCcw,
  ticket: Ticket,
  trash: Trash,
  terminal: Terminal,
  search: Search,
  help: CircleHelp,
  ellipsis: Ellipsis,
  dashboard: LayoutDashboard,
  logs: ScrollText,
  play: Play,
  "shield-check": ShieldCheck,
  sliders: SlidersHorizontal,
  upload: Upload,
  "file-archive": FileArchive,
  link: Link,
  globe: Globe,
  palette: Palette,
  "layout-grid": LayoutGrid,
  zap: Zap,
  "chart-column": ChartColumn,
  plug: Plug,
  puzzle: Puzzle,
  sparkles: Sparkles,
  "category-appearance": [
    ["path", { d: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" }],
    ["path", { d: "M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" }],
  ],
  "category-interface": [
    ["rect", { x: "3.5", y: "4.5", width: "17", height: "15", rx: "3" }],
    ["line", { x1: "9.5", y1: "4.5", x2: "9.5", y2: "19.5" }],
  ],
  "category-workflow": [
    ["circle", { cx: "6.5", cy: "7", r: "2.5" }],
    ["circle", { cx: "17.5", cy: "7", r: "2.5" }],
    ["circle", { cx: "17.5", cy: "17", r: "2.5" }],
    ["path", { d: "M9 7h6" }],
    ["path", { d: "M6.5 9.5V13a4 4 0 0 0 4 4H15" }],
  ],
  "category-analytics": [
    ["line", { x1: "6.5", y1: "18.5", x2: "6.5", y2: "13" }],
    ["line", { x1: "12", y1: "18.5", x2: "12", y2: "6.5" }],
    ["line", { x1: "17.5", y1: "18.5", x2: "17.5", y2: "10.5" }],
    ["line", { x1: "4", y1: "18.5", x2: "20", y2: "18.5" }],
  ],
  "category-integrations": [
    ["path", { d: "M10 14a4.2 4.2 0 0 0 6 0l2.5-2.5a4.2 4.2 0 0 0-6-6L11 7" }],
    ["path", { d: "M14 10a4.2 4.2 0 0 0-6 0L5.5 12.5a4.2 4.2 0 0 0 6 6L13 17" }],
  ],
  "category-tools": [
    ["path", { d: "M12 3.5l7.5 4.25v8.5L12 20.5l-7.5-4.25v-8.5L12 3.5z" }],
    ["path", { d: "M12 12l7.5-4.25" }],
    ["path", { d: "M12 12v8.5" }],
    ["path", { d: "M12 12L4.5 7.75" }],
  ],
} satisfies Record<RendererSettingsIconName, IconNode>;

export function isRendererSettingsIconName(value: string): value is RendererSettingsIconName {
  return (RENDERER_SETTINGS_ICON_NAMES as readonly string[]).includes(value);
}

export function createRendererSettingsIcon(name: RendererSettingsIconName, size = 18): SVGElement {
  const icon = createElement(iconNodes[name], {
    width: size,
    height: size,
    "aria-hidden": "true",
    focusable: "false",
  });
  icon.classList.add("codexhost-settings-icon");
  return icon;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * Historical rail-v1 geometry in currentColor, with a lighter C ring.
 * The 40-unit viewBox gives a 1.6px ring at 20px and a 1.76px ring at the rail's 22px.
 */
export function createRendererSettingsBrandGlyph(size = 20): SVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "12.8 12.2 40 40");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("data-codexhost-mark", "ch-navigation");
  const ring = document.createElementNS(SVG_NAMESPACE, "path");
  ring.setAttribute("d", "M 44.55 23.97 A 14.35 14.35 0 1 0 44.55 40.43");
  ring.setAttribute("fill", "none");
  ring.setAttribute("stroke", "currentColor");
  ring.setAttribute("stroke-width", "3.2");
  ring.setAttribute("stroke-linecap", "round");
  const module = document.createElementNS(SVG_NAMESPACE, "rect");
  module.setAttribute("x", "27.6");
  module.setAttribute("y", "27");
  module.setAttribute("width", "10.4");
  module.setAttribute("height", "10.4");
  module.setAttribute("rx", "2.4");
  module.setAttribute("fill", "currentColor");
  module.setAttribute("stroke", "none");
  svg.append(ring, module);
  svg.classList.add("codexhost-settings-icon");
  return svg;
}
