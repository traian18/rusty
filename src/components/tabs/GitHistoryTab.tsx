import React from "react";
import { GitHistoryTabContent } from "../GitHistoryTabContent";
import type { TabOfType } from "../../tabs/types";

interface GitHistoryTabProps {
  tab: TabOfType<"git-history">;
}

export const GitHistoryTab: React.FC<GitHistoryTabProps> = ({ tab }) => {
  return <GitHistoryTabContent tab={tab} />;
};
