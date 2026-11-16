/**
 * Compute catalog owned by this plugin.
 *
 * Nodes, container images, and deployments live in PostgreSQL through the
 * database plugin. The page, model tools, and other plugins call the same
 * service methods. Nothing is forwarded to another product.
 *
 * @module dsh-cpm
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

const ARCHITECTURES = ['X86', 'ARM64', 'RISC-V']
const CONTAINER_ARCHITECTURES = ['X86', 'ARM64', 'RISC-V']
const CARD_TYPES = ['CPU', 'NVIDIA', '天数', '华为']
const AUTH_MODES = ['password', 'certificate']
const ICON_LIMIT = 1_400_000
const ACCELERATORS = ['CPU', 'NVIDIA', '天数', '华为']
const IMAGE_SOURCES = ['file', 'registry']
const STATUSES = ['启动中', '正常', '异常']
const RESOURCES = 'dsh_cpm_resources'
const CONTAINERS = 'dsh_cpm_containers'
const DEPLOYMENTS = 'dsh_cpm_deployments'
const FILES = 'dsh_cpm_files'
const FILE_LIMIT = 32 * 1024 * 1024
/** Bounds one object-store write so a stalled MinIO surfaces as an error instead of a hung request. */
const UPLOAD_TIMEOUT_MS = 120000
const API_PATH = '/api/cpm/records'
const DEBUG_PATH = '/api/cpm/debug'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Container server connection shown on the plugin page. Token is write-only. */
export interface ServerConfig {
  host: Volatile<string>
  port: Volatile<number>
  https: Volatile<boolean>
  token: Volatile<string>
}

/** Plugin configuration as resolved by the Loader. */
export interface Config {
  server: ServerConfig
}

/** Host schema. Values can change without remounting the service. */
export const Config = z.object({
  server: z.object({
    host: z.string().default('127.0.0.1').description('容器服务器地址').volatile(),
    port: z.number().min(1).max(65535).default(8080).description('容器服务器端口').volatile(),
    https: z.boolean().default(false).description('使用 HTTPS').volatile(),
    token: z.string().role('secret').default('').volatile().description('访问令牌'),
  }).description('容器服务器'),
})

/** Resolved container-server values. */
export interface ServerSettings {
  host: string
  port: number
  https: boolean
  token: string
}

/** One compute node stored by this plugin. */
export interface ComputeResource {
  id: string
  name: string
  architecture: string
  cardTypes: string[]
  nodeIp: string
  sshPort: number
  username: string
  /** Empty when the node logs in with a certificate. */
  password: string
  /** password or certificate. */
  authMode: string
  privateKey: string
  icon: string
  /** Registry image address, including the tag when one was chosen. */
  imageRef: string
  imageId: string
  imageName: string
  status: string
  remark: string
  cpuPercent: number | null
  memoryPercent: number | null
  diskPercent: number | null
  createdAt: string
  updatedAt: string
}

/** Fields accepted when creating or editing a node. */
export interface ComputeResourceInput {
  name: string
  architecture: string
  cardTypes: string[]
  nodeIp: string
  sshPort: number
  username: string
  password?: string
  authMode: string
  privateKey?: string
  icon?: string
  imageRef?: string
  remark?: string
  status?: string
}

/** Usage reported by another plugin or the model. Percents are 0–100. */
export interface ComputeMetricsInput {
  cpuPercent?: number | null
  memoryPercent?: number | null
  diskPercent?: number | null
  status?: string
}

/** One container image in the local repository. */
export interface ComputeContainer {
  id: string
  name: string
  architecture: string
  accelerator: string
  imageVersion: string
  composeYaml: string
  imageRef: string
  /** file or registry. */
  imageSource: string
  imageFileName: string
  icon: string
  remark: string
  createdAt: string
  updatedAt: string
}

/** Fields accepted when creating or editing an image. */
export interface ComputeContainerInput {
  name: string
  architecture: string
  accelerator: string
  imageVersion: string
  composeYaml: string
  imageRef?: string
  imageSource?: string
  imageFileName?: string
  icon?: string
  remark?: string
}

/** One deployment of an image onto a node. */
export interface ComputeDeployment {
  id: string
  containerId: string
  containerName: string
  resourceId: string
  resourceName: string
  composeYaml: string
  status: string
  createdAt: string
}

/** One image found in the configured Docker registry. */
export interface RegistryImage {
  name: string
  tags: string[]
  /** Address used to pull the image, without a tag. */
  reference: string
}

/** Counts and averages for the dashboard. */
export interface ComputeDashboard {
  resources: number
  containers: number
  deployments: number
  normal: number
  error: number
  starting: number
  averageCpu: number | null
  averageMemory: number | null
  averageDisk: number | null
}

interface MinioLike {
  putObject(bucket: string, name: string, data: Buffer, size: number, meta?: Record<string, string>): Promise<unknown>
  getObject(bucket: string, name: string): Promise<AsyncIterable<Uint8Array>>
  removeObject(bucket: string, name: string): Promise<void>
}

interface DatabaseLike {
  query<T extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>
  minio(): { bucket: string }
  withMinio<T>(operation: (client: MinioLike) => Promise<T> | T): Promise<T>
}

interface ResourceRow {
  id: string
  name: string
  architecture: string
  card_types: unknown
  node_ip: string
  docker_port: number
  ssh_port: number | null
  username: string | null
  password: string | null
  auth_mode: string | null
  private_key: string | null
  icon: string | null
  image_ref: string | null
  image_id: string | null
  status: string
  remark: string
  cpu_percent: string | number | null
  memory_percent: string | number | null
  disk_percent: string | number | null
  created_at: string | Date
  updated_at: string | Date
  image_name: string | null
}

interface ContainerRow {
  id: string
  name: string
  architecture: string
  accelerator: string
  image_version: string
  compose_yaml: string
  image_ref: string
  image_source?: string
  image_file_name?: string
  icon?: string
  remark: string
  created_at: string | Date
  updated_at: string | Date
}

interface DeploymentRow {
  id: string
  container_id: string
  resource_id: string
  compose_yaml: string
  status: string
  created_at: string | Date
  container_name: string | null
  resource_name: string | null
}

/** A failure that maps to one HTTP response. */
export class CpmError extends Error {
  readonly code: string
  readonly status: number

  /** @param code - machine-readable code. @param message - text for the page. @param status - HTTP status. */
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'CpmError'
    this.code = code
    this.status = status
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Local compute catalog. */
    cpm: CpmService
  }
}

/** @returns true for a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @returns JSON. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** @returns an ISO timestamp. */
function stamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** @returns a numeric percent or null. */
function percent(value: string | number | null): number | null {
  if (value === null || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

/** @returns a string array stored as JSON. */
function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return strings(parsed)
    } catch (_invalid) { return [] }
  }
  return []
}

/** @returns a short id. */
function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** @returns a Docker container name derived from the node name. */
function containerName(name: string, id: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return `cpm-${slug || id.slice(-8)}`
}

/** @returns a Docker container id or name safe to pass to the CLI. */
function containerRef(value: string): string {
  const id = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) throw new CpmError('invalid-container', '容器 ID 无效', 400)
  return id
}

/** @returns a single-quoted shell token. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** @returns a safe absolute directory path. */
function debugPath(value: string): string {
  const raw = value.trim() === '' ? '/' : value.trim()
  if (!raw.startsWith('/') || raw.includes('\0') || raw.length > 512) throw new CpmError('invalid-input', '目录路径无效', 400)
  const parts = raw.split('/').filter(part => part !== '' && part !== '.')
  if (parts.some(part => part === '..')) throw new CpmError('invalid-input', '目录路径无效', 400)
  return `/${parts.join('/')}`
}

/** @returns the database service, or explains that it is missing. */
function databaseOf(ctx: Context): DatabaseLike {
  const database = ctx.get('database') as DatabaseLike | undefined
  if (database === undefined) {
    throw new CpmError('database-plugin-missing', '请先启用数据库插件。', 503)
  }
  return database
}

/** @returns a required trimmed string. */
function requiredText(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new CpmError('invalid-input', message, 400)
  return value.trim()
}

/** @returns one allowed choice. */
function oneOf(value: unknown, allowed: string[], message: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new CpmError('invalid-input', message, 400)
  return value
}

/**
 * Await one object-store operation, failing with a CpmError when it exceeds the bound.
 * @param operation - the pending write or read.
 * @param ms - the bound in milliseconds.
 * @param message - the user-facing timeout message.
 * @returns the operation's result.
 * @throws {CpmError} `gateway-timeout` when the bound elapses first.
 */
