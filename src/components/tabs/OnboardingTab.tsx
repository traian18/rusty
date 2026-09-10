import React, { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  CheckSquare,
  CornerDownLeft,
  Cpu,
  FileText,
  Folder,
  GitMerge,
  Globe,
  MessageSquare,
  MessageSquareCode,
  Play,
  Plug,
  ShieldCheck,
  Sparkles,
  Square,
  StickyNote,
  Wand2,
} from "lucide-react";
import { useWorkspaceStore } from "../../store";
import { CURRENT_ONBOARDING_RELEASE } from "../../config/onboarding";
import { RustyIcon } from "../RustyIcon";

type NodeKind = "global" | "task" | "context" | "mcp" | "sticky" | "boundary";

interface NodeGuide {
  kind: NodeKind;
  title: string;
  eyebrow: string;
  description: string;
  details: string[];
}

const nodeGuides: NodeGuide[] = [
  {
    kind: "global",
    title: "Global Explorer",
    eyebrow: "Plan the Rusty",
    description: "The reasoning center for this canvas. Give it your feature brief, explore the codebase, and generate an editable graph of tasks and supporting context.",
    details: ["One per Rusty", "Generates task and context nodes", "Uses the model and skill you select"],
  },
  {
    kind: "task",
    title: "Task Node",
    eyebrow: "Implement one bounded change",
    description: "A focused unit of execution. It receives only its connected context and upstream work, then writes its result into an isolated virtual workspace for review.",
    details: ["Choose a model per task", "Inspect the diff before integration", "Iterate through the node chat"],
  },
  {
    kind: "context",
    title: "Context Node",
    eyebrow: "Control what the model sees",
    description: "Attach a file, folder, or written instruction to the tasks that need it. Explicit context keeps generations grounded and makes their inputs visible to you.",
    details: ["Search or drag in project files", "Add architectural guidance", "Connect it only where relevant"],
  },
  {
    kind: "mcp",
    title: "MCP Node",
    eyebrow: "Bring in external knowledge",
    description: "Connect a configured MCP server to a task when implementation depends on information outside the repository, such as documentation, services, or project systems.",
    details: ["Select a configured server", "Describe what should be fetched", "Share the result with connected tasks"],
  },
  {
    kind: "sticky",
    title: "Sticky Note",
    eyebrow: "Keep human reasoning visible",
    description: "Record an assumption, question, decision, or reminder directly beside the work it concerns. Sticky notes never execute and never spend tokens.",
    details: ["Capture discoveries as you iterate", "Document decisions in place", "Use colors to build your own visual language"],
  },
  {
    kind: "boundary",
    title: "Boundary",
    eyebrow: "Give a large graph structure",
    description: "Group related work into a named visual area. Boundaries make large Rustys navigable without changing execution or forcing an artificial hierarchy.",
    details: ["Group a concern or subsystem", "Jump between named regions", "Keep 100+ node canvases legible"],
  },
];

const workflow = [
  {
    icon: MessageSquare,
    number: "01",
    phase: "Discover",
    title: "Explore the feature",
    text: "Begin in a normal chat. Investigate the existing code, compare approaches, and turn a vague request into a decision you are prepared to implement.",
    actions: ["Choose the model that fits the difficulty of the discussion.", "Use Inline Chat when a selected line or file needs focused explanation.", "Identify constraints, existing contracts, risks, and unresolved questions."],
    ready: "You can explain the desired behavior and what is out of scope.",
  },
  {
    icon: FileText,
    number: "02",
    phase: "Discover",
    title: "Capture the brief",
    text: "Extract the useful result of that conversation into a Markdown file. The brief is durable project context—not knowledge trapped inside chat history.",
    actions: ["Record the objective, contracts, acceptance criteria, and important decisions.", "Keep the brief in the repository so both you and future models can inspect it."],
    ready: "The Markdown file is specific enough to review without the original chat.",
  },
  {
    icon: Globe,
    number: "03",
    phase: "Build",
    title: "Generate the graph",
    text: "Open a Rusty, attach the brief, and ask the Global Explorer to propose an implementation graph. The proposal is a starting point, not an order to execute.",
    actions: ["Review task boundaries and connect the files or guidance each task needs.", "Add, remove, split, or reorder nodes until the graph matches your understanding."],
    ready: "Every task has a bounded purpose, relevant context, and sensible dependencies.",
  },
  {
    icon: Play,
    number: "04",
    phase: "Build",
    title: "Iterate node by node",
    text: "Work one bounded task at a time. Select its model and skill, run it, inspect the generated files and diff, then use the node chat to correct or deepen the result.",
    actions: ["Add context when the model guessed, duplicated behavior, or missed a contract.", "Rerun and review until you understand why each change belongs in the codebase."],
    ready: "You can explain the change, the contract it uses, and how it was verified.",
  },
  {
    icon: GitMerge,
    number: "05",
    phase: "Integrate",
    title: "Reconcile convergence",
    text: "Independent tasks may converge on the same file. Open reconciliation to compare their intended changes and compose one coherent implementation.",
    actions: ["Treat files touched by several nodes as integration hotspots, not ordinary diffs.", "Use a stronger model only when collision complexity actually requires it."],
    ready: "Overlapping work preserves every required behavior without duplicate implementations.",
  },
  {
    icon: CheckCircle2,
    number: "06",
    phase: "Integrate",
    title: "Review and merge",
    text: "Review the Rusty as a whole, apply its virtual changes to the real workspace, and use Git as the final integration boundary.",
    actions: ["Inspect the combined diff and run the relevant tests and checks.", "Merge only when the implementation still matches the Markdown brief."],
    ready: "The code is coherent, verified, and understandable enough for you to maintain.",
  },
];

