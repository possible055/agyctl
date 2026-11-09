// Minimal load-confirmation bridge appended to the original Hub preload.
// Sandboxed-preload safe: only contextBridge/ipcRenderer, no Node builtins,
// no generic channels, no management surface (plan §7.4).
import { contextBridge, ipcRenderer } from 'electron';

const CONFIRM_CHANNEL = 'agyctl:localization:confirm';

contextBridge.exposeInMainWorld('agyctlLocalization', {
  confirm: (confirmation: { artifactId: string; locale: string }) =>
    ipcRenderer.invoke(CONFIRM_CHANNEL, confirmation),
});