async function withTimeout<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new CpmError('gateway-timeout', message, 504)) }, ms)
  })
  try {
    return await Promise.race([operation, bound])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** PostgreSQL-backed compute catalog. */
export class CpmService extends Service {
  private tableReady: Promise<void> | undefined
  private readonly debugTickets = new Map<string, { digest: string, nonce: string, resourceId: string, containerId: string, timer: ReturnType<typeof setTimeout> }>()

  /** @param ctx - host context. @param config - container server settings. */
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'cpm')
  }

  /** @returns the container server address configured on the plugin page. */
  serverSettings(): ServerSettings {
    const server = this.config.server
    return {
      host: server.host.get(),
      port: server.port.get(),
      https: server.https.get(),
      token: server.token.get(),
    }
  }

  /** Create the tables once, retrying after a failed attempt. */
  private ensureTables(): Promise<void> {
    if (this.tableReady === undefined) {
      this.tableReady = this.createTables().catch((error: unknown) => {
        this.tableReady = undefined
        throw error
      })
    }
    return this.tableReady
  }

  private async createTables(): Promise<void> {
    const database = databaseOf(this.ctx)
    await database.query(`
      CREATE TABLE IF NOT EXISTS ${CONTAINERS} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        architecture TEXT NOT NULL,
        accelerator TEXT NOT NULL,
        image_version TEXT NOT NULL,
        compose_yaml TEXT NOT NULL DEFAULT '',
        image_ref TEXT NOT NULL DEFAULT '',
        remark TEXT NOT NULL DEFAULT '',
        image_source TEXT NOT NULL DEFAULT 'registry',
        image_file_name TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await database.query(`ALTER TABLE ${CONTAINERS} ADD COLUMN IF NOT EXISTS image_source TEXT NOT NULL DEFAULT 'registry'`)
    await database.query(`ALTER TABLE ${CONTAINERS} ADD COLUMN IF NOT EXISTS image_file_name TEXT NOT NULL DEFAULT ''`)
    await database.query(`ALTER TABLE ${CONTAINERS} ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT ''`)
    await database.query(`
      CREATE TABLE IF NOT EXISTS ${RESOURCES} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        architecture TEXT NOT NULL,
        card_types JSONB NOT NULL DEFAULT '[]',
        node_ip TEXT NOT NULL,
        docker_port INTEGER NOT NULL,
        image_id TEXT NOT NULL REFERENCES ${CONTAINERS}(id),
        status TEXT NOT NULL DEFAULT '启动中',
        remark TEXT NOT NULL DEFAULT '',
        cpu_percent DOUBLE PRECISION,
        memory_percent DOUBLE PRECISION,
        disk_percent DOUBLE PRECISION,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await database.query(`ALTER TABLE ${RESOURCES} ALTER COLUMN image_id DROP NOT NULL`)
    await database.query(`ALTER TABLE ${RESOURCES} ADD COLUMN IF NOT EXISTS ssh_port INTEGER NOT NULL DEFAULT 22`)
    await database.query(`ALTER TABLE ${RESOURCES} ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT ''`)
    await database.query(`ALTER TABLE ${RESOURCES} ADD COLUMN IF NOT EXISTS password TEXT NOT NULL DEFAULT ''`)
    await database.query(`ALTER TABLE ${RESOURCES} ADD COLUMN IF NOT EXISTS auth_mode TEXT NOT NULL DEFAULT 'password'`)
    await database.query(`ALTER TABLE ${RESOURCES} ADD COLUMN IF NOT EXISTS private_key TEXT NOT NULL DEFAULT ''`)
    await database.query(`ALTER TABLE ${RESOURCES} ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT ''`)
    await database.query(`ALTER TABLE ${RESOURCES} ADD COLUMN IF NOT EXISTS image_ref TEXT NOT NULL DEFAULT ''`)
    await database.query(`
      CREATE TABLE IF NOT EXISTS ${DEPLOYMENTS} (
        id TEXT PRIMARY KEY,
        container_id TEXT NOT NULL REFERENCES ${CONTAINERS}(id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL REFERENCES ${RESOURCES}(id) ON DELETE CASCADE,
        compose_yaml TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '已记录',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await database.query(`
      CREATE TABLE IF NOT EXISTS ${FILES} (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        object_key TEXT NOT NULL DEFAULT '',
        content_type TEXT NOT NULL DEFAULT '',
        size BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
  }

  /** @returns the database plugin's MinIO bucket. */
  private fileBucket(): string {
    const bucket = databaseOf(this.ctx).minio().bucket.trim()
    if (bucket === '') throw new CpmError('minio-not-configured', '请先在数据库插件里配置 MinIO 存储桶', 503)
    return bucket
  }

  /** @returns files and folders, newest first. */
  async listFiles(): Promise<Array<{ id: string, parentId: string, name: string, kind: string, contentType: string, size: number, createdAt: string }>> {
    await this.ensureTables()
    const result = await databaseOf(this.ctx).query<{ id: string, parent_id: string | null, name: string, kind: string, content_type: string, size: string, created_at: string | Date }>(`
      SELECT id, parent_id, name, kind, content_type, size, created_at FROM ${FILES} ORDER BY kind DESC, name ASC
    `)
    return result.rows.map(row => ({
      id: row.id,
      parentId: row.parent_id ?? '',
      name: row.name,
      kind: row.kind,
      contentType: row.content_type,
      size: Number(row.size) || 0,
      createdAt: stamp(row.created_at),
    }))
  }

  /** @returns the created folder. */
  async createFolder(name: string, parentId: string): Promise<{ id: string }> {
    await this.ensureTables()
    const folder = name.trim()
    if (folder === '' || folder.includes('/') || folder.includes('\\')) throw new CpmError('invalid-input', '文件夹名称无效', 400)
    if (parentId !== '') {
      const parent = await databaseOf(this.ctx).query(`SELECT id FROM ${FILES} WHERE id = $1 AND kind = 'folder'`, [parentId])
      if (parent.rows.length === 0) throw new CpmError('not-found', '上级文件夹不存在', 404)
    }
    const id = newId('cfile')
    await databaseOf(this.ctx).query(`
      INSERT INTO ${FILES} (id, parent_id, name, kind) VALUES ($1, $2, $3, 'folder')
    `, [id, parentId === '' ? null : parentId, folder])
    return { id }
  }

  /** Store one file in MinIO and record it. */
  async uploadFile(name: string, parentId: string, contentType: string, dataBase64: string): Promise<{ id: string }> {    await this.ensureTables()
    const fileName = name.trim()
    if (fileName === '' || fileName.includes('/') || fileName.includes('\\')) throw new CpmError('invalid-input', '文件名无效', 400)
    const raw = dataBase64.replace(/^data:[^,]*,/, '')
    const bytes = Buffer.from(raw, 'base64')
    if (bytes.length === 0) throw new CpmError('invalid-input', '文件是空的', 400)
    if (bytes.length > FILE_LIMIT) throw new CpmError('invalid-input', '文件不能超过 32 MB', 400)
    if (parentId !== '') {
      const parent = await databaseOf(this.ctx).query(`SELECT id FROM ${FILES} WHERE id = $1 AND kind = 'folder'`, [parentId])
      if (parent.rows.length === 0) throw new CpmError('not-found', '上级文件夹不存在', 404)
    }
    const id = newId('cfile')
    const key = `cpm/files/${id}`
    const type = contentType.trim() || 'application/octet-stream'
    const bucket = this.fileBucket()
    await databaseOf(this.ctx).withMinio(client => withTimeout(
      client.putObject(bucket, key, bytes, bytes.length, { 'Content-Type': type }),
      UPLOAD_TIMEOUT_MS,
      'MinIO 上传超时',
    ))
    await databaseOf(this.ctx).query(`
      INSERT INTO ${FILES} (id, parent_id, name, kind, object_key, content_type, size)
      VALUES ($1, $2, $3, 'file', $4, $5, $6)
    `, [id, parentId === '' ? null : parentId, fileName, key, type, bytes.length])
    return { id }
  }

  /** Remove a file, or a folder and everything inside it. */
  async deleteFile(id: string): Promise<void> {
    await this.ensureTables()
    const rows = await databaseOf(this.ctx).query<{ id: string, parent_id: string | null, kind: string, object_key: string }>(`
      SELECT id, parent_id, kind, object_key FROM ${FILES}
    `)
    const doomed = new Set<string>()
    const visit = (current: string) => {
      doomed.add(current)
      for (const row of rows.rows) if (row.parent_id === current) visit(row.id)
    }
    if (!rows.rows.some(row => row.id === id)) throw new CpmError('not-found', '文件不存在', 404)
    visit(id)
    const bucket = this.fileBucket()
    for (const row of rows.rows) {
      if (!doomed.has(row.id) || row.kind !== 'file' || row.object_key === '') continue
      try { await databaseOf(this.ctx).withMinio(client => client.removeObject(bucket, row.object_key)) }
      catch (error) { this.ctx.logger.warn('cpm: removing %s failed: %s', row.object_key, error instanceof Error ? error.message : String(error)) }
    }
    await databaseOf(this.ctx).query(`DELETE FROM ${FILES} WHERE id = ANY($1::text[])`, [[...doomed]])
  }

  /** @returns bytes stored in MinIO for one file. */
  async readFileObject(id: string): Promise<{ name: string, contentType: string, bytes: Buffer }> {
    await this.ensureTables()
    const result = await databaseOf(this.ctx).query<{ name: string, content_type: string, object_key: string, kind: string }>(`
      SELECT name, content_type, object_key, kind FROM ${FILES} WHERE id = $1
    `, [id])
    const row = result.rows[0]
    if (row === undefined || row.kind !== 'file' || row.object_key === '') throw new CpmError('not-found', '文件不存在', 404)
    const bucket = this.fileBucket()
    const stream = await databaseOf(this.ctx).withMinio(client => client.getObject(bucket, row.object_key))
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    return { name: row.name, contentType: row.content_type || 'application/octet-stream', bytes: Buffer.concat(chunks) }
  }

  /** @returns nodes matching an optional keyword. */
  async listResources(keyword = ''): Promise<ComputeResource[]> {
    await this.ensureTables()
    const like = `%${keyword.trim()}%`
    const result = await databaseOf(this.ctx).query<ResourceRow>(`
      SELECT r.*, c.name AS image_name
      FROM ${RESOURCES} r
      LEFT JOIN ${CONTAINERS} c ON c.id = r.image_id
      WHERE $1 = '%%' OR r.name ILIKE $1 OR r.node_ip ILIKE $1 OR r.remark ILIKE $1 OR COALESCE(c.name, '') ILIKE $1
      ORDER BY r.updated_at DESC
    `, [like])
    return result.rows.map(row => this.resourceFrom(row))
  }

  /** @returns one node. */
  async getResource(id: string): Promise<ComputeResource> {
    const rows = await this.listResources()
    const found = rows.find(item => item.id === id)
    if (found === undefined) throw new CpmError('not-found', '算力资源不存在', 404)
    return found
  }

  /** @returns the created node. */
  async createResource(input: ComputeResourceInput): Promise<ComputeResource> {
    const value = await this.normalizeResource(input)
    const id = newId('cres')
    await this.deployImage(value, containerName(value.name, id))
    value.status = '正常'
    await this.ensureTables()
    await databaseOf(this.ctx).query(`
      INSERT INTO ${RESOURCES} (
        id, name, architecture, card_types, node_ip, docker_port, ssh_port, username, password, auth_mode, private_key, icon, image_ref, status, remark
      ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `, [id, value.name, value.architecture, JSON.stringify(value.cardTypes), value.nodeIp, value.sshPort, value.sshPort, value.username, value.password, value.authMode, value.privateKey, value.icon, value.imageRef, value.status, value.remark])
    return this.getResource(id)
  }

  /** @returns the updated node. */
  async updateResource(id: string, input: ComputeResourceInput): Promise<ComputeResource> {
    await this.getResource(id)
    const value = await this.normalizeResource(input)
    await this.deployImage(value, containerName(value.name, id))
    value.status = '正常'
    await databaseOf(this.ctx).query(`
      UPDATE ${RESOURCES}
      SET name = $2, architecture = $3, card_types = $4::jsonb, node_ip = $5, docker_port = $6, ssh_port = $7,
          username = $8, password = $9, auth_mode = $10, private_key = $11, icon = $12, image_ref = $13, status = $14, remark = $15, updated_at = now()
      WHERE id = $1
    `, [id, value.name, value.architecture, JSON.stringify(value.cardTypes), value.nodeIp, value.sshPort, value.sshPort, value.username, value.password, value.authMode, value.privateKey, value.icon, value.imageRef, value.status, value.remark])
    return this.getResource(id)
  }

  /**
   * Try one SSH login with the form values.
   * Password mode uses SSH_ASKPASS. Certificate mode uses a temporary key file.
   */
  async testConnection(input: ComputeResourceInput): Promise<void> {
    const login = this.loginOf(input)
    await this.sshExec(login, 'true', 12000)
  }

  /**
   * Pull the selected image on the node and start it with restart policy unless-stopped.
   * An existing container with the same name is replaced.
   */
  private async deployImage(value: Required<ComputeResourceInput>, name: string): Promise<void> {
    if (!/^[\w][\w./:-]{0,220}$/.test(value.imageRef)) throw new CpmError('invalid-input', '数传镜像地址无效', 400)
    const image = shellQuote(value.imageRef)
    const container = shellQuote(name)
    const remote = `docker pull ${image} && { docker rm -f ${container} >/dev/null 2>&1 || true; docker run -d --name ${container} --restart unless-stopped ${image}; }`
    await this.sshExec(this.loginOf(value), remote, 180000)
  }

  /** @returns the SSH login fields, rejecting an incomplete login. */
  private loginOf(input: ComputeResourceInput): Required<Pick<ComputeResourceInput, 'nodeIp' | 'sshPort' | 'username' | 'password' | 'authMode' | 'privateKey'>> {
    const nodeIp = requiredText(input.nodeIp, '请填写算力节点 IP')
    const sshPort = Number.isInteger(input.sshPort) ? input.sshPort : 22
    if (sshPort < 1 || sshPort > 65535) throw new CpmError('invalid-input', '请填写有效的 SSH 端口（1–65535）', 400)
    const username = requiredText(input.username, '请填写账号')
    const authMode = oneOf(input.authMode || 'password', AUTH_MODES, '请选择登录方式')
    const password = input.password ?? ''
    const privateKey = input.privateKey ?? ''
    if (authMode === 'password' && password.trim() === '') throw new CpmError('invalid-input', '请填写密码', 400)
    if (authMode === 'certificate' && privateKey.trim() === '') throw new CpmError('invalid-input', '请填写登录证书', 400)
    return { nodeIp, sshPort, username, password, authMode, privateKey }
  }

  /** Run one remote command over SSH. */
  private async sshExec(login: Required<Pick<ComputeResourceInput, 'nodeIp' | 'sshPort' | 'username' | 'password' | 'authMode' | 'privateKey'>>, remote: string, timeoutMs: number): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'cpm-ssh-'))
    const askpass = join(directory, 'askpass')
    const keyPath = join(directory, 'key')
    try {
      await writeFile(askpass, '#!/bin/sh\nprintf %s "$CPM_SSH_PASSWORD"\n', { mode: 0o700 })
      await chmod(askpass, 0o700)
      const args = [
        '-p', String(login.sshPort),
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=8',
        '-o', 'NumberOfPasswordPrompts=1',
        `${login.username}@${login.nodeIp}`,
        remote,
      ]
      const env = { ...process.env, DISPLAY: 'none', SSH_ASKPASS_REQUIRE: 'force', SSH_ASKPASS: askpass, CPM_SSH_PASSWORD: '' }
      if (login.authMode === 'certificate') {
        await writeFile(keyPath, login.privateKey.endsWith('\n') ? login.privateKey : `${login.privateKey}\n`, { mode: 0o600 })
        args.unshift('-i', keyPath, '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey')
      } else {
        env.CPM_SSH_PASSWORD = login.password
        args.unshift('-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no')
      }
      return await new Promise<string>((resolve, reject) => {
        const child = spawn('ssh', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
        child.on('error', (error) => { clearTimeout(timer); reject(error) })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) resolve(stdout)
          else reject(new Error(stderr.trim() || `SSH 退出码 ${String(code)}`))
        })
      })
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n').filter(line => !line.includes('Permanently added')).join(' ') : '连接失败'
      throw new CpmError('connection-failed', message || '连接失败', 400)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  /** Run one remote command and keep the raw bytes. */
  private async sshExecRaw(login: Required<Pick<ComputeResourceInput, 'nodeIp' | 'sshPort' | 'username' | 'password' | 'authMode' | 'privateKey'>>, remote: string, timeoutMs: number): Promise<Buffer> {
    const directory = await mkdtemp(join(tmpdir(), 'cpm-ssh-'))
    const askpass = join(directory, 'askpass')
    const keyPath = join(directory, 'key')
    try {
      await writeFile(askpass, '#!/bin/sh\nprintf %s "$CPM_SSH_PASSWORD"\n', { mode: 0o700 })
      await chmod(askpass, 0o700)
      const args = ['-p', String(login.sshPort), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=8', '-o', 'NumberOfPasswordPrompts=1', `${login.username}@${login.nodeIp}`, remote]
      const env = { ...process.env, DISPLAY: 'none', SSH_ASKPASS_REQUIRE: 'force', SSH_ASKPASS: askpass, CPM_SSH_PASSWORD: '' }
      if (login.authMode === 'certificate') {
        await writeFile(keyPath, login.privateKey.endsWith('\n') ? login.privateKey : `${login.privateKey}\n`, { mode: 0o600 })
        args.unshift('-i', keyPath, '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey')
      } else {
        env.CPM_SSH_PASSWORD = login.password
        args.unshift('-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no')
      }
      return await new Promise<Buffer>((resolve, reject) => {
        const child = spawn('ssh', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
        const chunks: Buffer[] = []
        let total = 0
        let stderr = ''
        const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
        child.stdout.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > 512 * 1024 * 1024) { child.kill('SIGKILL'); return }
          chunks.push(chunk)
        })
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
        child.on('error', (error) => { clearTimeout(timer); reject(error) })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (total > 512 * 1024 * 1024) reject(new Error('文件超过 512MB，无法下载'))
          else if (code === 0) resolve(Buffer.concat(chunks))
          else reject(new Error(stderr.trim() || `SSH 退出码 ${String(code)}`))
        })
      })
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n').filter(line => !line.includes('Permanently added')).join(' ') : '连接失败'
      throw new CpmError('connection-failed', message || '连接失败', 400)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  /** Stream one remote command. The temporary key stays until the stream ends. */
  private async sshExecStream(login: Required<Pick<ComputeResourceInput, 'nodeIp' | 'sshPort' | 'username' | 'password' | 'authMode' | 'privateKey'>>, remote: string, timeoutMs: number): Promise<ReadableStream<Uint8Array>> {
    const directory = await mkdtemp(join(tmpdir(), 'cpm-ssh-'))
    const askpass = join(directory, 'askpass')
    const keyPath = join(directory, 'key')
    await writeFile(askpass, '#!/bin/sh\nprintf %s "$CPM_SSH_PASSWORD"\n', { mode: 0o700 })
    await chmod(askpass, 0o700)
    const args = ['-p', String(login.sshPort), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=8', '-o', 'NumberOfPasswordPrompts=1', `${login.username}@${login.nodeIp}`, remote]
    const env = { ...process.env, DISPLAY: 'none', SSH_ASKPASS_REQUIRE: 'force', SSH_ASKPASS: askpass, CPM_SSH_PASSWORD: '' }
    if (login.authMode === 'certificate') {
      await writeFile(keyPath, login.privateKey.endsWith('\n') ? login.privateKey : `${login.privateKey}\n`, { mode: 0o600 })
      args.unshift('-i', keyPath, '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey')
    } else {
      env.CPM_SSH_PASSWORD = login.password
      args.unshift('-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no')
    }
    const child = spawn('ssh', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void rm(directory, { recursive: true, force: true })
    }
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        let total = 0
        let stderr = ''
        child.stdout.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > 512 * 1024 * 1024) {
            child.kill('SIGKILL')
            return
          }
          controller.enqueue(new Uint8Array(chunk))
        })
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
        child.on('error', (error) => { finish(); controller.error(error) })
        child.on('close', (code) => {
          finish()
          if (total > 512 * 1024 * 1024) controller.error(new Error('文件超过 512MB，无法下载'))
          else if (code === 0) controller.close()
          else controller.error(new Error(stderr.trim() || `SSH 退出码 ${String(code)}`))
        })
      },
      cancel: () => { child.kill('SIGKILL'); finish() },
    })
  }

  /** Run one remote command and send bytes on standard input. */
  private async sshExecStdin(login: Required<Pick<ComputeResourceInput, 'nodeIp' | 'sshPort' | 'username' | 'password' | 'authMode' | 'privateKey'>>, remote: string, input: Buffer, timeoutMs: number): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'cpm-ssh-'))
    const askpass = join(directory, 'askpass')
    const keyPath = join(directory, 'key')
    try {
      await writeFile(askpass, '#!/bin/sh\nprintf %s "$CPM_SSH_PASSWORD"\n', { mode: 0o700 })
      await chmod(askpass, 0o700)
      const args = ['-p', String(login.sshPort), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=8', '-o', 'NumberOfPasswordPrompts=1', `${login.username}@${login.nodeIp}`, remote]
      const env = { ...process.env, DISPLAY: 'none', SSH_ASKPASS_REQUIRE: 'force', SSH_ASKPASS: askpass, CPM_SSH_PASSWORD: '' }
      if (login.authMode === 'certificate') {
        await writeFile(keyPath, login.privateKey.endsWith('\n') ? login.privateKey : `${login.privateKey}\n`, { mode: 0o600 })
        args.unshift('-i', keyPath, '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey')
      } else {
        env.CPM_SSH_PASSWORD = login.password
        args.unshift('-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no')
      }
      await new Promise<void>((resolve, reject) => {
        const child = spawn('ssh', args, { env, stdio: ['pipe', 'ignore', 'pipe'] })
        let stderr = ''
        const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
        child.on('error', (error) => { clearTimeout(timer); reject(error) })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) resolve()
          else reject(new Error(stderr.trim() || `SSH 退出码 ${String(code)}`))
        })
        child.stdin.on('error', () => {})
        child.stdin.end(input)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n').filter(line => !line.includes('Permanently added')).join(' ') : '连接失败'
      throw new CpmError('connection-failed', message || '连接失败', 400)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  /** @returns the live metrics document published by the image on port 19191. */
  async nodeMetrics(id: string): Promise<unknown> {
    const item = await this.getResource(id)
    let response: Response
    try {
      response = await fetch(`http://${item.nodeIp}:19191/api/v1/metrics`, { signal: AbortSignal.timeout(4000) })
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法连接数采服务'
      throw new CpmError('metrics-unreachable', message, 502)
    }
    if (!response.ok) throw new CpmError('metrics-error', `数采服务返回 ${String(response.status)}`, 502)
    return response.json() as Promise<unknown>
  }

  /** @returns Docker containers on the node. */
  async nodeContainers(id: string): Promise<Array<Record<string, string>>> {
    const item = await this.getResource(id)
    const text = await this.sshExec(this.loginOf(item), 'docker ps -a --format \'{{json .}}\'', 20000)
    const rows: Array<Record<string, string>> = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (!isRecord(parsed)) continue
        const textOf = (key: string) => typeof parsed[key] === 'string' ? parsed[key] : ''
        rows.push({
          id: textOf('ID'),
          name: textOf('Names'),
          image: textOf('Image'),
          command: textOf('Command'),
          createdAt: textOf('CreatedAt'),
          status: textOf('Status'),
          state: textOf('State'),
          ports: textOf('Ports'),
        })
      } catch (_invalid) { /* skip a non-JSON line */ }
    }
    return rows
  }

  /** Start, stop, restart, or remove containers on a node. */
  async containerAct(id: string, containerIds: string[], op: string): Promise<void> {
    const verb = op === 'start' ? 'start' : op === 'stop' ? 'stop' : op === 'restart' ? 'restart' : op === 'remove' ? 'rm -f' : ''
    if (verb === '') throw new CpmError('invalid-input', '不支持的容器操作', 400)
    const refs = containerIds.map(containerRef)
    if (refs.length === 0) throw new CpmError('invalid-input', '请选择容器', 400)
    const item = await this.getResource(id)
    await this.sshExec(this.loginOf(item), `docker ${verb} ${refs.map(shellQuote).join(' ')}`, 60000)
  }

  /** @returns the tail of a container log. */
  async containerLogs(id: string, containerId: string, tail: number): Promise<string> {
    const lines = tail === 500 || tail === 1000 ? tail : 100
    const item = await this.getResource(id)
    const text = await this.sshExec(this.loginOf(item), `docker logs --tail ${String(lines)} ${shellQuote(containerRef(containerId))} 2>&1`, 30000)
    return text.length > 200000 ? text.slice(-200000) : text
  }

  /** Run one command inside a running container and return its output. */
  async containerExec(id: string, containerId: string, command: string): Promise<string> {
    const script = command.trim()
    if (script === '' || script.length > 1000) throw new CpmError('invalid-input', '请输入 1000 字以内的调试命令', 400)
    const item = await this.getResource(id)
    const text = await this.sshExec(this.loginOf(item), `docker exec ${shellQuote(containerRef(containerId))} sh -c ${shellQuote(script)}`, 20000)
    return text.length > 100000 ? text.slice(-100000) : text
  }

  /** @returns one directory level on the debug target. */
  async listDebugDir(id: string, containerId: string, dir: string): Promise<Array<{ name: string, kind: 'dir' | 'file', size: number }>> {
    const path = debugPath(dir)
    const command = `find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -printf '%s\\t%y\\t%f\\n'`
    const text = containerId === ''
      ? await this.sshExec(this.loginOf(await this.getResource(id)), command, 20000)
      : await this.containerExec(id, containerId, command)
    const entries = text.split('\n').flatMap(line => {
      const parts = line.split('\t')
      if (parts.length < 3) return []
      const name = parts.slice(2).join('\t')
      if (name === '' || name === '.' || name === '..') return []
      return [{ name, kind: parts[1] === 'd' ? 'dir' as const : 'file' as const, size: Number(parts[0]) || 0 }]
    })
    entries.sort((left, right) => (left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'dir' ? -1 : 1))
    return entries
  }

  /** @returns one remote file as a stream, with its size known first. */
  async openDebugFile(id: string, containerId: string, file: string): Promise<{ name: string, size: number, body: ReadableStream<Uint8Array> }> {
    const path = debugPath(file)
    const name = path.split('/').pop() || 'download'
    const login = this.loginOf(await this.getResource(id))
    const stat = `stat -c %s ${shellQuote(path)}`
    const statCommand = containerId === '' ? stat : `docker exec ${shellQuote(containerRef(containerId))} ${stat}`
    const size = Number((await this.sshExec(login, statCommand, 20000)).trim())
    if (!Number.isFinite(size) || size < 0) throw new CpmError('invalid-input', '无法读取文件大小', 400)
    if (size > 512 * 1024 * 1024) throw new CpmError('invalid-input', '文件超过 512MB，无法下载', 400)
    const inner = `cat ${shellQuote(path)}`
    const command = containerId === '' ? inner : `docker exec ${shellQuote(containerRef(containerId))} ${inner}`
    const body = await this.sshExecStream(login, command, 120000)
    return { name, size, body }
  }

  /** Write one uploaded file into a debug directory. */
  async uploadDebugFile(id: string, containerId: string, dir: string, filename: string, bytes: Buffer): Promise<void> {
    if (bytes.length > 512 * 1024 * 1024) throw new CpmError('invalid-input', '文件超过 512MB', 400)
    const folder = debugPath(dir)
    const base = filename.replace(/\\/g, '/').split('/').pop() || ''
    if (base === '' || base === '.' || base === '..' || base.includes('\0')) throw new CpmError('invalid-input', '文件名无效', 400)
    const dest = folder === '/' ? `/${base}` : `${folder}/${base}`
    const write = `cat > ${shellQuote(dest)}`
    const command = containerId === '' ? write : `docker exec -i ${shellQuote(containerRef(containerId))} sh -c ${shellQuote(write)}`
    await this.sshExecStdin(this.loginOf(await this.getResource(id)), command, bytes, 120000)
  }

  /** Run one shell command on the debug host or inside the container. */
  private async runDebug(id: string, containerId: string, script: string): Promise<void> {
    const remote = containerId === '' ? script : `docker exec ${shellQuote(containerRef(containerId))} sh -c ${shellQuote(script)}`
    await this.sshExec(this.loginOf(await this.getResource(id)), remote, 120000)
  }

  /** Rename one file or folder on the debug target. */
  async renameDebug(id: string, containerId: string, file: string, nextName: string): Promise<void> {
    const source = debugPath(file)
    const base = nextName.trim().replace(/\\/g, '/').split('/').pop() || ''
    if (base === '' || base === '.' || base === '..' || base.includes('\0')) throw new CpmError('invalid-input', '名称无效', 400)
    const parent = source.includes('/') ? source.slice(0, source.lastIndexOf('/')) || '/' : '/'
    const dest = parent === '/' ? `/${base}` : `${parent}/${base}`
    await this.runDebug(id, containerId, `mv ${shellQuote(source)} ${shellQuote(dest)}`)
  }

  /** Delete one file or folder on the debug target. */
  async deleteDebug(id: string, containerId: string, file: string): Promise<void> {
    const source = debugPath(file)
    if (source === '/') throw new CpmError('invalid-input', '不能删除根目录', 400)
    await this.runDebug(id, containerId, `rm -rf ${shellQuote(source)}`)
  }

  /** Copy one remote file or folder into a directory. */
  async pasteDebug(id: string, containerId: string, sourcePath: string, dir: string): Promise<void> {
    const source = debugPath(sourcePath)
    const folder = debugPath(dir)
    const script = `src=${shellQuote(source)}; folder=${shellQuote(folder)}; name=$(basename "$src"); if [ -d "$src" ]; then stem="$name"; ext=""; else case "$name" in .*) stem="$name"; ext="";; *.*) stem="\${name%.*}"; ext=".\${name##*.}";; *) stem="$name"; ext="";; esac; fi; dest="$folder/$name"; n=1; while [ -e "$dest" ]; do dest="$folder/\${stem}(\${n})\${ext}"; n=$((n+1)); [ "$n" -le 99 ] || break; done; cp -a "$src" "$dest"`
    await this.runDebug(id, containerId, script)
  }

  /** Issue a one-time ticket. The socket must answer sha256(ticket:nonce) or it is closed. */
  async debugTicket(id: string, containerId: string): Promise<{ ticket: string, nonce: string }> {
    await this.getResource(id)
    if (containerId !== '') containerRef(containerId)
    const ticket = randomBytes(16).toString('hex')
    const nonce = randomBytes(16).toString('hex')
    const digest = createHash('sha256').update(`${ticket}:${nonce}`).digest('hex')
    const timer = setTimeout(() => { this.debugTickets.delete(ticket) }, 20000)
    this.debugTickets.set(ticket, { digest, nonce, resourceId: id, containerId, timer })
    return { ticket, nonce }
  }

  /** Upgrade /api/cpm/debug after the challenge succeeds, then keep one SSH shell. */
  async acceptDebug(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const ticket = new URL(req.url || '/', 'http://localhost').searchParams.get('ticket') || ''
    const pending = this.debugTickets.get(ticket)
    if (pending === undefined) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    this.debugTickets.delete(ticket)
    clearTimeout(pending.timer)
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string' || key === '') {
      socket.destroy()
      return
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${createHash('sha1').update(key + WS_GUID).digest('base64')}`,
      '',
      '',
    ].join('\r\n'))
    const frames = new FrameReader(socket, head)
    const send = (value: unknown) => { socket.write(encodeText(JSON.stringify(value))) }
    let passed = false
    const challenge = setTimeout(() => { if (!passed) socket.destroy() }, 5000)
    frames.onText = (text) => {
      let message: Record<string, unknown> = {}
      try { message = JSON.parse(text) as Record<string, unknown> } catch { socket.destroy(); return }
      if (!passed) {
        const digest = typeof message.digest === 'string' ? message.digest : ''
        const expected = Buffer.from(pending.digest)
        const actual = Buffer.from(digest)
        if (message.type !== 'answer' || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          socket.destroy()
          return
        }
        passed = true
        clearTimeout(challenge)
        const cols = Number(message.cols)
        const rows = Number(message.rows)
        void this.openDebugShell(pending.resourceId, pending.containerId, frames, send, socket, cols, rows)
        return
      }
      if (message.type === 'resize') {
          const cols = Number(message.cols)
          const rows = Number(message.rows)
          if (Number.isFinite(cols) && Number.isFinite(rows)) frames.onResize?.(Math.floor(cols), Math.floor(rows))
          return
        }
        if (message.type === 'fs') { frames.onFs?.(message); return }
        if (message.type === 'data' && typeof message.text === 'string' && message.text.length <= 2000) frames.onData?.(message.text)
    }
    send({ type: 'challenge', nonce: pending.nonce })
  }

  /** Keep an interactive shell open so Tab and other keys reach the container. */
  private async openDebugShell(id: string, containerId: string, frames: FrameReader, send: (value: unknown) => void, socket: Duplex, cols: number, rows: number): Promise<void> {
    const item = await this.getResource(id)
    const login = this.loginOf(item)
    const directory = await mkdtemp(join(tmpdir(), 'cpm-debug-'))
    const askpass = join(directory, 'askpass')
    const keyPath = join(directory, 'key')
    await writeFile(askpass, '#!/bin/sh\nprintf %s "$CPM_SSH_PASSWORD"\n', { mode: 0o700 })
    const width = Number.isFinite(cols) ? Math.min(400, Math.max(40, Math.floor(cols))) : 100
    const height = Number.isFinite(rows) ? Math.min(120, Math.max(16, Math.floor(rows))) : 32
    const shell = `stty cols ${String(width)} rows ${String(height)} >/dev/null 2>&1; export TERM=xterm-256color; exec bash || exec sh`
    const remote = containerId === ''
      ? shell
      : `stty cols ${String(width)} rows ${String(height)} >/dev/null 2>&1; export TERM=xterm-256color; exec docker exec -it ${shellQuote(containerRef(containerId))} bash || exec docker exec -it ${shellQuote(containerRef(containerId))} sh`
    const control = join(directory, 'cm')
    const args = ['-o', 'ControlMaster=yes', '-o', `ControlPath=${control}`, '-tt', '-p', String(login.sshPort), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=8', `${login.username}@${login.nodeIp}`, remote]
    const env = { ...process.env, DISPLAY: 'none', TERM: 'xterm-256color', SSH_ASKPASS_REQUIRE: 'force', SSH_ASKPASS: askpass, CPM_SSH_PASSWORD: '' }
    if (login.authMode === 'certificate') {
      await writeFile(keyPath, login.privateKey.endsWith('\n') ? login.privateKey : `${login.privateKey}\n`, { mode: 0o600 })
      args.unshift('-i', keyPath, '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey')
    } else {
      env.CPM_SSH_PASSWORD = login.password
      args.unshift('-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no')
    }
    const child = spawn('python3', ['-c', PTY_BRIDGE, 'ssh', ...args], { env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
    const sizePipe = child.stdio[3]
    const applySize = (nextCols: number, nextRows: number) => {
      const nextWidth = Math.min(400, Math.max(40, Math.floor(nextCols)))
      const nextHeight = Math.min(120, Math.max(16, Math.floor(nextRows)))
      if (sizePipe === null || !('write' in sizePipe)) return
      sizePipe.write(`${String(nextWidth)} ${String(nextHeight)}\n`)
    }
    applySize(width, height)
    frames.onResize = applySize
    const emit = (chunk: Buffer) => {
      const text = chunk.toString('utf8').split('\n').filter(line => !line.includes('Permanently added')).join('\n')
      if (text !== '') send({ type: 'data', text })
    }
    child.stdout.on('data', emit)
    child.stderr.on('data', emit)
    child.stdout.on('error', () => {})
    child.stderr.on('error', () => {})
    child.stdin.on('error', () => {})
    child.on('error', () => { send({ type: 'closed' }) })
    frames.onData = (text) => { if (!child.killed && child.stdin.writable) child.stdin.write(text) }
    const jobs = new Map<string, ReturnType<typeof spawn>>()
    frames.onFs = (message) => { void this.runDebugFs(login, containerId, control, message, send, jobs) }
    const stop = () => {
      for (const job of jobs.values()) job.kill('SIGKILL')
      child.kill('SIGKILL')
      void rm(directory, { recursive: true, force: true })
    }
    socket.on('close', stop)
    child.on('close', () => { send({ type: 'closed' }); socket.end() })
    let shared = false
    for (let attempt = 0; attempt < 25 && !shared; attempt += 1) {
      try {
        await this.controlExec(login, control, 'true', 4000)
        shared = true
      } catch { await new Promise(resolve => { setTimeout(resolve, 200) }) }
    }
    if (!shared) { send({ type: 'closed' }); return }
    send({ type: 'ready' })
  }

  /** Run one command on the SSH connection already opened for the terminal. */
  private controlExec(login: Required<Pick<ComputeResourceInput, 'nodeIp' | 'sshPort' | 'username' | 'password' | 'authMode' | 'privateKey'>>, control: string, remote: string, timeoutMs: number): Promise<string> {
    const child = this.controlSpawn(login, control, remote, ['ignore', 'pipe', 'pipe'])
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(stdout)
        else reject(new Error(stderr.trim() || `SSH 退出码 ${String(code)}`))
      })
    })
  }

  /** Open one extra channel on the terminal SSH connection. */
  private controlSpawn(login: Required<Pick<ComputeResourceInput, 'nodeIp' | 'sshPort' | 'username' | 'password' | 'authMode' | 'privateKey'>>, control: string, remote: string, stdio: 'pipe' | 'ignore'[]): ReturnType<typeof spawn> {
    return spawn('ssh', ['-S', control, '-o', 'ControlMaster=no', '-p', String(login.sshPort), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', `${login.username}@${login.nodeIp}`, remote], { stdio })
  }

  /** File commands share the debug socket and its SSH connection. */
  private async runDebugFs(login: Required<Pick<ComputeResourceInput, 'nodeIp' | 'sshPort' | 'username' | 'password' | 'authMode' | 'privateKey'>>, containerId: string, control: string, message: Record<string, unknown>, send: (value: unknown) => void, jobs: Map<string, ReturnType<typeof spawn>>): Promise<void> {
    const id = typeof message.id === 'string' ? message.id : ''
    const op = typeof message.op === 'string' ? message.op : ''
    const reply = (body: Record<string, unknown>) => { send({ type: 'fs', id, ...body }) }
    const remoteOf = (script: string, input = false) => containerId === '' ? script : `docker exec ${input ? '-i ' : ''}${shellQuote(containerRef(containerId))} sh -c ${shellQuote(script)}`
    try {
      if (op === 'cancel') {
        jobs.get(id)?.kill('SIGKILL')
        jobs.delete(id)
        return
      }
      if (op === 'list') {
        const path = debugPath(typeof message.path === 'string' ? message.path : '/')
        const text = await this.controlExec(login, control, remoteOf(`find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -printf '%s\\t%y\\t%f\\n'`), 20000)
        const entries = text.split('\n').flatMap(line => {
          const parts = line.split('\t')
          if (parts.length < 3) return []
          const name = parts.slice(2).join('\t')
          if (name === '' || name === '.' || name === '..') return []
          return [{ name, kind: parts[1] === 'd' ? 'dir' : 'file', size: Number(parts[0]) || 0 }]
        })
        entries.sort((left, right) => (left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'dir' ? -1 : 1))
        reply({ ok: true, entries })
        return
      }
      if (op === 'rename' || op === 'delete' || op === 'paste') {
        const file = debugPath(typeof message.path === 'string' ? message.path : '')
        if (op === 'delete' && file === '/') throw new Error('不能删除根目录')
        let script = ''
        if (op === 'delete') script = `rm -rf ${shellQuote(file)}`
        else if (op === 'rename') {
          const base = String(message.name || '').trim().replace(/\\/g, '/').split('/').pop() || ''
          if (base === '' || base === '.' || base === '..') throw new Error('名称无效')
          const parent = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) || '/' : '/'
          const dest = parent === '/' ? `/${base}` : `${parent}/${base}`
          script = `mv ${shellQuote(file)} ${shellQuote(dest)}`
        } else {
          const folder = debugPath(typeof message.dir === 'string' ? message.dir : '/')
          script = `src=${shellQuote(file)}; folder=${shellQuote(folder)}; name=$(basename "$src"); if [ -d "$src" ]; then stem="$name"; ext=""; else case "$name" in .*) stem="$name"; ext="";; *.*) stem="\${name%.*}"; ext=".\${name##*.}";; *) stem="$name"; ext="";; esac; fi; dest="$folder/$name"; n=1; while [ -e "$dest" ]; do dest="$folder/\${stem}(\${n})\${ext}"; n=$((n+1)); [ "$n" -le 99 ] || break; done; cp -a "$src" "$dest"`
        }
        await this.controlExec(login, control, remoteOf(script), 120000)
        reply({ ok: true, done: true })
        return
      }
      if (op === 'download') {
        const path = debugPath(typeof message.path === 'string' ? message.path : '')
        const size = Number((await this.controlExec(login, control, remoteOf(`stat -c %s ${shellQuote(path)}`), 20000)).trim())
        if (!Number.isFinite(size) || size < 0) throw new Error('无法读取文件大小')
        if (size > 512 * 1024 * 1024) throw new Error('文件超过 512MB，无法下载')
        const child = this.controlSpawn(login, control, remoteOf(`cat ${shellQuote(path)}`), ['ignore', 'pipe', 'pipe'])
        jobs.set(id, child)
        let pending = Buffer.alloc(0)
        const push = (last: boolean) => {
          while (pending.length >= 24 * 1024 || (last && pending.length > 0)) {
            const take = pending.subarray(0, 24 * 1024)
            pending = pending.subarray(take.length)
            reply({ data: take.toString('base64'), total: size })
          }
        }
        child.stdout?.on('data', (chunk: Buffer) => { pending = Buffer.concat([pending, chunk]); push(false) })
        child.on('close', (code) => {
          jobs.delete(id)
          if (code === 0) { push(true); reply({ done: true, total: size }) }
          else reply({ error: '下载失败' })
        })
        return
      }
      if (op === 'upload-begin') {
        const folder = debugPath(typeof message.dir === 'string' ? message.dir : '/')
        const base = String(message.name || '').replace(/\\/g, '/').split('/').pop() || ''
        const size = Number(message.size) || 0
        if (base === '' || base === '.' || base === '..') throw new Error('文件名无效')
        if (size > 512 * 1024 * 1024) throw new Error('文件超过 512MB')
        const dest = folder === '/' ? `/${base}` : `${folder}/${base}`
        const child = this.controlSpawn(login, control, remoteOf(`cat > ${shellQuote(dest)}`, true), ['pipe', 'pipe', 'pipe'])
        jobs.set(id, child)
        reply({ ok: true })
        return
      }
      if (op === 'upload-chunk' || op === 'upload-end') {
        const child = jobs.get(id)
        if (child === undefined || child.stdin === null) throw new Error('上传已中断')
        if (op === 'upload-chunk' && typeof message.data === 'string') child.stdin.write(Buffer.from(message.data, 'base64'))
        if (op === 'upload-end') {
          child.stdin.end()
          child.on('close', (code) => {
            jobs.delete(id)
            reply(code === 0 ? { done: true } : { error: '上传失败' })
          })
        }
        return
      }
      reply({ error: '不支持的文件操作' })
    } catch (error) {
      jobs.get(id)?.kill('SIGKILL')
      jobs.delete(id)
      reply({ error: error instanceof Error ? error.message : '文件操作失败' })
    }
  }

  /** Remove one node and its deployments. */
  async deleteResource(id: string): Promise<void> {
    await this.getResource(id)
    await databaseOf(this.ctx).query(`DELETE FROM ${RESOURCES} WHERE id = $1`, [id])
  }

  /**
   * Store usage reported by another plugin or the model.
   * @returns the updated node.
   */
  async reportMetrics(id: string, input: ComputeMetricsInput): Promise<ComputeResource> {
    await this.getResource(id)
    const cpu = this.optionalPercent(input.cpuPercent, 'CPU')
    const memory = this.optionalPercent(input.memoryPercent, '内存')
    const disk = this.optionalPercent(input.diskPercent, '存储')
    const status = input.status === undefined ? null : oneOf(input.status, STATUSES, '状态无效')
    await databaseOf(this.ctx).query(`
      UPDATE ${RESOURCES}
      SET cpu_percent = COALESCE($2, cpu_percent),
          memory_percent = COALESCE($3, memory_percent),
          disk_percent = COALESCE($4, disk_percent),
          status = COALESCE($5, status),
          updated_at = now()
      WHERE id = $1
    `, [id, cpu, memory, disk, status])
    return this.getResource(id)
  }

  /** @returns images matching an optional keyword. */
  async listContainers(keyword = ''): Promise<ComputeContainer[]> {
    await this.ensureTables()
    const like = `%${keyword.trim()}%`
    const result = await databaseOf(this.ctx).query<ContainerRow>(`
      SELECT * FROM ${CONTAINERS}
      WHERE $1 = '%%' OR name ILIKE $1 OR image_ref ILIKE $1 OR remark ILIKE $1 OR image_version ILIKE $1
      ORDER BY updated_at DESC
    `, [like])
    return result.rows.map(row => this.containerFrom(row))
  }

  /** @returns one image. */
  async getContainer(id: string): Promise<ComputeContainer> {
    const found = (await this.listContainers()).find(item => item.id === id)
    if (found === undefined) throw new CpmError('not-found', '容器镜像不存在', 404)
    return found
  }

  /** @returns the created image. */
  async createContainer(input: ComputeContainerInput): Promise<ComputeContainer> {
    const value = this.normalizeContainer(input)
    const id = newId('cimg')
    await this.ensureTables()
    await databaseOf(this.ctx).query(`
      INSERT INTO ${CONTAINERS} (id, name, architecture, accelerator, image_version, compose_yaml, image_ref, remark, image_source, image_file_name, icon)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [id, value.name, value.architecture, value.accelerator, value.imageVersion, value.composeYaml, value.imageRef, value.remark, value.imageSource, value.imageFileName, value.icon])
    return this.getContainer(id)
  }

  /** @returns the updated image. */
  async updateContainer(id: string, input: ComputeContainerInput): Promise<ComputeContainer> {
    await this.getContainer(id)
    const value = this.normalizeContainer(input)
    const resources = await databaseOf(this.ctx).query<{ name: string; architecture: string }>(
      `SELECT name, architecture FROM ${RESOURCES} WHERE image_id = $1`,
      [id],
    )
    const mismatch = resources.rows.find(row => row.architecture !== value.architecture)
    if (mismatch !== undefined) {
      throw new CpmError('invalid-input', `镜像已被算力资源「${mismatch.name}」使用，架构必须保持一致`, 400)
    }
    await databaseOf(this.ctx).query(`
      UPDATE ${CONTAINERS}
      SET name = $2, architecture = $3, accelerator = $4, image_version = $5, compose_yaml = $6, image_ref = $7, remark = $8,
          image_source = $9, image_file_name = $10, icon = $11, updated_at = now()
      WHERE id = $1
    `, [id, value.name, value.architecture, value.accelerator, value.imageVersion, value.composeYaml, value.imageRef, value.remark, value.imageSource, value.imageFileName, value.icon])
    return this.getContainer(id)
  }

  /** Remove one image. Fails while a node still points at it. */
  async deleteContainer(id: string): Promise<void> {
    await this.getContainer(id)
    const used = await databaseOf(this.ctx).query(`SELECT id FROM ${RESOURCES} WHERE image_id = $1 LIMIT 1`, [id])
    if (used.rows.length > 0) throw new CpmError('in-use', '已有算力资源使用该镜像', 409)
    await databaseOf(this.ctx).query(`DELETE FROM ${CONTAINERS} WHERE id = $1`, [id])
  }

  /**
   * Record a deployment of an image onto a node.
   * The compose text defaults to the image's saved orchestration.
   */
  async deploy(containerId: string, resourceId: string, composeYaml = ''): Promise<{ deployment: ComputeDeployment, log: string, ok: boolean }> {
    const container = await this.getContainer(containerId)
    const resource = await this.getResource(resourceId)
    if (container.architecture && resource.architecture && container.architecture !== resource.architecture) {
      throw new CpmError('invalid-input', '镜像架构和算力资源不一致', 400)
    }
    const compose = composeYaml.trim() === '' ? container.composeYaml : composeYaml
    if (compose.trim() === '') throw new CpmError('invalid-input', '请填写 Docker 编排', 400)
    const dir = `/tmp/cpm-${newId('dep').slice(-10)}`
    const login = this.loginOf(resource)
    const payload = Buffer.from(compose, 'utf8').toString('base64')
    const composeFile = `${dir}/compose.yml`
    const remote = `mkdir -p ${shellQuote(dir)} && printf %s ${shellQuote(payload)} | base64 -d > ${shellQuote(composeFile)} && docker compose -f ${shellQuote(composeFile)} up -d`
    const statusCmd = `docker compose -f ${shellQuote(composeFile)} ps -a --format '{{.Name}} {{.State}} {{.Status}}'`
    let log = [
      `$ ssh -p ${String(login.sshPort)} ${login.username}@${login.nodeIp}`,
      `$ mkdir -p ${dir}`,
      `$ cat > ${composeFile}`,
      `$ docker compose -f ${composeFile} up -d`,
      '',
    ].join('\n')
    let ok = true
    try {
      log += await this.sshExec(login, `${remote} 2>&1`, 180000)
      log += `\n$ docker compose -f ${composeFile} ps -a\n`
      const status = await this.sshExec(login, `${statusCmd} 2>&1`, 20000)
      log += status.endsWith('\n') ? status : `${status}\n`
      const lines = status.split('\n').map(line => line.trim()).filter(line => line !== '')
      const running = lines.length > 0 && lines.every(line => /\brunning\b/i.test(line))
      if (running) log += '部署成功\n'
      else {
        ok = false
        log += '部署失败：容器未处于运行中\n'
      }
    } catch (error) {
      ok = false
      log += error instanceof Error ? error.message : '部署失败'
    }
    const id = newId('cdep')
    await databaseOf(this.ctx).query(`
      INSERT INTO ${DEPLOYMENTS} (id, container_id, resource_id, compose_yaml, status)
      VALUES ($1, $2, $3, $4, $5)
    `, [id, containerId, resourceId, compose, ok ? '已部署' : '失败'])
    const deployment = (await this.listDeployments()).find(item => item.id === id) as ComputeDeployment
    return { deployment, log, ok }
  }

  /** @returns recorded deployments, newest first. */
  async listDeployments(): Promise<ComputeDeployment[]> {
    await this.ensureTables()
    const result = await databaseOf(this.ctx).query<DeploymentRow>(`
      SELECT d.*, c.name AS container_name, r.name AS resource_name
      FROM ${DEPLOYMENTS} d
      LEFT JOIN ${CONTAINERS} c ON c.id = d.container_id
      LEFT JOIN ${RESOURCES} r ON r.id = d.resource_id
      ORDER BY d.created_at DESC
    `)
    return result.rows.map(row => ({
      id: row.id,
      containerId: row.container_id,
      containerName: row.container_name ?? '',
      resourceId: row.resource_id,
      resourceName: row.resource_name ?? '',
      composeYaml: row.compose_yaml,
      status: row.status,
      createdAt: stamp(row.created_at),
    }))
  }

  /**
   * List repositories and tags from the Docker registry at the configured address.
   * A connection problem is returned as `error` so the rest of the page still loads.
   */
  async listRegistryImages(keyword = ''): Promise<{ images: RegistryImage[], error: string }> {
    const settings = this.serverSettings()
    if (settings.host.trim() === '') return { images: [], error: '请先在插件配置里填写镜像服务器地址和端口' }
    const host = settings.host.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
    const origin = `${settings.https ? 'https' : 'http'}://${host}:${String(settings.port)}`
    const headers: Record<string, string> = { accept: 'application/json' }
    if (settings.token.trim() !== '') headers.authorization = `Bearer ${settings.token.trim()}`
    const readJson = async (path: string): Promise<unknown> => {
      let response: Response
      try {
        response = await fetch(`${origin}${path}`, { headers, signal: AbortSignal.timeout(8000) })
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法连接镜像服务器'
        throw new CpmError('registry-unreachable', `无法连接镜像服务器 ${host}:${String(settings.port)}（${message}）`, 502)
      }
      if (response.status === 401) throw new CpmError('registry-unauthorized', '镜像服务器要求访问令牌', 401)
      if (!response.ok) throw new CpmError('registry-error', `镜像服务器返回 ${String(response.status)}`, 502)
      return response.json() as Promise<unknown>
    }
    try {
      const catalog = await readJson('/v2/_catalog?n=200')
      const names = isRecord(catalog) && Array.isArray(catalog.repositories)
        ? catalog.repositories.filter((name): name is string => typeof name === 'string')
        : []
      const needle = keyword.trim().toLowerCase()
      const matched = needle === '' ? names : names.filter(name => name.toLowerCase().includes(needle))
      const images = await Promise.all(matched.slice(0, 100).map(async name => {
        let tags: string[] = []
        try {
          const listed = await readJson(`/v2/${name}/tags/list`)
          if (isRecord(listed) && Array.isArray(listed.tags)) tags = listed.tags.filter((tag): tag is string => typeof tag === 'string')
        } catch (_tags) { tags = [] }
        return { name, tags, reference: `${host}:${String(settings.port)}/${name}` }
      }))
      return { images, error: '' }
    } catch (error) {
      if (error instanceof CpmError) return { images: [], error: error.message }
      const message = error instanceof Error ? error.message : '读取镜像仓库失败'
      return { images: [], error: message }
    }
  }

  /** @returns dashboard numbers from the stored catalog. */
  async dashboard(keyword = ''): Promise<ComputeDashboard> {
    const [resources, containers, deployments] = await Promise.all([
      this.listResources(keyword),
      this.listContainers(keyword),
      this.listDeployments(),
    ])
    const average = (pick: (item: ComputeResource) => number | null): number | null => {
      const values = resources.map(pick).filter((value): value is number => value !== null)
      if (values.length === 0) return null
      return values.reduce((sum, value) => sum + value, 0) / values.length
    }
    return {
      resources: resources.length,
      containers: containers.length,
      deployments: deployments.length,
      normal: resources.filter(item => item.status === '正常').length,
      error: resources.filter(item => item.status === '异常').length,
      starting: resources.filter(item => item.status !== '正常' && item.status !== '异常').length,
      averageCpu: average(item => item.cpuPercent),
      averageMemory: average(item => item.memoryPercent),
      averageDisk: average(item => item.diskPercent),
    }
  }

  /**
   * Answer the page.
   * @param request - Fetch request below `/api`.
   */
  async handle(request: Request): Promise<Response> {
    try {
      if (request.method === 'GET') {
        const url = new URL(request.url)
        const debugFile = url.searchParams.get('debugFile')
        if (debugFile !== null && debugFile !== '') {
          const file = await this.openDebugFile(url.searchParams.get('id') || '', url.searchParams.get('containerId') || '', debugFile)
          const encoded = encodeURIComponent(file.name)
          return new Response(file.body, {
            headers: {
              'content-type': 'application/octet-stream',
              'content-length': String(file.size),
              'content-disposition': `attachment; filename*=UTF-8''${encoded}`,
            },
          })
        }
        const fileId = url.searchParams.get('fileId')
        if (fileId !== null && fileId !== '') {
          const file = await this.readFileObject(fileId)
          const download = url.searchParams.get('download') === '1'
          const encoded = encodeURIComponent(file.name)
          return new Response(file.bytes, {
            headers: {
              'content-type': file.contentType,
              'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encoded}`,
              'cache-control': 'private, max-age=60',
            },
          })
        }
        const keyword = url.searchParams.get('keyword') ?? ''
        const registry = await this.listRegistryImages(keyword)
        const stored = await Promise.all([
          this.listResources(keyword),
          this.listContainers(keyword),
          this.listDeployments(),
          this.dashboard(keyword),
        ]).then(([resources, containers, deployments, dashboard]) => ({ resources, containers, deployments, dashboard, catalogError: '' }))
          .catch((error: unknown) => ({
            resources: [],
            containers: [],
            deployments: [],
            dashboard: null,
            catalogError: error instanceof Error ? error.message : '算力目录读取失败',
          }))
        return json({ ...stored, registryImages: registry.images, registryError: registry.error })
      }
      if (request.method !== 'POST') return json({ error: 'method-not-allowed', message: '不支持的方法' }, 405)
      const uploadUrl = new URL(request.url)
      if (uploadUrl.searchParams.get('debugUpload') === '1') {
        const bytes = Buffer.from(await request.arrayBuffer())
        await this.uploadDebugFile(uploadUrl.searchParams.get('id') || '', uploadUrl.searchParams.get('containerId') || '', uploadUrl.searchParams.get('dir') || '/', uploadUrl.searchParams.get('name') || '', bytes)
        return json({ ok: true })
      }
      let payload: unknown
      try { payload = await request.json() }
      catch (_invalid) { throw new CpmError('invalid-input', '请求体不是 JSON', 400) }
      if (!isRecord(payload) || typeof payload.action !== 'string') throw new CpmError('invalid-input', '缺少 action', 400)
      return json(await this.dispatch(payload.action, payload))
    } catch (error) {
      if (error instanceof CpmError) return json({ error: error.code, message: error.message }, error.status)
      const message = error instanceof Error ? error.message : '请求失败'
      this.ctx.logger.warn('cpm: %s', message)
      return json({ error: 'internal', message }, 500)
    }
  }

  private async dispatch(action: string, body: Record<string, unknown>): Promise<unknown> {
    const id = typeof body.id === 'string' ? body.id : ''
    if (action === 'test-connection') { await this.testConnection(this.resourceInput(body)); return { ok: true } }
    if (action === 'resource-metrics') return { metrics: await this.nodeMetrics(id) }
    if (action === 'resource-containers') return { items: await this.nodeContainers(id) }
    if (action === 'resource-container-act') {
      const ids = Array.isArray(body.containerIds) ? body.containerIds.filter((item): item is string => typeof item === 'string') : []
      await this.containerAct(id, ids, typeof body.op === 'string' ? body.op : '')
      return { ok: true }
    }
    if (action === 'resource-container-logs') {
      const tail = typeof body.tail === 'number' ? body.tail : 100
      return { text: await this.containerLogs(id, typeof body.containerId === 'string' ? body.containerId : '', tail) }
    }
    if (action === 'resource-container-exec') {
      return { text: await this.containerExec(id, typeof body.containerId === 'string' ? body.containerId : '', typeof body.command === 'string' ? body.command : '') }
    }
    if (action === 'debug-ticket') return this.debugTicket(id, typeof body.containerId === 'string' ? body.containerId : '')
    if (action === 'debug-files') {
      return { entries: await this.listDebugDir(id, typeof body.containerId === 'string' ? body.containerId : '', typeof body.path === 'string' ? body.path : '/') }
    }
    if (action === 'debug-rename') {
      await this.renameDebug(id, typeof body.containerId === 'string' ? body.containerId : '', typeof body.path === 'string' ? body.path : '', typeof body.name === 'string' ? body.name : '')
      return { ok: true }
    }
    if (action === 'debug-delete') {
      await this.deleteDebug(id, typeof body.containerId === 'string' ? body.containerId : '', typeof body.path === 'string' ? body.path : '')
      return { ok: true }
    }
    if (action === 'debug-paste') {
      await this.pasteDebug(id, typeof body.containerId === 'string' ? body.containerId : '', typeof body.source === 'string' ? body.source : '', typeof body.dir === 'string' ? body.dir : '/')
      return { ok: true }
    }
    if (action === 'create-resource') return { resource: await this.createResource(this.resourceInput(body)) }
    if (action === 'update-resource') return { resource: await this.updateResource(id, this.resourceInput(body)) }
    if (action === 'delete-resource') { await this.deleteResource(id); return { ok: true } }
    if (action === 'report-metrics') return { resource: await this.reportMetrics(id, this.metricsInput(body)) }
    if (action === 'create-container') return { container: await this.createContainer(this.containerInput(body)) }
    if (action === 'update-container') return { container: await this.updateContainer(id, this.containerInput(body)) }
    if (action === 'delete-container') { await this.deleteContainer(id); return { ok: true } }
    if (action === 'list-files') return { files: await this.listFiles() }
    if (action === 'create-folder') return await this.createFolder(requiredText(body.name, '请填写文件夹名称'), typeof body.parentId === 'string' ? body.parentId : '')
    if (action === 'upload-file') {
      return await this.uploadFile(
        requiredText(body.name, '请填写文件名'),
        typeof body.parentId === 'string' ? body.parentId : '',
        typeof body.contentType === 'string' ? body.contentType : '',
        requiredText(body.dataBase64, '请选择文件'),
      )
    }
    if (action === 'delete-file') { await this.deleteFile(requiredText(body.id, '请选择文件')); return { ok: true } }
    if (action === 'deploy') {
      return await this.deploy(
        requiredText(body.containerId, '请选择镜像'),
        requiredText(body.resourceId, '请选择算力资源'),
        typeof body.composeYaml === 'string' ? body.composeYaml : '',
      )
    }
    throw new CpmError('invalid-input', '未知操作', 400)
  }

  private resourceInput(body: Record<string, unknown>): ComputeResourceInput {
    return {
      name: typeof body.name === 'string' ? body.name : '',
      architecture: typeof body.architecture === 'string' ? body.architecture : '',
      cardTypes: strings(body.cardTypes),
      nodeIp: typeof body.nodeIp === 'string' ? body.nodeIp : '',
      sshPort: typeof body.sshPort === 'number' ? body.sshPort : Number(body.sshPort),
      username: typeof body.username === 'string' ? body.username : '',
      password: typeof body.password === 'string' ? body.password : '',
      authMode: typeof body.authMode === 'string' ? body.authMode : 'password',
      privateKey: typeof body.privateKey === 'string' ? body.privateKey : '',
      icon: typeof body.icon === 'string' ? body.icon : '',
      imageRef: typeof body.imageRef === 'string' ? body.imageRef : '',
      remark: typeof body.remark === 'string' ? body.remark : '',
      status: typeof body.status === 'string' ? body.status : undefined,
    }
  }

  private containerInput(body: Record<string, unknown>): ComputeContainerInput {
    return {
      name: typeof body.name === 'string' ? body.name : '',
      architecture: typeof body.architecture === 'string' ? body.architecture : '',
      accelerator: typeof body.accelerator === 'string' ? body.accelerator : '',
      imageVersion: typeof body.imageVersion === 'string' ? body.imageVersion : '',
      composeYaml: typeof body.composeYaml === 'string' ? body.composeYaml : '',
      imageRef: typeof body.imageRef === 'string' ? body.imageRef : '',
      imageSource: typeof body.imageSource === 'string' ? body.imageSource : '',
      imageFileName: typeof body.imageFileName === 'string' ? body.imageFileName : '',
      icon: typeof body.icon === 'string' ? body.icon : '',
      remark: typeof body.remark === 'string' ? body.remark : '',
    }
  }

  private metricsInput(body: Record<string, unknown>): ComputeMetricsInput {
    const numberOrNull = (value: unknown): number | null | undefined => {
      if (value === undefined) return undefined
      if (value === null || value === '') return null
      return typeof value === 'number' ? value : Number(value)
    }
    return {
      cpuPercent: numberOrNull(body.cpuPercent),
      memoryPercent: numberOrNull(body.memoryPercent),
      diskPercent: numberOrNull(body.diskPercent),
      status: typeof body.status === 'string' ? body.status : undefined,
    }
  }

  private async normalizeResource(input: ComputeResourceInput): Promise<Required<ComputeResourceInput>> {
    const name = requiredText(input.name, '请填写算力节点名称')
    const architecture = oneOf(input.architecture, ARCHITECTURES, '请选择系统架构')
    const cardTypes = [...new Set(input.cardTypes)]
    if (cardTypes.length !== 1 || !CARD_TYPES.includes(cardTypes[0])) {
      throw new CpmError('invalid-input', '请选择一种计算卡', 400)
    }
    const nodeIp = requiredText(input.nodeIp, '请填写算力节点 IP')
    if (!/^[\d.a-fA-F:]+$/.test(nodeIp)) throw new CpmError('invalid-input', '算力节点 IP 格式无效', 400)
    const sshPort = Number.isInteger(input.sshPort) ? input.sshPort : 22
    if (sshPort < 1 || sshPort > 65535) {
      throw new CpmError('invalid-input', '请填写有效的 SSH 端口（1–65535）', 400)
    }
    const authMode = oneOf(input.authMode || 'password', AUTH_MODES, '请选择登录方式')
    const username = requiredText(input.username, '请填写账号')
    const password = input.password ?? ''
    const privateKey = input.privateKey ?? ''
    if (authMode === 'password' && password.trim() === '') throw new CpmError('invalid-input', '请填写密码', 400)
    if (authMode === 'certificate' && privateKey.trim() === '') throw new CpmError('invalid-input', '请填写登录证书', 400)
    const icon = (input.icon ?? '').trim()
    if (!icon.startsWith('data:image/') || icon.length > ICON_LIMIT) {
      throw new CpmError('invalid-input', '请上传 1MB 以内的图标', 400)
    }
    const imageRef = requiredText(input.imageRef ?? '', '请选择数传镜像')
    const status = input.status === undefined || input.status === '' ? '启动中' : oneOf(input.status, STATUSES, '状态无效')
    return {
      name, architecture, cardTypes, nodeIp, sshPort, username, password, authMode, privateKey, icon, imageRef,
      remark: input.remark ?? '', status,
    }
  }

  private normalizeContainer(input: ComputeContainerInput): Required<ComputeContainerInput> {
    const imageSource = input.imageSource === undefined || input.imageSource === ''
      ? 'registry'
      : oneOf(input.imageSource, IMAGE_SOURCES, '请选择镜像来源')
    const imageRef = input.imageRef?.trim() ?? ''
    const imageFileName = input.imageFileName?.trim() ?? ''
    if (input.imageSource === 'file' && imageFileName === '') throw new CpmError('invalid-input', '请选择镜像文件', 400)
    if (input.imageSource === 'registry' && imageRef === '') throw new CpmError('invalid-input', '请填写镜像地址', 400)
    const icon = (input.icon ?? '').trim()
    if (icon !== '' && (!icon.startsWith('data:image/') || icon.length > ICON_LIMIT)) {
      throw new CpmError('invalid-input', '请上传 1MB 以内的图标', 400)
    }
    return {
      name: requiredText(input.name, '请填写名称'),
      architecture: oneOf(input.architecture, CONTAINER_ARCHITECTURES, '请选择支持架构'),
      accelerator: oneOf(input.accelerator, ACCELERATORS, '请选择支持计算卡'),
      imageVersion: requiredText(input.imageVersion, '请填写镜像版本'),
      composeYaml: requiredText(input.composeYaml, '请填写 Docker 编排'),
      imageRef: imageSource === 'registry' ? imageRef : '',
      imageSource,
      imageFileName: imageSource === 'file' ? imageFileName : '',
      icon,
      remark: input.remark ?? '',
    }
  }

  private optionalPercent(value: number | null | undefined, label: string): number | null {
    if (value === undefined || value === null) return null
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new CpmError('invalid-input', `${label}用量需要在 0–100`, 400)
    return value
  }

  private resourceFrom(row: ResourceRow): ComputeResource {
    return {
      id: row.id,
      name: row.name,
      architecture: row.architecture,
      cardTypes: strings(row.card_types),
      nodeIp: row.node_ip,
      sshPort: row.ssh_port ?? row.docker_port,
      username: row.username ?? '',
      password: row.password ?? '',
      authMode: row.auth_mode ?? 'password',
      privateKey: row.private_key ?? '',
      icon: row.icon ?? '',
      imageRef: row.image_ref ?? '',
      imageId: row.image_id ?? '',
      imageName: row.image_name ?? '',
      status: row.status,
      remark: row.remark,
      cpuPercent: percent(row.cpu_percent),
      memoryPercent: percent(row.memory_percent),
      diskPercent: percent(row.disk_percent),
      createdAt: stamp(row.created_at),
      updatedAt: stamp(row.updated_at),
    }
  }

  private containerFrom(row: ContainerRow): ComputeContainer {
    return {
      id: row.id,
      name: row.name,
      architecture: row.architecture,
      accelerator: row.accelerator,
      imageVersion: row.image_version,
      composeYaml: row.compose_yaml,
      imageRef: row.image_ref,
      imageSource: row.image_source || 'registry',
      imageFileName: row.image_file_name || '',
      icon: row.icon || '',
      remark: row.remark,
      createdAt: stamp(row.created_at),
      updatedAt: stamp(row.updated_at),
    }
  }
}