const NodeArtwork: React.FC<{ kind: NodeKind }> = ({ kind }) => {
  const commonCard = "relative w-[230px] rounded-lg border bg-[var(--bg-sidebar)] shadow-xl overflow-hidden";

  if (kind === "global") {
    return (
      <div className={`${commonCard} border-[var(--color-status-danger-border)]`}>
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-color)] bg-[var(--color-surface-sunken)]">
          <span className="flex items-center gap-2 text-[10px] font-semibold text-[var(--text-light)]"><Globe size={13} className="text-[var(--color-status-danger)]" /> Global Explorer</span>
          <span className="text-[8px] font-mono text-[var(--text-muted)]">PLAN</span>
        </div>
        <div className="p-3 space-y-2">
          <div className="text-[9px] leading-relaxed text-[var(--text-normal)] bg-[var(--color-surface-sunken)] rounded-md p-2 border border-[var(--border-color)]">Turn the security brief into bounded, connected tasks.</div>
          <div className="flex gap-1.5">
            <span className="px-2 py-1 rounded bg-[var(--accent-bg)] text-[8px] font-mono text-[var(--accent-color)]">AUDITOR</span>
            <span className="px-2 py-1 rounded bg-[var(--color-surface-elevated)] text-[8px] font-mono text-[var(--text-muted)]">MODEL</span>
          </div>
        </div>
      </div>
    );
  }

  if (kind === "task") {
    return (
      <div className={`${commonCard} border-[var(--border-active)]`}>
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-color)] bg-[var(--color-surface-sunken)]">
          <span className="flex items-center gap-2 text-[10px] font-semibold text-[var(--text-light)]"><Sparkles size={13} className="text-[var(--accent-color)]" /> Harden JWT validation</span>
          <span className="w-2 h-2 rounded-full bg-[var(--color-status-success)]" />
        </div>
        <div className="p-3">
          <div className="text-[8px] font-mono uppercase text-[var(--text-muted)] mb-1.5">Prompt instructions</div>
          <div className="text-[9px] leading-relaxed text-[var(--text-normal)] bg-[var(--color-surface-sunken)] rounded-md p-2 border border-[var(--border-color)]">Reuse the existing token contract and add expiry checks.</div>
        </div>
        <div className="flex justify-between px-3 py-1.5 border-t border-[var(--border-color)] text-[8px] font-mono text-[var(--text-muted)]"><span>OPEN PANE</span><span>LOCAL MODEL</span></div>
      </div>
    );
  }

  if (kind === "context") {
    return (
      <div className={`${commonCard} border-[var(--color-status-success-border)]`}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-color)] bg-[var(--color-surface-sunken)] text-[10px] font-semibold text-[var(--text-light)]">
          <Folder size={13} className="text-[var(--color-status-success)]" /> JWT contract
        </div>
        <div className="p-3 space-y-2">
          <div className="flex items-center gap-2 px-2 py-2 rounded-md border border-[var(--border-color)] bg-[var(--color-surface-sunken)]">
            <FileText size={14} className="text-[var(--accent-color)]" />
            <div><div className="text-[9px] text-[var(--text-light)]">token.service.ts</div><div className="text-[8px] font-mono text-[var(--text-muted)]">src/auth/</div></div>
          </div>
          <p className="text-[8px] leading-relaxed text-[var(--text-muted)]">Preserve the current claims shape and error contract.</p>
        </div>
      </div>
    );
  }

  if (kind === "mcp") {
    return (
      <div className={`${commonCard} border-[var(--color-status-info-border)]`}>
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-color)] bg-[var(--color-surface-sunken)]">
          <span className="flex items-center gap-2 text-[10px] font-semibold text-[var(--text-light)]"><Plug size={13} className="text-[var(--color-status-info)]" /> Security documentation</span>
          <span className="text-[8px] font-mono text-[var(--color-status-info)]">MCP</span>
        </div>
        <div className="p-3 space-y-2">
          <div className="text-[8px] font-mono uppercase text-[var(--text-muted)]">Connected server</div>
          <div className="rounded-md p-2 border border-[var(--border-color)] bg-[var(--color-surface-sunken)] text-[9px] text-[var(--text-normal)]">Project Knowledge Base</div>
          <p className="text-[8px] leading-relaxed text-[var(--text-muted)]">Fetch the current authentication requirements.</p>
        </div>
      </div>
    );
  }

  if (kind === "sticky") {
    return (
      <div className="relative w-[210px] min-h-[145px] rotate-[-2deg] rounded-md border border-[var(--color-status-warning-border)] bg-[var(--color-status-warning-bg)] shadow-xl p-4">
        <div className="flex items-center justify-between mb-3 text-[var(--color-status-warning)]"><StickyNote size={15} /><span className="text-[8px] font-mono">DECISION</span></div>
        <p className="text-[11px] leading-relaxed text-[var(--text-light)]">All controllers must use the shared authorization guard.</p>
        <div className="absolute bottom-3 left-4 right-4 h-px bg-[var(--color-status-warning-border)]" />
      </div>
    );
  }

  return (
    <div className="relative w-[250px] h-[160px] rounded-xl border-2 border-dashed border-[var(--color-status-danger-border)] bg-[var(--color-status-danger-bg)]/20 p-3">
      <div className="flex items-center gap-2 text-[10px] font-semibold text-[var(--color-status-danger)]"><Square size={13} /> Authentication</div>
      <div className="absolute left-5 right-5 top-12 bottom-5 grid grid-cols-2 gap-2">
        <div className="rounded border border-[var(--border-color)] bg-[var(--bg-sidebar)] flex items-center justify-center"><Folder size={15} className="text-[var(--color-status-success)]" /></div>
        <div className="rounded border border-[var(--border-active)] bg-[var(--bg-sidebar)] flex items-center justify-center"><CheckSquare size={15} className="text-[var(--accent-color)]" /></div>
      </div>
    </div>
  );
};

