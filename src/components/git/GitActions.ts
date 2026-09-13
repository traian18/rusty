// Re-exported from the single shared definition (REFACTOR_PLAN.md PR 5b
// commit 14) -- this file used to declare its own copy that had drifted
// from src/store/types.ts's (this one had "renamed", that one didn't;
// neither had "copied").
export type { GitFileStatus } from "../../store/types";

/**
 * Git Actions Interface
 * 
 * Formalizes all capabilities of the independent Git integration.
 * Enables clean extensibility for multiple repos or subprojects.
 */
export interface GitActions {
  commit: (rootDir: string, message: string) => Promise<void>;
  push: (rootDir: string, branchName: string) => Promise<void>;
  pull: (rootDir: string) => Promise<void>;
  stageFile: (rootDir: string, filePath: string) => Promise<void>;
  unstageFile: (rootDir: string, filePath: string) => Promise<void>;
  addToGitignore: (rootDir: string, filePath: string) => Promise<void>;
  discardChanges: (
    rootDir: string,
    filePath: string,
    fileName: string,
    confirmFn: (title: string, msg: string) => Promise<boolean>
  ) => Promise<void>;
  discardAllChanges: (
    rootDir: string,
    confirmFn: (title: string, msg: string) => Promise<boolean>
  ) => Promise<void>;
  switchBranch: (rootDir: string, branchName: string) => Promise<void>;
  createBranch: (rootDir: string, branchName: string, checkout: boolean) => Promise<void>;
  deleteBranch: (rootDir: string, branchName: string, force: boolean) => Promise<void>;
  mergeBranch: (rootDir: string, branchName: string) => Promise<void>;
  rebaseBranch: (rootDir: string, branchName: string) => Promise<void>;
  abortPending: (rootDir: string) => Promise<void>;
  undoLastRename: (rootDir: string, originalPath: string, newPath: string) => Promise<void>;
}
