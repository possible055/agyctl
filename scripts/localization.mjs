// Thin CLI entry for the built offline localization tool (plan §10.1).
import { verifyLocalizationBuild } from './lib/localization-build.mjs';

verifyLocalizationBuild();
const { runLocalizationCommand } = await import('../dist/localization/bundle/localization-cli.mjs');

process.exitCode = await runLocalizationCommand(process.argv.slice(2));
