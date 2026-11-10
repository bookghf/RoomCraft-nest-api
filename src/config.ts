// Settings from environment variables. Same names and defaults as the Go API.

export interface Config {
  port: string;
  mongoURI: string;
  mongoDB: string;
  jwtSecret: string;
  jwtIssuer: string;
  authDev: boolean;
  corsOrigins: string[];
  seedOnStart: boolean;
  shareBase: string;
  /** Share link lifetime in milliseconds; 0 means links never expire. */
  shareTTLms: number;
  writesPerMinute: number;

  // Back office: staff sign in with email and password and get a token signed with adminJWTSecret.
  adminJWTSecret: string;
  /** Staff session length in milliseconds. */
  adminTokenTTLms: number;
  // The first owner account is created from these when there are no staff yet.
  adminEmail: string;
  adminPassword: string;
}

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v ? v : fallback;
}

// Like Go's strconv.ParseBool: 1, t, T, TRUE, true, True, 0, f, F, FALSE, false, False.
function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key] ?? '';
  if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(v)) return true;
  if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(v)) return false;
  return fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key] ?? '';
  return /^[+-]?\d+$/.test(v) ? parseInt(v, 10) : fallback;
}

const HOUR = 60 * 60 * 1000;

export function loadConfig(): Config {
  const c: Config = {
    port: env('PORT', '8080'),
    mongoURI: env('MONGO_URI', 'mongodb://localhost:27017'),
    mongoDB: env('MONGO_DB', 'roomcraft'),
    jwtSecret: process.env.JWT_SECRET ?? '',
    jwtIssuer: process.env.JWT_ISSUER ?? '',
    authDev: envBool('AUTH_DEV', false),
    seedOnStart: envBool('SEED_ON_START', false),
    shareBase: env('SHARE_BASE_URL', 'https://roomcraft-sable.vercel.app').replace(/\/+$/, ''),
    shareTTLms: envInt('SHARE_TTL_DAYS', 0) * 24 * HOUR,
    writesPerMinute: envInt('WRITES_PER_MINUTE', 60),
    adminJWTSecret: process.env.ADMIN_JWT_SECRET ?? '',
    adminTokenTTLms: envInt('ADMIN_TOKEN_TTL_HOURS', 8) * HOUR,
    adminEmail: (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase(),
    adminPassword: process.env.ADMIN_PASSWORD ?? '',
    corsOrigins: env('CORS_ORIGINS', 'http://localhost:3000,https://roomcraft-sable.vercel.app')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
  if (!c.jwtSecret && !c.authDev) {
    throw new Error('JWT_SECRET is required (or set AUTH_DEV=true for local development)');
  }
  if (c.adminJWTSecret.length < 32) {
    throw new Error('ADMIN_JWT_SECRET must be at least 32 characters');
  }
  return c;
}

let cached: Config | undefined;

/** The config, read once per process. */
export function config(): Config {
  cached ??= loadConfig();
  return cached;
}
