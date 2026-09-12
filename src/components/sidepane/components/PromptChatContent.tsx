import React from "react";
import { useWorkspaceStore } from "../../../store";
import { CustomSelect } from "../../CustomSelect";
import { DEFAULT_SKILL_ID } from "../../../config/skillDefinitions";
import { Chat } from "../../ui/Chat";
import { AgentQuestion, ChatInput } from "../../ui/ChatInput";
import type { SubagentActivity } from "../../ui/Chat";
import { useSelectableModels } from "../../../hooks/useSelectableModels";

interface PromptChatContentProps {
  selectedNode: any;
  nodeStatus: string;
  explorerInput: string;
  setExplorerInput: (value: string) => void;
  handleExplorerSendMessage: () => void;
  handleStopExplorer: () => void;
  streamingMessageId: string | null;
  subagents: SubagentActivity[];
  agentQuestion: AgentQuestion | null;
  handleAgentQuestionAnswer: (answer: string) => void;
}

const EMPTY_ARRAY: any[] = [];

const ModelSelector: React.FC<{ nodeId: string; nodeData: any }> = ({ nodeId, nodeData }) => {
  const activeModel = useWorkspaceStore((s) => s.activeModel);
  const providers = useWorkspaceStore((s) => s.customProviders);
  const activeProviderId = useWorkspaceStore((s) => s.activeCustomProviderId);
  const providerStatus = useWorkspaceStore((s) => s.providerStatus);
  const updateTaskNode = useWorkspaceStore((s) => s.updateTaskNode);
  const { options: modelOptions, unauthenticatedProviders } = useSelectableModels(
    providers,
    providerStatus,
    activeProviderId,
  );
  return (
    <CustomSelect
      value={nodeData.model || activeModel}
      onChange={(val) => updateTaskNode(nodeId, { model: val })}
      options={modelOptions}
      placeholder={modelOptions.length === 0 && unauthenticatedProviders.length > 0
        ? `Sign in to ${unauthenticatedProviders.map((p) => p.name).join(", ")}`
        : "Model"}
      className="w-28 text-[10px]"
      direction="up"
    />
  );
};

const SkillSelector: React.FC<{ nodeId: string; skillId?: string }> = ({ nodeId, skillId }) => {
  const skills = useWorkspaceStore((s) => s.skills);
  const updateTaskNode = useWorkspaceStore((s) => s.updateTaskNode);
  // Internal skills (e.g. vfs-agent) are not user-selectable and must be hidden.
  const selectableSkills = skills.filter((s) => !s.isInternal);
  return (
    <CustomSelect
      value={skillId || DEFAULT_SKILL_ID}
      onChange={(val) => updateTaskNode(nodeId, { skillId: val })}
      options={selectableSkills.map((s) => ({ id: s.id, name: s.name }))}
      placeholder="Skill"
      className="w-24 text-[10px]"
      direction="up"
    />
  );
};

export const PromptChatContent: React.FC<PromptChatContentProps> = ({
  selectedNode,
  nodeStatus,
  explorerInput,
  setExplorerInput,
  handleExplorerSendMessage,
  handleStopExplorer,
  streamingMessageId,
  subagents,
  agentQuestion,
  handleAgentQuestionAnswer,
}) => {
  const globalChatHistory = useWorkspaceStore(
    (state) => state.globalChatHistory[selectedNode?.id || ""] || EMPTY_ARRAY
  );

  const chatMessages = [
    {
      id: "system-agent-init",
      role: "assistant" as const,
      content: "I will check the attached file inputs and execute your modifications. You can type instructions below to refine my work.",
      timestamp: "",
    },
    ...globalChatHistory
      .filter((msg: any, idx: number) => !(idx === 0 && msg.role === "user"))
      .map((msg: any, idx: number) => ({
        id: msg.id || `task-msg-${idx}`,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp || "",
        attachments: msg.attachments,
      })),
  ];

  return (
    <div className="flex flex-col h-full bg-[var(--bg-app)]">
      {/* Reusable Chat History List */}
      <Chat
        messages={chatMessages}
        isStreaming={nodeStatus === "running"}
        streamingMessageId={streamingMessageId}
        compact
        followLatest
        subagents={subagents}
      />

      {/* Model & Skill selectors */}
      {selectedNode?.type === "taskNode" && (
        <div className="flex items-center space-x-2 px-3 py-1.5 border-t border-[var(--border-color)] bg-[var(--bg-sidebar)]/10 flex-shrink-0">
          <span className="text-[9px] text-[var(--text-muted)] font-sans uppercase font-semibold">M:</span>
          <ModelSelector nodeId={selectedNode.id} nodeData={selectedNode.data} />
          <span className="text-[9px] text-[var(--text-muted)] font-sans uppercase font-semibold">S:</span>
          <SkillSelector nodeId={selectedNode.id} skillId={selectedNode.data?.skillId} />
        </div>
      )}

      {/* Reusable Chat Input area */}
      <div className="p-3 border-t border-[var(--border-color)] bg-[var(--bg-sidebar)]/20 flex-shrink-0">
        <ChatInput
          value={explorerInput}
          onChange={setExplorerInput}
          onSend={handleExplorerSendMessage}
          disabled={nodeStatus === "running"}
          isStreaming={nodeStatus === "running"}
          onStop={handleStopExplorer}
          agentQuestion={agentQuestion}
          onAgentQuestionAnswer={handleAgentQuestionAnswer}
          placeholder="Refine work, prompt modifications... (type @ to reference files)"
        />
      </div>
    </div>
  );
};
