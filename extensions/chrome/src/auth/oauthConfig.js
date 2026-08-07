export const OAUTH_CONFIG = Object.freeze({
  // Public application identifier registered for the Chrome Web Store item.
  // It is shared by every install; each user still receives their own tokens.
  clientId: 'verboo-code-chrome-extension',
  authorizeUrl: 'https://code.verboo.ai/oauth/authorize',
  tokenUrl: 'https://code.verboo.ai/oauth/token',
  scopes: Object.freeze(['user:profile', 'user:inference']),
})

export default OAUTH_CONFIG
