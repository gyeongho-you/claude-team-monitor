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
  refreshBoard: () => ipcRenderer.invoke('refresh-board'),
  adoptLead: (shortId: string) => ipcRenderer.invoke('adopt-lead', shortId),
  getInteractiveSessions: () => ipcRenderer.invoke('get-interactive-sessions'),
  forkSessionAsLead: (sessionId: string, cwd: string) => ipcRenderer.invoke('fork-session-as-lead', sessionId, cwd),
  launchTeamLead: (targetDir: string, instruction: string) =>
    ipcRenderer.invoke('launch-team-lead', targetDir, instruction),
  launchMember: (leadId: string, targetDir: string, instruction: string, role: string) =>
    ipcRenderer.invoke('launch-member', leadId, targetDir, instruction, role),
  getMemberTemplates: () => ipcRenderer.invoke('get-member-templates'),
  addMemberTemplate: (category: string, dir: string, name: string, role: string, instruction: string) =>
    ipcRenderer.invoke('add-member-template', category, dir, name, role, instruction),
  updateMemberTemplate: (id: string, fields: Record<string, string>) =>
    ipcRenderer.invoke('update-member-template', id, fields),
  toggleMemberTemplateApproved: (id: string) => ipcRenderer.invoke('toggle-member-template-approved', id),
  deleteMemberTemplate: (id: string) => ipcRenderer.invoke('delete-member-template', id),
  approveRequest: (requestId: string) => ipcRenderer.invoke('approve-request', requestId),
  denyRequest: (requestId: string) => ipcRenderer.invoke('deny-request', requestId),
  openInTerminal: (id: string) => ipcRenderer.invoke('open-in-terminal', id),
  getLeadTranscript: (leadId: string) => ipcRenderer.invoke('get-lead-transcript', leadId),
  sendToLead: (leadId: string, message: string) => ipcRenderer.invoke('send-to-lead', leadId, message),
  updateLeadLabel: (leadId: string, label: string) => ipcRenderer.invoke('update-lead-label', leadId, label),
  restartLead: (leadId: string, instruction: string) => ipcRenderer.invoke('restart-lead', leadId, instruction),
  endLeadWork: (leadId: string) => ipcRenderer.invoke('end-lead-work', leadId),
});
