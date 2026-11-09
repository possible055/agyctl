import { HOST_CAPSULE_FEATURE_MARKER } from '../host/contracts.js';

export function buildCapsulePreloadHook(capsuleCode: string): string {
  return `\n${HOST_CAPSULE_FEATURE_MARKER}\ntry {\n  const _code = ${JSON.stringify(capsuleCode)};\n  const _inject = () => {\n    void Promise.resolve().then(() => require('electron').webFrame.executeJavaScript(_code)).catch(error => console.warn('agyctl capsule activation failed', error));\n  };\n  _inject();\n} catch (error) { console.warn('agyctl capsule activation failed', error); }\n`;
}
