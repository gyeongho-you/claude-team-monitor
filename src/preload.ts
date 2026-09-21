import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  onAgentsUpdate: (callback: (payload: unknown) => void) => {
    ipcRenderer.on('agents-update', (_e, payload) => callback(payload));
  },
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
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
  endLeadWork: (leadId: string) => ipcRenderer.invoke('end-lead-work', leadId),
});
