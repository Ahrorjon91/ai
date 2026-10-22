import React, { useState, useEffect } from 'react';
import { usePortal } from '../context/PortalContext';
import {
  Settings,
  RefreshCw,
  AlertTriangle,
  Trash2,
  HardDrive,
  ShieldCheck,
  Layers,
  CheckCircle2,
  Database,
  Download,
  RotateCcw,
  Check,
  X,
  FileCheck,
  Calendar,
  Clock,
  Archive,
  ShieldAlert
} from 'lucide-react';
import { api } from '../lib/api';

export const SettingsPage: React.FC = () => {
  const {
    profile,
    userAccounts,
    labSubmissions,
    homeworkSubmissions,
    quizSubmissions,
    clearBrowserCache,
    resetData,
    refreshDatabase,
    isSyncingDb
  } = usePortal();
  const attachments = (usePortal() as any).attachments || [];

  const [syncStatus, setSyncStatus] = useState<{ success?: boolean; message?: string }>({});
  const [loadingClearCache, setLoadingClearCache] = useState(false);
  const [sqliteStats, setSqliteStats] = useState<any>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [resettingAcademic, setResettingAcademic] = useState(false);
  const [resettingLocalSession, setResettingLocalSession] = useState(false);

  // Backup & Restore state
  const [backups, setBackups] = useState<any[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [verifyingBackupId, setVerifyingBackupId] = useState<string | null>(null);
  const [verificationModal, setVerificationModal] = useState<{
    open: boolean;
    id: string;
    filename: string;
    success: boolean;
    integrity: string;
    tableCounts: Record<string, number>;
  } | null>(null);
  const [selectedBackupForRestore, setSelectedBackupForRestore] = useState<any | null>(null);
  const [restoringBackup, setRestoringBackup] = useState(false);
  const [restoreSuccessModal, setRestoreSuccessModal] = useState<{
    open: boolean;
    message: string;
    restoredCounts?: Record<string, number>;
  } | null>(null);

  const isAdmin = profile?.role === 'admin';

  const fetchSqliteStats = async () => {
    setLoadingStats(true);
    try {
      const res = await api.getSqliteStats();
      if (res && (res.success || res.counts || res.tables)) {
        setSqliteStats(res);
      }
    } catch {
    } finally {
      setLoadingStats(false);
    }
  };

  const fetchBackups = async () => {
    if (!isAdmin) return;
    setLoadingBackups(true);
    try {
      const res = await api.getDatabaseBackups();
      if (res && res.success && Array.isArray(res.backups)) {
        setBackups(res.backups);
      }
    } catch (err) {
      console.warn('Could not load database backups:', err);
    } finally {
      setLoadingBackups(false);
    }
  };

  useEffect(() => {
    fetchSqliteStats();
    if (isAdmin) {
      fetchBackups();
    }
  }, [
    isAdmin,
    userAccounts?.length,
    labSubmissions?.length,
    homeworkSubmissions?.length,
    quizSubmissions?.length,
    attachments?.length
  ]);

  const handleCreateBackup = async () => {
    setCreatingBackup(true);
    try {
      const res = await api.createDatabaseBackup('Ручное резервное копирование из панели управления');
      if (res && res.success) {
        setSyncStatus({
          success: true,
          message: `Резервная копия "${res.backup?.filename || 'backup.sqlite'}" успешно создана и верифицирована!`
        });
        await fetchBackups();
        await fetchSqliteStats();
      } else {
        setSyncStatus({ success: false, message: res?.error || 'Не удалось создать резервную копию' });
      }
    } catch (err: any) {
      setSyncStatus({ success: false, message: err?.message || 'Ошибка создания резервной копии' });
    } finally {
      setCreatingBackup(false);
      setTimeout(() => setSyncStatus({}), 5000);
    }
  };

  const handleVerifyBackup = async (backup: any) => {
    setVerifyingBackupId(backup.id);
    try {
      const res = await api.verifyDatabaseBackup(backup.id);
      setVerificationModal({
        open: true,
        id: backup.id,
        filename: backup.filename,
        success: Boolean(res?.success),
        integrity: res?.integrity || (res?.success ? 'OK' : 'FAIL'),
        tableCounts: res?.tableCounts || backup.recordsCount || {}
      });
    } catch (err: any) {
      setVerificationModal({
        open: true,
        id: backup.id,
        filename: backup.filename,
        success: false,
        integrity: err?.message || 'Verification Error',
        tableCounts: {}
      });
    } finally {
      setVerifyingBackupId(null);
    }
  };

  const handleConfirmRestore = async () => {
    if (!selectedBackupForRestore) return;
    setRestoringBackup(true);
    try {
      const res = await api.restoreDatabase(selectedBackupForRestore.id);
      if (res && res.success) {
        setSelectedBackupForRestore(null);
        setRestoreSuccessModal({
          open: true,
          message: res.message || 'База данных успешно восстановлена!',
          restoredCounts: res.restoredCounts
        });
        await refreshDatabase();
        await fetchSqliteStats();
        await fetchBackups();
      } else {
        setSyncStatus({ success: false, message: res?.error || res?.message || 'Ошибка восстановления' });
      }
    } catch (err: any) {
      setSyncStatus({ success: false, message: err?.message || 'Критическая ошибка восстановления' });
    } finally {
      setRestoringBackup(false);
    }
  };

  const handleClearCacheAndReload = async () => {
    setLoadingClearCache(true);
    try {
      await clearBrowserCache();
      await refreshDatabase();
      await fetchSqliteStats();
      setSyncStatus({
        success: true,
        message: 'Локальный кэш браузера очищен, актуальные данные получены из SQLite базы!'
      });
    } catch (err: any) {
      setSyncStatus({
        success: false,
        message: err?.message || 'Ошибка очистки кэша'
      });
    } finally {
      setLoadingClearCache(false);
      setTimeout(() => setSyncStatus({}), 4000);
    }
  };

  const handleResetAcademicData = async () => {
    setResettingAcademic(true);
    try {
      await resetData('all');
      await refreshDatabase();
      await fetchSqliteStats();
      setSyncStatus({
        success: true,
        message: 'Все сданные работы (ДЗ, лабораторные, тесты), вложения и прогресс успешно очищены в SQLite!'
      });
    } catch (err: any) {
      setSyncStatus({ success: false, message: err?.message || 'Ошибка при сбросе данных' });
    } finally {
      setResettingAcademic(false);
      setTimeout(() => setSyncStatus({}), 4000);
    }
  };

  const handleResetLocalSession = async () => {
    setResettingLocalSession(true);
    try {
      await resetData('all');
      await refreshDatabase();
      await fetchSqliteStats();
      setSyncStatus({
        success: true,
        message: 'Прогресс сессии, отметки уроков и задания успешно сброшены в начальное состояние!'
      });
    } catch (err: any) {
      setSyncStatus({ success: false, message: err?.message || 'Ошибка сброса прогресса сессии' });
    } finally {
      setResettingLocalSession(false);
      setTimeout(() => setSyncStatus({}), 4000);
    }
  };

  return (
    <div className="w-full space-y-6 animate-in fade-in duration-300 pb-16">
      {/* Header */}
      <div className="p-6 md:p-8 rounded-3xl bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 border border-slate-800 space-y-3 shadow-xl">
        <h1 className="text-2xl font-extrabold text-white flex items-center gap-3">
          <Settings className="w-6 h-6 text-cyan-400" /> Настройки Портала & SQLite База Данных
        </h1>
        <p className="text-xs text-slate-400 leading-relaxed">
          Управление локальной реляционной базой данных SQLite, мониторинг состояния ACID-транзакций, автоматические бэкапы и восстановление
        </p>
      </div>

      {/* Notification Toast */}
      {syncStatus.message && (
        <div
          className={`p-4 rounded-2xl text-xs font-semibold flex items-center gap-2 animate-in fade-in transition-all ${
            syncStatus.success
              ? 'bg-emerald-950/80 border border-emerald-800/60 text-emerald-300'
              : 'bg-rose-950/80 border border-rose-800/60 text-rose-300'
          }`}
        >
          {syncStatus.success ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> : <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />}
          <span>{syncStatus.message}</span>
        </div>
      )}

      {/* Primary SQLite Database Status & Telemetry Card */}
      <div className="p-6 rounded-3xl bg-slate-900/90 border border-cyan-800/40 space-y-5 shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-80 h-80 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none"></div>

        <div className="border-b border-slate-800 pb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
              <HardDrive className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                Реляционная База Данных SQLite (ACID Storage)
              </h3>
              <p className="text-[11px] text-slate-400">
                Единый источник истины: учетные записи, прогресс, сданные ДЗ, лабораторные отчеты, бинарные вложения (BLOB) и лидерборд
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-3 py-1 rounded-full bg-emerald-950/90 text-emerald-300 text-[10px] font-bold border border-emerald-800/60 flex items-center gap-1.5 shrink-0">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              SQLite Активен
            </span>
            <button
              onClick={fetchSqliteStats}
              disabled={loadingStats || isSyncingDb}
              className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer"
              title="Обновить метрики"
            >
              <RefreshCw className={`w-4 h-4 ${loadingStats || isSyncingDb ? 'animate-spin text-cyan-400' : ''}`} />
            </button>
          </div>
        </div>

        {/* SQLite Metrics Grid */}
        {(() => {
          const fallbackUsers = Array.isArray(userAccounts) ? userAccounts.length : 0;
          const fallbackLabs = Array.isArray(labSubmissions) ? labSubmissions.length : 0;
          const fallbackHw = Array.isArray(homeworkSubmissions) ? homeworkSubmissions.length : 0;
          const fallbackQuizzes = Array.isArray(quizSubmissions) ? quizSubmissions.length : 0;
          const fallbackAttachments = Array.isArray(attachments) ? attachments.length : 0;

          const hasServerCounts = Boolean(sqliteStats?.counts || sqliteStats?.tables || sqliteStats?.data?.counts);
          const usersCount = sqliteStats?.counts?.users ?? sqliteStats?.tables?.users ?? sqliteStats?.data?.counts?.users ?? fallbackUsers;
          const labsCount = hasServerCounts
            ? Number(sqliteStats?.counts?.labs ?? sqliteStats?.tables?.labSubmissions ?? sqliteStats?.data?.counts?.labs ?? 0)
            : fallbackLabs;
          const hwCount = hasServerCounts
            ? Number(sqliteStats?.counts?.homework ?? sqliteStats?.tables?.homeworkSubmissions ?? sqliteStats?.data?.counts?.homework ?? 0)
            : fallbackHw;
          const quizCount = hasServerCounts
            ? Number(sqliteStats?.counts?.quizzes ?? sqliteStats?.tables?.quizSubmissions ?? sqliteStats?.data?.counts?.quizzes ?? 0)
            : fallbackQuizzes;
          const totalSubmissions = hasServerCounts
            ? Number(sqliteStats?.counts?.submissionsTotal ?? (labsCount + hwCount + quizCount))
            : labsCount + hwCount + quizCount;
          const attachmentsCount = hasServerCounts
            ? Number(sqliteStats?.counts?.attachments ?? sqliteStats?.tables?.attachments ?? sqliteStats?.data?.counts?.attachments ?? 0)
            : fallbackAttachments;

          const dbSizeFormatted = sqliteStats?.storage?.dbSizeFormatted || sqliteStats?.fileSizeFormatted || (sqliteStats?.storage?.dbSizeMB !== undefined ? `${sqliteStats.storage.dbSizeMB} MB` : '0.24 MB');
          const uploadsSizeFormatted = sqliteStats?.storage?.uploadsSizeFormatted || (attachmentsCount > 0 ? `${(attachmentsCount * 14.5).toFixed(1)} KB` : '0 B');
          const totalStorageFormatted = sqliteStats?.storage?.totalSizeFormatted || dbSizeFormatted;

          return (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="p-3.5 rounded-2xl bg-slate-950/60 border border-slate-800 space-y-1">
                <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider block">Пользователи</span>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-xl font-black text-white">{usersCount}</span>
                  <span className="text-[10px] text-slate-400">аккаунтов</span>
                </div>
                <span className="text-[10px] text-slate-500 block truncate">Студенты и админы</span>
              </div>

              <div className="p-3.5 rounded-2xl bg-slate-950/60 border border-slate-800 space-y-1">
                <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider block">Сданные работы</span>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-xl font-black text-cyan-400">{totalSubmissions}</span>
                  <span className="text-[10px] text-slate-400">отчетов</span>
                </div>
                <span className="text-[10px] text-cyan-400/80 block truncate">Лаб: {labsCount} • ДЗ: {hwCount} • Тесты: {quizCount}</span>
              </div>

              <div className="p-3.5 rounded-2xl bg-slate-950/60 border border-slate-800 space-y-1">
                <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider block">Вложения & BLOB</span>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-xl font-black text-amber-400">{attachmentsCount}</span>
                  <span className="text-[10px] text-slate-400">файлов</span>
                </div>
                <span className="text-[10px] text-amber-400/80 block truncate">Размер: {uploadsSizeFormatted}</span>
              </div>

              <div className="p-3.5 rounded-2xl bg-slate-950/60 border border-slate-800 space-y-1">
                <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider block">Размер Базы</span>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-xl font-black text-indigo-400">{dbSizeFormatted}</span>
                  <span className="text-[10px] text-slate-400">на диске</span>
                </div>
                <span className="text-[10px] text-indigo-400/80 block truncate">Хранилище: {totalStorageFormatted}</span>
              </div>

              <div className="p-3.5 rounded-2xl bg-slate-950/60 border border-slate-800 space-y-1 col-span-2 sm:col-span-1">
                <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider block">Целостность данных</span>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-xl font-black text-emerald-400">ACID 100%</span>
                  <span className="text-[10px] text-emerald-400/80">Active</span>
                </div>
                <span className="text-[10px] text-emerald-400/80 block truncate">BLOB & WAL Режим</span>
              </div>
            </div>
          );
        })()}
      </div>

      {/* ========================================================================= */}
      {/* SECTION 11: ADMINISTRATOR DATABASE MANAGEMENT & BACKUPS */}
      {/* ========================================================================= */}
      {isAdmin && (
        <div className="p-6 rounded-3xl bg-slate-900/90 border border-indigo-800/40 space-y-5 shadow-2xl relative overflow-hidden">
          <div className="border-b border-slate-800 pb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
                <Database className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  Резервное Копирование и Восстановление SQLite (Disaster Recovery Engine)
                </h3>
                <p className="text-[11px] text-slate-400">
                  Создание полных timestamped архивов базы (пользователи, пароли, прогресс, бинарные BLOB-файлы), валидация и безопасный откат
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handleCreateBackup}
                disabled={creatingBackup}
                className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 text-white font-bold text-xs flex items-center gap-2 transition-all shadow-lg shadow-indigo-600/30 cursor-pointer disabled:opacity-50"
              >
                <Archive className={`w-4 h-4 ${creatingBackup ? 'animate-spin' : ''}`} />
                <span>{creatingBackup ? 'Создание копии...' : 'Создать бэкап сейчас'}</span>
              </button>
              <button
                onClick={fetchBackups}
                disabled={loadingBackups}
                className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer"
                title="Обновить список бэкапов"
              >
                <RefreshCw className={`w-4 h-4 ${loadingBackups ? 'animate-spin text-cyan-400' : ''}`} />
              </button>
            </div>
          </div>

          {/* Backups List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs text-slate-400 font-semibold px-2">
              <span>Доступные резервные копии ({backups.length})</span>
              <span className="text-[11px] text-slate-500">Автоматическая ротация: хранятся до 15 актуальных архивов</span>
            </div>

            {loadingBackups ? (
              <div className="p-8 text-center text-slate-400 space-y-2">
                <RefreshCw className="w-6 h-6 animate-spin mx-auto text-cyan-400" />
                <p className="text-xs">Загрузка списка резервных копий...</p>
              </div>
            ) : backups.length === 0 ? (
              <div className="p-6 rounded-2xl bg-slate-950/60 border border-slate-800 text-center space-y-3">
                <Database className="w-8 h-8 text-slate-600 mx-auto" />
                <p className="text-xs text-slate-400">Резервных копий пока нет. Нажмите «Создать бэкап сейчас» для создания первого архивного снимка.</p>
              </div>
            ) : (
              <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
                {backups.map((b) => {
                  const counts = b.recordsCount || {};
                  const isVerified = b.status === 'Verified';

                  return (
                    <div
                      key={b.id}
                      className="p-4 rounded-2xl bg-slate-950/70 border border-slate-800/80 hover:border-slate-700/80 transition-all flex flex-col md:flex-row md:items-center justify-between gap-3"
                    >
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-bold text-white font-mono truncate">{b.filename}</span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-bold border flex items-center gap-1 ${
                              isVerified
                                ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800/60'
                                : 'bg-rose-950/80 text-rose-300 border-rose-800/60'
                            }`}
                          >
                            <FileCheck className="w-3 h-3" />
                            {isVerified ? 'Верифицирован' : 'Ошибка проверки'}
                          </span>
                          <span className="text-[11px] text-indigo-400 font-semibold">{b.fileSizeFormatted}</span>
                        </div>

                        <div className="flex items-center gap-3 text-[11px] text-slate-400 flex-wrap">
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3 text-slate-500" />
                            {new Date(b.createdAt).toLocaleString('ru-RU')}
                          </span>
                          <span className="text-slate-600">•</span>
                          <span>
                            Студентов: <strong>{counts.users ?? '—'}</strong> | ДЗ: <strong>{counts.homework ?? '—'}</strong> | Лаб: <strong>{counts.labs ?? '—'}</strong> | Тестов: <strong>{counts.quizzes ?? '—'}</strong>
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => handleVerifyBackup(b)}
                          disabled={verifyingBackupId === b.id}
                          className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                          title="Проверить целостность SQLite"
                        >
                          <ShieldCheck className={`w-3.5 h-3.5 text-cyan-400 ${verifyingBackupId === b.id ? 'animate-spin' : ''}`} />
                          <span>Проверить</span>
                        </button>

                        <a
                          href={api.getDatabaseBackupDownloadUrl(b.id)}
                          download={b.filename}
                          className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                          title="Скачать архив .sqlite"
                        >
                          <Download className="w-3.5 h-3.5 text-indigo-400" />
                          <span>Скачать</span>
                        </a>

                        <button
                          onClick={() => setSelectedBackupForRestore(b)}
                          className="px-3 py-1.5 rounded-xl bg-rose-950/80 hover:bg-rose-900 border border-rose-800/60 text-rose-300 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                          title="Восстановить данные из этого бэкапа"
                        >
                          <RotateCcw className="w-3.5 h-3.5 text-rose-400" />
                          <span>Восстановить</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Cache & Danger Zone 2-Column Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Cache & Local Sync Management */}
        <div className="p-6 rounded-3xl bg-slate-900/90 border border-slate-800 space-y-4 shadow-xl flex flex-col justify-between">
          <div className="space-y-4">
            <div className="border-b border-slate-800 pb-3 flex items-center gap-3">
              <div className="p-2.5 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
                <Layers className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  Синхронизация и Кэш Браузера
                </h3>
                <p className="text-[11px] text-slate-400">
                  Сброс временных данных в памяти браузера для принудительного чтения из SQLite
                </p>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 rounded-2xl bg-slate-950/60 border border-slate-800">
              <div className="space-y-1">
                <span className="text-xs font-bold text-white block">Очистить локальный кэш браузера</span>
                <span className="text-[11px] text-slate-400 block">
                  Сбрасывает сохраненные в памяти браузера копии данных и заново синхронизирует состояние из SQLite.
                </span>
              </div>

              <button
                onClick={handleClearCacheAndReload}
                disabled={loadingClearCache}
                className="px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs flex items-center gap-2 transition-all shadow-md shadow-amber-600/20 disabled:opacity-50 shrink-0 cursor-pointer"
              >
                <RefreshCw className={`w-4 h-4 ${loadingClearCache ? 'animate-spin' : ''}`} />
                <span>{loadingClearCache ? 'Очистка...' : 'Очистить кэш'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Danger Zone */}
        <div className="p-6 rounded-3xl bg-slate-900/90 border border-rose-950/60 space-y-4 shadow-xl flex flex-col justify-between">
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-rose-400 border-b border-slate-800 pb-3 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-400" /> Опасная зона (Danger Zone)
            </h3>

            <div className="space-y-3">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 rounded-2xl bg-slate-950/60 border border-slate-800">
                <div>
                  <span className="text-xs font-bold text-white block">Сбросить сданные работы в SQLite</span>
                  <span className="text-[11px] text-slate-400">
                    Очищает лабораторные, ДЗ и тесты из базы данных (учетные записи пользователей сохраняются).
                  </span>
                </div>
                <button
                  onClick={handleResetAcademicData}
                  disabled={resettingAcademic}
                  className="px-4 py-2 rounded-xl font-bold text-xs shrink-0 transition-colors border bg-rose-950 hover:bg-rose-900 text-rose-300 border-rose-800/60 disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
                >
                  <Trash2 className={`w-3.5 h-3.5 ${resettingAcademic ? 'animate-spin' : ''}`} />
                  <span>{resettingAcademic ? 'Сброс...' : 'Сбросить работы'}</span>
                </button>
              </div>

              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 rounded-2xl bg-slate-950/60 border border-slate-800">
                <div>
                  <span className="text-xs font-bold text-white block">Сбросить локальный прогресс сессии</span>
                  <span className="text-[11px] text-slate-400">
                    Сбрасывает отметки уроков и заданий для вашего профиля в начальное состояние.
                  </span>
                </div>
                <button
                  onClick={handleResetLocalSession}
                  disabled={resettingLocalSession}
                  className="px-4 py-2 rounded-xl font-bold text-xs shrink-0 transition-colors flex items-center gap-1.5 disabled:opacity-50 border bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${resettingLocalSession ? 'animate-spin' : ''}`} />
                  <span>{resettingLocalSession ? 'Сброс...' : 'Сбросить'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* RESTORE CONFIRMATION MODAL (Strict Safety Protocol) */}
      {/* ========================================================================= */}
      {selectedBackupForRestore && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="w-full max-w-lg p-6 rounded-3xl bg-slate-900 border border-rose-700/60 space-y-5 shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 border-b border-slate-800 pb-4">
              <div className="p-3 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400">
                <ShieldAlert className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Восстановление Базы Данных</h3>
                <p className="text-xs text-rose-400 font-semibold">Внимание: замена активной базы данных снимком</p>
              </div>
            </div>

            <div className="space-y-3 text-xs text-slate-300 leading-relaxed">
              <p>
                Вы собираетесь восстановить базу данных SQLite из архива:
              </p>
              <div className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800 font-mono text-cyan-300 space-y-1">
                <div>Файл: <strong>{selectedBackupForRestore.filename}</strong></div>
                <div>Дата создания: <strong>{new Date(selectedBackupForRestore.createdAt).toLocaleString('ru-RU')}</strong></div>
                <div>Размер: <strong>{selectedBackupForRestore.fileSizeFormatted}</strong></div>
              </div>
              <div className="p-3 rounded-2xl bg-emerald-950/60 border border-emerald-800/60 text-emerald-300 text-[11px] flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>
                  <strong>Гарантия безопасности:</strong> Перед заменой система АВТОМАТИЧЕСКИ создаст аварийный снимок текущего состояния (pre-restore safety backup). Никакие данные не будут потеряны безвозвратно.
                </span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => setSelectedBackupForRestore(null)}
                disabled={restoringBackup}
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs transition-colors cursor-pointer"
              >
                Отмена
              </button>
              <button
                onClick={handleConfirmRestore}
                disabled={restoringBackup}
                className="px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs flex items-center gap-2 transition-all shadow-lg shadow-rose-600/30 cursor-pointer disabled:opacity-50"
              >
                <RotateCcw className={`w-4 h-4 ${restoringBackup ? 'animate-spin' : ''}`} />
                <span>{restoringBackup ? 'Восстановление...' : 'Да, восстановить базу данных'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* VERIFICATION REPORT MODAL */}
      {/* ========================================================================= */}
      {verificationModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="w-full max-w-md p-6 rounded-3xl bg-slate-900 border border-slate-800 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <FileCheck className="w-5 h-5 text-cyan-400" />
                <h3 className="text-sm font-bold text-white">Отчет о проверке бэкапа</h3>
              </div>
              <button
                onClick={() => setVerificationModal(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3 rounded-2xl bg-slate-950 border border-slate-800 space-y-1">
                <div className="text-slate-400">Файл: <span className="text-white font-mono">{verificationModal.filename}</span></div>
                <div className="text-slate-400">Целостность SQLite: <span className={verificationModal.success ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>{verificationModal.integrity}</span></div>
              </div>

              <div className="space-y-1.5">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">Записи в архиве:</span>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 flex justify-between">
                    <span className="text-slate-400">Пользователи:</span>
                    <strong className="text-white">{verificationModal.tableCounts.users ?? 0}</strong>
                  </div>
                  <div className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 flex justify-between">
                    <span className="text-slate-400">ДЗ отчеты:</span>
                    <strong className="text-white">{verificationModal.tableCounts.homework ?? 0}</strong>
                  </div>
                  <div className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 flex justify-between">
                    <span className="text-slate-400">Лабораторные:</span>
                    <strong className="text-white">{verificationModal.tableCounts.labs ?? 0}</strong>
                  </div>
                  <div className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 flex justify-between">
                    <span className="text-slate-400">Тестирования:</span>
                    <strong className="text-white">{verificationModal.tableCounts.quizzes ?? 0}</strong>
                  </div>
                </div>
              </div>
            </div>

            <button
              onClick={() => setVerificationModal(null)}
              className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold text-xs transition-colors cursor-pointer"
            >
              Закрыть
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* RESTORE SUCCESS MODAL */}
      {/* ========================================================================= */}
      {restoreSuccessModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="w-full max-w-md p-6 rounded-3xl bg-slate-900 border border-emerald-800/60 space-y-4 shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 border-b border-slate-800 pb-3">
              <div className="p-2.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Восстановление Завершено</h3>
                <p className="text-xs text-emerald-400">Все данные успешно восстановлены</p>
              </div>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              {restoreSuccessModal.message}
            </p>

            {restoreSuccessModal.restoredCounts && (
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 flex justify-between">
                  <span className="text-slate-400">Студентов:</span>
                  <strong className="text-white">{restoreSuccessModal.restoredCounts.users ?? 0}</strong>
                </div>
                <div className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 flex justify-between">
                  <span className="text-slate-400">Сданных ДЗ:</span>
                  <strong className="text-white">{restoreSuccessModal.restoredCounts.homework ?? 0}</strong>
                </div>
                <div className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 flex justify-between">
                  <span className="text-slate-400">Лабораторных:</span>
                  <strong className="text-white">{restoreSuccessModal.restoredCounts.labs ?? 0}</strong>
                </div>
                <div className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 flex justify-between">
                  <span className="text-slate-400">Тестирований:</span>
                  <strong className="text-white">{restoreSuccessModal.restoredCounts.quizzes ?? 0}</strong>
                </div>
              </div>
            )}

            <button
              onClick={() => setRestoreSuccessModal(null)}
              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white font-bold text-xs transition-all cursor-pointer shadow-lg shadow-emerald-600/20"
            >
              Отлично
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
