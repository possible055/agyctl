// The only coupling between the capsule and Antigravity's chat markup. A
// host-app selector change is a one-file fix here; `npm run capsule:install`
// refuses a client whose served web bundle no longer carries these anchors.
export const CAPSULE_ANCHORS = Object.freeze({
  permissionsTrigger: '[data-testid="permissions-selector-trigger"]',
  composer: '[data-testid="agent-input-box"]:not([data-side-panel-composer] *)',
  composerFooter: '.agy-composer-footer',
  composerCluster: '.shrink-0.flex.items-center.gap-0\\.5',
  composerClusterLast: '.shrink-0.flex.items-center:last-child',
  subComposer: '[data-side-panel-composer]',
  subagentTab: '[data-testid="subagent-tab-conversation"]',
  titlebarToolbar: '[data-testid="pane-titlebar-toolbar"] .flex.items-center.gap-1',
  titlebarMoreActions: '[data-testid="titlebar-more-actions"]',
  capsuleOwned: '[id^="agyctl-"]',
});

// Upstream class names the capsule's own markup borrows for styling. The
// build composes some of them at runtime, so only the stem is checkable.
export const UPSTREAM_STYLE_TOKENS = Object.freeze(['agy-button']);
