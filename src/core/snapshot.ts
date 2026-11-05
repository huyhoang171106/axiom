// src/core/snapshot.ts - File snapshotting and preimage recovery for step rollback (P7 / D2)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isSecretPath } from '../tools/permissions.js';
import { SECRET_NAME } from './secrets.js';

export interface SnapshotFileEntry {
  path: string;       // Đường dẫn tương đối với workspaceRoot, dùng dấu '/'
  sha256: string;     // Mã hash SHA-256 của nội dung file lúc chụp
  size: number;
  mode: number;
}

export interface SnapshotManifest {
  version: 1;
  createdAt: string;  // ISO timestamp lúc tạo snapshot
  workspaceRoot: string;
  files: SnapshotFileEntry[];
}

export interface RestoreOptions {
  /** Danh sách các file dự kiến bị ảnh hưởng bởi bước (nếu có); chỉ phục hồi hoặc xoá file trong danh sách này */
  affectedFiles?: readonly string[];
}

export interface RestoreResult {
  restored: string[]; // Các file đã được khôi phục về trạng thái preimage
  removed: string[];  // Các file mới sinh ra trong bước đã được dọn dẹp
  conflicts: string[];
}

const IGNORED_DIRS = new Set([
  '.git',
  '.venv',
  'node_modules',
  '__pycache__',
  'dist',
  '.axiom',
  '.cache',
  '.pytest_cache',
]);

/**
 * Kiểm tra xem một file có phải là secret hay không (không đọc và không lưu secret vào snapshot).
 */
export function isSecretFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  const base = path.basename(normalized);
  if (isSecretPath(normalized)) return true;
  if (/^\.env(\.(?!example$)[^/]*)?$/.test(base)) return true;
  if (base !== '.env.example' && SECRET_NAME.test(base)) return true;
  return false;
}

/**
 * Thu thập danh sách các file trong workspace, ưu tiên dùng git ls-files nếu có git,
 * tự động rơi về quét thư mục đệ quy nếu không có git.
 */
function listWorkspaceFiles(workspaceRoot: string): string[] {
  const result: string[] = [];

  // Thử dùng git ls-files nếu trong repo git
  try {
    const gitRes = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], {
      cwd: workspaceRoot,
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (gitRes.status === 0 && typeof gitRes.stdout === 'string') {
      const lines = gitRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const norm = line.replace(/\\/g, '/');
        if (!isSecretFile(norm)) {
          result.push(norm);
        }
      }
      return result;
    }
  } catch {
    // Không có git hoặc lệnh git thất bại, chuyển sang quét thủ công
  }

  // Quét đệ quy không cần git (hỗ trợ trường hợp repo không có git)
  function walk(currentDir: string, relBase: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name) || ent.name.startsWith('.git')) continue;
        walk(path.join(currentDir, ent.name), relBase ? `${relBase}/${ent.name}` : ent.name);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        const relPath = relBase ? `${relBase}/${ent.name}` : ent.name;
        if (!isSecretFile(relPath)) {
          result.push(relPath);
        }
      }
    }
  }

  walk(workspaceRoot, '');
  return result;
}

/**
 * Chụp snapshot các file trong workspace vào thư mục snapshotDir trước khi chạy bước 'doing'.
 * Đảm bảo:
 * - Không đọc/lưu file secret.
 * - Thư mục phân quyền 0700, file 0600.
 * - Ghi manifest atomic (file .tmp rồi rename) để chống crash giữa chừng.
 */
