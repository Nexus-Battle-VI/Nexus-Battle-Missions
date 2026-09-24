import { execFileSync, spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import type { Readable } from 'node:stream'

import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'

/**
 * Arranque de las piezas REALES de la cadena HU-09 (Task HU-09.6).
 *
 * POR QUE PROCESOS HIJOS Y NO IMPORTACIONES. HU-23 intento levantar dos
 * `AppModule` de repos distintos en el mismo proceso de Jest y no se pudo: cada
 * repositorio trae su copia de `@nestjs/core` y los guards globales del modulo
 * importado inyectan SU `Reflector`, que el modulo de pruebas no puede resolver
 * (`docs/hu-23-validacion-cruzada.md` §1). Aqui no se importa nada de los repos
 * hermanos: se compilan y se arrancan como PROCESOS (`node dist/main.js`), cada
 * uno con su `node_modules` y su MongoDB. Lo unico que cruza es HTTP firmado, que
 * es exactamente lo que se quiere probar.
 *
 * Los servicios hermanos no migran al arrancar: hay que ejecutar su `npm run
 * migrate` antes de levantar el proceso.
 */

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

/** El secreto compartido es del escenario, no un secreto real. */
export const INTERNAL_SECRET = 'secreto-cadena-hu-09'

export interface Sibling {
  readonly name: string
  readonly dir: string
  readonly port: number
  readonly baseUrl: string
  readonly commit: string
  readonly dirty: boolean
  /** `true` cuando el proceso responde `ready`. */
  readonly isUp: () => boolean
  start: () => Promise<void>
  stop: () => Promise<void>
  logs: () => string
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/**
 * En Windows `npm` es un `.cmd` y, desde Node 20, no se puede ejecutar sin shell
 * (la correccion de CVE-2024-27980 lo prohibe). En Linux se ejecuta directo.
 */
const npmOptions = { shell: process.platform === 'win32' } as const

const runNpm = (dir: string, args: readonly string[], env: NodeJS.ProcessEnv): void => {
  execFileSync(npm, [...args], {
    cwd: dir,
    env,
    stdio: 'pipe',
    encoding: 'utf8',
    ...npmOptions,
  })
}

const git = (dir: string, args: readonly string[]): string =>
  execFileSync('git', [...args], { cwd: dir, encoding: 'utf8' }).trim()

/** El commit del repositorio, para el reporte de ejecucion. */
export const commitOf = (dir: string): string => git(dir, ['rev-parse', 'HEAD'])

/** `true` si el repositorio tiene cambios sin confirmar: el reporte lo dice. */
export const isDirty = (dir: string): boolean => git(dir, ['status', '--porcelain']).length > 0

/**
 * Localiza un repositorio hermano. NO SE SALTA LA PRUEBA SI FALTA: una cadena que
 * no se ejecuta no demuestra nada, asi que el escenario falla con el motivo.
 */
export const siblingDir = (envName: string, repository: string): string => {
  const dir = path.resolve(process.env[envName] ?? path.join(REPO_ROOT, '..', repository))

  if (!existsSync(path.join(dir, 'package.json'))) {
    throw new Error(
      `La cadena de HU-09 necesita el repositorio ${repository} en ${dir}. ` +
        `Clonalo junto a este o define ${envName}.`,
    )
  }

  return dir
}

/** Un puerto libre de la maquina, para no chocar con nada de quien ejecuta. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()

      if (address === null || typeof address === 'string') {
        reject(new Error('No se pudo reservar un puerto libre.'))
        return
      }

      const { port } = address

      server.close(() => {
        resolve(port)
      })
    })
  })

const ready = async (baseUrl: string): Promise<boolean> => {
  try {
    const response = await fetch(`${baseUrl}/api/health/ready`)

    return response.ok
  } catch {
    return false
  }
}

const waitForReady = async (baseUrl: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await ready(baseUrl)) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(`El servicio ${baseUrl} no llego a "ready" en ${String(timeoutMs)} ms.`)
}

export interface SiblingOptions {
  readonly name: string
  readonly dir: string
  readonly mongoUri: string
  /** Extra para el proceso; Combat fija ademas la semilla de HU-24. */
  readonly extraEnv?: Readonly<Record<string, string>>
}

/**
 * Arranca un servicio hermano de verdad: compilado, migrado y escuchando.
 *
 * `NODE_ENV=test` es deliberado: con `production` los dos servicios exigen las
 * URLs de sus propios consumidores y se niegan a arrancar con `AUTH_MODE=disabled`,
 * que aqui es correcto porque la unica superficie que se ejerce es la interna
 * (firmada con HMAC) y la de salud.
 */
export const startSibling = async (options: SiblingOptions): Promise<Sibling> => {
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${String(port)}`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PERSISTENCE_DRIVER: 'mongo',
    MONGODB_URI: `${options.mongoUri}/?directConnection=true`,
    AUTH_MODE: 'disabled',
    INTERNAL_SERVICE_AUTH_SECRET: INTERNAL_SECRET,
    LOG_LEVEL: 'error',
    SWAGGER_ENABLED: 'false',
    PORT: String(port),
    ...options.extraEnv,
  }

  if (
    !existsSync(path.join(options.dir, 'dist', 'main.js')) ||
    process.env.HU09_E2E_REBUILD === '1'
  ) {
    runNpm(options.dir, ['run', 'build'], env)
  }

  runNpm(options.dir, ['run', 'migrate'], env)

  let child: ChildProcessByStdio<null, Readable, Readable> | null = null
  let output = ''
  let up = false

  const collect = (chunk: Buffer): void => {
    output += chunk.toString('utf8')
  }

  const start = async (): Promise<void> => {
    if (up) {
      return
    }

    output = ''
    const spawned = spawn(process.execPath, ['dist/main.js'], {
      cwd: options.dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child = spawned
    spawned.stdout.on('data', collect)
    spawned.stderr.on('data', collect)
    spawned.on('exit', () => {
      up = false
    })

    try {
      await waitForReady(baseUrl, 60_000)
    } catch (error: unknown) {
      const detail = output.split('\n').slice(-40).join('\n')

      throw new Error(`${options.name} no arranco. Ultimas lineas de su salida:\n${detail}`, {
        cause: error,
      })
    }

    up = true
  }

  const stop = async (): Promise<void> => {
    const running = child

    if (running?.exitCode != null) {
      up = false
      child = null
      return
    }

    if (running === null) {
      up = false
      return
    }

    await new Promise<void>((resolve) => {
      running.once('exit', () => {
        resolve()
      })
      running.kill('SIGTERM')
      setTimeout(() => {
        running.kill('SIGKILL')
        resolve()
      }, 10_000)
    })

    child = null
    up = false
  }

  return {
    name: options.name,
    dir: options.dir,
    port,
    baseUrl,
    commit: commitOf(options.dir),
    dirty: isDirty(options.dir),
    isUp: () => up,
    start,
    stop,
    logs: () => output,
  }
}

/** Un MongoDB REAL en replica: los dos servicios lo comparten con bases distintas. */
export const startMongo = async (): Promise<StartedMongoDBContainer> =>
  new MongoDBContainer('mongo:8.0').start()

export interface ScriptResult {
  readonly command: string
  readonly ok: boolean
  /** La salida completa: el escenario de las guardas afirma sobre ella. */
  readonly output: string
  readonly tail: string
}

/**
 * Ejecuta un script de npm en un repositorio y devuelve su resultado.
 *
 * Lo usa el escenario de las guardas de no-duplicacion: la Task exige que esten en
 * verde EN EL CODIGO QUE SE ESTA PROBANDO, y ese codigo es el del commit clonado,
 * no el de la copia de quien ejecuta.
 *
 * SE LEEN LAS DOS SALIDAS, y no es un detalle: Jest escribe su resumen por
 * `stderr` (el arbol de pruebas va por `stdout`). Quedarse con `stdout` deja al
 * escenario sin el «Test Suites: 1 passed» que afirma, y el aserto falla aunque
 * las guardas esten verdes.
 *
 * EL FILTRO ES `--testPathPatterns`, tampoco por casualidad: Jest 30 retiro el
 * patron posicional, asi que `jest --selectProjects unit hu-09-reward-policy`
 * corre el proyecto ENTERO y sale en verde. Ese es exactamente el modo de que una
 * guarda deje de vigilar sin que nadie se entere.
 */
export const runNpmScript = (dir: string, args: readonly string[]): ScriptResult => {
  const command = `npm ${args.join(' ')}`
  const result = spawnSync(npm, [...args], {
    cwd: dir,
    encoding: 'utf8',
    ...npmOptions,
    maxBuffer: 32 * 1024 * 1024,
  })
  const output = `${result.stdout}\n${result.stderr}`
  const ok = result.status === 0

  return {
    command,
    ok,
    output,
    tail: output
      .split('\n')
      .slice(ok ? -5 : -20)
      .join('\n'),
  }
}
