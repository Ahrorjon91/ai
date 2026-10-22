import { apiRequest, ApiResponse } from './apiClient';
import { UserAccount } from '../types';

export interface AuditLogEntry {
  logId: string;
  timestamp: string;
  action: string;
  userEmail: string;
  role: string;
  details: string;
}

export const adminApi = {
  getStudents: async (): Promise<ApiResponse<UserAccount[]>> => {
    return apiRequest<UserAccount[]>('adminGetStudents', {}, 'GET');
  },

  createStudent: async (studentData: Partial<UserAccount>): Promise<ApiResponse<UserAccount>> => {
    return apiRequest<UserAccount>('adminCreateStudent', studentData);
  },

  updateStudent: async (studentId: string, studentData: Partial<UserAccount>): Promise<ApiResponse<UserAccount>> => {
    return apiRequest<UserAccount>('adminUpdateStudent', { studentId, ...studentData });
  },

  disableStudent: async (studentId: string, status: string = 'Blocked'): Promise<ApiResponse> => {
    return apiRequest('adminDisableStudent', { studentId, status });
  },

  deleteStudent: async (studentId: string, studentEmail?: string): Promise<ApiResponse> => {
    return apiRequest('deleteUser', { studentId, studentEmail, id: studentId, email: studentEmail });
  },

  getAuditLog: async (): Promise<ApiResponse<AuditLogEntry[]>> => {
    return apiRequest<AuditLogEntry[]>('getAuditLog', {}, 'GET');
  },

  createBackup: async (reason?: string): Promise<ApiResponse<any>> => {
    return apiRequest('createDatabaseBackup', { reason });
  },

  getBackups: async (): Promise<ApiResponse<any[]>> => {
    return apiRequest<any[]>('getDatabaseBackups', {}, 'GET');
  },

  restoreBackup: async (backupId: string): Promise<ApiResponse<any>> => {
    return apiRequest('restoreDatabase', { backupId });
  },

  verifyBackup: async (backupId: string): Promise<ApiResponse<any>> => {
    return apiRequest(`admin/database/backups/${encodeURIComponent(backupId)}/verify`);
  },
};
