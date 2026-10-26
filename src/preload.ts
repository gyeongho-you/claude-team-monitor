import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('api', {
  onAgentsUpdate: (callback: (payload: unknown) => void) => {
    ipcRenderer.on('agents-update', (_e, payload) => callback(payload));
  },
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  getMemberActivity: (cwd: string, sessionId: string) => ipcRenderer.invoke('get-member-activity', cwd, sessionId),
  getSubagentActivity: (leadId: string, agentId: string) => ipcRenderer.invoke('get-subagent-activity', leadId, agentId),
  getBackgroundTasks: (leadId: string) => ipcRenderer.invoke('get-background-tasks', leadId),
  getTaskOutput: (leadId: string, taskId: string) => ipcRenderer.invoke('get-task-output', leadId, taskId),
  savePastedImage: (dataBase64: string, mime: string) => ipcRenderer.invoke('save-pasted-image', dataBase64, mime),
  // Electron은 창에 떨어뜨린 파일을 HTML5 drop으로 주고, 경로는 webUtils.getPathForFile로 얻는다.
  onFilesDropped: (callback: (paths: string[]) => void) => {
    // tsconfig가 DOM 타입을 안 쓰므로 필요한 모양만 직접 적는다.
    type DropEventLike = { preventDefault(): void; dataTransfer?: { files: ArrayLike<unknown> } | null };
    const win = globalThis as unknown as { addEventListener(type: string, cb: (e: DropEventLike) => void): void };
    win.addEventListener('dragover', e => e.preventDefault());
    win.addEventListener('drop', e => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []) as Parameters<typeof webUtils.getPathForFile>[0][];
      const paths = files.map(f => webUtils.getPathForFile(f)).filter(Boolean);
      if (paths.length) callback(paths);
    });
  },
  getFavorites: () => ipcRenderer.invoke('get-favorites'),
  addFavorite: (dir: string) => ipcRenderer.invoke('add-favorite', dir),
  removeFavorite: (dir: string) => ipcRenderer.invoke('remove-favorite', dir),
  updateFavoriteName: (dir: string, name: string) => ipcRenderer.invoke('update-favorite-name', dir, name),
  getAdoptableSessions: () => ipcRenderer.invoke('get-adoptable-sessions'),
  getAllBackgroundSessions: () => ipcRenderer.invoke('get-all-background-sessions'),
  stopBackgroundSession: (shortId: string) => ipcRenderer.invoke('stop-background-session', shortId),
  registerProbableMember: (agentId: string, leadId: string) => ipcRenderer.invoke('register-probable-member', agentId, leadId),
  refreshBoard: () => ipcRenderer.invoke('refresh-board'),
  adoptLead: (shortId: string) => ipcRenderer.invoke('adopt-lead', shortId),
  getInteractiveSessions: () => ipcRenderer.invoke('get-interactive-sessions'),
  forkSessionAsLead: (sessionId: string, cwd: string) => ipcRenderer.invoke('fork-session-as-lead', sessionId, cwd),
  launchTeamLead: (targetDir: string, instruction: string, label?: string, secret?: boolean) =>
    ipcRenderer.invoke('launch-team-lead', targetDir, instruction, label, secret),
  launchMember: (leadId: string, targetDir: string, instruction: string, role: string, label: string, model?: string) =>
    ipcRenderer.invoke('launch-member', leadId, targetDir, instruction, role, label, model),
  getMemberTemplates: () => ipcRenderer.invoke('get-member-templates'),
  addMemberTemplate: (scope: string, dir: string, name: string, role: string, instruction: string, model?: string) =>
    ipcRenderer.invoke('add-member-template', scope, dir, name, role, instruction, model),
  updateMemberTemplate: (id: string, fields: Record<string, string>) =>
    ipcRenderer.invoke('update-member-template', id, fields),
  toggleMemberTemplateApproved: (id: string) => ipcRenderer.invoke('toggle-member-template-approved', id),
  deleteMemberTemplate: (id: string) => ipcRenderer.invoke('delete-member-template', id),
  approveRequest: (requestId: string) => ipcRenderer.invoke('approve-request', requestId),
  denyRequest: (requestId: string) => ipcRenderer.invoke('deny-request', requestId),
  openInTerminal: (id: string) => ipcRenderer.invoke('open-in-terminal', id),
  openTerminalForApproval: (targetDir: string) => ipcRenderer.invoke('open-terminal-for-approval', targetDir),
  getLeadTranscript: (leadId: string) => ipcRenderer.invoke('get-lead-transcript', leadId),
  getPendingChoice: (shortId: string) => ipcRenderer.invoke('get-pending-choice', shortId),
  getChatUnresolvableDetail: (shortId: string) => ipcRenderer.invoke('get-chat-unresolvable-detail', shortId),
  getBlockedNeeds: (shortId: string) => ipcRenderer.invoke('get-blocked-needs', shortId),
  getChangedFiles: (cwd: string) => ipcRenderer.invoke('get-changed-files', cwd),
  getFileDiff: (cwd: string, file: string) => ipcRenderer.invoke('get-file-diff', cwd, file),
  sendToLead: (leadId: string, message: string) => ipcRenderer.invoke('send-to-lead', leadId, message),
  cancelQueuedMessage: (leadId: string, noticeId: string) => ipcRenderer.invoke('cancel-queued-message', leadId, noticeId),
  deleteLeadHistory: (internalId: string) => ipcRenderer.invoke('delete-lead-history', internalId),
  getPendingNoticeIds: (leadId: string) => ipcRenderer.invoke('get-pending-notice-ids', leadId),
  getStallAlerts: () => ipcRenderer.invoke('get-stall-alerts'),
  confirmStallAlert: (alertId: string) => ipcRenderer.invoke('confirm-stall-alert', alertId),
  dismissStallAlert: (alertId: string) => ipcRenderer.invoke('dismiss-stall-alert', alertId),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (partial: Record<string, number>) => ipcRenderer.invoke('update-settings', partial),
  setLeadAutoStallNudge: (leadId: string, value: boolean) => ipcRenderer.invoke('set-lead-auto-stall-nudge', leadId, value),
  updateLeadLabel: (leadId: string, label: string) => ipcRenderer.invoke('update-lead-label', leadId, label),
  restartLead: (leadId: string, instruction: string) => ipcRenderer.invoke('restart-lead', leadId, instruction),
  emergencyStopLead: (leadId: string) => ipcRenderer.invoke('emergency-stop-lead', leadId),
  endLeadWork: (leadId: string) => ipcRenderer.invoke('end-lead-work', leadId),
});
