import { create } from "zustand";
import { createAgentSlice } from "./store/slices/createAgentSlice";
import { createCanvasSlice } from "./store/slices/createCanvasSlice";
import { createTabsSlice } from "./store/slices/createTabsSlice";
import { createGitSlice } from "./store/slices/createGitSlice";
import { createIntegrationSlice } from "./store/slices/createIntegrationSlice";
import { createMetricsSlice } from "./store/slices/createMetricsSlice";
import { createPreferencesSlice } from "./store/slices/createPreferencesSlice";
import { createTerminalSlice } from "./store/slices/createTerminalSlice";
import { createWorkspaceSlice } from "./store/slices/createWorkspaceSlice";
import type { WorkspaceState } from "./store/types";

export * from "./store/types";

export const useWorkspaceStore = create<WorkspaceState>()((...args) => ({
  ...createWorkspaceSlice(...args),
  ...createGitSlice(...args),
  ...createTerminalSlice(...args),
  ...createTabsSlice(...args),
  ...createCanvasSlice(...args),
  ...createAgentSlice(...args),
  ...createIntegrationSlice(...args),
  ...createMetricsSlice(...args),
  ...createPreferencesSlice(...args),
}) as WorkspaceState);