export function snapshotFiles(workspaceRoot: string, snapshotDir: string): SnapshotManifest {
  fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
  const filesDir = path.join(snapshotDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });

  const allFiles = listWorkspaceFiles(workspaceRoot);
  const fileEntries: SnapshotFileEntry[] = [];

  for (const relPath of allFiles) {
    const absPath = path.join(workspaceRoot, relPath);
    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) continue;

      const content = fs.readFileSync(absPath);
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');

      // Lưu bản sao preimage vào files/<relPath>
      const destPath = path.join(filesDir, relPath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destPath, content, { mode: 0o600 });

      fileEntries.push({
        path: relPath,
        sha256,
        size: stat.size,
        mode: stat.mode,
      });
    } catch {
      // Bỏ qua nếu file bị xoá hoặc khoá trong lúc chụp
    }
  }

  const manifest: SnapshotManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    workspaceRoot,
    files: fileEntries,
  };

  const manifestPath = path.join(snapshotDir, 'manifest.json');
  const tmpPath = `${manifestPath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, manifestPath);

  return manifest;
}

/**
 * Khôi phục trạng thái workspace từ snapshot khi bước bị gián đoạn/crash lúc đang 'doing'.
 * - Kiểm tra hash preimage: file nào bị sửa đổi sẽ được phục hồi về bản chụp gốc.
 * - Xoá các file mới được tạo ra bởi bước bị crash (chỉ trong affectedFiles nếu được truyền).
 * - Không phục hồi toàn bộ workspace một cách mù quáng để tránh xoá file mới của người dùng.
 */
export function restoreFiles(
  workspaceRoot: string,
  snapshotDir: string,
  opts?: RestoreOptions
): RestoreResult {
  const manifestPath = path.join(snapshotDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { restored: [], removed: [], conflicts: [] };
  }

  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as SnapshotManifest;
  } catch {
    return { restored: [], removed: [], conflicts: [] };
  }

  const restored: string[] = [];
  const removed: string[] = [];
  const conflicts: string[] = [];
  const manifestMap = new Map<string, SnapshotFileEntry>();

  for (const entry of manifest.files) {
    manifestMap.set(entry.path, entry);
  }

  const affectedSet = opts?.affectedFiles ? new Set(opts.affectedFiles.map((p) => p.replace(/\\/g, '/'))) : null;

  // 1. Khôi phục các file đã tồn tại lúc snapshot nhưng bị sửa đổi hoặc xoá
  for (const entry of manifest.files) {
    if (affectedSet && !affectedSet.has(entry.path)) {
      continue;
    }

    const currentAbs = path.join(workspaceRoot, entry.path);
    const backupAbs = path.join(snapshotDir, 'files', entry.path);

    if (!fs.existsSync(backupAbs)) continue;

    let needsRestore = false;
    if (!fs.existsSync(currentAbs)) {
      needsRestore = true;
    } else {
      try {
        const currentContent = fs.readFileSync(currentAbs);
        const currentHash = crypto.createHash('sha256').update(currentContent).digest('hex');
        if (currentHash !== entry.sha256) {
          needsRestore = true;
        }
      } catch {
        needsRestore = true;
      }
    }

    if (needsRestore) {
      try {
        fs.mkdirSync(path.dirname(currentAbs), { recursive: true });
        const backupContent = fs.readFileSync(backupAbs);
        fs.writeFileSync(currentAbs, backupContent, { mode: entry.mode });
        restored.push(entry.path);
      } catch (err) {
        conflicts.push(entry.path);
      }
    }
  }

  // 2. Dọn dẹp các file mới sinh ra trong lần chạy bước đó
  if (affectedSet) {
    // Nếu có danh sách file của bước (target files), chỉ xoá những file trong danh sách này mà trước đó chưa tồn tại
    for (const relPath of affectedSet) {
      if (!manifestMap.has(relPath)) {
        const absPath = path.join(workspaceRoot, relPath);
        if (fs.existsSync(absPath)) {
          try {
            fs.unlinkSync(absPath);
            removed.push(relPath);
          } catch {
            conflicts.push(relPath);
          }
        }
      }
    }
  } else {
    // Nếu không có affectedFiles, kiểm tra các file hiện có so với snapshot
    const currentFiles = listWorkspaceFiles(workspaceRoot);
    const snapshotCreatedTime = new Date(manifest.createdAt).getTime();

    for (const relPath of currentFiles) {
      if (!manifestMap.has(relPath)) {
        const absPath = path.join(workspaceRoot, relPath);
        try {
          const stat = fs.statSync(absPath);
          // Chỉ xoá nếu file sinh ra sau thời điểm chụp snapshot
          if (stat.mtimeMs >= snapshotCreatedTime - 1000) {
            fs.unlinkSync(absPath);
            removed.push(relPath);
          }
        } catch {
          // Bỏ qua nếu không đọc được
        }
      }
    }
  }

  return { restored, removed, conflicts };
}