const RESOURCE_PROPERTIES = {
  id: { type: 'string', required: true },
  name: { type: 'string', required: true },
  architecture: { type: 'string', required: true },
  nodeIp: { type: 'string', required: true },
  sshPort: { type: 'number', required: true },
  status: { type: 'string', required: true },
  imageId: { type: 'string', required: true },
  imageName: { type: 'string', required: true },
} as const

const CONTAINER_PROPERTIES = {
  id: { type: 'string', required: true },
  name: { type: 'string', required: true },
  architecture: { type: 'string', required: true },
  accelerator: { type: 'string', required: true },
  imageVersion: { type: 'string', required: true },
  imageRef: { type: 'string', required: true },
  imageSource: { type: 'string', required: true },
  remark: { type: 'string', required: true },
} as const

/** @returns a node without its SSH secrets. */
function publicResource(item: ComputeResource) {
  return { ...item, password: '', privateKey: '' }
}

/** @returns true when a stored file is likely safe to decode as UTF-8 text. */
function isTextFile(name: string, contentType: string): boolean {
  return contentType.startsWith('text/')
    || /(?:json|xml|yaml|javascript|typescript)/i.test(contentType)
    || /\.(?:txt|md|json|ya?ml|xml|csv|log|ts|js|html|css|sh)$/i.test(name)
}

