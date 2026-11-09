import vm from 'node:vm';
import { ComposerError } from '../host/contracts.js';
import type { CapsuleFeatureInput } from '../host/inputs.js';
import type { HostFeature } from '../host/features.js';
import { buildCapsulePreloadHook } from './preload-hook.js';

export { buildCapsulePreloadHook } from './preload-hook.js';

export const capsuleFeature: HostFeature<CapsuleFeatureInput> = {
  validate({ code }) {
    if (typeof code !== 'string' || !code.trim())
      throw new ComposerError('HOST_CONFLICT', 'Capsule code must be nonempty JavaScript');
    new vm.Script(code, { filename: 'input-capsule.js' });
  },
  compose({ code }) {
    return {
      preload: buildCapsulePreloadHook(code),
      files: { 'dist/input-capsule.js': Buffer.from(code, 'utf8') },
    };
  },
};
