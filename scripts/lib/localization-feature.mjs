import { createRequire } from 'node:module';
import { verifyLocalizationBuild } from './localization-build.mjs';

const require = createRequire(import.meta.url);

export function loadLocalizationFeature(profiles) {
  verifyLocalizationBuild();
  const {
    createLocalizationFeature,
  } = require('../../dist/localization/bundle/feature-provider.mjs');
  return createLocalizationFeature(profiles);
}
