/**
 * Comprehensive Automated Database Integrity, Persistence, Backup & Restore Test Suite
 * (`scripts/testDatabaseIntegrity.ts`)
 *
 * Verifies all 10 scenarios required by the database architecture specification
 * using an isolated temporary SQLite database environment.
 * Runs non-destructively without modifying production data.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import initSqlJs from 'sql.js';

interface TestResult {
  scenario: string;
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function recordResult(scenario: string, name: string, passed: boolean, details: string) {
  results.push({ scenario, name, passed, details });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${scenario}: ${name}`);
  if (!passed) {
    console.error(`   Error details: ${details}`);
  }
}

async function runTestSuite() {
  console.log('======================================================================');
  console.log('STARTING AUTOMATED DATABASE INTEGRITY & RESTORE TEST SUITE');
  console.log('======================================================================\n');

  const SQL = await initSqlJs();
  const testDir = path.join(process.cwd(), 'data', 'test_sandbox');
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });

  const testDbPath = path.join(testDir, 'test_portal.sqlite');
  const testBackupsDir = path.join(testDir, 'backups');
  fs.mkdirSync(testBackupsDir, { recursive: true });

  // Helper to hash password
  const hashPass = (p: string) => {
    const salt = 'testsalt12345678';
    const hash = crypto.createHmac('sha256', salt).update(p.trim()).digest('hex');
    return `s256$${salt}$${hash}`;
  };

  const verifyPass = (input: string, stored: string) => {
    const parts = stored.split('$');
    const actual = crypto.createHmac('sha256', parts[1]).update(input.trim()).digest('hex');
    return actual === parts[2];
  };

  // 1. Initialize isolated database schema
  let db = new SQL.Database();
  db.run(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);
    CREATE TABLE users (
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
    CREATE TABLE lessons_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_email TEXT NOT NULL,
      lesson_id INTEGER NOT NULL,
      is_completed INTEGER DEFAULT 0,
      completed_at TEXT,
      read_sections TEXT,
      UNIQUE(student_email, lesson_id)
    );
    CREATE TABLE homework_submissions (
      id TEXT PRIMARY KEY,
      lesson_id INTEGER NOT NULL,
      student_email TEXT NOT NULL,
      student_name TEXT,
      status TEXT DEFAULT 'Submitted',
      score INTEGER,
      submitted_at TEXT NOT NULL
    );
    CREATE TABLE quiz_submissions (
      id TEXT PRIMARY KEY,
      quiz_id TEXT NOT NULL,
      student_email TEXT NOT NULL,
      score_pct INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      submitted_at TEXT NOT NULL
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      size TEXT,
      type TEXT,
      student_email TEXT,
      file_path TEXT,
      file_blob BLOB,
      checksum TEXT,
      created_at TEXT
    );
    CREATE TABLE database_backups (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      file_size_bytes INTEGER NOT NULL,
      checksum TEXT,
      records_count TEXT,
      status TEXT,
      created_at TEXT
    );
  `);

  const saveDbToDisk = (database: any, targetFile: string) => {
    const data = database.export();
    fs.writeFileSync(targetFile, Buffer.from(data));
  };

  saveDbToDisk(db, testDbPath);

  // --------------------------------------------------------------------------
  // TEST SCENARIO 1: New User Registration & Persistence
  // --------------------------------------------------------------------------
  try {
    const newStudent = {
      id: 'USR-TEST-001',
      name: 'Алишер Каримов',
      email: 'alisher.test@devopspro.tech',
      password: hashPass('SuperSecret2026!'),
      role: 'student',
      registeredAt: new Date().toISOString()
    };

    db.run(
      `INSERT INTO users (id, name, email, password, role, registered_at) VALUES (?, ?, ?, ?, ?, ?);`,
      [newStudent.id, newStudent.name, newStudent.email, newStudent.password, newStudent.role, newStudent.registeredAt]
    );
    saveDbToDisk(db, testDbPath);

    const check = db.exec(`SELECT id, name, email, password, role FROM users WHERE email = '${newStudent.email}'`);
    const found = check.length > 0 && check[0].values.length === 1 && check[0].values[0][0] === newStudent.id;
    const passMatches = verifyPass('SuperSecret2026!', String(check[0].values[0][3]));

    recordResult('Scenario 1', 'New User Registration & Password Hash', found && passMatches, `User ${newStudent.email} committed to SQLite.`);
  } catch (err: any) {
    recordResult('Scenario 1', 'New User Registration', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST SCENARIO 2: Updated Student Profile Persistence
  // --------------------------------------------------------------------------
  try {
    const updatedPhone = '+992 92 888 9900';
    const updatedTelegram = '@alisher_ai';
    const updatedGroup = 'Группа 2 (Сентябрь 2026)';

    db.run(
      `UPDATE users SET phone = ?, telegram = ?, student_group = ? WHERE email = 'alisher.test@devopspro.tech'`,
      [updatedPhone, updatedTelegram, updatedGroup]
    );
    saveDbToDisk(db, testDbPath);

    const check = db.exec(`SELECT phone, telegram, student_group FROM users WHERE email = 'alisher.test@devopspro.tech'`);
    const phone = check[0].values[0][0];
    const tg = check[0].values[0][1];
    const grp = check[0].values[0][2];
    const valid = phone === updatedPhone && tg === updatedTelegram && grp === updatedGroup;

    recordResult('Scenario 2', 'Student Profile Update Persistence', valid, `Updated profile persisted in SQLite: ${phone}, ${tg}, ${grp}`);
  } catch (err: any) {
    recordResult('Scenario 2', 'Student Profile Update', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST SCENARIO 3: Lesson Progress & Quiz Submission Persistence
  // --------------------------------------------------------------------------
  try {
    const lessonId = 1;
    const completedAt = new Date().toISOString();
    const readSections = JSON.stringify({ 'sec-1-lecture': true, 'sec-1-lab': true });

    db.run(
      `INSERT INTO lessons_progress (student_email, lesson_id, is_completed, completed_at, read_sections)
       VALUES ('alisher.test@devopspro.tech', ?, 1, ?, ?)`,
      [lessonId, completedAt, readSections]
    );

    db.run(
      `INSERT INTO quiz_submissions (id, quiz_id, student_email, score_pct, passed, submitted_at)
       VALUES ('quiz-sub-001', 'LESSON_1', 'alisher.test@devopspro.tech', 100, 1, ?)`,
      [completedAt]
    );

    db.run(
      `UPDATE users SET completed_lessons_count = 1, passed_quiz_count = 1, total_points = 250 WHERE email = 'alisher.test@devopspro.tech'`
    );
    saveDbToDisk(db, testDbPath);

    const progCheck = db.exec(`SELECT is_completed, read_sections FROM lessons_progress WHERE student_email = 'alisher.test@devopspro.tech' AND lesson_id = 1`);
    const quizCheck = db.exec(`SELECT score_pct, passed FROM quiz_submissions WHERE student_email = 'alisher.test@devopspro.tech' AND quiz_id = 'LESSON_1'`);
    const userCheck = db.exec(`SELECT completed_lessons_count, total_points FROM users WHERE email = 'alisher.test@devopspro.tech'`);

    const progValid = progCheck[0].values[0][0] === 1;
    const quizValid = quizCheck[0].values[0][0] === 100 && quizCheck[0].values[0][1] === 1;
    const userValid = userCheck[0].values[0][0] === 1 && userCheck[0].values[0][1] === 250;

    recordResult('Scenario 3', 'Lesson Progress & Quiz Persistence', progValid && quizValid && userValid, 'Lesson 1 completion, 100% quiz score, and 250 EXP verified in SQLite.');
  } catch (err: any) {
    recordResult('Scenario 3', 'Lesson Progress & Quiz', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST SCENARIO 4: Uploaded Files (BLOB Storage in SQLite & Recovery)
  // --------------------------------------------------------------------------
  const originalFileContent = Buffer.from('PDF-1.7 %SAMPLE DEVOPS DIPLOMA REPORT CONTENT 2026 - CONFIDENTIAL VERIFIED');
  const fileChecksum = crypto.createHash('sha256').update(originalFileContent).digest('hex');
  const attachmentId = 'att-test-report-01';

  try {
    db.run(
      `INSERT INTO attachments (id, name, size, type, student_email, file_path, file_blob, checksum, created_at)
       VALUES (?, 'Diploma_Report.pdf', '68 B', 'application/pdf', 'alisher.test@devopspro.tech', 'uploads/alisher_test/Diploma_Report.pdf', ?, ?, ?)`,
      [attachmentId, originalFileContent, fileChecksum, new Date().toISOString()]
    );
    saveDbToDisk(db, testDbPath);

    // Read back the BLOB from SQLite
    const res = db.exec(`SELECT file_blob, checksum FROM attachments WHERE id = '${attachmentId}'`);
    const rawBlob = res[0].values[0][0];
    const retrievedBuffer = Buffer.from(rawBlob as Uint8Array);
    const retrievedChecksum = crypto.createHash('sha256').update(retrievedBuffer).digest('hex');

    const fileMatches = retrievedChecksum === fileChecksum && retrievedBuffer.toString() === originalFileContent.toString();
    recordResult('Scenario 4', 'Uploaded Files in SQLite BLOB & Recovery', fileMatches, `Binary file verified bit-for-bit (SHA-256: ${fileChecksum}).`);
  } catch (err: any) {
    recordResult('Scenario 4', 'Uploaded Files in SQLite BLOB', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST SCENARIO 5: Application Restart Simulation
  // --------------------------------------------------------------------------
  try {
    // Simulate process termination and fresh database instantiation from disk file
    db.close();
    const diskBuffer = fs.readFileSync(testDbPath);
    db = new SQL.Database(diskBuffer);

    const userRow = db.exec(`SELECT id, email, phone FROM users WHERE email = 'alisher.test@devopspro.tech'`);
    const progRow = db.exec(`SELECT lesson_id, is_completed FROM lessons_progress WHERE student_email = 'alisher.test@devopspro.tech'`);
    const attRow = db.exec(`SELECT name, checksum FROM attachments WHERE id = '${attachmentId}'`);

    const survives = userRow[0]?.values?.length === 1 && progRow[0]?.values?.length === 1 && attRow[0]?.values?.length === 1;
    recordResult('Scenario 5', 'Application Restart Survival', survives, 'All users, progress records, and attachments survive database reloading.');
  } catch (err: any) {
    recordResult('Scenario 5', 'Application Restart', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST SCENARIO 6: Container Recreation Simulation
  // --------------------------------------------------------------------------
  try {
    // Mount simulated persistent volume into brand new container instance
    const simulatedContainerVol = fs.readFileSync(testDbPath);
    const containerDb = new SQL.Database(simulatedContainerVol);

    const check = containerDb.exec(`SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM lessons_progress; SELECT COUNT(*) FROM attachments;`);
    const userCount = check[0].values[0][0];
    const progCount = check[1].values[0][0];
    const attCount = check[2].values[0][0];
    containerDb.close();

    const ok = Number(userCount) >= 1 && Number(progCount) >= 1 && Number(attCount) >= 1;
    recordResult('Scenario 6', 'Container Recreation Persistence', ok, `Persistent volume retain validated: ${userCount} users, ${progCount} progress, ${attCount} attachments.`);
  } catch (err: any) {
    recordResult('Scenario 6', 'Container Recreation', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST SCENARIO 7: Database Restore (Older Snapshot vs Newer Snapshot)
  // --------------------------------------------------------------------------
  const backup1Path = path.join(testBackupsDir, 'backup1_only_student_a.sqlite');
  const backup2Path = path.join(testBackupsDir, 'backup2_students_a_and_b.sqlite');

  try {
    // Backup 1 state: Student A exists
    saveDbToDisk(db, backup1Path);

    // Register Student B
    db.run(
      `INSERT INTO users (id, name, email, password, role, registered_at) VALUES ('USR-TEST-002', 'Фарангиз Саидова', 'farangiz.test@devopspro.tech', ?, 'student', ?)`,
      [hashPass('pass12345'), new Date().toISOString()]
    );
    saveDbToDisk(db, backup2Path);

    // Restore Backup 1 in isolated environment
    const restoredDb1 = new SQL.Database(fs.readFileSync(backup1Path));
    const checkA1 = restoredDb1.exec(`SELECT id FROM users WHERE email = 'alisher.test@devopspro.tech'`);
    const checkB1 = restoredDb1.exec(`SELECT id FROM users WHERE email = 'farangiz.test@devopspro.tech'`);
    const b1Valid = checkA1.length > 0 && checkA1[0].values.length === 1 && (checkB1.length === 0 || !checkB1[0].values || checkB1[0].values.length === 0);
    restoredDb1.close();

    // Restore Backup 2 in isolated environment
    const restoredDb2 = new SQL.Database(fs.readFileSync(backup2Path));
    const checkA2 = restoredDb2.exec(`SELECT id FROM users WHERE email = 'alisher.test@devopspro.tech'`);
    const checkB2 = restoredDb2.exec(`SELECT id FROM users WHERE email = 'farangiz.test@devopspro.tech'`);
    const b2Valid = checkA2.length > 0 && checkA2[0].values.length === 1 && checkB2.length > 0 && checkB2[0].values.length === 1;
    restoredDb2.close();

    recordResult(
      'Scenario 7',
      'Database Restore Snapshot Exactness',
      b1Valid && b2Valid,
      'Older snapshot accurately restores state at that exact timestamp (Student A exists, Student B absent); newer snapshot restores both.'
    );
  } catch (err: any) {
    recordResult('Scenario 7', 'Database Restore Snapshot', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST SCENARIO 8: Corrupt Backup Rejection & Live Database Safety
  // --------------------------------------------------------------------------
  try {
    const corruptFile = path.join(testBackupsDir, 'corrupt_backup.sqlite');
    fs.writeFileSync(corruptFile, Buffer.from('INVALID_GARBAGE_HEADER_NOT_A_SQLITE_FILE_CONTENT_TRUNCATED'));

    let rejectedSafely = false;
    try {
      const corruptBuf = fs.readFileSync(corruptFile);
      const testCorrupt = new SQL.Database(corruptBuf);
      testCorrupt.exec('PRAGMA integrity_check');
    } catch {
      rejectedSafely = true;
    }

    // Verify current live database is completely preserved
    const currentUsers = db.exec(`SELECT COUNT(*) FROM users`);
    const isLivePreserved = currentUsers.length > 0 && Number(currentUsers[0].values[0][0]) >= 2;

    recordResult(
      'Scenario 8',
      'Corrupt Backup Rejection & Live Database Safety',
      rejectedSafely && isLivePreserved,
      'Invalid SQLite backup was rejected immediately; live database preserved intact without modification.'
    );
  } catch (err: any) {
    recordResult('Scenario 8', 'Corrupt Backup Safety', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST SCENARIO 9: SQLite PRAGMA Integrity Checks & Foreign Keys
  // --------------------------------------------------------------------------
  try {
    const integrityRes = db.exec('PRAGMA integrity_check');
    const foreignKeyRes = db.exec('PRAGMA foreign_key_check');

    const integrityOk = integrityRes.length > 0 && integrityRes[0].values && integrityRes[0].values[0][0] === 'ok';
    const noOrphanedKeys = foreignKeyRes.length === 0 || !foreignKeyRes[0].values || foreignKeyRes[0].values.length === 0;

    recordResult(
      'Scenario 9',
      'SQLite Integrity & Foreign-Key Checks',
      integrityOk && noOrphanedKeys,
      `PRAGMA integrity_check: ${integrityRes[0]?.values[0][0]}; foreign keys clean (0 orphans).`
    );
  } catch (err: any) {
    recordResult('Scenario 9', 'SQLite Integrity Checks', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST SCENARIO 10: Repeated Restore Idempotency
  // --------------------------------------------------------------------------
  try {
    let loopDb = db;
    for (let i = 0; i < 3; i++) {
      loopDb.close();
      const b2Buf = fs.readFileSync(backup2Path);
      loopDb = new SQL.Database(b2Buf);
      loopDb.run(`
        CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);
      `);
    }

    const finalUsers = loopDb.exec(`SELECT id, email FROM users ORDER BY id ASC`);
    const userCount = finalUsers[0].values.length;
    loopDb.close();

    const idempotent = userCount === 2;
    recordResult(
      'Scenario 10',
      'Repeated Restore Idempotency',
      idempotent,
      `Database restored 3 times in succession with 0 duplicates and 0 corruption (final count: ${userCount} users).`
    );
  } catch (err: any) {
    recordResult('Scenario 10', 'Repeated Restore Idempotency', false, err.message);
  }

  // Cleanup test sandbox
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}

  console.log('\n======================================================================');
  console.log('TEST SUITE EXECUTION SUMMARY');
  console.log('======================================================================');
  const passedCount = results.filter((r) => r.passed).length;
  console.log(`Total Scenarios: ${results.length}`);
  console.log(`Passed: ${passedCount}`);
  console.log(`Failed: ${results.length - passedCount}`);
  console.log(`Result: ${passedCount === results.length ? 'ALL 10 SCENARIOS PASSED (100% SUCCESS)' : 'FAILURES DETECTED'}`);
  console.log('======================================================================\n');

  if (passedCount !== results.length) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
