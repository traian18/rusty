import type { WorkspaceSliceCreator } from "../sliceTypes";

export const createAgentSlice: WorkspaceSliceCreator = (set) => ({
  agentChats: {},
  agentStreams: {},
  agentPermissionRequests: {},

  addAgentMessage: (tabId, message) => set((state) => {
    // An agent tab's WebSocket is torn down on unmount, which happens after
    // the tab (and its chat) have already been pruned. Without this guard a
    // late message would recreate the key, and the next agent tab -- which
    // reuses the same singleton id -- would inherit the orphaned history.
    const existing = state.agentChats[tabId];
    if (!existing) return {};
    return { agentChats: { ...state.agentChats, [tabId]: [...existing, message] } };
  }),

  updateAgentMessage: (tabId, messageId, content) => set((state) => ({
    agentChats: {
      ...state.agentChats,
      [tabId]: (state.agentChats[tabId] || []).map((message) =>
        message.id === messageId ? { ...message, content } : message,
      ),
    },
  })),

  setAgentMessages: (tabId, messages) => set((state) => {
    if (!state.agentChats[tabId]) return {};
    return { agentChats: { ...state.agentChats, [tabId]: messages } };
  }),

  clearAgentMessages: (tabId) => set((state) => ({
    agentChats: { ...state.agentChats, [tabId]: [] },
  })),

  updateAgentStream: (tabId, content) => set((state) => {
    if (!state.agentChats[tabId]) return {};
    return { agentStreams: { ...state.agentStreams, [tabId]: content } };
  }),

  clearAgentStream: (tabId) => set((state) => {
    const agentStreams = { ...state.agentStreams };
    delete agentStreams[tabId];
    return { agentStreams };
  }),

  addAgentPermissionRequest: (tabId, request) => set((state) => {
    if (!state.agentChats[tabId]) return {};
    return {
      agentPermissionRequests: {
        ...state.agentPermissionRequests,
        [tabId]: [...(state.agentPermissionRequests[tabId] || []), request],
      },
    };
  }),

  resolveAgentPermission: (tabId, requestId, approved) => set((state) => ({
    agentPermissionRequests: {
      ...state.agentPermissionRequests,
      [tabId]: (state.agentPermissionRequests[tabId] || []).map((request) =>
        request.id === requestId
          ? { ...request, status: approved ? "approved" as const : "denied" as const }
          : request,
      ),
    },
  })),
});