const HeroGraph: React.FC = () => (
  <div
    className="relative h-[360px] rounded-3xl border border-[var(--border-color)] overflow-hidden shadow-2xl"
    style={{
      backgroundColor: "var(--bg-canvas)",
      backgroundImage: "radial-gradient(circle, var(--border-color) 1px, transparent 1px)",
      backgroundSize: "22px 22px",
    }}
  >
    <div className="absolute inset-0 bg-gradient-to-br from-[var(--accent-bg)] via-transparent to-[var(--color-status-info-bg)]/30" />
    <svg className="absolute inset-0 w-full h-full" aria-hidden="true">
      <path d="M145 112 C 220 112, 205 250, 292 250" fill="none" stroke="var(--color-status-success)" strokeWidth="2" strokeDasharray="6 6" opacity="0.65" />
      <path d="M302 112 C 360 112, 350 250, 400 250" fill="none" stroke="var(--accent-color)" strokeWidth="2.5" opacity="0.8" />
      <path d="M330 250 L 375 250" fill="none" stroke="var(--accent-color)" strokeWidth="2.5" opacity="0.8" />
    </svg>

    <div className="absolute left-[7%] top-[18%] w-[142px] rounded-lg border border-[var(--color-status-success-border)] bg-[var(--bg-sidebar)] shadow-xl overflow-hidden">
      <div className="px-2.5 py-2 border-b border-[var(--border-color)] flex items-center gap-2 text-[9px] font-semibold text-[var(--text-light)]"><Folder size={12} className="text-[var(--color-status-success)]" /> Feature brief</div>
      <div className="p-2.5 text-[8px] font-mono text-[var(--text-muted)]">security-update.md</div>
    </div>

    <div className="absolute left-[38%] top-[13%] w-[154px] rounded-lg border border-[var(--color-status-danger-border)] bg-[var(--bg-sidebar)] shadow-xl overflow-hidden">
      <div className="px-2.5 py-2 border-b border-[var(--border-color)] flex items-center gap-2 text-[9px] font-semibold text-[var(--text-light)]"><Globe size={12} className="text-[var(--color-status-danger)]" /> Global Explorer</div>
      <div className="p-2.5 text-[8px] text-[var(--text-muted)]">Generate the implementation graph</div>
    </div>

    <div className="absolute left-[24%] bottom-[14%] w-[155px] rounded-lg border border-[var(--border-active)] bg-[var(--bg-sidebar)] shadow-xl overflow-hidden">
      <div className="px-2.5 py-2 border-b border-[var(--border-color)] flex items-center gap-2 text-[9px] font-semibold text-[var(--text-light)]"><Sparkles size={12} className="text-[var(--accent-color)]" /> JWT handling</div>
      <div className="p-2.5 text-[8px] text-[var(--text-muted)]">Reuse the existing contract</div>
    </div>

    <div className="absolute right-[7%] bottom-[14%] w-[155px] rounded-lg border border-[var(--border-active)] bg-[var(--bg-sidebar)] shadow-xl overflow-hidden">
      <div className="px-2.5 py-2 border-b border-[var(--border-color)] flex items-center gap-2 text-[9px] font-semibold text-[var(--text-light)]"><Sparkles size={12} className="text-[var(--accent-color)]" /> Rate limiting</div>
      <div className="p-2.5 text-[8px] text-[var(--text-muted)]">Apply policy at the boundary</div>
    </div>

    <div className="absolute left-5 bottom-5 flex items-center gap-2 rounded-full border border-[var(--border-color)] bg-[var(--bg-sidebar)]/90 px-3 py-1.5 text-[8px] font-mono text-[var(--text-muted)] shadow-lg">
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-status-success)]" /> CONTEXT IS EXPLICIT
    </div>
  </div>
);

