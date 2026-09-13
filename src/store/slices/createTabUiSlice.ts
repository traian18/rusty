import type { WorkspaceSliceCreator } from "../sliceTypes";
import type { Skill } from "../types";

/**
 * Tab-specific UI state that should persist even when the tab is inactive.
 * This fixes the issue where tabs lose their state when switched out of view
 * because local component useState is lost on unmount. By storing this in
 * Zustand, state persists across tab mount/unmount cycles.
 *
 * Each tab type gets its own section (skillsTabUi, llmSetupTabUi, etc.) to
 * keep concerns separated and make it easy to know which state belongs to
 * which tab.
 */

export interface SkillsTabUi {
  selectedSkillId: string | null;
  editingSkill: Partial<Skill> | null;
  isGenerating: boolean;
  generateError: string | null;
  genModel: string;
  genDescription: string;
  showSavedModal: boolean;
}

export interface LlmSetupTabUi {
  apiKey: string;
  baseUrl: string;
  catalogUrl: string;
  apiType: string;
  authType: "bearer" | "anthropic" | "none" | "environment";
  showKey: boolean;
  fetchingModels: boolean;
  testingConnection: boolean;
  connectionStatus: Record<string, "connected" | "failed">;
  signingOut: boolean;
}

export const createTabUiSlice: WorkspaceSliceCreator = (set) => ({
  skillsTabUi: {
    selectedSkillId: null,
    editingSkill: null,
    isGenerating: false,
    generateError: null,
    genModel: "",
    genDescription: "",
    showSavedModal: false,
  },

  setSkillsTabUi: (updates: Partial<SkillsTabUi>) =>
    set((state) => ({
      skillsTabUi: { ...state.skillsTabUi, ...updates },
    })),

  setSkillsTabSelectedSkillId: (id: string | null) =>
    set((state) => ({
      skillsTabUi: { ...state.skillsTabUi, selectedSkillId: id },
    })),

  setSkillsTabEditingSkill: (skill: Partial<Skill> | null) =>
    set((state) => ({
      skillsTabUi: { ...state.skillsTabUi, editingSkill: skill },
    })),

  setSkillsTabIsGenerating: (isGenerating: boolean) =>
    set((state) => ({
      skillsTabUi: { ...state.skillsTabUi, isGenerating },
    })),

  setSkillsTabGenerateError: (error: string | null) =>
    set((state) => ({
      skillsTabUi: { ...state.skillsTabUi, generateError: error },
    })),

  setSkillsTabGenModel: (model: string) =>
    set((state) => ({
      skillsTabUi: { ...state.skillsTabUi, genModel: model },
    })),

  setSkillsTabGenDescription: (description: string) =>
    set((state) => ({
      skillsTabUi: { ...state.skillsTabUi, genDescription: description },
    })),

  setSkillsTabShowSavedModal: (show: boolean) =>
    set((state) => ({
      skillsTabUi: { ...state.skillsTabUi, showSavedModal: show },
    })),

  llmSetupTabUi: {
    apiKey: "",
    baseUrl: "",
    catalogUrl: "",
    apiType: "openai-completions",
    authType: "bearer",
    showKey: false,
    fetchingModels: false,
    testingConnection: false,
    connectionStatus: {},
    signingOut: false,
  },

  setLlmSetupTabUi: (updates: Partial<LlmSetupTabUi>) =>
    set((state) => ({
      llmSetupTabUi: { ...state.llmSetupTabUi, ...updates },
    })),

  setLlmSetupTabApiKey: (key: string) =>
    set((state) => ({
      llmSetupTabUi: { ...state.llmSetupTabUi, apiKey: key },
    })),

  setLlmSetupTabBaseUrl: (url: string) =>
    set((state) => ({
      llmSetupTabUi: { ...state.llmSetupTabUi, baseUrl: url },
    })),

  setLlmSetupTabCatalogUrl: (url: string) =>
    set((state) => ({
      llmSetupTabUi: { ...state.llmSetupTabUi, catalogUrl: url },
    })),

  setLlmSetupTabApiType: (type: string) =>
    set((state) => ({
      llmSetupTabUi: { ...state.llmSetupTabUi, apiType: type },
    })),

  setLlmSetupTabAuthType: (type: "bearer" | "anthropic" | "none" | "environment") =>
    set((state) => ({
      llmSetupTabUi: { ...state.llmSetupTabUi, authType: type },
    })),

  setLlmSetupTabShowKey: (show: boolean) =>
    set((state) => ({
      llmSetupTabUi: { ...state.llmSetupTabUi, showKey: show },
    })),

  setLlmSetupTabFetchingModels: (fetching: boolean) =>
    set((state) => ({
      llmSetupTabUi: { ...state.llmSetupTabUi, fetchingModels: fetching },
    })),

  setLlmSetupTabTestingConnection: (testing: boolean) =>
    set((state) => ({
      llmSetupTabUi: { ...state.llmSetupTabUi, testingConnection: testing },
    })),

  setLlmSetupTabConnectionStatus: (
    status: Record<string, "connected" | "failed">
  ) =>
    set((state) => ({
      llmSetupTabUi: { ...state.llmSetupTabUi, connectionStatus: status },
    })),

  setLlmSetupTabSigningOut: (signingOut: boolean) =>
    set((state) => ({
      llmSetupTabUi: { ...state.llmSetupTabUi, signingOut },
    })),
});
