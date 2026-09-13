import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../store";
import { RotateCcw, ArrowUp, ArrowDown, Copy, Check, GitCommit, GitBranch, Tag, User, Calendar, ExternalLink } from "lucide-react";
import { notify } from "../notificationStore";
import { useConfirm } from "./useConfirm";
import { gitErrorMessage } from "./git/gitErrors";
import { formatHeadLabel } from "./git/gitHeadLabel";
import type { TabOfType } from "../tabs/types";

interface GitCommitInfo {
  hash: string;
  short_hash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  decorations: string;
  is_unpushed: boolean;
}

interface parsedDecoration {
  name: string;
  type: "head" | "remote" | "tag" | "branch";
}

/**
 * GitHistoryTabContent Component
 * Renders a visual log/graph of recent commits in the active Git repository.
 * Highlights unpushed (outgoing) commits and parses branch/tag decorations as badges.
 */
export const GitHistoryTabContent: React.FC<{ tab: TabOfType<"git-history"> }> = ({ tab }) => {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  // Falls back to the workspace root for the repo-wide graph opened before
  // subproject selection existed.
  const repoPath = tab?.repoPath ?? rootPath;
  const loadGitStatus = useWorkspaceStore((state) => state.loadGitStatus);
  const gitStatus = useWorkspaceStore((state) => state.gitStatus);
  const repositories = useWorkspaceStore((state) => state.repositories);
  // Real HEAD state for this tab's own repository (REFACTOR_PLAN.md PR 5b
  // commit 18), replacing the `gitStatus?.currentBranch || "detached"`
  // guess -- gitStatus is the deprecated single-slot shim, always scoped to
  // the workspace root, so it was silently wrong for any subproject tab.
  // Falls back to that same guess only if repositories hasn't been
  // discovered yet (e.g. this tab opened before SourceControl ever
  // mounted) -- full cross-refresh guarantees land in commit 24.
  const repository = repositories.find((repo) => repo.worktreePath === repoPath) ?? null;
  const currentBranchName = repository
    ? repository.head.mode === "branch"
      ? repository.head.branch
      : null
    : gitStatus?.currentBranch ?? null;
  const headBadgeLabel = repository ? formatHeadLabel(repository.head) : gitStatus?.currentBranch || "detached";

  const [commits, setCommits] = useState<GitCommitInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const [isPushing, setIsPushing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);

  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<any[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const openTab = useWorkspaceStore((state) => state.openTab);

  const { confirm, ConfirmModalComponent } = useConfirm();

  const handleToggleExpand = async (commitHash: string) => {
    if (expandedCommit === commitHash) {
      setExpandedCommit(null);
      setCommitFiles([]);
    } else {
      setExpandedCommit(commitHash);
      setCommitFiles([]);
      setLoadingFiles(true);
      try {
        const files: any[] = await invoke("git_get_commit_files", {
          rootDir: repoPath,
          commitHash,
        });
        setCommitFiles(files);
      } catch (err) {
        console.error("Failed to load commit files:", err);
      } finally {
        setLoadingFiles(false);
      }
    }
  };

  const handleOpenFileDiff = (filePath: string, _fileName: string, commitHash: string, _shortHash: string) => {
    openTab({
      type: "git-diff",
      repoPath,
      path: filePath,
      diffType: "commit",
      commitHash,
    });
  };

  const handleRevertCommit = async (commitHash: string) => {
    try {
      const confirmRevert = await confirm({
        title: "Revert Commit",
        message: `Are you sure you want to revert commit ${commitHash.substring(0, 7)}? This will create a new commit undoing its modifications.`,
        kind: "warning",
      });
      if (!confirmRevert) return;

      console.log(`Git Graph: Reverting commit ${commitHash}`);
      await invoke("git_revert_commit", { rootDir: repoPath, commitHash });
      await handleRefresh();
      // Reload workspace directory tree structure
      const tree: any[] = await invoke("get_directory_structure", { rootDir: rootPath });
      useWorkspaceStore.getState().setFileTree(tree);
      notify("Revert complete", "Commit reverted successfully.", "success");
    } catch (err: any) {
      console.error("Revert failed:", err);
      notify("Revert failed", `Revert failed: ${gitErrorMessage(err)}`, "error");
    }
  };

  const handleResetToCommit = async (commitHash: string) => {
    try {
      const confirmReset = await confirm({
        title: "Hard Reset",
        message: `WARNING: Are you sure you want to HARD RESET your current branch to commit ${commitHash.substring(0, 7)}? ALL uncommitted modifications and commits after this point will be DESTROYED.`,
        kind: "danger",
      });
      if (!confirmReset) return;

      console.log(`Git Graph: Resetting branch to ${commitHash}`);
      await invoke("git_reset_to_commit", { rootDir: repoPath, commitHash });
      await handleRefresh();
      // Reload workspace directory tree structure
      const tree: any[] = await invoke("get_directory_structure", { rootDir: rootPath });
      useWorkspaceStore.getState().setFileTree(tree);
      notify("Reset complete", "Branch reset successfully.", "success");
    } catch (err: any) {
      console.error("Reset failed:", err);
      notify("Reset failed", `Reset failed: ${gitErrorMessage(err)}`, "error");
    }
  };

  // Fetch the commit log from the backend
  const fetchCommitHistory = async () => {
    if (!repoPath) return;
    setLoading(true);
    setError(null);
    try {
      const isFileHistory = Boolean(tab?.path);
      const history: GitCommitInfo[] = isFileHistory
        ? await invoke("git_get_file_commit_history", {
            rootDir: repoPath,
            filePath: tab.path,
          })
        : await invoke("git_get_commit_history", {
            rootDir: repoPath,
          });
      setCommits(history);
    } catch (err: any) {
      console.error("Failed to load commit history:", err);
      setError(gitErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // Run on mount or when root path/tab changes
  useEffect(() => {
    fetchCommitHistory();
  }, [repoPath, tab?.path]);

  // Handle manual refresh
  const handleRefresh = async () => {
    await fetchCommitHistory();
    await loadGitStatus(repoPath);
  };

  // Push changes to remote tracking branch
  const handlePush = async () => {
    if (!repoPath || !currentBranchName || isPushing) return;
    setIsPushing(true);
    try {
      console.log(`Git Graph: Pushing branch "${currentBranchName}"...`);
      await invoke("git_push", { rootDir: repoPath, branchName: currentBranchName });
      await handleRefresh();
      notify("Push complete", "Successfully pushed commits to remote upstream.", "success");
    } catch (err: any) {
      console.error("Push failed:", err);
      notify("Push failed", `Push failed: ${gitErrorMessage(err)}`, "error");
    } finally {
      setIsPushing(false);
    }
  };

  // Pull changes from remote upstream
  const handlePull = async () => {
    if (!repoPath || isPulling) return;
    setIsPulling(true);
    try {
      console.log("Git Graph: Pulling remote modifications...");
      await invoke("git_pull", { rootDir: repoPath });
      await handleRefresh();
      // Reload workspace directory tree structure
      const tree: any[] = await invoke("get_directory_structure", { rootDir: rootPath });
      useWorkspaceStore.getState().setFileTree(tree);
      notify("Pull complete", "Successfully pulled changes from remote.", "success");
    } catch (err: any) {
      console.error("Pull failed:", err);
      notify("Pull failed", `Pull failed: ${gitErrorMessage(err)}`, "error");
    } finally {
      setIsPulling(false);
    }
  };

  // Helper to handle hash copying
  const handleCopyHash = (fullHash: string) => {
    navigator.clipboard.writeText(fullHash);
    setCopiedHash(fullHash);
    setTimeout(() => {
      setCopiedHash(null);
    }, 2000);
  };

  // Helper to parse Git decorations into badges
  const parseDecorations = (decorationsStr: string): parsedDecoration[] => {
    if (!decorationsStr) return [];
    // Strip parentheses and trim whitespace
    const clean = decorationsStr.replace(/[()]/g, "").trim();
    if (!clean) return [];

    return clean.split(",").map((part) => {
      const text = part.trim();
      let type: "head" | "remote" | "tag" | "branch" = "branch";
      let name = text;

      if (text.startsWith("HEAD ->")) {
        type = "head";
        name = text.replace("HEAD ->", "").trim();
      } else if (text.startsWith("tag:")) {
        type = "tag";
        name = text.replace("tag:", "").trim();
      } else if (text.includes("/")) {
        type = "remote";
      }

      return { name, type };
    });
  };

  const unpushedCommitsCount = commits.filter((c) => c.is_unpushed).length;

  const isFileHistory = Boolean(tab.path);
  const fileBasename = tab.path ? tab.path.split(/[/\\]/).pop() || tab.path : "";

  return (
    <div className="w-full h-full flex flex-col bg-[var(--bg-app)] font-sans text-xs select-none text-[var(--text-normal)]">
      {/* Control Header Panel */}
      <div className="px-6 py-4 bg-[var(--bg-sidebar)] border-b border-[var(--border-color)] flex items-center justify-between flex-shrink-0">
        <div className="space-y-1">
          <div className="flex items-center space-x-2">
            <h2 className="text-base font-bold text-[var(--text-light)]">
              {isFileHistory ? `History: ${fileBasename}` : "Git Commit History"}
            </h2>
            <span className="bg-[var(--accent-bg)] text-[var(--accent-color)] text-[10px] px-2 py-0.5 rounded font-mono font-bold border border-[var(--accent-color)]/25">
              {headBadgeLabel}
            </span>
          </div>
          <p className="text-[10px] text-[var(--text-muted)] font-mono truncate max-w-lg">
            {isFileHistory ? `Showing commits affecting ${tab.path}` : "Showing last 100 commits from all branches"}
          </p>
        </div>

        {/* Action Controls */}
        <div className="flex items-center space-x-2">
          {!isFileHistory && unpushedCommitsCount > 0 && (
            <div className="flex items-center space-x-1.5 bg-[var(--color-status-warning-bg)] border border-[var(--color-status-warning-border)] text-[var(--color-status-warning)] px-3 py-1.5 rounded-lg text-[10px] font-mono font-semibold mr-2 select-none">
              <ArrowUp size={11} className="animate-bounce" />
              <span>{unpushedCommitsCount} outgoing commit{unpushedCommitsCount > 1 ? "s" : ""}</span>
            </div>
          )}

          {!isFileHistory && (
            <>
              <button
                onClick={handlePull}
                disabled={loading || isPulling || isPushing}
                className="bg-[var(--bg-app)] border border-[var(--border-color)] hover:border-[var(--border-active)] hover:text-[var(--text-light)] text-[var(--text-normal)] disabled:opacity-50 px-3 py-1.5 rounded-lg font-mono font-semibold transition-all flex items-center space-x-1.5 cursor-pointer"
                title="Pull remote commits"
              >
                <ArrowDown size={12} className={isPulling ? "animate-bounce" : ""} />
                <span>Pull</span>
              </button>

              <button
                onClick={handlePush}
                disabled={loading || isPulling || isPushing}
                className="bg-[var(--accent-color)] hover:bg-[var(--accent-color)]/85 text-[var(--color-primary-foreground)] disabled:bg-[var(--border-color)] disabled:opacity-50 px-3.5 py-1.5 rounded-lg font-mono font-bold transition-all shadow-md hover:shadow-indigo-500/10 flex items-center space-x-1.5 cursor-pointer glow-btn"
                title="Push local commits"
              >
                <ArrowUp size={12} className={isPushing ? "animate-bounce" : ""} />
                <span>Push</span>
              </button>
            </>
          )}

          <button
            onClick={handleRefresh}
            disabled={loading}
            className="p-2 bg-[var(--bg-app)] border border-[var(--border-color)] hover:border-[var(--border-active)] hover:text-[var(--text-light)] text-[var(--text-normal)] disabled:opacity-50 rounded-lg transition-all cursor-pointer flex items-center justify-center"
            title="Refresh commits history"
          >
            <RotateCcw size={13} className={loading ? "animate-spin text-[var(--accent-color)]" : ""} />
          </button>
        </div>
      </div>

      {/* Main Commit Graph Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && commits.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full space-y-2 text-[var(--text-muted)] font-mono">
            <RotateCcw size={20} className="animate-spin text-[var(--accent-color)]" />
            <span>Reading Git logs...</span>
          </div>
        ) : error ? (
          <div className="p-8 max-w-lg mx-auto text-center space-y-3 font-mono">
            <span className="text-[var(--color-status-danger)] font-bold block text-sm">Failed to retrieve commit history</span>
            <div className="bg-[var(--color-surface-sunken)] border border-[var(--border-color)] p-4 rounded-lg text-left text-xs break-all text-[var(--text-muted)] select-text">
              {error}
            </div>
            <button
              onClick={handleRefresh}
              className="px-4 py-2 bg-[var(--bg-sidebar)] border border-[var(--border-color)] hover:border-[var(--border-active)] text-xs rounded-lg cursor-pointer font-bold"
            >
              Retry
            </button>
          </div>
        ) : commits.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)] font-mono space-y-2">
            <GitCommit size={24} className="opacity-40" />
            <span className="text-sm font-semibold">No Commits Found</span>
            <span className="text-[10px] max-w-[250px] text-center leading-relaxed">
              This repository does not have any commits yet. Make your first commit from the Source Control panel.
            </span>
          </div>
        ) : (
          <div className="flex flex-col py-4">
            {commits.map((commit, index) => {
              const decorations = parseDecorations(commit.decorations);
              const isExpanded = expandedCommit === commit.hash;

              return (
                <div key={commit.hash} className="flex flex-col border-b border-[var(--border-color)]/25">
                  {/* Main Commit Row Info */}
                  <div
                    onClick={() => handleToggleExpand(commit.hash)}
                    className="flex items-stretch h-14 hover:bg-[var(--accent-bg)]/20 transition-colors group/row cursor-pointer"
                  >
                    {/* Timeline Graphic Graph Column */}
                    <div className="w-12 flex-shrink-0 flex items-center justify-center relative">
                      <svg className="w-full h-full" viewBox="0 0 48 56" preserveAspectRatio="none">
                        {/* Connection track lines */}
                        {index > 0 && (
                          <line
                            x1="24"
                            y1="0"
                            x2="24"
                            y2="28"
                            stroke={commit.is_unpushed ? "var(--color-status-warning)" : "var(--color-border-default)"}
                            strokeWidth="2"
                          />
                        )}
                        {index < commits.length - 1 && (
                          <line
                            x1="24"
                            y1="28"
                            x2="24"
                            y2="56"
                            stroke={commits[index + 1].is_unpushed ? "var(--color-status-warning)" : "var(--color-border-default)"}
                            strokeWidth="2"
                          />
                        )}

                        {/* Timeline node circle */}
                        <circle
                          cx="24"
                          cy="28"
                          r={commit.is_unpushed ? "6" : "4.5"}
                          fill={commit.is_unpushed ? "var(--color-status-warning-solid)" : "var(--color-surface-app)"}
                          stroke={commit.is_unpushed ? "var(--color-status-warning)" : "var(--color-primary)"}
                          strokeWidth="2"
                        />
                      </svg>
                    </div>

                    {/* Commit Information Column */}
                    <div className="flex-1 min-w-0 pr-6 flex flex-col justify-center space-y-1">
                      {/* Subject Row */}
                      <div className="flex items-center space-x-2">
                        <span className="font-semibold text-[var(--text-light)] truncate max-w-[50%] select-text font-sans text-xs">
                          {commit.subject}
                        </span>

                        {/* Decorations (Branches/Tags) badges */}
                        <div className="flex items-center space-x-1.5 flex-wrap">
                          {decorations.map((dec, i) => {
                            const colors = {
                              head: "bg-[var(--color-status-success-bg)] text-[var(--color-status-success)] border-[var(--color-status-success-border)]",
                              remote: "bg-[var(--color-status-danger-bg)] text-[var(--color-status-danger)] border-[var(--color-status-danger-border)]",
                              tag: "bg-[var(--color-status-warning-bg)] text-[var(--color-status-warning)] border-[var(--color-status-warning-border)]",
                              branch: "bg-[var(--color-status-info-bg)] text-[var(--color-status-info)] border-[var(--color-status-info-border)]",
                            };
                            const icons = {
                              head: <GitBranch size={9} />,
                              remote: <ExternalLink size={8} />,
                              tag: <Tag size={8} />,
                              branch: <GitBranch size={9} />,
                            };
                            return (
                              <span
                                key={i}
                                className={`inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border ${colors[dec.type]}`}
                              >
                                {icons[dec.type]}
                                <span>{dec.name}</span>
                              </span>
                            );
                          })}

                          {/* Outgoing Commit Badge */}
                          {commit.is_unpushed && (
                            <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[var(--color-status-warning-bg)] text-[var(--color-status-warning)] border border-[var(--color-status-warning-border)]">
                              <ArrowUp size={9} />
                              <span>Outgoing</span>
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Metadata Row */}
                      <div className="flex items-center text-[10px] text-[var(--text-muted)] font-mono space-x-4">
                        <div className="flex items-center space-x-1">
                          <User size={10} className="text-[var(--text-muted)]/75" />
                          <span className="truncate max-w-[120px]">{commit.author}</span>
                        </div>
                        <div className="flex items-center space-x-1">
                          <Calendar size={10} className="text-[var(--text-muted)]/75" />
                          <span>{commit.date}</span>
                        </div>
                        <div className="flex items-center space-x-1.5 group/hash">
                          <span className="text-[var(--text-muted)]/70 select-text font-bold">
                            {commit.short_hash}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopyHash(commit.hash);
                            }}
                            className="text-[var(--text-muted)] hover:text-[var(--text-light)] p-0.5 rounded transition-all cursor-pointer opacity-0 group-hover/row:opacity-100 group-focus/row:opacity-100"
                            title="Copy commit SHA"
                          >
                            {copiedHash === commit.hash ? (
                              <Check size={9} className="text-[var(--color-status-success)]" />
                            ) : (
                              <Copy size={9} />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Expanded Changed Files List */}
                  {isExpanded && (
                    <div className="flex items-stretch bg-[var(--color-surface-sunken)]">
                      {/* Timeline vertical line extension */}
                      <div className="w-12 flex-shrink-0 flex items-center justify-center relative">
                        <svg className="w-full h-full" viewBox="0 0 48 100" preserveAspectRatio="none">
                          {index < commits.length - 1 && (
                            <line
                              x1="24"
                              y1="0"
                              x2="24"
                              y2="100"
                              stroke={commits[index + 1].is_unpushed ? "var(--color-status-warning)" : "var(--color-border-default)"}
                              strokeWidth="2"
                            />
                          )}
                        </svg>
                      </div>

                      {/* Files list container */}
                      <div className="flex-1 pr-6 py-2.5 space-y-1.5 select-none font-mono text-[11px] text-[var(--text-normal)]">
                        <div className="text-[9px] uppercase font-bold text-[var(--text-muted)] tracking-wider mb-1 flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <span>Changed Files</span>
                            {loadingFiles ? <span>loading...</span> : <span>{commitFiles.length} item(s)</span>}
                          </div>

                          {/* Commit Rollback Actions */}
                          <div className="flex items-center space-x-2.5 font-mono select-none">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRevertCommit(commit.hash);
                              }}
                              className="text-[9px] hover:text-[var(--color-status-warning)] text-[var(--text-muted)] hover:underline cursor-pointer flex items-center space-x-1 font-bold"
                              title="Revert changes made by this commit"
                            >
                              <span>[ revert commit ]</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleResetToCommit(commit.hash);
                              }}
                              className="text-[9px] hover:text-[var(--color-status-danger)] text-[var(--text-muted)] hover:underline cursor-pointer flex items-center space-x-1 font-bold"
                              title="Hard reset branch to this commit point"
                            >
                              <span>[ reset branch to here ]</span>
                            </button>
                          </div>
                        </div>

                        {loadingFiles ? (
                          <div className="py-2 text-[10px] text-[var(--text-muted)] italic">
                            Loading modifications...
                          </div>
                        ) : commitFiles.length === 0 ? (
                          <div className="py-2 text-[10px] text-[var(--text-muted)] italic">
                            No files changed in this commit.
                          </div>
                        ) : (
                          <div className="space-y-0.5">
                            {commitFiles.map((file) => {
                              const statusColors = {
                                added: "text-[var(--color-status-success)] font-bold",
                                deleted: "text-[var(--color-status-danger)] font-bold",
                                modified: "text-[var(--color-status-warning)] font-bold",
                              };
                              const statusLabels = {
                                added: "A",
                                deleted: "D",
                                modified: "M",
                              };
                              const relativePath = file.path.replace(repoPath, "").replace(/^\//, "");

                              return (
                                <div
                                  key={file.path}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleOpenFileDiff(file.path, file.name, commit.hash, commit.short_hash);
                                  }}
                                  className="group/file flex items-center justify-between px-2 py-1 rounded hover:bg-[var(--accent-bg)]/25 cursor-pointer transition-colors border border-transparent hover:border-[var(--border-color)]/30"
                                >
                                  <div className="flex items-center space-x-2 truncate">
                                    <span className={`w-4 text-center text-[10px] font-bold ${statusColors[file.status_type as keyof typeof statusColors] || "text-[var(--color-fg-default)]"}`}>
                                      {statusLabels[file.status_type as keyof typeof statusLabels] || "M"}
                                    </span>
                                    <span className="text-[var(--text-normal)] group-hover/file:text-[var(--text-light)] truncate">
                                      {file.name}
                                    </span>
                                    <span className="text-[9px] text-[var(--text-muted)] truncate">
                                      {relativePath}
                                    </span>
                                  </div>
                                  <div className="opacity-0 group-hover/file:opacity-100 text-[10px] text-[var(--accent-color)] font-mono font-bold select-none pr-1">
                                    Compare &rarr;
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Confirmation Modal */}
      {ConfirmModalComponent}
    </div>
  );
};
