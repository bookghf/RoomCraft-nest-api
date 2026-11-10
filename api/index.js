// Vercel serverless function: every path is rewritten here (see vercel.json).
// The TypeScript is compiled to dist/ by `npm run build` during the Vercel build.
module.exports = require('../dist/vercel').default;
