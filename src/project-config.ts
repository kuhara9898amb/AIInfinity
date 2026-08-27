import './env.js';
import mysql from 'mysql2/promise';

export type ProjectKey =
  | 'aiinfinity'
  | 'dashboard98'
  | 'sages'
  | 'monkeyai'
  | 'mcpv4'
  | 'soreai'
  | 'sugoi_ai_site_shindan';

export type ProjectConfig = {
  key: ProjectKey;
  label: string;
  laravelRoot: string;
  db: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
};

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function dbConfig(prefix: string) {
  return {
    host: env(`${prefix}_DB_HOST`, '127.0.0.1'),
    port: Number(env(`${prefix}_DB_PORT`, '3307')),
    database: env(`${prefix}_DB_NAME`),
    user: env(`${prefix}_DB_USER`),
    password: env(`${prefix}_DB_PASSWORD`),
  };
}

export const projects: Record<ProjectKey, ProjectConfig> = {
  aiinfinity: {
    key: 'aiinfinity',
    label: 'AI Infinity',
    laravelRoot: env(
      'AI_INFINITY_LARAVEL_ROOT',
      '/Users/erka/AIInfinity/dashboard'
    ),
    db: dbConfig('AI_INFINITY'),
  },

  dashboard98: {
    key: 'dashboard98',
    label: 'Dashboard98',
    laravelRoot: env(
      'DASHBOARD98_LARAVEL_ROOT',
      '/Users/erka/Dashboard98'
    ),
    db: dbConfig('DASHBOARD98'),
  },

  sages: {
    key: 'sages',
    label: 'SAGES',
    laravelRoot: env(
      'SAGES_LARAVEL_ROOT',
      '/Users/erka/SAGES'
    ),
    db: dbConfig('SAGES'),
  },

  monkeyai: {
    key: 'monkeyai',
    label: 'MonkeyAI',
    laravelRoot: env(
      'MONKEYAI_LARAVEL_ROOT',
      '/Users/erka/MonkeyAI'
    ),
    db: dbConfig('MONKEYAI'),
  },
  soreai: {
    key: 'soreai',
    label: 'それAI',
    laravelRoot: env('SOREAI_LARAVEL_ROOT', '/Users/erka/SoreAI'),
    db: {
      host: env('SOREAI_DB_HOST', env('AI_INFINITY_DB_HOST', '127.0.0.1')),
      port: Number(env('SOREAI_DB_PORT', env('AI_INFINITY_DB_PORT', '3307'))),
      database: env('SOREAI_DB_NAME', 'sore_ai'),
      user: env('SOREAI_DB_USER', env('AI_INFINITY_DB_USER')),
      password: env('SOREAI_DB_PASSWORD', env('AI_INFINITY_DB_PASSWORD')),
    },
  },
  sugoi_ai_site_shindan: {
    key: 'sugoi_ai_site_shindan',
    label: 'すごいAIサイト診断',
    laravelRoot: env('SUGOI_AI_SITE_SHINDAN_LARAVEL_ROOT', '/Users/erka/SugoiAISiteShindan'),
    db: {
      host: env('SUGOI_AI_SITE_SHINDAN_DB_HOST', env('AI_INFINITY_DB_HOST', '127.0.0.1')),
      port: Number(env('SUGOI_AI_SITE_SHINDAN_DB_PORT', env('AI_INFINITY_DB_PORT', '3307'))),
      database: env('SUGOI_AI_SITE_SHINDAN_DB_NAME', 'sugoi_ai_site_shindan'),
      user: env('SUGOI_AI_SITE_SHINDAN_DB_USER', env('AI_INFINITY_DB_USER')),
      password: env('SUGOI_AI_SITE_SHINDAN_DB_PASSWORD', env('AI_INFINITY_DB_PASSWORD')),
    },
  },
  mcpv4: {
    key: 'mcpv4',
    label: 'AI Infinity MCP v4',
    laravelRoot: env(
      'MCP_V4_ROOT',
      '/Users/erka/AIInfinity/mysql-mcp-v4'
    ),
    db: dbConfig('AI_INFINITY'),
  },
};

export function getProject(key: ProjectKey): ProjectConfig {
  const project = projects[key];

  if (!project) {
    throw new Error(`未対応プロジェクトです: ${key}`);
  }

  return project;
}

export function createProjectPool(key: ProjectKey) {
  const project = getProject(key);

  return mysql.createPool({
    host: project.db.host,
    port: project.db.port,
    database: project.db.database,
    user: project.db.user,
    password: project.db.password,

    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,

    decimalNumbers: true,
    dateStrings: true,
  });
}
