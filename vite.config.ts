import { defineConfig, type Plugin } from 'vite';

// Strict Content-Security-Policy for the production build only. The Vite dev
// server needs inline styles and a live-reload connection, so the policy is
// injected at build time instead of living in index.html.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function productionCsp(): Plugin {
  return {
    name: 'shiftfair-production-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

// Static build with relative asset paths so dist/ can be served from any sub-path.
export default defineConfig({
  base: './',
  plugins: [productionCsp()],
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0, modulePreload: false },
});
