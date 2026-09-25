/**
 * e2e 测试环境：以独立 ESM 子进程启动用户态嵌入式 PostgreSQL。
 * Jest 串行执行多个测试文件时，每个文件使用独立端口和数据目录，避免
 * 上一文件的 PG 进程尚未完全释放目录导致 ENOTEMPTY。
 */
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

function suiteKey(): string {
  const testPath = expect.getState().testPath ?? process.env.JEST_WORKER_ID ?? 'default';
  return createHash('sha1').update(testPath).digest('hex').slice(0, 8);
}

const key = suiteKey();
const DATA_DIR = path.resolve(process.cwd(), `.pg-test-data-${key}`);
const PORT = 55400 + (parseInt(key.slice(0, 4), 16) % 1000);

let child: ChildProcess | null = null;

function waitForReady(proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('嵌入式 PostgreSQL 启动超时')),
      90_000,
    );
    proc.stdout!.on('data', (chunk) => {
      if (chunk.toString().includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr!.on('data', () => {
      /* postgres 日志忽略 */
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`嵌入式 PostgreSQL 提前退出 code=${code}`));
    });
  });
}

beforeAll(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  child = spawn(
    'node',
    [path.resolve(__dirname, 'embedded-server.mjs'), DATA_DIR, String(PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await waitForReady(child);

  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
  process.env.DB_USERNAME = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_DATABASE = 'eldercare_test';
}, 120_000);

afterAll(async () => {
  if (child) {
    child.kill('SIGTERM');
    await new Promise((r) => child!.on('exit', r));
    child = null;
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}, 30_000);
