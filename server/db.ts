import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import initSqlJs, { Database, SqlValue } from 'sql.js';

let SQL: any = null;
let db: Database | null = null;

// Configurable database directory and file path supporting Docker, VPS, Dokploy, and local environments
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = process.env.SQLITE_DB_PATH || process.env.DB_PATH || path.join(DATA_DIR, 'academy.sqlite');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

let saveTimeout: NodeJS.Timeout | null = null;

// ============================================================================
// PASSWORD ENCRYPTION & VERIFICATION (Backward compatible SHA-256 HMAC + Salt)
// ============================================================================
export function hashPassword(plainText: any, salt?: string): string {
  if (!plainText) return '';
  const str = String(plainText).trim();
  if (str.startsWith('s256$')) return str;
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', s).update(str).digest('hex');
  return `s256$${s}$${hash}`;
}

export function verifyPassword(inputPassword: any, storedPassword: any): boolean {
  if (!inputPassword || !storedPassword) return false;
  const trimmedInput = String(inputPassword).trim();
  const trimmedStored = String(storedPassword).trim();

  // Salted SHA-256 HMAC
  if (trimmedStored.startsWith('s256$')) {
    const parts = trimmedStored.split('$');
    if (parts.length === 3) {
      const s = parts[1];
      const expectedHash = parts[2];
      const actualHash = crypto.createHmac('sha256', s).update(trimmedInput).digest('hex');
      try {
        return crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash));
      } catch {
        return false;
      }
    }
  }

  // Legacy 64-char plain hex SHA-256
  if (/^[a-f0-9]{64}$/i.test(trimmedStored)) {
    const legacyHash = crypto.createHash('sha256').update(trimmedInput).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(legacyHash.toLowerCase()), Buffer.from(trimmedStored.toLowerCase()));
    } catch {
      return false;
    }
  }

  // Plaintext fallback for initial development accounts (will be upgraded on next save)
  return trimmedStored === trimmedInput;
}

// ============================================================================
// DATABASE FILE PERSISTENCE (ACID Write-Ahead Cache Flush)
// ============================================================================
export function persistDb(immediate = false): void {
  if (!db) return;

  const doSave = () => {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const data = db!.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
    } catch (err) {
      console.error('[SQLite] Failed to persist database to disk:', err);
    }
  };

  if (immediate) {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    doSave();
  } else {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(doSave, 250);
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================
export async function initDatabase(): Promise<Database> {
  if (db) return db;

  if (!SQL) {
    SQL = await initSqlJs();
  }

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }

  if (fs.existsSync(DB_PATH)) {
    try {
      const fileBuffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(fileBuffer);
      console.log(`[SQLite] Loaded existing database from ${DB_PATH}`);
      ensureTables(db);
      runMigrations(db);
      seedInitialData(db);
      persistDb(true);
      return db;
    } catch (e) {
      console.warn('[SQLite] Corrupt or unreadable database file, initializing fresh database:', e);
      db = new SQL.Database();
      ensureTables(db);
      runMigrations(db);
      seedInitialData(db);
      persistDb(true);
      return db;
    }
  } else {
    console.log(`[SQLite] Creating new database at ${DB_PATH}`);
    db = new SQL.Database();
    ensureTables(db);
    runMigrations(db);
    seedInitialData(db);
    persistDb(true);
    return db;
  }
}

export function getDb(): Database {
  if (!db) {
    throw new Error('Database not initialized! Call initDatabase() first.');
  }
  return db;
}

function sanitizeSqlParams(params: any = []): SqlValue[] {
  return (Array.isArray(params) ? params : [params]).map((p) => (p === undefined ? null : p));
}

