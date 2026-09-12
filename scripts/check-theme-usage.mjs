import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const sourceRoot = new URL("../src", import.meta.url).pathname;
const sourceExtensions = new Set([".css", ".ts", ".tsx"]);
const allowedFixedColorFiles = new Set([
  "services/fileTypeService.tsx", // Official language and tool artwork.
  "components/nodes/sticky/StickyNode.tsx", // User-selectable sticky-note ink.
  "components/nodes/sticky/stickyColors.ts", // User-selectable sticky-note paper.
]);
const forbidden = [
  { pattern: /\bbg-black(?:\/\d+)?\b/, message: "use a semantic surface token" },
  { pattern: /\b(?:text|bg|border)-zinc-\d+\b/, message: "use foreground, surface, or border tokens" },
  { pattern: /\bprose-invert\b/, message: "Markdown appearance must follow the active theme" },
  { pattern: /highlight\.js\/styles\/[^\"']*dark/i, message: "use the tokenized highlight.js rules" },
];
const semanticCssModules = [
  /^App\.module\.css$/,
  /^components\/shell\/(?:AppBootstrapBoundary|AppShell|StartupDegradedBanner)\.module\.css$/,
  /^components\/workspace\/(?:MainWorkspace|TabStrip|TabOutlet)\.module\.css$/,
  /^components\/navigation\/NavigationRail\.module\.css$/,
  /^components\/drawer\/(?:ContextDrawer|DrawerSkeleton)\.module\.css$/,
  /^components\/(?:Header|TerminalPanel|LocalTerminal|SearchPalette|CustomSelect)\.module\.css$/,
  /^components\/settings\/.*\.module\.css$/,
  /^components\/tabs\/SettingsTab\.module\.css$/,
  /^components\/ui\/(?:Button|FormControls|NumberStepper|Modal|IconButton|Callout|Tooltip)\//,
  /^components\/ui\/(?:Chat|ChatInput|MarkdownRenderer|SubagentActivityPanel)\.module\.css$/,
  /^components\/ui\/DiffViewToggle\.module\.css$/,
  /^components\/nodes\/TaskNode\.module\.css$/,
  /^components\/nodes\/McpNode\.module\.css$/,
  /^components\/nodes\/boundary\/BoundaryNode\.module\.css$/,
  /^components\/(?:CreateDialog|MoveDialog|BranchDialog)\.module\.css$/,
  /^components\/permissions\/CommandPermissionDialog\.module\.css$/,
];
const semanticModuleForbidden = [
  {
    pattern: /var\(--(?:bg|text|accent|border)(?:-|_)/,
    message: "migrated CSS Modules must use the canonical --color-* contract",
  },
  {
    pattern: /(?:^|[^\w-])(?:#(?:[\da-f]{3,8})|rgba?\(|hsla?\()/i,
    message: "migrated CSS Modules must not contain raw colors",
  },
  {
    pattern: /font-size:\s*\d+(?:\.\d+)?px\b/,
    message: "migrated CSS Modules must use a typography role",
  },
];
const migratedJsxFiles = new Set([
  "App.tsx",
  "components/shell/AppBootstrapBoundary.view.tsx",
  "components/shell/StartupDegradedBanner.tsx",
  "components/shell/AppShell.view.tsx",
  "components/workspace/MainWorkspace.tsx",
  "components/workspace/TabOutlet.tsx",
  "components/workspace/TabStrip.view.tsx",
  "components/navigation/NavigationRail.view.tsx",
  "components/drawer/ContextDrawer.view.tsx",
  "components/drawer/DrawerSkeleton.tsx",
  "components/Header.view.tsx",
  "components/TerminalPanel.tsx",
  "components/LocalTerminal.tsx",
  "components/SearchPalette.view.tsx",
  "components/CustomSelect.view.tsx",
  "components/ui/DiffViewToggle.tsx",
  "components/ui/Tooltip/Tooltip.tsx",
  "components/nodes/TaskNode.tsx",
  "components/nodes/McpNode.tsx",
  "components/nodes/boundary/BoundaryNode.tsx",
  "components/nodes/sticky/StickyNode.tsx",
  "components/ConfirmModal.tsx",
  "components/CreateDialog.tsx",
  "components/MoveDialog.tsx",
  "components/BranchDialog.tsx",
  "components/permissions/CommandPermissionDialog.tsx",
  "components/mcp/McpIntegrationModal.tsx",
]);

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const violations = [];
for (const path of walk(sourceRoot)) {
  if (!sourceExtensions.has(extname(path))) continue;
  const displayPath = relative(sourceRoot, path);
  if (allowedFixedColorFiles.has(displayPath)) continue;
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, index) => {
    forbidden.forEach(({ pattern, message }) => {
      if (pattern.test(line)) violations.push(`${displayPath}:${index + 1}: ${message}`);
    });
    if (semanticCssModules.some((pattern) => pattern.test(displayPath))) {
      semanticModuleForbidden.forEach(({ pattern, message }) => {
        if (pattern.test(line)) violations.push(`${displayPath}:${index + 1}: ${message}`);
      });
    }
    if (migratedJsxFiles.has(displayPath) && /className\s*=\s*["']/.test(line)) {
      violations.push(`${displayPath}:${index + 1}: migrated components must keep presentation in their CSS Module`);
    }
  });
}

const protectedMonacoTypographyConsumers = [
  "components/tabs/FileTab.tsx",
  "components/tabs/GitDiffTab.tsx",
  "components/tabs/TaskTab.tsx",
  "components/edgeinspector/components/EdgeDiffTabContent.tsx",
  "components/sidepane/components/DiffTabContent.tsx",
  "components/sidepane/components/ManualReconciliationEditor.tsx",
  "components/sidepane/components/PRDiffView.tsx",
];

for (const displayPath of protectedMonacoTypographyConsumers) {
  const path = join(sourceRoot, displayPath);
  readFileSync(path, "utf8").split("\n").forEach((line, index) => {
    if (/fontSize:\s*\d/.test(line)) {
      violations.push(`${displayPath}:${index + 1}: Monaco typography must use src/editor/monacoOptions.ts`);
    }
  });
}

if (violations.length > 0) {
  console.error(`Theme usage check failed:\n${violations.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Theme usage check passed.");
}