export const OnboardingTab: React.FC = () => {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const openTab = useWorkspaceStore((state) => state.openTab);

  // package.json's version drifts from the app's real version (tauri.conf.json,
  // bumped per release) — read the actual running app version from Tauri instead.
  const [appVersion, setAppVersion] = useState(CURRENT_ONBOARDING_RELEASE.appVersion);
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => { });
  }, []);

  const handleStart = () => {
    if (rootPath) {
      openTab({ type: "canvas" });
      return;
    }
    openTab({ type: "workspace" });
  };

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-[var(--bg-editor)] text-[var(--text-normal)]">
      <div className="sticky top-0 z-30 border-b border-[var(--border-color)] bg-[var(--bg-editor)]/90 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <RustyIcon size={36} className="shadow-lg" />
            <div><div className="text-[12px] font-mono font-bold tracking-[0.22em] text-[var(--text-light)]">RUSTY</div><div className="text-[8px] font-mono uppercase tracking-wider text-[var(--text-muted)]">{CURRENT_ONBOARDING_RELEASE.id} · v{appVersion}</div></div>
          </div>
          <nav className="hidden md:flex items-center gap-1 text-[10px] font-mono">
            <button onClick={() => scrollTo("workflow")} className="px-3 py-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-light)] hover:bg-[var(--accent-bg)] transition-colors cursor-pointer">Workflow</button>
            <button onClick={() => scrollTo("nodes")} className="px-3 py-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-light)] hover:bg-[var(--accent-bg)] transition-colors cursor-pointer">Meet the nodes</button>
            <button onClick={() => scrollTo("inline-chat")} className="px-3 py-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-light)] hover:bg-[var(--accent-bg)] transition-colors cursor-pointer">Inline chat</button>
            <button onClick={() => scrollTo("control")} className="px-3 py-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-light)] hover:bg-[var(--accent-bg)] transition-colors cursor-pointer">Model control</button>
          </nav>
        </div>
      </div>

      <main>
        <section className="relative max-w-7xl mx-auto px-6 lg:px-10 pt-16 lg:pt-24 pb-20 lg:pb-28">
          <div className="absolute top-10 left-1/4 w-80 h-80 rounded-full bg-[var(--accent-bg)] blur-3xl opacity-60 pointer-events-none" />
          <div className="relative grid lg:grid-cols-[1.02fr_0.98fr] gap-12 lg:gap-16 items-center">
            <div>
              <div className="flex items-center gap-4 mb-7">
                <div className="w-[72px] h-[72px] rounded-2xl border border-[var(--border-color)] bg-[var(--color-surface-elevated)] flex items-center justify-center shadow-2xl">
                  <RustyIcon size={56} />
                </div>
                <div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-[var(--border-color)] bg-[var(--color-surface-elevated)] px-3 py-1.5 text-[9px] font-mono uppercase tracking-[0.16em] text-[var(--accent-color)]">
                    <ShieldCheck size={12} /> {CURRENT_ONBOARDING_RELEASE.id}
                  </div>
                  <div className="mt-2 pl-1 text-[8px] font-mono uppercase tracking-[0.16em] text-[var(--text-muted)]">Rusty version {appVersion}</div>
                </div>
              </div>
              <h1 className="max-w-3xl text-4xl sm:text-5xl xl:text-6xl font-semibold tracking-[-0.045em] leading-[1.04] text-[var(--text-light)]">
                Understand the code<br />you <span className="text-[var(--accent-color)]">generate.</span>
              </h1>
              <p className="mt-7 max-w-xl text-sm sm:text-base leading-7 text-[var(--text-normal)]">
                Rusty turns a feature brief into explicit context, bounded tasks, and inspectable changes. Use AI without surrendering architectural discipline—or paying a frontier model for every line.
              </p>
              <div className="mt-9 flex flex-wrap gap-3">
                <button onClick={handleStart} className="group inline-flex items-center gap-2 rounded-xl bg-[var(--accent-color)] px-5 py-3 text-xs font-mono font-bold text-[var(--color-primary-foreground)] shadow-lg hover:brightness-110 transition-all cursor-pointer">
                  {rootPath ? "Create a Code Canvas" : "Choose a workspace"}<ArrowRight size={15} className="group-hover:translate-x-0.5 transition-transform" />
                </button>
                <button onClick={() => scrollTo("workflow")} className="inline-flex items-center gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--color-surface-elevated)] px-5 py-3 text-xs font-mono font-semibold text-[var(--text-light)] hover:border-[var(--border-active)] transition-colors cursor-pointer">
                  See the workflow<BookOpen size={14} />
                </button>
              </div>
              <div className="mt-10 grid grid-cols-3 gap-5 max-w-lg border-t border-[var(--border-color)] pt-6">
                <div><div className="text-lg font-semibold text-[var(--text-light)]">Explicit</div><div className="text-[9px] font-mono uppercase tracking-wider text-[var(--text-muted)] mt-1">context</div></div>
                <div><div className="text-lg font-semibold text-[var(--text-light)]">Bounded</div><div className="text-[9px] font-mono uppercase tracking-wider text-[var(--text-muted)] mt-1">execution</div></div>
                <div><div className="text-lg font-semibold text-[var(--text-light)]">Selective</div><div className="text-[9px] font-mono uppercase tracking-wider text-[var(--text-muted)] mt-1">model cost</div></div>
              </div>
              <p className="mt-5 max-w-lg text-[9px] font-mono leading-4 text-[var(--text-muted)]">
                You are viewing the <span className="text-[var(--accent-color)]">{CURRENT_ONBOARDING_RELEASE.id}</span> guide. Onboarding content is versioned with Rusty and will evolve as the application does.
              </p>
            </div>
            <HeroGraph />
          </div>
        </section>

        <section className="border-y border-[var(--border-color)] bg-[var(--color-surface-sunken)]">
          <div className="max-w-7xl mx-auto px-6 lg:px-10 py-16 lg:py-20">
            <div className="grid lg:grid-cols-[0.75fr_1.25fr] gap-10 lg:gap-20">
              <div>
                <div className="text-[9px] font-mono uppercase tracking-[0.2em] text-[var(--accent-color)] mb-4">The philosophy</div>
                <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-[var(--text-light)]">AI is powerful.<br />Ownership stays human.</h2>
              </div>
              <div className="grid sm:grid-cols-3 gap-5">
                {[
                  ["01", "Context before code", "Make the inputs and constraints visible before asking a model to implement."],
                  ["02", "Comprehension before merge", "Review every bounded change until you can explain what enters the project."],
                  ["03", "Power at convergence", "Use inexpensive models for isolated work and stronger reasoning where changes collide."],
                ].map(([number, title, text]) => (
                  <div key={number} className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-editor)] p-5">
                    <div className="text-[9px] font-mono text-[var(--accent-color)]">{number}</div>
                    <h3 className="mt-5 text-sm font-semibold text-[var(--text-light)]">{title}</h3>
                    <p className="mt-3 text-xs leading-5 text-[var(--text-muted)]">{text}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="workflow" className="scroll-mt-16 max-w-7xl mx-auto px-6 lg:px-10 py-20 lg:py-28">
          <div className="max-w-3xl">
            <div className="text-[9px] font-mono uppercase tracking-[0.2em] text-[var(--accent-color)] mb-4">A repeatable loop</div>
            <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-[var(--text-light)]">From conversation to understood code.</h2>
            <p className="mt-5 text-sm leading-6 text-[var(--text-normal)]">A Rusty is the middle of the process—not the beginning and not the final authority. Start by deciding what should exist, use the canvas to implement it deliberately, and finish at a Git boundary.</p>
          </div>

          <div className="mt-10 grid md:grid-cols-3 gap-3">
            {[
              ["Discover", "01–02", "Decide what to build and preserve the reasoning in a reviewable brief."],
              ["Build", "03–04", "Turn intent into a graph, then learn through small execution and review loops."],
              ["Integrate", "05–06", "Resolve converging changes, verify the whole, and cross the Git boundary."],
            ].map(([title, range, text], index) => (
              <div key={title} className="relative rounded-2xl border border-[var(--border-color)] bg-[var(--color-surface-sunken)] p-5">
                <div className="flex items-center justify-between"><span className="text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-[var(--accent-color)]">{title}</span><span className="text-[9px] font-mono text-[var(--text-muted)]">{range}</span></div>
                <p className="mt-3 text-[11px] leading-5 text-[var(--text-muted)]">{text}</p>
                {index < 2 && <ArrowRight size={14} className="hidden md:block absolute -right-[9px] top-1/2 z-10 text-[var(--accent-color)]" />}
              </div>
            ))}
          </div>

          <div className="mt-5 grid lg:grid-cols-2 gap-4">
            {workflow.map(({ icon: Icon, number, phase, title, text, actions, ready }) => (
              <article key={number} className="relative rounded-2xl border border-[var(--border-color)] bg-[var(--bg-editor)] p-6 lg:p-7 min-h-[340px] group hover:border-[var(--border-active)] transition-colors">
                <div className="flex items-center justify-between">
                  <span className="w-9 h-9 rounded-lg border border-[var(--border-color)] bg-[var(--color-surface-sunken)] flex items-center justify-center text-[var(--accent-color)] group-hover:border-[var(--border-active)] transition-colors"><Icon size={16} /></span>
                  <div className="flex items-center gap-3"><span className="text-[8px] font-mono uppercase tracking-widest text-[var(--text-muted)]">{phase}</span><span className="text-[9px] font-mono text-[var(--accent-color)]">{number}</span></div>
                </div>
                <h3 className="mt-7 text-lg font-semibold text-[var(--text-light)]">{title}</h3>
                <p className="mt-3 text-xs leading-5 text-[var(--text-normal)]">{text}</p>
                <div className="mt-5">
                  <div className="text-[8px] font-mono uppercase tracking-[0.16em] text-[var(--text-muted)] mb-2.5">What you do</div>
                  <ul className="space-y-2">
                    {actions.map((action) => (
                      <li key={action} className="flex items-start gap-2 text-[10px] leading-4 text-[var(--text-muted)]"><span className="mt-[6px] w-1 h-1 rounded-full bg-[var(--accent-color)] flex-shrink-0" />{action}</li>
                    ))}
                  </ul>
                </div>
                <div className="mt-6 pt-4 border-t border-[var(--border-color)] flex items-start gap-3">
                  <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0 text-[var(--color-status-success)]" />
                  <div><div className="text-[8px] font-mono uppercase tracking-[0.16em] text-[var(--color-status-success)]">Ready when</div><p className="mt-1.5 text-[10px] leading-4 text-[var(--text-normal)]">{ready}</p></div>
                </div>
              </article>
            ))}
          </div>

          <div className="mt-5 rounded-2xl border border-[var(--border-active)] bg-[var(--accent-bg)] p-6 lg:p-8 grid lg:grid-cols-[0.75fr_1.25fr] gap-8 items-center">
            <div>
              <div className="text-[9px] font-mono uppercase tracking-[0.18em] text-[var(--accent-color)] mb-3">Iteration is the point</div>
              <h3 className="text-xl font-semibold text-[var(--text-light)]">A failed first result is information.</h3>
              <p className="mt-3 text-xs leading-5 text-[var(--text-normal)]">Do not compensate with a larger prompt or blindly accept a plausible diff. Find what the task lacked, make that context explicit, and run the bounded loop again.</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {["Inspect the diff", "Find the missing context", "Adjust the task", "Run and verify again"].map((label, index) => (
                <div key={label} className="relative min-h-24 rounded-xl border border-[var(--border-color)] bg-[var(--bg-editor)] p-3 flex flex-col justify-between">
                  <span className="text-[8px] font-mono text-[var(--accent-color)]">0{index + 1}</span>
                  <span className="text-[10px] leading-4 font-semibold text-[var(--text-light)]">{label}</span>
                  {index < 3 && <ArrowRight size={12} className="hidden sm:block absolute -right-[7px] top-1/2 z-10 text-[var(--accent-color)]" />}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="nodes" className="scroll-mt-16 border-y border-[var(--border-color)] bg-[var(--color-surface-sunken)]">
          <div className="max-w-7xl mx-auto px-6 lg:px-10 py-20 lg:py-28">
            <div className="max-w-2xl">
              <div className="text-[9px] font-mono uppercase tracking-[0.2em] text-[var(--accent-color)] mb-4">Meet the nodes</div>
              <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-[var(--text-light)]">Each shape has one responsibility.</h2>
              <p className="mt-5 text-sm leading-6 text-[var(--text-normal)]">Nodes keep planning, evidence, execution, and human notes separate. Edges make their relationships explicit.</p>
            </div>

            <div className="mt-14 space-y-5">
              {nodeGuides.map((node, index) => (
                <article key={node.kind} className="grid lg:grid-cols-[0.85fr_1.15fr] min-h-[310px] rounded-3xl border border-[var(--border-color)] bg-[var(--bg-editor)] overflow-hidden">
                  <div
                    className={`relative min-h-[260px] flex items-center justify-center p-8 border-b lg:border-b-0 ${index % 2 === 0 ? "lg:border-r" : "lg:border-l lg:order-2"} border-[var(--border-color)]`}
                    style={{ backgroundImage: "radial-gradient(circle, var(--border-color) 1px, transparent 1px)", backgroundSize: "20px 20px" }}
                  >
                    <div className="absolute inset-0 bg-[var(--accent-bg)] opacity-20" />
                    <div className="relative scale-105 sm:scale-110"><NodeArtwork kind={node.kind} /></div>
                  </div>
                  <div className={`p-8 lg:p-12 flex flex-col justify-center ${index % 2 === 0 ? "" : "lg:order-1"}`}>
                    <div className="text-[9px] font-mono uppercase tracking-[0.18em] text-[var(--accent-color)]">{node.eyebrow}</div>
                    <h3 className="mt-3 text-2xl font-semibold text-[var(--text-light)]">{node.title}</h3>
                    <p className="mt-4 max-w-xl text-sm leading-6 text-[var(--text-normal)]">{node.description}</p>
                    <ul className="mt-6 grid sm:grid-cols-3 gap-3">
                      {node.details.map((detail) => (
                        <li key={detail} className="flex items-start gap-2 text-[10px] leading-4 text-[var(--text-muted)]"><CheckCircle2 size={12} className="mt-0.5 flex-shrink-0 text-[var(--color-status-success)]" />{detail}</li>
                      ))}
                    </ul>
                  </div>
                </article>
              ))}
            </div>

            <div className="mt-8 rounded-2xl border border-[var(--border-color)] bg-[var(--bg-editor)] p-6 lg:p-8 grid lg:grid-cols-[0.7fr_1.3fr] gap-8 items-center">
              <div>
                <div className="text-[9px] font-mono uppercase tracking-[0.18em] text-[var(--accent-color)] mb-3">Reading the graph</div>
                <h3 className="text-xl font-semibold text-[var(--text-light)]">Edges describe the flow of evidence and work.</h3>
              </div>
              <div className="grid sm:grid-cols-3 gap-3">
                {[
                  ["Context → Task", "The task receives a file, folder, instruction, or MCP result."],
                  ["Task → Task", "The downstream task builds on files produced upstream."],
                  ["Many → One file", "A reconciliation point: inspect and compose overlapping intent."],
                ].map(([title, text]) => (
                  <div key={title} className="rounded-xl border border-[var(--border-color)] bg-[var(--color-surface-sunken)] p-4"><div className="text-[10px] font-mono font-bold text-[var(--text-light)]">{title}</div><div className="mt-2 text-[10px] leading-4 text-[var(--text-muted)]">{text}</div></div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="inline-chat" className="scroll-mt-16 border-y border-[var(--border-color)] bg-[var(--color-surface-sunken)]">
          <div className="max-w-7xl mx-auto px-6 lg:px-10 py-20 lg:py-28">
            <div className="grid lg:grid-cols-[0.78fr_1.22fr] gap-12 lg:gap-16 items-center">
              <div>
                <div className="inline-flex items-center gap-2 text-[9px] font-mono uppercase tracking-[0.2em] text-[var(--accent-color)] mb-4"><MessageSquareCode size={13} /> Explore in place</div>
                <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-[var(--text-light)]">Ask the code while you read it.</h2>
                <p className="mt-5 text-sm leading-6 text-[var(--text-normal)]">Inline Chat keeps exploration attached to the editor. Select a block—or simply place the cursor on a line—and ask a model to explain behavior, trace a contract, identify risk, or suggest a direction without leaving the file.</p>

                <div className="mt-8 space-y-3">
                  {[
                    ["01", "Select the relevant code", "Rusty sends the open file and marks the exact lines you selected."],
                    ["02", "Press Ctrl/Cmd + Enter", "The conversation opens beneath the current line and remains anchored to that editor context."],
                    ["03", "Choose a model and ask", "Use a local model for ordinary explanation or a stronger one when the code requires deeper reasoning."],
                  ].map(([number, title, text]) => (
                    <div key={number} className="grid grid-cols-[32px_1fr] gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--bg-editor)] p-4">
                      <span className="text-[9px] font-mono text-[var(--accent-color)] pt-0.5">{number}</span>
                      <div><h3 className="text-xs font-semibold text-[var(--text-light)]">{title}</h3><p className="mt-1.5 text-[10px] leading-4 text-[var(--text-muted)]">{text}</p></div>
                    </div>
                  ))}
                </div>

                <div className="mt-5 rounded-xl border border-[var(--border-active)] bg-[var(--accent-bg)] px-4 py-3 text-[10px] leading-5 text-[var(--text-normal)]">
                  Use Inline Chat to understand local code. When the exploration becomes implementation work, capture the decision in the brief or turn it into a Rusty task.
                </div>
              </div>

              <div
                className="relative min-h-[520px] rounded-3xl border border-[var(--border-color)] overflow-hidden shadow-2xl"
                style={{ backgroundColor: "var(--bg-app)", backgroundImage: "radial-gradient(circle, var(--border-color) 1px, transparent 1px)", backgroundSize: "22px 22px" }}
              >
                <div className="absolute inset-5 sm:inset-8 rounded-xl border border-[var(--border-color)] bg-[var(--bg-editor)] overflow-hidden shadow-xl">
                  <div className="h-10 px-4 flex items-center justify-between border-b border-[var(--border-color)] bg-[var(--bg-header)]">
                    <div className="flex items-center gap-2"><FileText size={12} className="text-[var(--accent-color)]" /><span className="text-[9px] font-mono text-[var(--text-light)]">token.service.ts</span></div>
                    <span className="text-[8px] font-mono text-[var(--text-muted)]">TYPESCRIPT</span>
                  </div>

                  <div className="relative font-mono text-[9px] leading-6 pt-4">
                    {[
                      ["10", "async verifyRefreshToken(token: string) {"],
                      ["11", "  const payload = await this.jwt.verify(token);"],
                      ["12", "  const session = await this.sessions.find(payload.sid);"],
                      ["13", "  if (!session || session.revokedAt) {"],
                      ["14", "    throw new InvalidTokenError();"],
                      ["15", "  }"],
                      ["16", "  return { payload, session };"],
                      ["17", "}"],
                    ].map(([line, code]) => {
                      const selected = Number(line) >= 12 && Number(line) <= 16;
                      return (
                        <div key={line} className={`grid grid-cols-[42px_1fr] px-3 ${selected ? "bg-[var(--accent-bg)]" : ""}`}>
                          <span className="text-right pr-4 text-[var(--text-muted)] select-none">{line}</span>
                          <span className={selected ? "text-[var(--text-light)]" : "text-[var(--text-normal)]"}>{code}</span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="absolute left-4 right-4 top-[218px] rounded-lg border border-[var(--border-active)] bg-[var(--bg-sidebar)] shadow-2xl overflow-hidden font-mono">
                    <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-[var(--border-color)] bg-[var(--color-surface-sunken)]">
                      <div className="flex items-center gap-2 min-w-0"><MessageSquareCode size={13} className="text-[var(--accent-color)] flex-shrink-0" /><span className="text-[8px] font-bold uppercase text-[var(--text-muted)]">Inline Chat</span><span className="text-[8px] text-[var(--text-normal)]">Lines 12–16</span></div>
                      <span className="rounded border border-[var(--border-color)] bg-[var(--bg-app)] px-2 py-1 text-[8px] text-[var(--text-muted)] whitespace-nowrap">Local / Qwen</span>
                    </div>
                    <div className="p-3 space-y-3">
                      <div className="ml-10 rounded-md bg-[var(--accent-bg)] px-3 py-2 text-[9px] leading-4 text-[var(--text-light)]">Why is the session checked after JWT verification?</div>
                      <div className="text-[9px] leading-4 text-[var(--text-normal)]">
                        <span className="text-[var(--accent-color)] font-semibold">The checks protect different contracts.</span> JWT verification proves the token was signed and unexpired. The session lookup verifies that the refresh session still exists and has not been revoked server-side.
                      </div>
                    </div>
                    <div className="border-t border-[var(--border-color)] p-2">
                      <div className="flex items-center gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-app)] p-2">
                        <span className="flex-1 text-[8px] text-[var(--text-muted)]">Ask a follow-up about this code…</span>
                        <span className="rounded bg-[var(--accent-color)] p-1 text-[var(--color-primary-foreground)]"><CornerDownLeft size={10} /></span>
                      </div>
                      <div className="mt-1.5 text-[7px] text-[var(--text-muted)]">Enter to send · Shift+Enter for a new line · Esc to close</div>
                    </div>
                  </div>
                </div>

                <div className="absolute right-5 bottom-5 rounded-full border border-[var(--border-color)] bg-[var(--bg-sidebar)] px-3 py-1.5 text-[8px] font-mono text-[var(--text-muted)] shadow-lg">CTRL/CMD + ENTER</div>
              </div>
            </div>
          </div>
        </section>

        <section id="control" className="scroll-mt-16 max-w-7xl mx-auto px-6 lg:px-10 py-20 lg:py-28">
          <div className="grid lg:grid-cols-2 gap-8 items-stretch">
            <div className="rounded-3xl border border-[var(--border-color)] bg-[var(--color-surface-sunken)] p-8 lg:p-10">
              <div className="flex items-center gap-3 text-[var(--accent-color)]"><Cpu size={20} /><span className="text-[9px] font-mono uppercase tracking-[0.2em]">Model control</span></div>
              <h2 className="mt-7 text-3xl font-semibold tracking-tight text-[var(--text-light)]">Spend intelligence where it matters.</h2>
              <p className="mt-5 text-sm leading-6 text-[var(--text-normal)]">Pick a model in every chat and task. Local and free models can handle bounded implementation; larger models can focus on planning, difficult reasoning, and high-collision reconciliation.</p>
              <div className="mt-8 space-y-3">
                {["Planning and architecture", "Independent implementation", "Cross-task reconciliation"].map((label, index) => (
                  <div key={label} className="flex items-center justify-between rounded-xl border border-[var(--border-color)] bg-[var(--bg-editor)] px-4 py-3"><span className="text-xs text-[var(--text-light)]">{label}</span><span className={`text-[8px] font-mono px-2 py-1 rounded ${index === 1 ? "bg-[var(--color-status-success-bg)] text-[var(--color-status-success)]" : "bg-[var(--accent-bg)] text-[var(--accent-color)]"}`}>{index === 1 ? "LOCAL / FREE" : "STRONG MODEL"}</span></div>
                ))}
              </div>
            </div>

            <div className="rounded-3xl border border-[var(--border-color)] bg-[var(--color-surface-sunken)] p-8 lg:p-10">
              <div className="flex items-center gap-3 text-[var(--color-status-warning)]"><Wand2 size={20} /><span className="text-[9px] font-mono uppercase tracking-[0.2em]">Skills</span></div>
              <h2 className="mt-7 text-3xl font-semibold tracking-tight text-[var(--text-light)]">Make discipline reusable.</h2>
              <p className="mt-5 text-sm leading-6 text-[var(--text-normal)]">A skill defines how the model should work: its system instructions, tools, preferred model, and MCP access. Configure it once in the clean Skills UI, then apply it consistently.</p>
              <div className="mt-8 grid grid-cols-2 gap-3">
                {["PLAN", "BUILD", "AUDIT", "CUSTOM"].map((label, index) => (
                  <div key={label} className={`rounded-xl border p-4 ${index === 2 ? "border-[var(--border-active)] bg-[var(--accent-bg)]" : "border-[var(--border-color)] bg-[var(--bg-editor)]"}`}><div className="flex items-center gap-2"><Wand2 size={13} className={index === 2 ? "text-[var(--accent-color)]" : "text-[var(--text-muted)]"} /><span className="text-[9px] font-mono font-bold text-[var(--text-light)]">{label}</span></div><div className="mt-3 h-1 rounded-full bg-[var(--border-color)] overflow-hidden"><div className="h-full bg-[var(--accent-color)]" style={{ width: `${45 + index * 13}%` }} /></div></div>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-8 rounded-2xl border border-[var(--border-active)] bg-[var(--accent-bg)] px-6 py-5 grid sm:grid-cols-4 gap-5">
            {[
              ["Skill", "How the model works"],
              ["Model", "Capability and cost"],
              ["Context", "What the model knows"],
              ["Task", "The bounded outcome"],
            ].map(([title, text]) => <div key={title}><div className="text-xs font-semibold text-[var(--text-light)]">{title}</div><div className="mt-1 text-[9px] font-mono uppercase tracking-wider text-[var(--text-muted)]">{text}</div></div>)}
          </div>
        </section>

        <section className="border-t border-[var(--border-color)] bg-[var(--color-surface-sunken)]">
          <div className="max-w-5xl mx-auto px-6 lg:px-10 py-20 text-center">
            <RustyIcon size={68} className="mx-auto shadow-2xl" />
            <h2 className="mt-7 text-3xl sm:text-4xl font-semibold tracking-tight text-[var(--text-light)]">Build with AI. Keep the architecture yours.</h2>
            <p className="mt-5 mx-auto max-w-xl text-sm leading-6 text-[var(--text-normal)]">Start from a written intent, iterate over inspectable work, and merge only the code you understand.</p>
            <button onClick={handleStart} className="group mt-8 inline-flex items-center gap-2 rounded-xl bg-[var(--accent-color)] px-5 py-3 text-xs font-mono font-bold text-[var(--color-primary-foreground)] shadow-lg hover:brightness-110 transition-all cursor-pointer">
              {rootPath ? "Create a Rusty" : "Open your first workspace"}<ArrowRight size={15} className="group-hover:translate-x-0.5 transition-transform" />
            </button>
            <div className="mt-8 text-[8px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">Guide: {CURRENT_ONBOARDING_RELEASE.id} · Rusty v{appVersion}</div>
          </div>
        </section>
      </main>
    </div>
  );
};