export function query(sqlStr: string, params: any = []): any[] {
  const database = getDb();
  const stmt = database.prepare(sqlStr);
  const safeParams = sanitizeSqlParams(params);
  if (safeParams.length > 0) {
    stmt.bind(safeParams);
  }
  const rows: any[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

export function queryOne(sqlStr: string, params: any = []): any | null {
  const rows = query(sqlStr, params);
  return rows.length > 0 ? rows[0] : null;
}

export function run(sqlStr: string, params: any = []): { changes: number } {
  const database = getDb();
  const safeParams = sanitizeSqlParams(params);
  if (safeParams.length > 0) {
    database.run(sqlStr, safeParams);
  } else {
    database.run(sqlStr);
  }
  const changes = database.getRowsModified();
  persistDb(true);
  return { changes };
}

// ============================================================================
// SCHEMA DEFINITION & MIGRATIONS
// ============================================================================
function addColumnIfNotExists(database: Database, table: string, column: string, colDef: string) {
  try {
    const info = database.exec(`PRAGMA table_info(${table})`);
    if (info.length > 0 && info[0].values) {
      const colNames = info[0].values.map((v) => String(v[1]).toLowerCase());
      if (!colNames.includes(column.toLowerCase())) {
        const safeCol = column.startsWith('"') ? column : `"${column}"`;
        database.run(`ALTER TABLE ${table} ADD COLUMN ${safeCol} ${colDef};`);
      }
    }
  } catch (e) {}
}

export function ensureTables(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      student_group TEXT DEFAULT 'Группа 1 (Август 2026)',
      status TEXT DEFAULT 'Active',
      unlocked_lessons_count INTEGER DEFAULT 1,
      completed_lessons_count INTEGER DEFAULT 0,
      completed_labs_count INTEGER DEFAULT 0,
      passed_quiz_count INTEGER DEFAULT 0,
      attendance_pct INTEGER DEFAULT 100,
      total_points INTEGER DEFAULT 0,
      registered_at TEXT,
      phone TEXT,
      telegram TEXT,
      bio TEXT,
      avatar_url TEXT,
      hidden_from_leaderboard INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS lessons_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_email TEXT NOT NULL,
      lesson_id INTEGER NOT NULL,
      is_completed INTEGER DEFAULT 0,
      completed_at TEXT,
      read_sections TEXT,
      UNIQUE(student_email, lesson_id)
    );

    CREATE TABLE IF NOT EXISTS homework_submissions (
      id TEXT PRIMARY KEY,
      lesson_id INTEGER NOT NULL,
      lesson_title TEXT,
      student_id TEXT,
      student_name TEXT,
      student_email TEXT NOT NULL,
      report_text TEXT,
      student_notes TEXT,
      file_url TEXT,
      repo_url TEXT,
      github_url TEXT,
      attached_files TEXT,
      submitted_at TEXT NOT NULL,
      status TEXT DEFAULT 'Submitted',
      submission_status TEXT DEFAULT 'Submitted',
      is_completed INTEGER DEFAULT 0,
      score INTEGER,
      feedback TEXT,
      mentor_feedback TEXT,
      reviewed_at TEXT,
      reviewed_by TEXT
    );

    CREATE TABLE IF NOT EXISTS lab_submissions (
      id TEXT PRIMARY KEY,
      lab_id INTEGER NOT NULL,
      lesson_id INTEGER,
      student_id TEXT,
      student_name TEXT,
      student_email TEXT NOT NULL,
      report_text TEXT,
      student_notes TEXT,
      repo_url TEXT,
      file_url TEXT,
      demo_url TEXT,
      tasks_data TEXT,
      attached_files TEXT,
      submitted_at TEXT NOT NULL,
      status TEXT DEFAULT 'Submitted',
      submission_status TEXT DEFAULT 'Submitted',
      score INTEGER DEFAULT 0,
      feedback TEXT,
      mentor_feedback TEXT,
      reviewed_at TEXT,
      reviewed_by TEXT
    );

    CREATE TABLE IF NOT EXISTS quiz_submissions (
      id TEXT PRIMARY KEY,
      quiz_id TEXT NOT NULL,
      lesson_id INTEGER,
      quiz_title TEXT,
      student_id TEXT,
      student_name TEXT,
      student_email TEXT NOT NULL,
      score_pct INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      correct_count INTEGER DEFAULT 0,
      total_questions INTEGER DEFAULT 5,
      user_answers TEXT,
      submitted_at TEXT NOT NULL,
      status TEXT DEFAULT 'Approved',
      mentor_comment TEXT,
      reviewed_at TEXT,
      answers_json TEXT
    );

    CREATE TABLE IF NOT EXISTS exp_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_email TEXT NOT NULL,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      reference_id TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS exp_ledger (
      id TEXT PRIMARY KEY,
      student_email TEXT NOT NULL,
      amount INTEGER NOT NULL,
      type TEXT,
      description TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS certificates (
      certificate_id TEXT PRIMARY KEY,
      student_id TEXT,
      student_name TEXT NOT NULL,
      student_email TEXT NOT NULL,
      course_name TEXT NOT NULL,
      academic_hours TEXT,
      final_score_text TEXT,
      issued_at TEXT NOT NULL,
      verification_url TEXT
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      size TEXT,
      type TEXT,
      data_url TEXT,
      student_email TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      file_size TEXT,
      description TEXT,
      download_url TEXT NOT NULL,
      is_external INTEGER DEFAULT 0,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS faq_items (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS handbook_sections (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      order_idx INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mentor_consultations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_name TEXT NOT NULL,
      student_email TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      topic TEXT NOT NULL,
      status TEXT DEFAULT 'Booked',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT,
      action TEXT NOT NULL,
      details TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS final_projects (
      id TEXT PRIMARY KEY,
      student_id TEXT,
      student_email TEXT NOT NULL,
      student_name TEXT,
      project_url TEXT,
      notes TEXT,
      status TEXT DEFAULT 'Under Review',
      score INTEGER DEFAULT 0,
      feedback TEXT,
      submitted_at TEXT NOT NULL,
      reviewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS snapshot_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      snapshot_data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS database_backups (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      file_size_bytes INTEGER NOT NULL,
      checksum TEXT,
      records_count TEXT,
      status TEXT DEFAULT 'Verified',
      verification_result TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT DEFAULT 'system'
    );

    CREATE INDEX IF NOT EXISTS idx_hw_student ON homework_submissions(student_email, lesson_id);
    CREATE INDEX IF NOT EXISTS idx_labs_student ON lab_submissions(student_email, lab_id);
    CREATE INDEX IF NOT EXISTS idx_quiz_student ON quiz_submissions(student_email, quiz_id);
    CREATE INDEX IF NOT EXISTS idx_lessons_student ON lessons_progress(student_email, lesson_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_exp_student ON exp_history(student_email);
    CREATE INDEX IF NOT EXISTS idx_hw_status ON homework_submissions(status);
    CREATE INDEX IF NOT EXISTS idx_labs_status ON lab_submissions(status);
    CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments(student_email);
  `);

  // Ensure extended columns exist
  addColumnIfNotExists(database, 'users', 'student_group', "TEXT DEFAULT 'Группа 1 (Август 2026)'");
  addColumnIfNotExists(database, 'users', 'group', "TEXT DEFAULT 'Группа 1 (Август 2026)'");
  addColumnIfNotExists(database, 'users', 'group_name', "TEXT DEFAULT 'Группа 1 (Август 2026)'");
  addColumnIfNotExists(database, 'users', 'hidden_from_leaderboard', 'INTEGER DEFAULT 0');
  addColumnIfNotExists(database, 'users', 'phone', 'TEXT');
  addColumnIfNotExists(database, 'users', 'telegram', 'TEXT');
  addColumnIfNotExists(database, 'users', 'bio', 'TEXT');
  addColumnIfNotExists(database, 'users', 'avatar_url', 'TEXT');
  addColumnIfNotExists(database, 'users', 'unlocked_lessons_count', 'INTEGER DEFAULT 1');
  addColumnIfNotExists(database, 'users', 'completed_lessons_count', 'INTEGER DEFAULT 0');
  addColumnIfNotExists(database, 'users', 'completed_labs_count', 'INTEGER DEFAULT 0');
  addColumnIfNotExists(database, 'users', 'passed_quiz_count', 'INTEGER DEFAULT 0');
  addColumnIfNotExists(database, 'users', 'attendance_pct', 'REAL DEFAULT 100');
  addColumnIfNotExists(database, 'users', 'total_points', 'INTEGER DEFAULT 0');
  addColumnIfNotExists(database, 'users', 'linked_student_id', 'TEXT');
  addColumnIfNotExists(database, 'users', 'linked_student_email', 'TEXT');
  addColumnIfNotExists(database, 'users', 'linked_student_name', 'TEXT');
  addColumnIfNotExists(database, 'users', 'parent_contact', 'TEXT');
  addColumnIfNotExists(database, 'users', 'last_active_at', 'TEXT');
  addColumnIfNotExists(database, 'users', 'time_spent_minutes', 'INTEGER DEFAULT 0');
  addColumnIfNotExists(database, 'users', 'read_sections', "TEXT DEFAULT '{}'");
  addColumnIfNotExists(database, 'users', 'test_scores', "TEXT DEFAULT '{}'");
  addColumnIfNotExists(database, 'users', 'badges', "TEXT DEFAULT '[]'");
  addColumnIfNotExists(database, 'users', 'updated_at', 'TEXT');

  // Attachments BLOB & metadata extensions for full SQLite backup recovery
  addColumnIfNotExists(database, 'attachments', 'file_blob', 'BLOB');
  addColumnIfNotExists(database, 'attachments', 'file_path', 'TEXT');
  addColumnIfNotExists(database, 'attachments', 'mime_type', 'TEXT');
  addColumnIfNotExists(database, 'attachments', 'owner_email', 'TEXT');
  addColumnIfNotExists(database, 'attachments', 'owner_id', 'TEXT');
  addColumnIfNotExists(database, 'attachments', 'related_type', 'TEXT');
  addColumnIfNotExists(database, 'attachments', 'related_id', 'TEXT');
  addColumnIfNotExists(database, 'attachments', 'checksum', 'TEXT');

  // Homework & Labs columns
  addColumnIfNotExists(database, 'homework_submissions', 'file_url', 'TEXT');
  addColumnIfNotExists(database, 'homework_submissions', 'demo_url', 'TEXT');
  addColumnIfNotExists(database, 'homework_submissions', 'repo_url', 'TEXT');
  addColumnIfNotExists(database, 'homework_submissions', 'github_url', 'TEXT');
  addColumnIfNotExists(database, 'homework_submissions', 'student_notes', 'TEXT');
  addColumnIfNotExists(database, 'homework_submissions', 'lesson_title', 'TEXT');
  addColumnIfNotExists(database, 'homework_submissions', 'submission_status', "TEXT DEFAULT 'Submitted'");
  addColumnIfNotExists(database, 'homework_submissions', 'is_completed', 'INTEGER DEFAULT 0');
  addColumnIfNotExists(database, 'homework_submissions', 'mentor_feedback', 'TEXT');

  addColumnIfNotExists(database, 'lab_submissions', 'file_url', 'TEXT');
  addColumnIfNotExists(database, 'lab_submissions', 'title', 'TEXT');
  addColumnIfNotExists(database, 'lab_submissions', 'is_completed', 'INTEGER DEFAULT 0');
  addColumnIfNotExists(database, 'lab_submissions', 'submission_status', "TEXT DEFAULT 'Submitted'");
  addColumnIfNotExists(database, 'lab_submissions', 'lesson_id', 'INTEGER');
  addColumnIfNotExists(database, 'lab_submissions', 'student_notes', 'TEXT');
  addColumnIfNotExists(database, 'lab_submissions', 'repo_url', 'TEXT');
  addColumnIfNotExists(database, 'lab_submissions', 'demo_url', 'TEXT');
  addColumnIfNotExists(database, 'lab_submissions', 'tasks_data', 'TEXT');
  addColumnIfNotExists(database, 'lab_submissions', 'mentor_feedback', 'TEXT');
  addColumnIfNotExists(database, 'lab_submissions', 'screenshots', 'TEXT');
  addColumnIfNotExists(database, 'lab_submissions', 'pdf_report_name', 'TEXT');

  // Quizzes columns
  addColumnIfNotExists(database, 'quiz_submissions', 'score_pct', 'INTEGER DEFAULT 0');
  addColumnIfNotExists(database, 'quiz_submissions', 'score', 'INTEGER DEFAULT 0');
  addColumnIfNotExists(database, 'quiz_submissions', 'max_score', 'INTEGER DEFAULT 10');
  addColumnIfNotExists(database, 'quiz_submissions', 'percentage', 'REAL DEFAULT 0');
  addColumnIfNotExists(database, 'quiz_submissions', 'passed', 'INTEGER DEFAULT 1');
  addColumnIfNotExists(database, 'quiz_submissions', 'status', "TEXT DEFAULT 'Approved'");
  addColumnIfNotExists(database, 'quiz_submissions', 'mentor_comment', 'TEXT');
  addColumnIfNotExists(database, 'quiz_submissions', 'reviewed_at', 'TEXT');
  addColumnIfNotExists(database, 'quiz_submissions', 'answers_json', 'TEXT');
  addColumnIfNotExists(database, 'quiz_submissions', 'details', 'TEXT');
  addColumnIfNotExists(database, 'quiz_submissions', 'retake_allowed', 'INTEGER DEFAULT 0');
  addColumnIfNotExists(database, 'quiz_submissions', 'correct_count', 'INTEGER DEFAULT 0');
  addColumnIfNotExists(database, 'quiz_submissions', 'total_questions', 'INTEGER DEFAULT 5');
  addColumnIfNotExists(database, 'quiz_submissions', 'user_answers', 'TEXT');

  // Progress columns
  addColumnIfNotExists(database, 'lessons_progress', 'student_name', 'TEXT');
  addColumnIfNotExists(database, 'lessons_progress', 'title_ru', 'TEXT');
  addColumnIfNotExists(database, 'lessons_progress', 'title_en', 'TEXT');
  addColumnIfNotExists(database, 'lessons_progress', 'week', 'INTEGER DEFAULT 1');
  addColumnIfNotExists(database, 'lessons_progress', 'block_id', 'INTEGER DEFAULT 1');
  addColumnIfNotExists(database, 'lessons_progress', 'status', "TEXT DEFAULT 'In Progress'");
}

function runMigrations(database: Database): void {
  try {
    const appliedVersions = new Set<number>();
    try {
      const res = database.exec('SELECT version FROM schema_migrations ORDER BY version ASC');
      if (res.length > 0 && res[0].values) {
        res[0].values.forEach((v) => appliedVersions.add(Number(v[0])));
      }
    } catch {}

    const now = new Date().toISOString();

    if (!appliedVersions.has(1)) {
      database.run(
        `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (1, 'initial_schema', ?);`,
        [now]
      );
    }
    if (!appliedVersions.has(2)) {
      database.run(
        `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (2, 'blob_attachments_support', ?);`,
        [now]
      );
    }
    if (!appliedVersions.has(3)) {
      database.run(
        `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (3, 'database_backups_table', ?);`,
        [now]
      );
    }
  } catch (err) {
    console.warn('[SQLite] Schema migration check warning:', err);
  }
}

// ============================================================================
// SEED INITIAL DATA (STRICT PROTECTION: Never re-insert deleted accounts!)
// ============================================================================
function seedInitialData(database: Database): void {
  // Check if initial users were ever seeded in this database
  let alreadySeeded = false;
  try {
    const s = database.exec("SELECT value FROM settings WHERE key = 'initial_users_seeded'");
    if (s.length > 0 && s[0].values && s[0].values.length > 0 && String(s[0].values[0][0]) === '1') {
      alreadySeeded = true;
    }
  } catch {}

  // If ANY user exists in users table, consider already seeded to prevent resurrection
  if (!alreadySeeded) {
    try {
      const u = database.exec('SELECT COUNT(*) FROM users');
      if (u.length > 0 && u[0].values && u[0].values.length > 0 && Number(u[0].values[0][0]) > 0) {
        alreadySeeded = true;
        database.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('initial_users_seeded', '1');`);
      }
    } catch {}
  }

  // Ensure Administrator account ALWAYS exists so system admin is never locked out
  try {
    const a = database.exec(
      "SELECT COUNT(*) FROM users WHERE role = 'admin' OR LOWER(email) = 'admin@devopspro.tech'"
    );
    const hasAdmin = a.length > 0 && a[0].values && a[0].values.length > 0 && Number(a[0].values[0][0]) > 0;
    if (!hasAdmin) {
      database.run(
        `
        INSERT OR IGNORE INTO users (id, name, email, password, role, student_group, status, unlocked_lessons_count, completed_lessons_count, total_points, registered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
        [
          'ADM-2026-0001',
          'Administrator',
          'admin@devopspro.tech',
          hashPassword('123456789'),
          'admin',
          'Группа 1 (Август 2026)',
          'Active',
          24,
          24,
          3500,
          '2026-08-01',
        ]
      );
    }
  } catch {}

  // ONLY seed demo students on a brand new, empty database that has NEVER been seeded before
  if (!alreadySeeded) {
    database.run(
      `
      INSERT OR IGNORE INTO users (id, name, email, password, role, student_group, status, unlocked_lessons_count, completed_lessons_count, completed_labs_count, passed_quiz_count, total_points, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
      [
        'USR-STU-01',
        'John Smith',
        'student@devopspro.tech',
        hashPassword('123456789'),
        'student',
        'Группа 1 (Август 2026)',
        'Active',
        1,
        0,
        0,
        0,
        0,
        '2026-08-01',
      ]
    );
    database.run(
      `
      INSERT OR IGNORE INTO users (id, name, email, password, role, student_group, status, unlocked_lessons_count, completed_lessons_count, completed_labs_count, passed_quiz_count, total_points, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
      [
        'USR-STU-02',
        'Турдиев Муллочон',
        'mullojon@devopspro.tech',
        hashPassword('123456789'),
        'student',
        'Группа 1 (Август 2026)',
        'Active',
        1,
        0,
        0,
        0,
        0,
        '2026-08-01',
      ]
    );
    database.run(
      `
      INSERT OR IGNORE INTO users (id, name, email, password, role, student_group, status, unlocked_lessons_count, completed_lessons_count, total_points, registered_at, linked_student_id, linked_student_email, linked_student_name, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
      [
        'PAR-2026-0001',
        'Турдиева Мавлуда (Родитель)',
        'parent@devopspro.tech',
        hashPassword('123456789'),
        'parent',
        'Okt1',
        'Active',
        0,
        0,
        0,
        '2026-08-01',
        'USR-STU-02',
        'mullojon@devopspro.tech',
        'Турдиев Муллочон',
        '+992 92 777 5678',
      ]
    );

    // Mark that initial seed was executed once and must NEVER execute again
    try {
      database.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('initial_users_seeded', '1');`);
    } catch {}
  }

  // Seed standard download materials and handbook sections idempotently
  const initialDownloads = [
    {
      id: 'd1',
      title: 'DAIR.AI Prompt Engineering Guide & Playbook',
      category: 'Prompting',
      fileSize: 'Web & PDF',
      description: 'Полное практическое руководство по фреймворкам CREATE, PREP, RTF, Few-Shot и Chain-of-Thought промптингу для ChatGPT, Claude и DeepSeek.',
      downloadUrl: 'https://www.promptingguide.ai/',
      isExternal: 1,
    },
    {
      id: 'd2',
      title: 'Cursor AI IDE — Редактор Нового Поколения (Claude 3.5 & GPT-4o)',
      category: 'Software',
      fileSize: 'Установщик • 95 MB',
      description: 'Флагманский AI-редактор кода со встроенным умным чатом, Composer и автодополнением.',
      downloadUrl: 'https://www.cursor.com/',
      isExternal: 1,
    },
    {
      id: 'd4',
      title: 'Ollama — Локальный Запуск LLM (DeepSeek, Llama 3.3, Qwen)',
      category: 'Model',
      fileSize: 'Win / Mac / Linux • 55 MB',
      description: 'Утилита для запуска открытых моделей искусственного интеллекта на собственном компьютере.',
      downloadUrl: 'https://ollama.com/download',
      isExternal: 1,
    },
    {
      id: 'd16',
      title: 'Справочник Выпускника AI Engineer & Prompt Guide',
      category: 'PDF',
      fileSize: 'Онлайн & PDF',
      description: 'Официальный регламент Академии: балльно-рейтинговая система (EXP), критерии Demo Day, этика AI и руководство по промптингу.',
      downloadUrl: 'https://www.promptingguide.ai/',
      isExternal: 1,
    },
  ];

  for (const d of initialDownloads) {
    database.run(
      `
      INSERT INTO downloads (id, title, category, file_size, description, download_url, is_external, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        category = excluded.category,
        file_size = excluded.file_size,
        description = excluded.description,
        download_url = excluded.download_url,
        is_external = excluded.is_external;
    `,
      [d.id, d.title, d.category, d.fileSize, d.description, d.downloadUrl, d.isExternal, new Date().toISOString()]
    );
  }

  const handbook = [
    {
      id: 'rules',
      title: '1. Регламент и Учебный Процесс AI Engineer Academy',
      content:
        'Добро пожаловать в AI Engineer Academy!\nПродолжительность: 12 недель (24 урока, 36 часов).\nФормула обучения: 30% теории / 70% практики.',
    },
    {
      id: 'grading',
      title: '2. Система Баллов и Начисление Опыта (EXP)',
      content:
        '1. Посещаемость (10% | 100 EXP)\n2. Лабораторные (30% | 2400 EXP)\n3. Тесты (20% | 900 EXP)\n4. ДЗ (20% | 1200 EXP)\n5. Дипломный проект (20% | 1000 EXP)',
    },
    {
      id: 'ethics',
      title: '3. Этика и Безопасность Использования AI',
      content:
        'Прозрачность, фактчекинг и ответственность: проверяйте результаты генераций, защищайте персональные данные и API-ключи.',
    },
  ];

  for (let i = 0; i < handbook.length; i++) {
    const h = handbook[i];
    database.run(
      `
      INSERT OR IGNORE INTO handbook_sections (id, title, content, order_idx)
      VALUES (?, ?, ?, ?);
    `,
      [h.id, h.title, h.content, i]
    );
  }

  database.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('db_engine', 'SQLite 3 via sql.js');`);
  database.run(
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('course_title', 'AI ENGINEER — Практический AI для учёбы, работы, бизнеса и создания проектов');`
  );
  database.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('total_lessons', '24');`);
  database.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('total_hours', '36');`);

  // Upgrade legacy unhashed passwords safely
  try {
    const userStmt = database.prepare(`SELECT id, password FROM users`);
    const usersToUpdate: Array<{ id: string; hashed: string }> = [];
    while (userStmt.step()) {
      const row = userStmt.getAsObject() as any;
      if (row.password && !String(row.password).startsWith('s256$') && !/^[a-f0-9]{64}$/i.test(row.password)) {
        usersToUpdate.push({ id: row.id, hashed: hashPassword(row.password) });
      }
    }
    userStmt.free();
    for (const item of usersToUpdate) {
      database.run(`UPDATE users SET password = ? WHERE id = ?`, [item.hashed, item.id]);
    }
  } catch (err) {
    console.warn('[SQLite] Error encrypting passwords:', err);
  }
}

// ============================================================================
// ATTACHMENT STORAGE & RETRIEVAL (SQLite BLOB + Disk Cache)
// ============================================================================
export interface AttachmentRecord {
  id: string;
  name: string;
  size: string;
  type: string;
  studentEmail?: string;
  filePath: string;
  mimeType?: string;
  checksum?: string;
  dataUrl?: string;
}

export function saveAttachmentToSqlite(data: {
  id?: string;
  name: string;
  size?: string;
  type?: string;
  dataUrl?: string;
  fileBuffer?: Buffer;
  studentEmail?: string;
  studentId?: string;
  relatedType?: string;
  relatedId?: string;
}): { id: string; filePath: string; size: string } {
  const attId = data.id || `att-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();
  const safeExt = path.extname(data.name).toLowerCase();
  const baseName = path.basename(data.name, safeExt).replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeFilename = `${Date.now()}_${baseName}${safeExt}`;

  const studentFolder = (data.studentEmail || data.studentId || 'general').replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetDir = path.join(UPLOADS_DIR, studentFolder);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const relativeFilePath = `uploads/${studentFolder}/${safeFilename}`;
  const absoluteFilePath = path.join(targetDir, safeFilename);

  let buffer: Buffer;
  const rawBuf = data.fileBuffer || (data as any).fileBlob;
  if (rawBuf && (Buffer.isBuffer(rawBuf) || rawBuf instanceof Uint8Array)) {
    buffer = Buffer.from(rawBuf);
  } else if (data.dataUrl) {
    const base64Data = data.dataUrl.includes(';base64,') ? data.dataUrl.split(';base64,').pop()! : data.dataUrl;
    buffer = Buffer.from(base64Data, 'base64');
  } else {
    buffer = Buffer.from('');
  }

  // 1. Write file to disk for instant static delivery
  try {
    fs.writeFileSync(absoluteFilePath, buffer);
  } catch (err) {
    console.warn('[SQLite Attachments] Warning writing to disk cache:', err);
  }

  // 2. Persist directly into SQLite BLOB column for disaster-proof recovery
  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
  const sizeFormatted = data.size || `${(buffer.length / 1024).toFixed(1)} KB`;
  const mimeType = data.type || (safeExt === '.pdf' ? 'application/pdf' : 'application/octet-stream');

  run(
    `
    INSERT OR REPLACE INTO attachments (
      id, name, size, type, data_url, student_email, created_at,
      file_blob, file_path, mime_type, owner_email, owner_id, related_type, related_id, checksum
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
  `,
    [
      attId,
      data.name,
      sizeFormatted,
      mimeType,
      data.dataUrl || null,
      data.studentEmail || null,
      now,
      buffer,
      relativeFilePath,
      mimeType,
      data.studentEmail || null,
      data.studentId || null,
      data.relatedType || 'general',
      data.relatedId || null,
      checksum,
    ]
  );

  return { id: attId, filePath: relativeFilePath, size: sizeFormatted };
}

export function restoreAttachmentFileToDisk(identifier: string): boolean {
  try {
    const cleanPath = identifier.replace(/^\/+/, '');
    let absolutePath = path.join(process.cwd(), cleanPath);
    if (fs.existsSync(absolutePath) && !fs.statSync(absolutePath).isDirectory()) return true;

    const row = queryOne(
      `SELECT file_blob, name, data_url, file_path FROM attachments WHERE id = ? OR file_path = ? OR file_path LIKE ? LIMIT 1`,
      [identifier, cleanPath, `%${path.basename(cleanPath)}`]
    );

    if (row) {
      const resolvedPath = row.file_path ? row.file_path.replace(/^\/+/, '') : cleanPath;
      absolutePath = path.join(process.cwd(), resolvedPath);
      if (fs.existsSync(absolutePath) && !fs.statSync(absolutePath).isDirectory()) return true;

      let buf: Buffer | null = null;
      if (row.file_blob && (Buffer.isBuffer(row.file_blob) || row.file_blob instanceof Uint8Array)) {
        buf = Buffer.from(row.file_blob);
      } else if (row.data_url && typeof row.data_url === 'string' && row.data_url.startsWith('data:')) {
        const b64 = row.data_url.split(';base64,').pop()!;
        buf = Buffer.from(b64, 'base64');
      }

      if (buf && buf.length > 0) {
        const parentDir = path.dirname(absolutePath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.writeFileSync(absolutePath, buf);
        console.log(`[SQLite Attachments] Restored file from database BLOB to disk: ${resolvedPath}`);
        return true;
      }
    }
  } catch (err) {
    console.warn('[SQLite Attachments] Could not restore file to disk:', err);
  }
  return false;
}

// ============================================================================
// AUTOMATIC BACKUP ENGINE & RETENTION
// ============================================================================
export interface BackupMetadata {
  id: string;
  filename: string;
  filepath: string;
  fileSizeBytes: number;
  fileSizeFormatted: string;
  checksum: string;
  recordsCount: Record<string, number>;
  status: 'Verified' | 'Error';
  verificationResult: string;
  createdAt: string;
  createdBy: string;
}

export function createDatabaseBackup(createdBy = 'system', reason = 'manual'): BackupMetadata {
  const currentDb = getDb();
  persistDb(true);

  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupId = `backup-${timestamp}`;
  const filename = `portal-backup-${timestamp}.sqlite`;
  const backupFilePath = path.join(BACKUPS_DIR, filename);

  // 1. Export in-memory committed database state to binary buffer
  const dbData = currentDb.export();
  const buffer = Buffer.from(dbData);
  fs.writeFileSync(backupFilePath, buffer);

  // 2. Perform deep SQLite verification on the written backup file
  let status: 'Verified' | 'Error' = 'Verified';
  let verificationResult = 'PRAGMA integrity_check passed successfully';
  let recordsCount: Record<string, number> = {};

  try {
    const testDb = new SQL.Database(buffer);
    const integrityRes = testDb.exec('PRAGMA integrity_check');
    if (
      !integrityRes ||
      integrityRes.length === 0 ||
      !integrityRes[0].values ||
      integrityRes[0].values[0][0] !== 'ok'
    ) {
      status = 'Error';
      verificationResult = 'Integrity check failed: ' + JSON.stringify(integrityRes);
    }

    const countTable = (t: string) => {
      try {
        const res = testDb.exec(`SELECT COUNT(*) FROM ${t}`);
        return res[0]?.values[0][0] !== undefined ? Number(res[0].values[0][0]) : 0;
      } catch {
        return 0;
      }
    };

    recordsCount = {
      users: countTable('users'),
      homework: countTable('homework_submissions'),
      labs: countTable('lab_submissions'),
      quizzes: countTable('quiz_submissions'),
      progress: countTable('lessons_progress'),
      attachments: countTable('attachments'),
      certificates: countTable('certificates'),
    };
    testDb.close();
  } catch (err: any) {
    status = 'Error';
    verificationResult = err?.message || 'Verification failed';
  }

  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
  const fileSizeBytes = buffer.length;

  // 3. Register backup in database_backups table
  try {
    run(
      `
      INSERT OR REPLACE INTO database_backups (
        id, filename, filepath, file_size_bytes, checksum, records_count, status, verification_result, created_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
      [
        backupId,
        filename,
        backupFilePath,
        fileSizeBytes,
        checksum,
        JSON.stringify(recordsCount),
        status,
        verificationResult,
        new Date().toISOString(),
        createdBy,
      ]
    );

    // Audit log
    run(`INSERT INTO audit_logs (user_email, action, details, timestamp) VALUES (?, 'CREATE_BACKUP', ?, ?);`, [
      createdBy,
      `Создана резервная копия ${filename} (${(fileSizeBytes / 1024).toFixed(1)} KB, reason: ${reason})`,
      new Date().toISOString(),
    ]);
  } catch (logErr) {
    console.warn('[SQLite Backups] Error logging backup entry:', logErr);
  }

  // 4. Enforce Retention: keep up to 15 recent backups, never delete the only valid backup!
  enforceBackupRetention();

  return {
    id: backupId,
    filename,
    filepath: backupFilePath,
    fileSizeBytes,
    fileSizeFormatted: `${(fileSizeBytes / 1024).toFixed(1)} KB`,
    checksum,
    recordsCount,
    status,
    verificationResult,
    createdAt: new Date().toISOString(),
    createdBy,
  };
}

export function enforceBackupRetention(maxBackups = 15): void {
  try {
    const all = query(`SELECT id, filename, filepath FROM database_backups ORDER BY created_at DESC`);
    if (all.length > maxBackups) {
      const toDelete = all.slice(maxBackups);
      for (const b of toDelete) {
        try {
          if (b.filepath && fs.existsSync(b.filepath)) {
            fs.unlinkSync(b.filepath);
          }
          run(`DELETE FROM database_backups WHERE id = ?`, [b.id]);
          console.log(`[SQLite Retention] Pruned old backup: ${b.filename}`);
        } catch {}
      }
    }
  } catch (e) {
    console.warn('[SQLite Retention] Retention policy warning:', e);
  }
}

export function syncDiskBackupsWithTable(): void {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
      return;
    }
    const files = fs.readdirSync(BACKUPS_DIR);
    for (const f of files) {
      const lower = f.toLowerCase();
      if (!lower.endsWith('.sqlite') && !lower.endsWith('.db') && !lower.endsWith('.sqlite3')) continue;
      const fullPath = path.join(BACKUPS_DIR, f);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile() || stat.size < 100) continue;

        const row = queryOne(
          `SELECT id FROM database_backups WHERE filename = ? OR filepath = ? OR id = ? LIMIT 1`,
          [f, fullPath, f.replace(/\.(sqlite|db|sqlite3)$/i, '')]
        );
        if (!row) {
          const buf = fs.readFileSync(fullPath);
          let recordsCount: Record<string, number> = {};
          let status: 'Verified' | 'Error' = 'Verified';
          let verificationResult = 'PRAGMA integrity_check passed successfully';

          if (SQL) {
            try {
              const testDb = new SQL.Database(buf);
              const integrityRes = testDb.exec('PRAGMA integrity_check');
              if (
                !integrityRes ||
                integrityRes.length === 0 ||
                !integrityRes[0].values ||
                integrityRes[0].values[0][0] !== 'ok'
              ) {
                status = 'Error';
                verificationResult = 'Integrity check failed: ' + JSON.stringify(integrityRes);
              }
              const countTable = (t: string) => {
                try {
                  const res = testDb.exec(`SELECT COUNT(*) FROM ${t}`);
                  return res[0]?.values[0][0] !== undefined ? Number(res[0].values[0][0]) : 0;
                } catch {
                  return 0;
                }
              };
              recordsCount = {
                users: countTable('users'),
                homework: countTable('homework_submissions'),
                labs: countTable('lab_submissions'),
                quizzes: countTable('quiz_submissions'),
                progress: countTable('lessons_progress'),
                attachments: countTable('attachments'),
                certificates: countTable('certificates'),
              };
              testDb.close();
            } catch (err: any) {
              status = 'Error';
              verificationResult = err?.message || 'Verification error';
            }
          }
          const checksum = crypto.createHash('sha256').update(buf).digest('hex');
          const backupId = f.replace(/\.(sqlite|db|sqlite3)$/i, '');
          const createdAt = stat.mtime ? stat.mtime.toISOString() : new Date().toISOString();
          run(
            `INSERT OR REPLACE INTO database_backups (
              id, filename, filepath, file_size_bytes, checksum, records_count, status, verification_result, created_at, created_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            [
              backupId,
              f,
              fullPath,
              stat.size,
              checksum,
              JSON.stringify(recordsCount),
              status,
              verificationResult,
              createdAt,
              'system',
            ]
          );
        }
      } catch (err) {
        console.warn('[syncDiskBackupsWithTable] Error syncing file:', f, err);
      }
    }

    // Prune entries from DB that no longer exist on disk
    const rows = query(`SELECT id, filename, filepath FROM database_backups`);
    for (const r of rows) {
      const exists =
        (r.filepath && fs.existsSync(r.filepath)) ||
        (r.filename && fs.existsSync(path.join(BACKUPS_DIR, r.filename)));
      if (!exists) {
        run(`DELETE FROM database_backups WHERE id = ?`, [r.id]);
      }
    }
  } catch (err) {
    console.warn('[syncDiskBackupsWithTable] Warning during backups sync:', err);
  }
}

export function resolveBackupFilePath(backupIdOrFilename: string): string | null {
  if (!backupIdOrFilename || typeof backupIdOrFilename !== 'string') return null;
  const clean = path.basename(backupIdOrFilename.trim());

  // 1. Direct path in BACKUPS_DIR
  const directPath = path.join(BACKUPS_DIR, clean);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) return directPath;

  // 2. Direct with extension
  for (const ext of ['.sqlite', '.db', '.sqlite3']) {
    const p = path.join(BACKUPS_DIR, `${clean}${ext}`);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }

  // 3. Query database_backups table
  try {
    const row = queryOne(
      `SELECT filepath, filename FROM database_backups WHERE id = ? OR filename = ? LIMIT 1`,
      [clean, clean]
    );
    if (row) {
      if (row.filepath && fs.existsSync(row.filepath) && fs.statSync(row.filepath).isFile()) return row.filepath;
      if (row.filename) {
        const fromRowName = path.join(BACKUPS_DIR, row.filename);
        if (fs.existsSync(fromRowName) && fs.statSync(fromRowName).isFile()) return fromRowName;
      }
    }
  } catch {}

  // 4. Scan BACKUPS_DIR for partial or case-insensitive match
  if (fs.existsSync(BACKUPS_DIR)) {
    const files = fs.readdirSync(BACKUPS_DIR);
    for (const f of files) {
      const baseNoExt = f.replace(/\.(sqlite|db|sqlite3)$/i, '');
      if (
        f.toLowerCase() === clean.toLowerCase() ||
        baseNoExt.toLowerCase() === clean.toLowerCase() ||
        f.toLowerCase().includes(clean.toLowerCase())
      ) {
        const p = path.join(BACKUPS_DIR, f);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      }
    }
  }

  return null;
}

export function listDatabaseBackups(): BackupMetadata[] {
  try {
    syncDiskBackupsWithTable();
    const rows = query(`SELECT * FROM database_backups ORDER BY created_at DESC`);
    return rows.map((r: any) => {
      let recordsCount: Record<string, number> = {};
      try {
        if (r.records_count) recordsCount = JSON.parse(r.records_count);
      } catch {}
      return {
        id: r.id,
        filename: r.filename,
        filepath: r.filepath,
        fileSizeBytes: Number(r.file_size_bytes || 0),
        fileSizeFormatted: `${(Number(r.file_size_bytes || 0) / 1024).toFixed(1)} KB`,
        checksum: r.checksum || '',
        recordsCount,
        status: r.status || 'Verified',
        verificationResult: r.verification_result || 'PRAGMA integrity_check passed',
        createdAt: r.created_at,
        createdBy: r.created_by || 'system',
      };
    });
  } catch {
    return [];
  }
}

export function verifyDatabaseBackup(backupIdOrFilename: string): {
  success: boolean;
  integrity: string;
  tableCounts: Record<string, number>;
  checksum: string;
  error?: string;
} {
  try {
    const targetPath = resolveBackupFilePath(backupIdOrFilename);
    if (!targetPath || !fs.existsSync(targetPath)) {
      return { success: false, integrity: 'File not found', tableCounts: {}, checksum: '', error: 'Файл резервной копии не найден на сервере' };
    }

    const buffer = fs.readFileSync(targetPath);
    if (!SQL) {
      return { success: false, integrity: 'SQL not ready', tableCounts: {}, checksum: '', error: 'SQL engine not initialized' };
    }
    const testDb = new SQL.Database(buffer);
    const integrityRes = testDb.exec('PRAGMA integrity_check');
    const integrity =
      integrityRes.length > 0 && integrityRes[0].values && integrityRes[0].values[0][0] === 'ok'
        ? 'OK'
        : 'FAIL: ' + JSON.stringify(integrityRes);

    const countTable = (t: string) => {
      try {
        const res = testDb.exec(`SELECT COUNT(*) FROM ${t}`);
        return res[0]?.values[0][0] !== undefined ? Number(res[0].values[0][0]) : 0;
      } catch {
        return 0;
      }
    };

    const tableCounts = {
      users: countTable('users'),
      homework: countTable('homework_submissions'),
      labs: countTable('lab_submissions'),
      quizzes: countTable('quiz_submissions'),
      progress: countTable('lessons_progress'),
      attachments: countTable('attachments'),
      certificates: countTable('certificates'),
    };
    testDb.close();
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

    return {
      success: integrity === 'OK',
      integrity,
      tableCounts,
      checksum,
    };
  } catch (err: any) {
    return {
      success: false,
      integrity: 'FAIL',
      tableCounts: {},
      checksum: '',
      error: err?.message || 'Error verifying backup file',
    };
  }
}

export function deleteDatabaseBackup(
  backupIdOrFilename: string,
  adminEmail: string = 'admin@devopspro.tech'
): { success: boolean; message: string; filename?: string; error?: string } {
  try {
    if (!backupIdOrFilename || typeof backupIdOrFilename !== 'string') {
      return { success: false, message: 'Идентификатор резервной копии не указан', error: 'Missing backup ID' };
    }
    const clean = path.basename(backupIdOrFilename.trim());
    if (clean.includes('..') || clean === '/' || clean === '.') {
      return { success: false, message: 'Недопустимое имя файла резервной копии', error: 'Invalid backup filename' };
    }

    const targetPath = resolveBackupFilePath(clean);
    const resolvedFilename = targetPath ? path.basename(targetPath) : clean;

    if (targetPath && fs.existsSync(targetPath)) {
      try {
        fs.unlinkSync(targetPath);
      } catch (err: any) {
        return { success: false, message: 'Ошибка при удалении файла с диска: ' + err.message, error: err.message };
      }
    }

    // Delete record from database_backups
    const cleanId = clean.replace(/\.(sqlite|db|sqlite3)$/i, '');
    run(
      `DELETE FROM database_backups WHERE id = ? OR filename = ? OR filepath = ? OR id = ?`,
      [clean, resolvedFilename, targetPath || '', cleanId]
    );

    syncDiskBackupsWithTable();
    persistDb(true);

    try {
      run(
        `INSERT INTO audit_logs (user_email, action, details, timestamp) VALUES (?, 'DELETE_BACKUP', ?, ?);`,
        [
          adminEmail,
          `Удалена резервная копия базы данных: ${resolvedFilename}`,
          new Date().toISOString(),
        ]
      );
    } catch {}

    return {
      success: true,
      message: `Резервная копия "${resolvedFilename}" успешно удалена`,
      filename: resolvedFilename
    };
  } catch (err: any) {
    console.error('[deleteDatabaseBackup] Error:', err);
    return {
      success: false,
      message: 'Ошибка при удалении резервной копии: ' + err?.message,
      error: err?.message
    };
  }
}

export function saveUploadedDatabaseBackup(
  originalFileName: string,
  buffer: Buffer,
  adminEmail: string,
  restoreImmediately: boolean = false
): {
  success: boolean;
  backup?: BackupMetadata;
  restored?: boolean;
  restoredCounts?: Record<string, number>;
  message: string;
  error?: string;
} {
  try {
    if (!buffer || buffer.length < 512) {
      return { success: false, message: 'Файл базы данных слишком мал или пуст', error: 'Empty or corrupt file' };
    }

    // Verify SQLite 3 magic header ("SQLite format 3\0")
    const magic = buffer.subarray(0, 16).toString('utf-8');
    if (!magic.startsWith('SQLite format 3')) {
      return {
        success: false,
        message: 'Загруженный файл не является допустимой базой данных SQLite 3 (отсутствует сигнатура "SQLite format 3")',
        error: 'Invalid SQLite header'
      };
    }

    if (!SQL) {
      throw new Error('SQLite engine is not initialized');
    }

    // Verify database integrity
    const testDb = new SQL.Database(buffer);
    const integrityRes = testDb.exec('PRAGMA integrity_check');
    if (
      !integrityRes ||
      integrityRes.length === 0 ||
      !integrityRes[0].values ||
      integrityRes[0].values[0][0] !== 'ok'
    ) {
      testDb.close();
      return {
        success: false,
        message: 'Файл поврежден: PRAGMA integrity_check завершился с ошибкой',
        error: 'Integrity check failed: ' + JSON.stringify(integrityRes)
      };
    }

    const countTable = (t: string) => {
      try {
        const res = testDb.exec(`SELECT COUNT(*) FROM ${t}`);
        return res[0]?.values[0][0] !== undefined ? Number(res[0].values[0][0]) : 0;
      } catch {
        return 0;
      }
    };

    const recordsCount = {
      users: countTable('users'),
      homework: countTable('homework_submissions'),
      labs: countTable('lab_submissions'),
      quizzes: countTable('quiz_submissions'),
      progress: countTable('lessons_progress'),
      attachments: countTable('attachments'),
      certificates: countTable('certificates'),
    };
    testDb.close();

    if (!fs.existsSync(BACKUPS_DIR)) {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    }

    const ext = path.extname(originalFileName).toLowerCase() || '.sqlite';
    const safeExt = ['.db', '.sqlite', '.sqlite3'].includes(ext) ? ext : '.sqlite';
    const rawBase = path.basename(originalFileName, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `uploaded-${timestamp}-${rawBase || 'backup'}${safeExt}`;
    const backupFilePath = path.join(BACKUPS_DIR, filename);
    const backupId = filename.replace(/\.(sqlite|db|sqlite3)$/i, '');

    fs.writeFileSync(backupFilePath, buffer);

    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const fileSizeBytes = buffer.length;

    run(
      `INSERT OR REPLACE INTO database_backups (
        id, filename, filepath, file_size_bytes, checksum, records_count, status, verification_result, created_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        backupId,
        filename,
        backupFilePath,
        fileSizeBytes,
        checksum,
        JSON.stringify(recordsCount),
        'Verified',
        'PRAGMA integrity_check passed successfully',
        new Date().toISOString(),
        adminEmail || 'admin@devopspro.tech',
      ]
    );

    try {
      run(
        `INSERT INTO audit_logs (user_email, action, details, timestamp) VALUES (?, 'UPLOAD_BACKUP', ?, ?);`,
        [
          adminEmail || 'admin@devopspro.tech',
          `Загружен архив базы данных ${filename} (${(fileSizeBytes / 1024).toFixed(1)} KB, Пользователей: ${recordsCount.users})`,
          new Date().toISOString(),
        ]
      );
    } catch {}

    const backupMeta: BackupMetadata = {
      id: backupId,
      filename,
      filepath: backupFilePath,
      fileSizeBytes,
      fileSizeFormatted: `${(fileSizeBytes / 1024).toFixed(1)} KB`,
      checksum,
      recordsCount,
      status: 'Verified',
      verificationResult: 'PRAGMA integrity_check passed successfully',
      createdAt: new Date().toISOString(),
      createdBy: adminEmail || 'admin@devopspro.tech',
    };

    enforceBackupRetention();

    if (restoreImmediately) {
      const restoreRes = restoreDatabaseFromBackup(filename, adminEmail);
      return {
        success: restoreRes.success,
        backup: backupMeta,
        restored: restoreRes.success,
        restoredCounts: restoreRes.restoredCounts || recordsCount,
        message: restoreRes.success
          ? `Файл ${filename} успешно загружен и применен в качестве активной базы данных!`
          : `Файл загружен в бэкапы, но при восстановлении возникла ошибка: ${restoreRes.message}`,
        error: restoreRes.error,
      };
    }

    return {
      success: true,
      backup: backupMeta,
      restored: false,
      restoredCounts: recordsCount,
      message: `Резервная копия "${filename}" успешно загружена и добавлена в список бэкапов!`,
    };
  } catch (err: any) {
    console.error('[saveUploadedDatabaseBackup] Error:', err);
    return {
      success: false,
      message: 'Ошибка при сохранении загруженной базы данных: ' + err?.message,
      error: err?.message,
    };
  }
}

// ============================================================================
// COMPLETE RESTORATION SYSTEM (With Automated Safety Rollback Snapshot)
// ============================================================================
export function restoreDatabaseFromBackup(
  backupIdOrFilename: string,
  adminEmail: string
): { success: boolean; message: string; restoredCounts?: Record<string, number>; error?: string } {
  try {
    const targetPath = resolveBackupFilePath(backupIdOrFilename);
    if (!targetPath || !fs.existsSync(targetPath)) {
      return { success: false, message: 'Файл резервной копии не найден на сервере', error: 'Backup file does not exist' };
    }

    // 1. Verify target backup file before touching live database
    const fileBuffer = fs.readFileSync(targetPath);
    if (fileBuffer.length < 512) {
      return { success: false, message: 'Файл резервной копии поврежден или пуст', error: 'Corrupt or empty backup file' };
    }

    const magic = fileBuffer.subarray(0, 16).toString('utf-8');
    if (!magic.startsWith('SQLite format 3')) {
      return { success: false, message: 'Файл не является валидной базой данных SQLite 3', error: 'Invalid SQLite header' };
    }

    if (!SQL) {
      throw new Error('SQLite engine is not initialized');
    }

    const testDb = new SQL.Database(fileBuffer);
    const integrityRes = testDb.exec('PRAGMA integrity_check');
    if (
      !integrityRes ||
      integrityRes.length === 0 ||
      !integrityRes[0].values ||
      integrityRes[0].values[0][0] !== 'ok'
    ) {
      testDb.close();
      return {
        success: false,
        message: 'Проверка целостности SQLite завершилась ошибкой',
        error: 'Backup failed integrity check',
      };
    }

    const countTable = (t: string) => {
      try {
        const res = testDb.exec(`SELECT COUNT(*) FROM ${t}`);
        return res[0]?.values[0][0] !== undefined ? Number(res[0].values[0][0]) : 0;
      } catch {
        return 0;
      }
    };
    const restoredCounts = {
      users: countTable('users'),
      homework: countTable('homework_submissions'),
      labs: countTable('lab_submissions'),
      quizzes: countTable('quiz_submissions'),
      progress: countTable('lessons_progress'),
      attachments: countTable('attachments'),
      certificates: countTable('certificates'),
    };
    testDb.close();

    // 2. Take an automated PRE-RESTORE SAFETY BACKUP of the current active database!
    try {
      createDatabaseBackup(adminEmail, 'pre-restore-safety-snapshot');
      console.log('[SQLite Restore] Pre-restore safety snapshot created.');
    } catch (safeErr) {
      console.warn('[SQLite Restore] Notice: could not take pre-restore safety snapshot:', safeErr);
    }

    // 3. Atomically swap live database with verified backup
    db = new SQL.Database(fileBuffer);
    fs.writeFileSync(DB_PATH, fileBuffer);

    // 4. Ensure all schema migrations & columns are up to date on restored database
    ensureTables(db);
    runMigrations(db);
    migrateAndSyncDatabase();
    recalculateAllUsersPoints();
    persistDb(true);

    // 5. Restore any attachments in database BLOB to disk uploads folder
    try {
      const atts = query(`SELECT file_path FROM attachments WHERE file_blob IS NOT NULL OR data_url IS NOT NULL`);
      for (const a of atts) {
        if (a.file_path) {
          restoreAttachmentFileToDisk(a.file_path);
        }
      }
    } catch {}

    // 6. Resynchronize database_backups table so all backup files on disk are registered!
    syncDiskBackupsWithTable();
    persistDb(true);

    // 7. Log audit event
    const now = new Date().toISOString();
    try {
      run(
        `INSERT INTO audit_logs (user_email, action, details, timestamp) VALUES (?, 'RESTORE_DATABASE', ?, ?);`,
        [
          adminEmail,
          `Успешно восстановлена база данных из копии "${path.basename(targetPath)}". Восстановлено: ${restoredCounts.users} пользователей, ${restoredCounts.homework} ДЗ, ${restoredCounts.labs} лаб.`,
          now,
        ]
      );
    } catch {}

    return {
      success: true,
      message: `База данных успешно восстановлена из архива "${path.basename(targetPath)}"!`,
      restoredCounts,
    };
  } catch (err: any) {
    console.error('[SQLite Restore] Critical error during restoration:', err);
    return {
      success: false,
      message: 'Ошибка при восстановлении базы данных: ' + err?.message,
      error: err?.message,
    };
  }
}

// ============================================================================
// EXP & DETERMINISTIC POINTS CALCULATION (ACID Verified)
// ============================================================================
export function normalizeMentorScore(score: any, feedback?: string): number {
  const fb = String(feedback || '').trim();
  const s = Number(score);
  if (!isNaN(s)) {
    if (s === 5) return 100;
    if (s === 4) return 75;
    if (s === 3) return 50;
  }
  if ((isNaN(s) || s <= 50) && fb) {
    if (/100\s*\/\s*100|\+?\s*100\s*EXP|отличная работа/i.test(fb)) return 100;
    if (/75\s*\/\s*100|\+?\s*75\s*EXP|хорошая работа/i.test(fb)) return 75;
    if (/50\s*\/\s*100|\+?\s*50\s*EXP/i.test(fb)) return 50;
  }
  if (!isNaN(s) && s > 0) {
    if (s < 50) return 100;
    if (s >= 88) return 100;
    if (s >= 63) return 75;
    return 50;
  }
  return 100;
}

export function calculateDeterministicUserPoints(email: string, userRole?: string): number {
  const emailLower = String(email || '').toLowerCase().trim();
  if (!emailLower) return 0;
  if (userRole === 'admin' || emailLower === 'admin@devopspro.tech') return 3500;

  try {
    const userRow = queryOne(
      `SELECT completed_lessons_count, completed_labs_count, passed_quiz_count, read_sections FROM users WHERE LOWER(email) = ?`,
      [emailLower]
    );
    const progressRows = query(
      `SELECT lesson_id, is_completed, read_sections FROM lessons_progress WHERE LOWER(student_email) = ?`,
      [emailLower]
    );
    const hwRows = query(
      `SELECT lesson_id, score, status, submission_status FROM homework_submissions WHERE LOWER(student_email) = ?`,
      [emailLower]
    );

    const approvedHwMap = new Map<number, number>();
    hwRows.forEach((hw: any) => {
      const st = String(hw.status || hw.submission_status || '').toLowerCase().trim();
      if (st === 'approved') {
        const lId = Number(hw.lesson_id);
        const rawScore = typeof hw.score === 'number' && hw.score > 0 ? hw.score : 100;
        const score = rawScore >= 88 ? 100 : rawScore >= 63 ? 75 : 50;
        approvedHwMap.set(lId, Math.max(approvedHwMap.get(lId) || 0, score));
      }
    });

    const completedLessonIds = new Set<number>();
    const flatReadSections: Record<string, boolean> = {};

    if (userRow?.read_sections) {
      try {
        const parsed = JSON.parse(userRow.read_sections);
        if (parsed && typeof parsed === 'object') Object.assign(flatReadSections, parsed);
      } catch {}
    }

    progressRows.forEach((p: any) => {
      const lId = Number(p.lesson_id);
      if (p.is_completed === 1 && approvedHwMap.has(lId)) {
        completedLessonIds.add(lId);
      }
      if (p.read_sections) {
        try {
          const parsed = JSON.parse(p.read_sections);
          if (parsed && typeof parsed === 'object') Object.assign(flatReadSections, parsed);
        } catch {}
      }
    });

    approvedHwMap.forEach((_score, lId) => {
      if (lId >= 1 && lId <= 24) completedLessonIds.add(lId);
    });

    const fallbackCompletedLessons = Number(userRow?.completed_lessons_count || 0);
    if (completedLessonIds.size === 0 && approvedHwMap.size === 0 && fallbackCompletedLessons > 0) {
      for (let i = 1; i <= Math.min(24, fallbackCompletedLessons); i++) {
        completedLessonIds.add(i);
      }
    }

    let hwXp = 0;
    approvedHwMap.forEach((score) => {
      hwXp += score;
    });

    const labRows = query(
      `SELECT lab_id, score, status, submission_status FROM lab_submissions WHERE LOWER(student_email) = ?`,
      [emailLower]
    );
    const approvedLabMap = new Map<number, number>();
    labRows.forEach((lb: any) => {
      const st = String(lb.status || lb.submission_status || '').toLowerCase().trim();
      if (st === 'approved') {
        const lId = Number(lb.lab_id);
        const rawScore = typeof lb.score === 'number' && lb.score > 0 ? lb.score : 100;
        const score = rawScore >= 88 ? 100 : rawScore >= 63 ? 75 : 50;
        approvedLabMap.set(lId, Math.max(approvedLabMap.get(lId) || 0, score));
      }
    });

    let labXp = 0;
    approvedLabMap.forEach((score) => {
      labXp += score;
    });

    const quizRows = query(
      `SELECT quiz_id, lesson_id, quiz_title, score_pct, passed, status, retake_allowed FROM quiz_submissions WHERE LOWER(student_email) = ?`,
      [emailLower]
    );
    const passedQuizMap = new Map<string, number>();
    quizRows.forEach((qz: any) => {
      const isRej = String(qz.status || '').toLowerCase() === 'rejected' || qz.retake_allowed === 1;
      const isPassed = !isRej && (qz.passed === 1 || qz.passed === '1' || qz.passed === 'true' || Number(qz.score_pct) >= 60);
      if (isPassed) {
        const rawQId = String(qz.quiz_id || '').toUpperCase();
        const isExplicitBlock =
          (/^BLOCK(?:_TEST)?[_-]?[1-6]$/i.test(rawQId) || /^TEST_[1-6]$/i.test(rawQId)) &&
          !qz.lesson_id &&
          !String(qz.quiz_title || '').includes('Урок') &&
          !String(qz.quiz_title || '').includes('Мини-тест');
        const m = rawQId.match(/^(?:LESSON[_-]?(?:TEST[_-]?)?|TEST[_-]?)?(\d+)$/i);
        const qId = rawQId.includes('FINAL')
          ? 'FINAL_EXAM'
          : isExplicitBlock
          ? `BLOCK_TEST_${rawQId.replace(/\D/g, '')}`
          : qz.lesson_id
          ? `LESSON_${qz.lesson_id}`
          : m
          ? `LESSON_${m[1]}`
          : rawQId;
        const sPct = qz.score_pct !== null && qz.score_pct !== undefined ? Number(qz.score_pct) : 100;
        let testXp = sPct >= 100 ? 100 : sPct >= 70 ? 75 : sPct >= 60 ? 50 : 0;
        if (qId === 'FINAL_EXAM') {
          testXp = 500;
        }
        if (testXp > 0) {
          passedQuizMap.set(qId, Math.max(passedQuizMap.get(qId) || 0, testXp));
        }
      }
    });

    const fallbackQuizCount = Number(userRow?.passed_quiz_count || 0);
    if (passedQuizMap.size === 0 && fallbackQuizCount > 0) {
      for (let i = 1; i <= Math.min(24, fallbackQuizCount); i++) {
        const qKey = `LESSON_${i}`;
        if (!passedQuizMap.has(qKey)) {
          passedQuizMap.set(qKey, 100);
        }
      }
    }

    let quizXp = 0;
    passedQuizMap.forEach((xp) => {
      quizXp += xp;
    });

    let sectionXp = 0;
    let lessonCompletionXp = 0;
    for (let lid = 1; lid <= 24; lid++) {
      const isComp = completedLessonIds.has(lid);
      const isLec = Boolean(
        isComp ||
          flatReadSections[`sec-${lid}-lecture`] ||
          flatReadSections[`lesson-${lid}-lecture`] ||
          flatReadSections[`lesson-${lid}-sec-1`]
      );
      const isLab = Boolean(
        isComp ||
          flatReadSections[`sec-${lid}-lab`] ||
          flatReadSections[`lesson-${lid}-lab`] ||
          flatReadSections[`lesson-${lid}-sec-2`] ||
          approvedLabMap.has(lid)
      );
      const isQz = Boolean(
        isComp ||
          flatReadSections[`sec-${lid}-quiz`] ||
          flatReadSections[`lesson-${lid}-quiz`] ||
          flatReadSections[`lesson-${lid}-sec-3`] ||
          flatReadSections[`${lid}-quiz`] ||
          passedQuizMap.has(`LESSON_${lid}`)
      );
      const isHw = Boolean(
        isComp ||
          flatReadSections[`sec-${lid}-homework`] ||
          flatReadSections[`lesson-${lid}-homework`] ||
          flatReadSections[`lesson-${lid}-sec-4`] ||
          approvedHwMap.has(lid)
      );
      const count = (isLec ? 1 : 0) + (isLab ? 1 : 0) + (isQz ? 1 : 0) + (isHw ? 1 : 0);
      sectionXp += count * 25;
      if (isComp || count === 4) {
        lessonCompletionXp += 50;
      }
    }

    let badgeXp = 0;
    if (completedLessonIds.has(1) || passedQuizMap.has('LESSON_1') || passedQuizMap.has('1')) badgeXp += 150;
    if (completedLessonIds.has(2)) badgeXp += 100;
    if (completedLessonIds.has(4)) badgeXp += 100;
    if (completedLessonIds.has(6)) badgeXp += 100;
    if (completedLessonIds.has(8)) badgeXp += 150;
    if (completedLessonIds.has(9)) badgeXp += 100;
    if (completedLessonIds.has(12)) badgeXp += 150;
    if (completedLessonIds.has(13)) badgeXp += 150;
    if (completedLessonIds.has(14)) badgeXp += 150;
    if (completedLessonIds.has(15)) badgeXp += 150;
    if (completedLessonIds.has(17)) badgeXp += 150;
    if (completedLessonIds.has(18)) badgeXp += 150;
    if (completedLessonIds.has(19)) badgeXp += 100;
    if (completedLessonIds.has(20)) badgeXp += 150;
    if (completedLessonIds.has(21)) badgeXp += 150;
    if (completedLessonIds.has(23)) badgeXp += 150;
    if (completedLessonIds.has(24)) badgeXp += 500;

    return sectionXp + lessonCompletionXp + hwXp + labXp + quizXp + badgeXp;
  } catch (err) {
    console.warn('[calculateDeterministicUserPoints] Error calculating for', email, err);
    return 0;
  }
}

export function recalculateAllUsersPoints(): void {
  try {
    const users = query(`SELECT id, email, role, total_points FROM users`);
    for (const u of users) {
      if (u.role === 'admin') {
        if (u.total_points !== 3500) {
          run(`UPDATE users SET total_points = 3500 WHERE id = ?`, [u.id]);
        }
      } else {
        const correctPts = calculateDeterministicUserPoints(u.email, u.role);
        if (u.total_points !== correctPts) {
          run(`UPDATE users SET total_points = ? WHERE id = ?`, [correctPts, u.id]);
        }
      }
    }
  } catch (err) {
    console.error('Error recalculating user points:', err);
  }
}

export function migrateAndSyncDatabase(): { success: boolean; syncedUsers?: number; error?: string } {
  try {
    const database = getDb();
    ensureTables(database);

    // 1. Deduplicate homework submissions
    const allHw = query(
      `SELECT id, lesson_id, student_email, status, submission_status, score, submitted_at FROM homework_submissions ORDER BY CASE WHEN LOWER(status) = 'approved' THEN 0 ELSE 1 END, submitted_at DESC`
    );
    const seenHwKeys = new Set<string>();
    for (const hw of allHw) {
      const key = `${hw.lesson_id}:${String(hw.student_email || '').toLowerCase().trim()}`;
      if (seenHwKeys.has(key)) {
        run(`DELETE FROM homework_submissions WHERE id = ?`, [hw.id]);
      } else {
        seenHwKeys.add(key);
      }
    }

    // 2. Deduplicate lab submissions
    const allLabs = query(
      `SELECT id, lab_id, student_email, status, submission_status, score, feedback, mentor_feedback, submitted_at FROM lab_submissions ORDER BY CASE WHEN LOWER(status) = 'approved' THEN 0 ELSE 1 END, submitted_at DESC`
    );
    const seenLabKeys = new Set<string>();
    for (const lb of allLabs) {
      const key = `${lb.lab_id}:${String(lb.student_email || '').toLowerCase().trim()}`;
      if (seenLabKeys.has(key)) {
        run(`DELETE FROM lab_submissions WHERE id = ?`, [lb.id]);
      } else {
        seenLabKeys.add(key);
        const stL = String(lb.status || lb.submission_status || '').toLowerCase();
        if (stL === 'approved') {
          const normL = normalizeMentorScore(lb.score, lb.feedback || lb.mentor_feedback);
          if (lb.score !== normL) {
            run(`UPDATE lab_submissions SET status = 'Approved', score = ? WHERE id = ?`, [normL, lb.id]);
          }
        }
      }
    }

    // 3. Deduplicate quiz submissions
    const allQuizzes = query(
      `SELECT id, quiz_id, lesson_id, student_email, passed, score_pct, submitted_at, answers_json FROM quiz_submissions ORDER BY CASE WHEN passed = 1 OR score_pct >= 60 THEN 0 ELSE 1 END, LENGTH(COALESCE(answers_json, "")) DESC, submitted_at DESC`
    );
    const seenQuizKeys = new Set<string>();
    for (const qz of allQuizzes) {
      const em = String(qz.student_email || '').toLowerCase().trim();
      const rawQ = String(qz.quiz_id || '').toUpperCase();
      const m = rawQ.match(/^(?:LESSON[_-]?|TEST[_-]?)?(\d+)$/i);
      const lid = qz.lesson_id || (m ? parseInt(m[1], 10) : NaN);
      const canonId = !isNaN(lid) && lid >= 1 && lid <= 24 && !rawQ.startsWith('BLOCK') ? `LESSON_${lid}` : rawQ;
      const key = `${canonId}:${em}`;
      if (seenQuizKeys.has(key)) {
        run(`DELETE FROM quiz_submissions WHERE id = ?`, [qz.id]);
      } else {
        seenQuizKeys.add(key);
      }
    }

    // 4. Synchronize lesson unlock sequence and progress
    const approvedHw = query(
      `SELECT id, lesson_id, student_email, status, submission_status, score, feedback, mentor_feedback, reviewed_at FROM homework_submissions`
    );
    const studentMaxLesson = new Map<string, number>();
    const studentCompletedLessons = new Map<string, Set<number>>();

    for (const hw of approvedHw) {
      const st = String(hw.status || hw.submission_status || '').toLowerCase();
      const isApp = st === 'approved';
      if (isApp) {
        const normSc = normalizeMentorScore(hw.score, hw.feedback || hw.mentor_feedback);
        if (hw.score !== normSc) {
          run(`UPDATE homework_submissions SET status = 'Approved', score = ? WHERE id = ?`, [normSc, hw.id]);
          hw.score = normSc;
        }
        const em = String(hw.student_email || '').toLowerCase().trim();
        const lId = Number(hw.lesson_id);
        if (em && lId >= 1 && lId <= 24) {
          if (!studentCompletedLessons.has(em)) studentCompletedLessons.set(em, new Set());
          studentCompletedLessons.get(em)!.add(lId);
          const nextUnlock = Math.min(24, lId + 1);
          studentMaxLesson.set(em, Math.max(studentMaxLesson.get(em) || 1, nextUnlock));

          const existingProg = queryOne(
            `SELECT read_sections, is_completed FROM lessons_progress WHERE LOWER(student_email) = ? AND lesson_id = ?`,
            [em, lId]
          );
          let secMap: Record<string, boolean> = {};
          if (existingProg?.read_sections) {
            try {
              secMap = JSON.parse(existingProg.read_sections) || {};
            } catch {}
          }
          secMap[`sec-${lId}-homework`] = true;
          if (!existingProg || existingProg.is_completed !== 1) {
            run(
              `INSERT INTO lessons_progress (student_email, lesson_id, is_completed, completed_at, read_sections)
               VALUES (?, ?, 1, ?, ?)
               ON CONFLICT(student_email, lesson_id) DO UPDATE SET is_completed = 1, read_sections = excluded.read_sections;`,
              [em, lId, new Date().toISOString(), JSON.stringify(secMap)]
            );
          }
        }
      }
    }

    const allUsers = query(`SELECT id, email, role, unlocked_lessons_count, completed_lessons_count FROM users`);
    for (const u of allUsers) {
      if (u.role === 'admin') continue;
      const em = String(u.email || '').toLowerCase().trim();
      const compSet = studentCompletedLessons.get(em) || new Set();
      const compCount = compSet.size;
      const targetUnlock = Math.max(1, studentMaxLesson.get(em) || 1);
      const newUnlock = u.role === 'parent' ? 0 : Math.min(24, targetUnlock);
      const labCount =
        queryOne(
          `SELECT COUNT(DISTINCT lab_id) as c FROM lab_submissions WHERE LOWER(student_email) = ? AND (LOWER(status) = 'approved' OR LOWER(submission_status) = 'approved')`,
          [em]
        )?.c || 0;

      const passedQuizRows = query(
        `SELECT quiz_id, lesson_id FROM quiz_submissions WHERE LOWER(student_email) = ? AND (passed = 1 OR score_pct >= 60 OR LOWER(status) = 'approved')`,
        [em]
      );
      const passedQuizSet = new Set<string>();
      passedQuizRows.forEach((qz: any) => {
        const rawQ = String(qz.quiz_id || '').toUpperCase();
        const m = rawQ.match(/^(?:LESSON[_-]?|TEST[_-]?)?(\d+)$/i);
        const lid = qz.lesson_id || (m ? parseInt(m[1], 10) : NaN);
        const canonId = !isNaN(lid) && lid >= 1 && lid <= 24 && !rawQ.startsWith('BLOCK') ? `LESSON_${lid}` : rawQ;
        passedQuizSet.add(canonId);
      });
      const quizCount = passedQuizSet.size;

      run(
        `UPDATE users SET unlocked_lessons_count = ?, completed_lessons_count = ?, completed_labs_count = ?, passed_quiz_count = ? WHERE id = ?`,
        [newUnlock, compCount, labCount, quizCount, u.id]
      );
      const pts = calculateDeterministicUserPoints(em, u.role);
      run(`UPDATE users SET total_points = ? WHERE id = ?`, [pts, u.id]);
    }

    persistDb(true);
    return { success: true, syncedUsers: allUsers.length };
  } catch (err: any) {
    console.warn('[migrateAndSyncDatabase] Notice:', err);
    return { success: false, error: err?.message };
  }
}

// ============================================================================
// FULL DATABASE SNAPSHOT (Complete Single-Source Representation)
// ============================================================================
export function getFullSnapshot(): any {
  const database = getDb();
  const users = query(`SELECT * FROM users ORDER BY total_points DESC`);
  const homework = query(`SELECT * FROM homework_submissions ORDER BY submitted_at DESC`);
  const labs = query(`SELECT * FROM lab_submissions ORDER BY submitted_at DESC`);
  const quizzes = query(`SELECT * FROM quiz_submissions ORDER BY submitted_at DESC`);
  const certificates = query(`SELECT * FROM certificates ORDER BY issued_at DESC`);
  const downloads = query(`SELECT * FROM downloads ORDER BY id ASC`);
  const faq = query(`SELECT * FROM faq_items ORDER BY id ASC`);
  const handbook = query(`SELECT * FROM handbook_sections ORDER BY order_idx ASC`);
  const progressRows = query(`SELECT * FROM lessons_progress`);
  const expHistory = query(`SELECT * FROM exp_history ORDER BY timestamp DESC LIMIT 200`);

  const progressMap: Record<string, any> = {};
  progressRows.forEach((pr: any) => {
    const em = String(pr.student_email || '').toLowerCase().trim();
    if (!progressMap[em]) {
      progressMap[em] = { flatReadSections: {}, completedLessons: [] };
    }
    if (pr.is_completed === 1) {
      progressMap[em].completedLessons.push(Number(pr.lesson_id));
    }
    if (pr.read_sections) {
      try {
        const parsed = JSON.parse(pr.read_sections);
        if (parsed && typeof parsed === 'object') {
          Object.assign(progressMap[em].flatReadSections, parsed);
        }
      } catch {}
    }
  });

  const mappedUsers = users.map((u: any) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    group: u.student_group || u.group || u.group_name || 'Группа 1 (Август 2026)',
    status: u.status || 'Active',
    unlockedLessonsCount: u.unlocked_lessons_count,
    completedLessonsCount: u.completed_lessons_count,
    completedLabsCount: u.completed_labs_count,
    passedQuizCount: u.passed_quiz_count,
    attendancePct: u.attendance_pct,
    totalPoints: u.total_points,
    registeredAt: u.registered_at,
    phone: u.phone,
    telegram: u.telegram,
    bio: u.bio,
    avatarUrl: u.avatar_url,
    hiddenFromLeaderboard: Boolean(u.hidden_from_leaderboard),
    linkedStudentId: u.linked_student_id,
    linkedStudentEmail: u.linked_student_email,
    linkedStudentName: u.linked_student_name,
    parentContact: u.parent_contact,
    lastActiveAt: u.last_active_at,
    timeSpentMinutes: u.time_spent_minutes || 0,
  }));

  const mappedHomework = homework.map((hw: any) => {
    let attachedFiles: any[] = [];
    if (hw.attached_files) {
      try {
        const parsed = typeof hw.attached_files === 'string' ? JSON.parse(hw.attached_files) : hw.attached_files;
        if (Array.isArray(parsed)) attachedFiles = parsed;
      } catch {}
    }
    const rawStatus = hw.status || 'Submitted';
    const normStatus = rawStatus === 'Pending' || rawStatus === 'pending' ? 'Submitted' : rawStatus;
    const isApproved = normStatus === 'Approved';
    const resolvedUrl = hw.file_url || hw.repo_url || hw.github_url || hw.demo_url || '';
    return {
      id: hw.id,
      lessonId: hw.lesson_id,
      studentId: hw.student_id,
      studentName: hw.student_name,
      studentEmail: hw.student_email,
      reportText: hw.report_text || hw.student_notes || '',
      studentNotes: hw.student_notes || hw.report_text || '',
      fileUrl: resolvedUrl,
      repoUrl: hw.repo_url || resolvedUrl,
      githubUrl: hw.github_url || resolvedUrl,
      demoUrl: hw.demo_url || resolvedUrl,
      attachedFiles,
      submittedAt: hw.submitted_at,
      status: normStatus,
      submissionStatus: normStatus,
      isCompleted: isApproved,
      score: isApproved ? normalizeMentorScore(hw.score, hw.feedback || hw.mentor_feedback) : hw.score,
      feedback: hw.feedback || hw.mentor_feedback || '',
      mentorFeedback: hw.mentor_feedback || hw.feedback || '',
      reviewedAt: hw.reviewed_at,
      reviewedBy: hw.reviewed_by,
    };
  });

  const mappedLabs = labs.map((l: any) => {
    let attachedFiles: any[] = [];
    if (l.attached_files) {
      try {
        const parsed = typeof l.attached_files === 'string' ? JSON.parse(l.attached_files) : l.attached_files;
        if (Array.isArray(parsed)) attachedFiles = parsed;
      } catch {}
    }
    const rawStatus = l.status || l.submission_status || 'Submitted';
    const normStatus = rawStatus === 'Pending' || rawStatus === 'pending' ? 'Submitted' : rawStatus;
    const isApproved = normStatus === 'Approved';
    const resolvedLabUrl = l.repo_url || l.file_url || l.demo_url || l.github_url || '';
    return {
      id: l.id,
      labId: l.lab_id,
      lessonId: l.lesson_id || l.lab_id,
      studentId: l.student_id,
      studentName: l.student_name,
      studentEmail: l.student_email,
      reportText: l.report_text || l.student_notes || '',
      studentNotes: l.student_notes || l.report_text || '',
      repoUrl: resolvedLabUrl,
      fileUrl: l.file_url || resolvedLabUrl,
      demoUrl: l.demo_url || resolvedLabUrl,
      githubUrl: resolvedLabUrl,
      attachedFiles,
      submittedAt: l.submitted_at,
      status: normStatus,
      submissionStatus: normStatus,
      isCompleted: isApproved,
      score: isApproved ? normalizeMentorScore(l.score, l.feedback || l.mentor_feedback) : l.score,
      feedback: l.feedback || l.mentor_feedback || '',
      mentorFeedback: l.mentor_feedback || l.feedback || '',
      reviewedAt: l.reviewed_at,
      reviewedBy: l.reviewed_by,
    };
  });

  const mappedQuizzes = quizzes.map((q: any) => {
    let parsedUserAnswers = {};
    let parsedDetails: any[] = [];
    for (const col of [q.user_answers, q.answers_json, q.details]) {
      if (!col) continue;
      try {
        const p = typeof col === 'string' ? JSON.parse(col) : col;
        if (Array.isArray(p) && p.length > 0 && parsedDetails.length === 0) parsedDetails = p;
        else if (p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length > 0)
          parsedUserAnswers = p;
      } catch {}
    }
    const rawScore = Number(q.score_pct ?? q.percentage ?? q.score ?? 0);
    const isPassed = Boolean(q.passed === 1 || q.passed === true || String(q.passed).toUpperCase() === 'PASSED' || rawScore >= 60);

    return {
      id: q.id,
      submissionId: q.id,
      quizId: q.quiz_id,
      lessonId: q.lesson_id,
      quizTitle: q.quiz_title || `Тестирование ${q.quiz_id}`,
      studentId: q.student_id,
      studentName: q.student_name,
      studentEmail: q.student_email,
      scorePct: rawScore,
      score: rawScore,
      correctCount: q.correct_count !== undefined ? Number(q.correct_count) : Math.round(rawScore / 10),
      totalQuestions: q.total_questions !== undefined ? Number(q.total_questions) : 5,
      passed: isPassed,
      submittedAt: q.submitted_at,
      status: q.status || (isPassed ? 'Submitted' : 'Failed'),
      mentorComment: q.mentor_comment,
      reviewedAt: q.reviewed_at,
      retakeAllowed: Boolean(q.retake_allowed),
      answers: parsedUserAnswers,
      userAnswers: parsedUserAnswers,
      details: parsedDetails,
    };
  });

  const leaderboard = mappedUsers
    .filter((u: any) => !u.hiddenFromLeaderboard && u.role !== 'admin' && u.role !== 'parent')
    .sort((a: any, b: any) => b.totalPoints - a.totalPoints)
    .map((u: any, index: number) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      rank: index + 1,
      totalPoints: u.totalPoints,
      completedLessons: u.completedLessonsCount,
      completedLessonsCount: u.completedLessonsCount,
      completedLabsCount: u.completedLabsCount,
      passedQuizCount: u.passedQuizCount,
      attendancePct: u.attendancePct,
      badgesCount: Math.min(10, Math.floor((u.completedLessonsCount || 0) / 2)),
      group: u.group,
      avatar: u.avatarUrl,
      avatarUrl: u.avatarUrl,
      status: u.status,
      hiddenFromLeaderboard: false,
    }));

  return {
    databaseType: 'SQLite',
    dbFilePath: DB_PATH,
    timestamp: new Date().toISOString(),
    users: mappedUsers,
    students: mappedUsers,
    homework: mappedHomework,
    homeworkSubmissions: mappedHomework,
    labs: mappedLabs,
    labSubmissions: mappedLabs,
    quizzes: mappedQuizzes,
    quizSubmissions: mappedQuizzes,
    certificates,
    downloads,
    faq,
    handbook,
    progress: progressMap,
    studentProgress: progressMap,
    leaderboard,
    expHistory,
  };
}

export function resetAllAcademicData(studentEmail?: string): boolean {
  const targetEmail = String(studentEmail || '').trim().toLowerCase();
  const now = new Date().toISOString();

  if (targetEmail && targetEmail !== 'all' && targetEmail !== 'admin@devopspro.tech') {
    run(`DELETE FROM homework_submissions WHERE LOWER(student_email) = ?;`, [targetEmail]);
    run(`DELETE FROM lab_submissions WHERE LOWER(student_email) = ?;`, [targetEmail]);
    run(`DELETE FROM quiz_submissions WHERE LOWER(student_email) = ?;`, [targetEmail]);
    run(`DELETE FROM lessons_progress WHERE LOWER(student_email) = ?;`, [targetEmail]);
    run(`DELETE FROM exp_history WHERE LOWER(student_email) = ?;`, [targetEmail]);
    try { run(`DELETE FROM exp_ledger WHERE LOWER(student_email) = ?;`, [targetEmail]); } catch {}
    try { run(`DELETE FROM certificates WHERE LOWER(student_email) = ?;`, [targetEmail]); } catch {}
    try { run(`DELETE FROM final_projects WHERE LOWER(student_email) = ?;`, [targetEmail]); } catch {}

    run(
      `
      UPDATE users 
      SET completed_lessons_count = 0, 
          completed_labs_count = 0, 
          passed_quiz_count = 0, 
          total_points = CASE WHEN role = 'admin' THEN 3500 ELSE 0 END,
          unlocked_lessons_count = CASE WHEN role = 'admin' THEN 24 ELSE 1 END,
          time_spent_minutes = 0,
          attendance_pct = 100,
          read_sections = '{}',
          test_scores = '{}',
          badges = '[]'
      WHERE LOWER(email) = ?;
    `,
      [targetEmail]
    );

    try {
      run(`INSERT INTO audit_logs (user_email, action, details, timestamp) VALUES (?, 'RESET_STUDENT_PROGRESS', ?, ?);`, [
        targetEmail,
        `Сброшена успеваемость студента ${targetEmail}`,
        now,
      ]);
    } catch {}
    persistDb(true);
    return true;
  }

  // Complete reset of all student academic data
  run(`DELETE FROM homework_submissions;`);
  run(`DELETE FROM lab_submissions;`);
  run(`DELETE FROM quiz_submissions;`);
  run(`DELETE FROM lessons_progress;`);
  run(`DELETE FROM exp_history;`);
  try { run(`DELETE FROM exp_ledger;`); } catch {}
  try { run(`DELETE FROM certificates;`); } catch {}
  try { run(`DELETE FROM final_projects;`); } catch {}

  run(`
    UPDATE users 
    SET completed_lessons_count = 0, 
        completed_labs_count = 0, 
        passed_quiz_count = 0, 
        total_points = CASE WHEN role = 'admin' THEN 3500 ELSE 0 END,
        unlocked_lessons_count = CASE WHEN role = 'admin' THEN 24 ELSE 1 END,
        time_spent_minutes = 0,
        attendance_pct = 100,
        read_sections = '{}',
        test_scores = '{}',
        badges = '[]'
    WHERE role != 'admin';
  `);

  try {
    run(`INSERT INTO audit_logs (user_email, action, details, timestamp) VALUES ('admin@devopspro.tech', 'RESET_ALL_PROGRESS', 'Сброс успеваемости всех студентов', ?);`, [now]);
  } catch {}
  persistDb(true);
  return true;
}

export function getDatabase() {
  const rawDb = getDb();
  return {
    prepare(sqlStr: string) {
      return {
        all(...params: any[]) {
          const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
          return query(sqlStr, flatParams);
        },
        get(...params: any[]) {
          const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
          return queryOne(sqlStr, flatParams);
        },
        run(...params: any[]) {
          const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
          return run(sqlStr, flatParams);
        },
      };
    },
    query,
    queryOne,
    run,
    raw: rawDb,
  };
}