/** @returns one compact field for a model-facing list line. */
function textField(item: Record<string, unknown>, key: string): string {
  const value = item[key]
  if (value === undefined || value === null || value === '') return '-'
  if (Array.isArray(value)) {
    if (value.length === 0) return '-'
    return value.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('|')
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** @returns a compact node line with the fields needed to select a node. */
function resourceLine(item: Record<string, unknown>): string {
  const image = textField(item, 'imageRef') === '-' ? textField(item, 'imageName') : textField(item, 'imageRef')
  return [
    `id=${textField(item, 'id')}`,
    `name=${JSON.stringify(textField(item, 'name'))}`,
    `ip=${textField(item, 'nodeIp')}`,
    `sshPort=${textField(item, 'sshPort')}`,
    `arch=${textField(item, 'architecture')}`,
    `cards=${textField(item, 'cardTypes')}`,
    `status=${textField(item, 'status')}`,
    `image=${image}`,
    `cpu=${textField(item, 'cpuPercent')}`,
    `memory=${textField(item, 'memoryPercent')}`,
    `disk=${textField(item, 'diskPercent')}`,
    `remark=${JSON.stringify(textField(item, 'remark') === '-' ? '' : textField(item, 'remark'))}`,
  ].join(' ')
}

/** @returns a compact image line with the fields needed to deploy it. */
function containerLine(item: Record<string, unknown>): string {
  return [
    `id=${textField(item, 'id')}`,
    `name=${JSON.stringify(textField(item, 'name'))}`,
    `arch=${textField(item, 'architecture')}`,
    `accelerator=${textField(item, 'accelerator')}`,
    `version=${textField(item, 'imageVersion')}`,
    `image=${textField(item, 'imageRef')}`,
    `source=${textField(item, 'imageSource')}`,
    `remark=${JSON.stringify(textField(item, 'remark') === '-' ? '' : textField(item, 'remark'))}`,
  ].join(' ')
}

/** @returns a compact deployment line. */
function deploymentLine(item: Record<string, unknown>): string {
  return [
    `id=${textField(item, 'id')}`,
    `image=${JSON.stringify(textField(item, 'containerName'))}`,
    `node=${JSON.stringify(textField(item, 'resourceName'))}`,
    `status=${textField(item, 'status')}`,
    `createdAt=${textField(item, 'createdAt')}`,
  ].join(' ')
}

/** @returns a compact file line. */
function fileLine(item: Record<string, unknown>): string {
  return [
    `id=${textField(item, 'id')}`,
    `kind=${textField(item, 'kind')}`,
    `name=${JSON.stringify(textField(item, 'name'))}`,
    `size=${textField(item, 'size')}`,
    `type=${textField(item, 'contentType')}`,
    `parentId=${textField(item, 'parentId')}`,
  ].join(' ')
}

/** @returns a compact registry image line. */
function registryLine(item: Record<string, unknown>): string {
  return [
    `reference=${textField(item, 'reference')}`,
    `name=${textField(item, 'name')}`,
    `tags=${textField(item, 'tags')}`,
  ].join(' ')
}

/**
 * Register the catalog, its page route, and model tools.
 * @param ctx - host context.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
  const service = new CpmService(ctx, config)
  ctx.inject(['webServer'], (child) => {
    const server = (child as Context & { webServer: { registerUpgrade(route: { path: string, handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void }): () => void } }).webServer
    child.effect(() => server.registerUpgrade({
      path: DEBUG_PATH,
      handler: (req, socket, head) => { void service.acceptDebug(req, socket, head) },
    }))
  })
  ctx.inject(['connection'], (child) => {
    child.effect(() => child.connection.fetch.register({
      path: API_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: request => service.handle(request),
    }), 'cpm: catalog route')
  })
  ctx.inject(['tools'], (child) => {
    child.effect(() => {
      const disposers = [
        child.tools.register(defineTool({
          name: 'list_compute_resources',
          description: 'List compute nodes stored by the compute plugin. Returns each node id, name, IP, SSH port, architecture, card types, status, and metrics. Optional keyword matches name, IP, remark, or image name.',
          parameters: { keyword: { type: 'string', description: 'Optional search text.' } },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { resources: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } } },
            render: (_args, value) => [{ type: 'text', text: value.resources.length === 0 ? '没有算力节点。' : `共 ${value.resources.length} 个算力节点：\n${value.resources.map(item => resourceLine(item)).join('\n')}` }],
          },
          presentCall: () => ({ card: 'generic', kind: 'search', title: '查询算力资源' }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            const resources = await service.listResources(typeof args.keyword === 'string' ? args.keyword : '')
            return { resources: resources.map(item => publicResource(item)) }
          },
        })),
        child.tools.register(defineTool({
          name: 'get_compute_resource',
          description: 'Get one compute node by id, including its SSH address, image reference, status, and reported metrics. Password and private key are omitted.',
          parameters: { id: { type: 'string', required: true, description: 'Node id.' } },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { resource: { type: 'object', required: true, additionalProperties: true, properties: RESOURCE_PROPERTIES } } },
            render: (_args, value) => [{ type: 'text', text: `算力节点：${resourceLine(value.resource)}` }],
          },
          presentCall: args => ({ card: 'generic', kind: 'search', title: `查看算力节点 ${args.id}` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            return { resource: { ...await service.getResource(args.id), password: '', privateKey: '' } }
          },
        })),
        child.tools.register(defineTool({
          name: 'test_compute_connection',
          description: 'Test an SSH login for a saved node by id, or for the supplied connection fields. The saved node credentials are used when id is set.',
          parameters: {
            id: { type: 'string', description: 'Existing node id. Takes precedence over the connection fields.' },
            nodeIp: { type: 'string', description: 'Node IP address when id is omitted.' },
            sshPort: { type: 'number', description: 'SSH port. Defaults to 22.' },
            username: { type: 'string', description: 'SSH account when id is omitted.' },
            password: { type: 'string', description: 'SSH password for password authentication.' },
            authMode: { type: 'string', enum: AUTH_MODES, description: 'password or certificate. Defaults to password.' },
            privateKey: { type: 'string', description: 'PEM private key for certificate authentication.' },
          },
          output: {
            schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
            render: () => [{ type: 'text', text: 'SSH 连接成功。' }],
          },
          presentCall: args => ({ card: 'generic', kind: 'search', title: args.id ? `测试节点 ${args.id} 连接` : '测试算力节点连接' }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            const input: ComputeResourceInput = typeof args.id === 'string' && args.id !== ''
              ? await service.getResource(args.id)
              : {
                  name: '',
                  architecture: 'X86',
                  cardTypes: ['CPU'],
                  nodeIp: args.nodeIp ?? '',
                  sshPort: args.sshPort ?? 22,
                  username: args.username ?? '',
                  password: args.password ?? '',
                  authMode: args.authMode ?? 'password',
                  privateKey: args.privateKey ?? '',
                }
            await service.testConnection(input)
            return { ok: true }
          },
        })),
        child.tools.register(defineTool({
          name: 'create_compute_resource',
          description: 'Create a compute node. Architecture is X86, ARM64, or RISC-V. Card types are CPU, NVIDIA, 天数, and 华为. sshPort defaults to 22. authMode is password or certificate.',
          parameters: {
            name: { type: 'string', required: true, description: 'Node name.' },
            architecture: { type: 'string', required: true, description: 'X86, ARM64, or RISC-V.' },
            cardTypes: { type: 'array', required: true, items: { type: 'string' }, description: 'Exactly one of CPU, NVIDIA, 天数, or 华为.' },
            nodeIp: { type: 'string', required: true, description: 'Node IP address.' },
            sshPort: { type: 'number', description: 'SSH port. Defaults to 22.' },
            username: { type: 'string', required: true, description: 'SSH account.' },
            password: { type: 'string', description: 'SSH password. Required when authMode is password.' },
            authMode: { type: 'string', description: 'password or certificate. Defaults to password.' },
            privateKey: { type: 'string', description: 'PEM private key. Required when authMode is certificate.' },
            icon: { type: 'string', description: 'Optional icon as a data:image URL, at most 1MB.' },
            remark: { type: 'string', description: 'Optional note.' },
            status: { type: 'string', description: '启动中, 正常, or 异常. Defaults to 启动中.' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { resource: { type: 'object', required: true, additionalProperties: true, properties: RESOURCE_PROPERTIES } } },
            render: (_args, value) => [{ type: 'text', text: `已添加算力节点：${resourceLine(value.resource)}` }],
          },
          presentCall: args => ({ card: 'generic', kind: 'edit', title: `添加算力节点「${args.name}」` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            const resource = await service.createResource(args)
            return { resource: publicResource(resource) }
          },
        })),
        child.tools.register(defineTool({
          name: 'update_compute_resource',
          description: 'Update one compute node by id. Send the full node fields, not a partial patch. authMode is password or certificate.',
          parameters: {
            id: { type: 'string', required: true, description: 'Node id.' },
            name: { type: 'string', required: true, description: 'Node name.' },
            architecture: { type: 'string', required: true, description: 'X86, ARM64, or RISC-V.' },
            cardTypes: { type: 'array', required: true, items: { type: 'string' }, description: 'Exactly one of CPU, NVIDIA, 天数, or 华为.' },
            nodeIp: { type: 'string', required: true, description: 'Node IP address.' },
            sshPort: { type: 'number', required: true, description: 'SSH port.' },
            username: { type: 'string', required: true, description: 'SSH account.' },
            password: { type: 'string', description: 'SSH password when authMode is password.' },
            authMode: { type: 'string', required: true, description: 'password or certificate.' },
            privateKey: { type: 'string', description: 'PEM private key when authMode is certificate.' },
            icon: { type: 'string', description: 'Optional icon as a data:image URL, at most 1MB.' },
            remark: { type: 'string', description: 'Optional note.' },
            status: { type: 'string', description: '启动中, 正常, or 异常.' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { resource: { type: 'object', required: true, additionalProperties: true, properties: RESOURCE_PROPERTIES } } },
            render: (_args, value) => [{ type: 'text', text: `已更新算力节点：${resourceLine(value.resource)}` }],
          },
          presentCall: args => ({ card: 'generic', kind: 'edit', title: `更新算力节点 ${args.id}` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            const { id, ...input } = args
            return { resource: publicResource(await service.updateResource(id, input)) }
          },
        })),
        child.tools.register(defineTool({
          name: 'delete_compute_resource',
          description: 'Delete one compute node and its deployment records.',
          parameters: { id: { type: 'string', required: true, description: 'Node id.' } },
          output: {
            schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
            render: () => [{ type: 'text', text: '已删除算力节点。' }],
          },
          presentCall: args => ({ card: 'generic', kind: 'edit', title: `删除算力节点 ${args.id}` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            await service.deleteResource(args.id)
            return { ok: true }
          },
        })),
        child.tools.register(defineTool({
          name: 'report_compute_metrics',
          description: 'Store CPU, memory, and disk usage for one node. Percents are 0–100. Other plugins should call the cpm service method of the same name.',
          parameters: {
            id: { type: 'string', required: true, description: 'Node id.' },
            cpuPercent: { type: 'number', description: 'CPU usage percent.' },
            memoryPercent: { type: 'number', description: 'Memory usage percent.' },
            diskPercent: { type: 'number', description: 'Root disk usage percent.' },
            status: { type: 'string', description: '启动中, 正常, or 异常.' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { resource: { type: 'object', required: true, additionalProperties: true, properties: RESOURCE_PROPERTIES } } },
            render: (_args, value) => [{ type: 'text', text: `已更新用量：${resourceLine(value.resource)}` }],
          },
          presentCall: args => ({ card: 'generic', kind: 'edit', title: `上报节点用量 ${args.id}` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            return { resource: publicResource(await service.reportMetrics(args.id, args)) }
          },
        })),
        child.tools.register(defineTool({
          name: 'get_node_metrics',
          description: 'Read the live metrics document published by the node image at port 19191.',
          parameters: { id: { type: 'string', required: true, description: 'Node id.' } },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { metrics: { type: 'json', required: true } } },
            render: (_args, value) => [{ type: 'text', text: `节点实时指标：\n${JSON.stringify(value.metrics, null, 2)}` }],
          },
          presentCall: args => ({ card: 'generic', kind: 'search', title: `查看节点指标 ${args.id}` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            return { metrics: await service.nodeMetrics(args.id) }
          },
        })),
        child.tools.register(defineTool({
          name: 'list_node_containers',
          description: 'List the Docker containers on one compute node.',
          parameters: { id: { type: 'string', required: true, description: 'Node id.' } },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { containers: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } } },
            render: (_args, value) => [{ type: 'text', text: value.containers.length === 0 ? '节点上没有容器。' : `节点上共 ${value.containers.length} 个容器：\n${JSON.stringify(value.containers, null, 2)}` }],
          },
          presentCall: args => ({ card: 'generic', kind: 'search', title: `查看节点 ${args.id} 的容器` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            return { containers: await service.nodeContainers(args.id) }
          },
        })),
        child.tools.register(defineTool({
          name: 'control_node_containers',
          description: 'Start, stop, restart, or remove one or more Docker containers on a compute node.',
          parameters: {
            id: { type: 'string', required: true, description: 'Node id.' },
            containerIds: { type: 'array', required: true, items: { type: 'string' }, description: 'Container ids or names.' },
            op: { type: 'string', required: true, enum: ['start', 'stop', 'restart', 'remove'], description: 'start, stop, restart, or remove.' },
          },
          output: {
            schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
            render: args => [{ type: 'text', text: `已对容器执行 ${args.op}。` }],
          },
          presentCall: args => ({ card: 'generic', kind: 'edit', title: `${args.op} 节点容器` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            await service.containerAct(args.id, args.containerIds, args.op)
            return { ok: true }
          },
        })),
        child.tools.register(defineTool({
          name: 'get_container_logs',
          description: 'Read the tail of a Docker container log on one compute node. The result is capped at 200000 characters.',
          parameters: {
            id: { type: 'string', required: true, description: 'Node id.' },
            containerId: { type: 'string', required: true, description: 'Container id or name.' },
            tail: { type: 'number', enum: [100, 500, 1000], description: 'Number of lines. Defaults to 100.' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { logs: { type: 'string', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.logs === '' ? '容器日志为空。' : `容器日志：\n${value.logs}` }],
          },
          presentCall: args => ({ card: 'generic', kind: 'search', title: `查看容器 ${args.containerId} 日志` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            return { logs: await service.containerLogs(args.id, args.containerId, args.tail ?? 100) }
          },
        })),
        child.tools.register(defineTool({
          name: 'exec_container_command',
          description: 'Run one command inside a running Docker container on a compute node and return its output. The command is limited to 1000 characters.',
          parameters: {
            id: { type: 'string', required: true, description: 'Node id.' },
            containerId: { type: 'string', required: true, description: 'Container id or name.' },
            command: { type: 'string', required: true, description: 'Shell command to run inside the container.' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { output: { type: 'string', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.output === '' ? '命令执行完成，没有输出。' : `命令输出：\n${value.output}` }],
          },
          presentCall: args => ({ card: 'generic', kind: 'edit', title: `在容器 ${args.containerId} 内执行命令` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            return { output: await service.containerExec(args.id, args.containerId, args.command) }
          },
        })),
        child.tools.register(defineTool({
          name: 'list_registry_images',
          description: 'List container images in the Docker registry configured on the resource plugin page. Each image has a repository name, tags, and a pull reference of host:port/name.',
          parameters: { keyword: { type: 'string', description: 'Optional text matched against the repository name.' } },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { images: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } }, error: { type: 'string', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.error !== '' ? value.error : value.images.length === 0 ? '镜像仓库没有仓库。' : `镜像仓库共 ${value.images.length} 个仓库：\n${value.images.map(item => registryLine(item)).join('\n')}` }],
          },
          presentCall: () => ({ card: 'generic', kind: 'search', title: '查询镜像仓库' }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            return service.listRegistryImages(typeof args.keyword === 'string' ? args.keyword : '')
          },
        })),
        child.tools.register(defineTool({
          name: 'list_compute_containers',
          description: 'List container images in the local repository. Returns each image id, name, architecture, accelerator, version, address, source, and remark. Optional keyword matches name, version, image address, or remark.',
          parameters: { keyword: { type: 'string', description: 'Optional search text.' } },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { containers: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } } },
            render: (_args, value) => [{ type: 'text', text: value.containers.length === 0 ? '没有容器镜像。' : `共 ${value.containers.length} 个容器镜像：\n${value.containers.map(item => containerLine(item)).join('\n')}` }],
          },
          presentCall: () => ({ card: 'generic', kind: 'search', title: '查询镜像仓库' }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            return { containers: await service.listContainers(typeof args.keyword === 'string' ? args.keyword : '') }
          },
        })),
        child.tools.register(defineTool({
          name: 'get_compute_container',
          description: 'Get one container image record by id, including its compose text and registry address.',
          parameters: { id: { type: 'string', required: true, description: 'Image id.' } },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { container: { type: 'object', required: true, additionalProperties: true, properties: CONTAINER_PROPERTIES } } },
            render: (_args, value) => [{ type: 'text', text: `容器镜像：${containerLine(value.container)}` }],
          },
          presentCall: args => ({ card: 'generic', kind: 'search', title: `查看镜像 ${args.id}` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            return { container: await service.getContainer(args.id) }
          },
        })),
        child.tools.register(defineTool({
          name: 'create_compute_container',
          description: 'Create a container image record. Architecture is X86 or ARM64. Accelerator is CPU, NVIDIA, or 天数. composeYaml is the Docker Compose text. imageRef is an optional registry address.',
          parameters: {
            name: { type: 'string', required: true, description: 'Image name.' },
            architecture: { type: 'string', required: true, description: 'X86 or ARM64.' },
            accelerator: { type: 'string', required: true, description: 'CPU, NVIDIA, or 天数.' },
            imageVersion: { type: 'string', required: true, description: 'Image version.' },
            composeYaml: { type: 'string', required: true, description: 'Docker Compose YAML.' },
            imageRef: { type: 'string', description: 'Optional registry address.' },
            remark: { type: 'string', description: 'Optional note.' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { container: { type: 'object', required: true, additionalProperties: true } } },
            render: (_args, value) => [{ type: 'text', text: `已添加镜像：${containerLine(value.container)}` }],
          },
          presentCall: args => ({ card: 'generic', kind: 'edit', title: `新建镜像「${args.name}」` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            return { container: await service.createContainer(args) }
          },
        })),
        child.tools.register(defineTool({
          name: 'update_compute_container',
          description: 'Update one container image by id. Architecture cannot change while a node still uses the image.',
          parameters: {
            id: { type: 'string', required: true, description: 'Image id.' },
            name: { type: 'string', required: true, description: 'Image name.' },
            architecture: { type: 'string', required: true, description: 'X86 or ARM64.' },
            accelerator: { type: 'string', required: true, description: 'CPU, NVIDIA, or 天数.' },
            imageVersion: { type: 'string', required: true, description: 'Image version.' },
            composeYaml: { type: 'string', required: true, description: 'Docker Compose YAML.' },
            imageRef: { type: 'string', description: 'Optional registry address.' },
            remark: { type: 'string', description: 'Optional note.' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { container: { type: 'object', required: true, additionalProperties: true } } },
            render: (_args, value) => [{ type: 'text', text: `已更新镜像：${containerLine(value.container)}` }],
          },
          presentCall: args => ({ card: 'generic', kind: 'edit', title: `更新镜像 ${args.id}` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            const { id, ...input } = args
            return { container: await service.updateContainer(id, input) }
          },
        })),
        child.tools.register(defineTool({
          name: 'delete_compute_container',
          description: 'Delete one container image. Fails when a compute node still references it.',
          parameters: { id: { type: 'string', required: true, description: 'Image id.' } },
          output: {
            schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
            render: () => [{ type: 'text', text: '已删除容器镜像。' }],
          },
          presentCall: args => ({ card: 'generic', kind: 'edit', title: `删除镜像 ${args.id}` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            await service.deleteContainer(args.id)
            return { ok: true }
          },
        })),
        child.tools.register(defineTool({
          name: 'deploy_compute_container',
          description: 'Deploy one container image onto one compute node with docker compose over SSH, and return the command log.',
          parameters: {
            containerId: { type: 'string', required: true, description: 'Image id.' },
            resourceId: { type: 'string', required: true, description: 'Node id.' },
            composeYaml: { type: 'string', description: 'Optional compose override.' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: true,
              properties: {
                deployment: { type: 'object', required: true, additionalProperties: true },
                log: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
              },
            },
            render: (_args, value) => [{ type: 'text', text: `${value.ok ? '部署成功' : '部署失败'}：${textField(value.deployment, 'containerName')} → ${textField(value.deployment, 'resourceName')}\n${value.log}` }],
          },
          presentCall: () => ({ card: 'generic', kind: 'edit', title: '部署容器镜像' }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            return service.deploy(args.containerId, args.resourceId, typeof args.composeYaml === 'string' ? args.composeYaml : '')
          },
        })),
        child.tools.register(defineTool({
          name: 'list_compute_deployments',
          description: 'List recorded container deployments, newest first.',
          parameters: {},
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { deployments: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } } },
            render: (_args, value) => [{ type: 'text', text: value.deployments.length === 0 ? '没有部署记录。' : `共 ${value.deployments.length} 条部署记录：\n${value.deployments.map(item => deploymentLine(item)).join('\n')}` }],
          },
          presentCall: () => ({ card: 'generic', kind: 'search', title: '查询部署记录' }),
          async execute(_args, exec) {
            exec.signal.throwIfAborted()
            return { deployments: await service.listDeployments() }
          },
        })),
        child.tools.register(defineTool({
          name: 'list_compute_files',
          description: 'List files and folders stored by the resource plugin, including their id, parent folder, kind, content type, and size.',
          parameters: {},
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { files: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } } },
            render: (_args, value) => [{ type: 'text', text: value.files.length === 0 ? '没有文件和文件夹。' : `共 ${value.files.length} 个文件和文件夹：\n${value.files.map(item => fileLine(item)).join('\n')}` }],
          },
          presentCall: () => ({ card: 'generic', kind: 'search', title: '查询资源文件' }),
          async execute(_args, exec) {
            exec.signal.throwIfAborted()
            return { files: await service.listFiles() }
          },
        })),
        child.tools.register(defineTool({
          name: 'create_compute_folder',
          description: 'Create a folder in the resource plugin file storage. parentId is empty for the root folder.',
          parameters: {
            name: { type: 'string', required: true, description: 'Folder name.' },
            parentId: { type: 'string', description: 'Parent folder id. Omit for the root.' },
          },
          output: {
            schema: { type: 'object', additionalProperties: false, properties: { folderId: { type: 'string', required: true } } },
            render: (_args, value) => [{ type: 'text', text: `已创建文件夹，id=${value.folderId}。` }],
          },
          presentCall: args => ({ card: 'generic', kind: 'edit', title: `新建文件夹「${args.name}」` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            return { folderId: (await service.createFolder(args.name, args.parentId ?? '')).id }
          },
        })),
        child.tools.register(defineTool({
          name: 'upload_compute_file',
          description: 'Upload a file to the resource plugin file storage. dataBase64 is the file body encoded as base64, up to 32 MB.',
          parameters: {
            name: { type: 'string', required: true, description: 'File name.' },
            parentId: { type: 'string', description: 'Parent folder id. Omit for the root.' },
            contentType: { type: 'string', description: 'MIME type. Defaults to application/octet-stream.' },
            dataBase64: { type: 'string', required: true, description: 'Base64-encoded file body.' },
          },
          output: {
            schema: { type: 'object', additionalProperties: false, properties: { fileId: { type: 'string', required: true } } },
            render: (_args, value) => [{ type: 'text', text: `已上传文件，id=${value.fileId}。` }],
          },
          presentCall: args => ({ card: 'generic', kind: 'edit', title: `上传文件「${args.name}」` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            return { fileId: (await service.uploadFile(args.name, args.parentId ?? '', args.contentType ?? '', args.dataBase64)).id }
          },
        })),
        child.tools.register(defineTool({
          name: 'read_compute_file',
          description: 'Read a stored file. Text files return a UTF-8 string; other files return base64. The result is capped at maxBytes, 256 KB by default and 1 MB maximum.',
          parameters: {
            id: { type: 'string', required: true, description: 'File id.' },
            maxBytes: { type: 'number', description: 'Maximum bytes to return. Defaults to 262144 and cannot exceed 1048576.' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                contentType: { type: 'string', required: true },
                size: { type: 'number', required: true },
                truncated: { type: 'boolean', required: true },
                text: { type: 'string', required: true },
                dataBase64: { type: 'string', required: true },
              },
            },
            render: (_args, value) => [{
              type: 'text',
              text: `文件 ${value.name}（${value.contentType}，${value.size} 字节${value.truncated ? '，已截断' : ''}）\n${value.text !== '' ? value.text : value.dataBase64 !== '' ? `base64:\n${value.dataBase64}` : '（空）'}`,
            }],
          },
          presentCall: args => ({ card: 'generic', kind: 'search', title: `读取文件 ${args.id}` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            const file = await service.readFileObject(args.id)
            const requested = typeof args.maxBytes === 'number' && Number.isFinite(args.maxBytes) ? args.maxBytes : 262144
            const limit = Math.max(1, Math.min(1_048_576, Math.floor(requested)))
            const bytes = file.bytes.subarray(0, limit)
            const textual = isTextFile(file.name, file.contentType)
            return {
              name: file.name,
              contentType: file.contentType,
              size: file.bytes.length,
              truncated: file.bytes.length > bytes.length,
              text: textual ? bytes.toString('utf8') : '',
              dataBase64: textual ? '' : bytes.toString('base64'),
            }
          },
        })),
        child.tools.register(defineTool({
          name: 'delete_compute_file',
          description: 'Delete a stored file, or a folder and everything inside it.',
          parameters: { id: { type: 'string', required: true, description: 'File or folder id.' } },
          output: {
            schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
            render: () => [{ type: 'text', text: '已删除。' }],
          },
          presentCall: args => ({ card: 'generic', kind: 'edit', title: `删除文件 ${args.id}` }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            await service.deleteFile(args.id)
            return { ok: true }
          },
        })),
        child.tools.register(defineTool({
          name: 'compute_dashboard',
          description: 'Summarize the local compute catalog: node status counts, image count, deployment count, and average CPU, memory, and disk when metrics have been reported.',
          parameters: {},
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { dashboard: { type: 'object', required: true, additionalProperties: true } } },
            render: (_args, value) => [{
              type: 'text',
              text: `节点 ${value.dashboard.resources}（正常 ${value.dashboard.normal}，异常 ${value.dashboard.error}，启动中 ${value.dashboard.starting}），镜像 ${value.dashboard.containers}，部署 ${value.dashboard.deployments}。`,
            }],
          },
          presentCall: () => ({ card: 'generic', kind: 'search', title: '算力看板' }),
          async execute(_args, exec) {
            exec.signal.throwIfAborted()
            return { dashboard: await service.dashboard() }
          },
        })),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, 'cpm: model tools')
  })
}

const PTY_BRIDGE = `
import os, sys, select, signal, struct, fcntl, termios
cmd = sys.argv[1:]
pid, fd = __import__('pty').fork()
if pid == 0:
    os.execvpe(cmd[0], cmd, os.environ)
def winsize(cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    try:
        os.kill(pid, signal.SIGWINCH)
    except OSError:
        pass
for stream in (0, 3):
    os.set_blocking(stream, False)
os.set_blocking(fd, False)
pending = b''
alive = True
while alive:
    watch = [fd, 0, 3]
    try:
        ready, _, _ = select.select(watch, [], [])
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if data == b'':
            break
        os.write(1, data)
    if 0 in ready:
        try:
            data = os.read(0, 65536)
        except OSError:
            data = b''
        if data == b'':
            alive = False
        else:
            os.write(fd, data)
    if 3 in ready:
        try:
            chunk = os.read(3, 256)
        except OSError:
            chunk = b''
        pending += chunk
        while b'\\n' in pending:
            line, pending = pending.split(b'\\n', 1)
            parts = line.split()
            if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                winsize(int(parts[0]), int(parts[1]))
os.close(fd)
`

/** Read masked client frames from one debug socket. */
class FrameReader {
  onText: (text: string) => void = () => {}
  onData?: (text: string) => void
  onResize?: (cols: number, rows: number) => void
  onFs?: (message: Record<string, unknown>) => void
  private buffer: Buffer

  constructor(socket: Duplex, head: Buffer) {
    this.buffer = Buffer.from(head)
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.drain(socket)
    })
  }

  private drain(socket: Duplex): void {
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 0x0f
      let length = this.buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        socket.destroy()
        return
      }
      if ((this.buffer[1] & 0x80) === 0 || this.buffer.length < offset + 4 + length) return
      const mask = this.buffer.subarray(offset, offset + 4)
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length))
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
      this.buffer = this.buffer.subarray(offset + 4 + length)
      if (opcode === 8) { socket.end(); return }
      if (opcode === 9) socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]))
      if (opcode === 1) this.onText(payload.toString('utf8'))
    }
  }
}

/** Encode one server text frame. */
function encodeText(text: string): Buffer {
  const payload = Buffer.from(text)
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, 0, 0])
  if (payload.length >= 126) head.writeUInt16BE(payload.length, 2)
  return Buffer.concat([head, payload])
}
