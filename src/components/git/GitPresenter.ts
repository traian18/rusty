import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../store";
import { notify } from "../../notificationStore";
import { GitActions } from "./GitActions";

export const gitPresenter: GitActions = {
  async commit(rootDir: string, message: string): Promise<void> {
    console.log(`GitPresenter: Committing staged changes at ${rootDir} with message: "${message}"`);
    try {
      await invoke("git_commit", { rootDir, message });
      await useWorkspaceStore.getState().loadGitStatus();
      notify("Commit Complete", "Successfully committed staged modifications.", "success");
    } catch (err: any) {
      console.error("Failed to commit git modifications:", err);
      // git_commit now rejects with a structured GitError object (PR 5a),
      // not a bare string -- String(err) would print "[object Object]" for
      // it. `?? String(err)` keeps this correct for the remaining
      // not-yet-converted commands' plain-string errors during the PR 5a
      // migration window.
      notify("Commit Failed", err?.message ?? String(err), "error");
      throw err;
    }
  },

  async push(rootDir: string, branchName: string): Promise<void> {
    console.log(`GitPresenter: Pushing branch ${branchName} at ${rootDir}`);
    try {
      await invoke("git_push", { rootDir, branchName });
      notify("Push Complete", "Successfully pushed local commits to remote.", "success");
    } catch (err: any) {
      console.error("Failed to push branch:", err);
      notify("Push Failed", String(err), "error");
      throw err;
    }
  },

  async pull(rootDir: string): Promise<void> {
    console.log(`GitPresenter: Pulling changes at ${rootDir}`);
    try {
      await invoke("git_pull", { rootDir });
      await useWorkspaceStore.getState().loadGitStatus();
      // Refresh directory tree
      const tree: any[] = await invoke("get_directory_structure", { rootDir });
      useWorkspaceStore.getState().setFileTree(tree);
      notify("Pull Complete", "Successfully pulled remote updates.", "success");
    } catch (err: any) {
      console.error("Failed to pull changes:", err);
      notify("Pull Failed", String(err), "error");
      throw err;
    }
  },

  async stageFile(rootDir: string, filePath: string): Promise<void> {
    console.log(`GitPresenter: Staging file ${filePath}`);
    try {
      await invoke("git_stage_file", { rootDir, filePath });
      await useWorkspaceStore.getState().loadGitStatus();
    } catch (err: any) {
      console.error(`Failed to stage file:`, err);
      notify("Stage Failed", String(err), "error");
      throw err;
    }
  },

  async unstageFile(rootDir: string, filePath: string): Promise<void> {
    console.log(`GitPresenter: Unstaging file ${filePath}`);
    try {
      await invoke("git_unstage_file", { rootDir, filePath });
      await useWorkspaceStore.getState().loadGitStatus();
    } catch (err: any) {
      console.error(`Failed to unstage file:`, err);
      notify("Unstage Failed", String(err), "error");
      throw err;
    }
  },

  async addToGitignore(rootDir: string, filePath: string): Promise<void> {
    console.log(`GitPresenter: Adding to .gitignore: ${filePath}`);
    try {
      await invoke("git_add_to_gitignore", { rootDir, filePath });
      await useWorkspaceStore.getState().loadGitStatus();
      const tree: any[] = await invoke("get_directory_structure", { rootDir });
      useWorkspaceStore.getState().setFileTree(tree);
      notify("Added to .gitignore", "File will no longer show up as a change.", "success");
    } catch (err: any) {
      console.error("Failed to add to .gitignore:", err);
      notify("Failed", String(err), "error");
      throw err;
    }
  },

  async discardChanges(
    rootDir: string,
    filePath: string,
    fileName: string,
    confirmFn: (title: string, msg: string) => Promise<boolean>
  ): Promise<void> {
    console.log(`GitPresenter: Request to discard changes in ${filePath}`);
    const confirmed = await confirmFn(
      "Discard Changes",
      `Are you sure you want to discard all unstaged changes in "${fileName}"? This cannot be undone.`
    );
    if (!confirmed) return;

    try {
      await invoke("git_discard_changes", { rootDir, filePath });
      await useWorkspaceStore.getState().loadGitStatus();
      // Reload directory tree
      const tree: any[] = await invoke("get_directory_structure", { rootDir });
      useWorkspaceStore.getState().setFileTree(tree);
      notify("Discarded Changes", `Discarded changes for ${fileName}`, "success");
    } catch (err: any) {
      console.error(`Failed to discard changes:`, err);
      notify("Discard Failed", String(err), "error");
      throw err;
    }
  },

  async discardAllChanges(
    rootDir: string,
    confirmFn: (title: string, msg: string) => Promise<boolean>
  ): Promise<void> {
    console.log(`GitPresenter: Request to discard ALL changes in ${rootDir}`);
    const confirmed = await confirmFn(
      "Discard All Changes",
      "Are you sure you want to discard ALL unstaged modifications and untracked files? This action CANNOT BE UNDONE."
    );
    if (!confirmed) return;

    try {
      await invoke("git_discard_all_changes", { rootDir });
      await useWorkspaceStore.getState().loadGitStatus();
      // Reload directory tree
      const tree: any[] = await invoke("get_directory_structure", { rootDir });
      useWorkspaceStore.getState().setFileTree(tree);
      notify("Discard complete", "All unstaged changes have been discarded.", "success");
    } catch (err: any) {
      console.error("Failed to discard all changes:", err);
      notify("Discard Failed", String(err), "error");
      throw err;
    }
  },

  async switchBranch(rootDir: string, branchName: string): Promise<void> {
    console.log(`GitPresenter: Checking out branch ${branchName}`);
    try {
      const result = await invoke<{ stashed: boolean; restored: boolean }>("git_smart_checkout_branch", { rootDir, branchName });
      // Unmount branch-specific editors and clear the old tree only after the
      // checkout succeeds, so a failed checkout leaves the current view intact.
      useWorkspaceStore.getState().resetForBranchChange();
      await useWorkspaceStore.getState().loadGitStatus();
      const tree: any[] = await invoke("get_directory_structure", { rootDir });
      useWorkspaceStore.getState().setFileTree(tree);
      const display = branchName.startsWith("origin/") ? branchName.substring(7) : branchName;
      const preserved = result.stashed ? " Current branch changes were saved." : "";
      const restored = result.restored ? " Saved branch changes were restored." : "";
      notify("Branch Switched", `Active branch is now: ${display}.${preserved}${restored}`, "success");
    } catch (err: any) {
      console.error("Failed to switch branch:", err);
      notify("Checkout Failed", String(err), "error");
      throw err;
    }
  },

  async createBranch(rootDir: string, branchName: string, checkout: boolean): Promise<void> {
    console.log(`GitPresenter: Creating branch ${branchName} (checkout: ${checkout})`);
    try {
      const result = await invoke<{ stashed: boolean; restored: boolean }>("git_smart_create_branch", { rootDir, branchName, checkout });
      if (checkout) {
        useWorkspaceStore.getState().resetForBranchChange();
        await useWorkspaceStore.getState().loadGitStatus();
        const tree: any[] = await invoke("get_directory_structure", { rootDir });
        useWorkspaceStore.getState().setFileTree(tree);
      }
      notify(
        "Branch Created",
        `Successfully created branch: ${branchName}.${result.stashed ? " Current branch changes were saved." : ""}`,
        "success"
      );
    } catch (err: any) {
      console.error("Failed to create branch:", err);
      notify("Creation Failed", String(err), "error");
      throw err;
    }
  },

  async deleteBranch(rootDir: string, branchName: string, force: boolean): Promise<void> {
    console.log(`GitPresenter: Deleting branch ${branchName} (force: ${force})`);
    try {
      if (branchName.startsWith("origin/")) {
        await invoke("git_delete_remote_branch", { rootDir, branchName });
      } else {
        await invoke("git_delete_branch", { rootDir, branchName, force });
      }
      await useWorkspaceStore.getState().loadGitStatus();
      notify("Branch Deleted", `Successfully deleted branch: ${branchName}`, "success");
    } catch (err: any) {
      console.error("Failed to delete branch:", err);
      notify("Deletion Failed", String(err), "error");
      throw err;
    }
  },

  async mergeBranch(rootDir: string, branchName: string): Promise<void> {
    console.log(`GitPresenter: Merging branch ${branchName} into current`);
    try {
      const result = await invoke("git_merge_branch", { rootDir, branchName });
      await useWorkspaceStore.getState().loadGitStatus();
      const tree: any[] = await invoke("get_directory_structure", { rootDir });
      useWorkspaceStore.getState().setFileTree(tree);
      notify("Merge Complete", String(result) || `Merged ${branchName} into current.`, "success");
    } catch (err: any) {
      const errMsg = String(err);
      if (errMsg.includes("conflict") || errMsg.includes("CONFLICT")) {
        notify("Merge Conflicts", "Merge conflicts detected. Resolve them and commit, or abort the merge.", "danger");
      } else {
        notify("Merge Failed", errMsg, "error");
      }
      throw err;
    }
  },

  async rebaseBranch(rootDir: string, branchName: string): Promise<void> {
    console.log(`GitPresenter: Rebasing current branch onto ${branchName}`);
    try {
      const result = await invoke("git_rebase_branch", { rootDir, branchName });
      await useWorkspaceStore.getState().loadGitStatus();
      const tree: any[] = await invoke("get_directory_structure", { rootDir });
      useWorkspaceStore.getState().setFileTree(tree);
      notify("Rebase Complete", String(result) || `Rebased onto ${branchName}.`, "success");
    } catch (err: any) {
      const errMsg = String(err);
      if (errMsg.includes("conflict") || errMsg.includes("CONFLICT")) {
        notify("Rebase Conflicts", "Conflicts detected. Resolve them and continue, or abort rebase.", "danger");
      } else {
        notify("Rebase Failed", errMsg, "error");
      }
      throw err;
    }
  },

  async abortPending(rootDir: string): Promise<void> {
    console.log(`GitPresenter: Aborting pending merge/rebase`);
    try {
      try {
        await invoke("git_abort_pending", { rootDir, operation: "rebase" });
      } catch {
        await invoke("git_abort_pending", { rootDir, operation: "merge" });
      }
      await useWorkspaceStore.getState().loadGitStatus();
      const tree: any[] = await invoke("get_directory_structure", { rootDir });
      useWorkspaceStore.getState().setFileTree(tree);
      notify("Operation Aborted", "Aborted pending conflict operation.", "success");
    } catch (err: any) {
      notify("Abort Failed", String(err), "error");
      throw err;
    }
  },

  async undoLastRename(rootDir: string, originalPath: string, newPath: string): Promise<void> {
    console.log(`GitPresenter: Undoing last move/rename: ${newPath} -> ${originalPath}`);
    try {
      await invoke("git_undo_last_rename", { rootDir, originalPath, newPath });
      await useWorkspaceStore.getState().loadGitStatus();
      const tree: any[] = await invoke("get_directory_structure", { rootDir });
      useWorkspaceStore.getState().setFileTree(tree);
      notify("Undo Complete", "Move/rename has been undone.", "success");
    } catch (err: any) {
      notify("Undo Failed", String(err), "error");
      throw err;
    }
  },

  async scanSubprojects(rootDir: string): Promise<string[]> {
    try {
      return await invoke<string[]>("git_scan_subprojects", { rootDir });
    } catch (err) {
      console.error("Failed to scan git subprojects:", err);
      return [];
    }
  },
};
