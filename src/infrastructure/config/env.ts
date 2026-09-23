export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

export const AuthMode = {
  /**
   * Sin verificacion de identidad. Solo existe para desarrollo y pruebas: un
   * binario con `NODE_ENV=production` y este modo NO ARRANCA (ADR-004).
   */
  Disabled: 'disabled',
  /** Se exige un testimonio firmado por el user pool de Cognito. */
  Jwt: 'jwt',
} as const

export type AuthMode = (typeof AuthMode)[keyof typeof AuthMode]

export interface CognitoConfig {
  readonly userPoolId: string
  readonly clientId: string
}

export const PersistenceDriver = {
  Memory: 'memory',
  Postgres: 'postgres',
} as const

export type PersistenceDriver = (typeof PersistenceDriver)[keyof typeof PersistenceDriver]

/**
 * Como habla Missions con otro servicio. Lo usan la reserva del heroe (HU-70,
 * `HERO_COMMITMENTS_DRIVER`), sus habilidades y su perfil (HU-71 y HU-72,
 * `HERO_ABILITIES_DRIVER`) y la simulacion en Combat (HU-72,
 * `COMBAT_SIMULATION_DRIVER`).
 *
 * - `http`: el contrato interno. Es el unico permitido en produccion. Hasta que
 *   Team Alfa publique las rutas, la matricula queda PENDING, guardar una
 *   estrategia responde 503 y la simulacion espera: es el resultado honesto.
 * - `memory`: dobles de desarrollo.
 */
export const IntegrationDriver = {
  Memory: 'memory',
  Http: 'http',
} as const

export type IntegrationDriver = (typeof IntegrationDriver)[keyof typeof IntegrationDriver]

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production'
  readonly serviceName: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  readonly port: number
  readonly globalPrefix: string
  readonly swaggerEnabled: boolean
  readonly persistenceDriver: PersistenceDriver
  readonly databaseUrl: string | null
  readonly authMode: AuthMode
  readonly cognito: CognitoConfig | null
  readonly internalServiceAuthSecret: string | null
  readonly heroCommitmentsDriver: IntegrationDriver
  readonly heroAbilitiesDriver: IntegrationDriver
  /** Sin barra final. `null`: las reservas quedan sin confirmar y lo avisa el registro. */
  readonly playerInventoryBaseUrl: string | null
  readonly internalHttpTimeoutMs: number
  /** Reconciliador de matriculas PENDING; apagado por defecto, como los demas temporizadores. */
  readonly enrollmentReconcilerEnabled: boolean
  readonly enrollmentReconcilerIntervalMs: number
  readonly combatSimulationDriver: IntegrationDriver
  /** Sin barra final. `null`: las simulaciones no se piden y lo avisa el registro. */
  readonly combatBaseUrl: string | null
  /** La simulacion es acelerada, pero mas larga que una llamada corriente. */
  readonly combatSimulationTimeoutMs: number
  /** Planificador de HU-72; apagado por defecto, como los demas temporizadores. */
  readonly missionExecutionEnabled: boolean
  readonly missionExecutionIntervalMs: number
  /** Misiones de ejemplo del curso, solo con persistencia en memoria. */
  readonly exampleCatalog: boolean
}

type RawEnv = Readonly<Record<string, string | undefined>>

const readEnum = <T extends string>(
  env: RawEnv,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T => {
  const raw = env[key]

  if (raw === undefined || raw === '') {
    return fallback
  }

  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigurationError(
      `${key} debe ser uno de: ${allowed.join(', ')}. Se recibio "${raw}".`,
    )
  }

  return raw as T
}

const readInteger = (
  env: RawEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = env[key]

  if (raw === undefined || raw === '') {
    return fallback
  }

  const parsed = Number(raw)

  if (!Number.isInteger(parsed)) {
    throw new ConfigurationError(`${key} debe ser un numero entero. Se recibio "${raw}".`)
  }

  if (parsed < min || parsed > max) {
    throw new ConfigurationError(
      `${key} debe estar entre ${String(min)} y ${String(max)}. Se recibio ${String(parsed)}.`,
    )
  }

  return parsed
}

const readString = (env: RawEnv, key: string, fallback: string): string => {
  const raw = env[key]

  return raw === undefined || raw === '' ? fallback : raw
}

const readBoolean = (env: RawEnv, key: string, fallback: boolean): boolean => {
  const raw = env[key]

  if (raw === undefined || raw === '') {
    return fallback
  }

  if (raw !== 'true' && raw !== 'false') {
    throw new ConfigurationError(`${key} debe ser "true" o "false". Se recibio "${raw}".`)
  }

  return raw === 'true'
}

/**
 * Construye la configuracion a partir del entorno. Es una funcion pura sobre
 * `env`: no lee `process.env` directamente, de modo que puede verificarse por
 * completo sin contaminar el proceso de pruebas.
 *
 * Falla de inmediato ante una configuracion invalida. Un servicio mal
 * configurado no debe arrancar y aparentar salud.
 */
export const loadConfig = (env: RawEnv): AppConfig => {
  const nodeEnv = readEnum(
    env,
    'NODE_ENV',
    ['development', 'test', 'production'] as const,
    'development',
  )

  const persistenceDriver = readEnum(
    env,
    'PERSISTENCE_DRIVER',
    [PersistenceDriver.Memory, PersistenceDriver.Postgres],
    PersistenceDriver.Memory,
  )

  const databaseUrl = readString(env, 'DATABASE_URL', '')

  if (persistenceDriver === PersistenceDriver.Postgres && databaseUrl === '') {
    throw new ConfigurationError(
      'DATABASE_URL es obligatorio cuando PERSISTENCE_DRIVER es "postgres".',
    )
  }

  const authMode = readEnum(env, 'AUTH_MODE', [AuthMode.Disabled, AuthMode.Jwt], AuthMode.Disabled)

  if (nodeEnv === 'production' && authMode === AuthMode.Disabled) {
    throw new ConfigurationError(
      'AUTH_MODE no puede ser "disabled" con NODE_ENV=production. Sin verificacion de ' +
        'identidad el servicio no debe exponerse. Vease ADR-004.',
    )
  }

  const cognitoUserPoolId = readString(env, 'COGNITO_USER_POOL_ID', '')
  const cognitoClientId = readString(env, 'COGNITO_CLIENT_ID', '')

  if (authMode === AuthMode.Jwt && (cognitoUserPoolId === '' || cognitoClientId === '')) {
    throw new ConfigurationError(
      'COGNITO_USER_POOL_ID y COGNITO_CLIENT_ID son obligatorios cuando AUTH_MODE es "jwt".',
    )
  }

  // Se comprueba DESPUES de la identidad a proposito: la imagen sin configurar
  // debe negarse a arrancar nombrando AUTH_MODE, que es lo que verifica la CI.
  //
  // Una matricula que desaparece al reiniciar deja heroes bloqueados sin mision.
  // La persistencia en memoria es un doble de desarrollo y pruebas, nunca un
  // modo de produccion.
  if (nodeEnv === 'production' && persistenceDriver === PersistenceDriver.Memory) {
    throw new ConfigurationError(
      'PERSISTENCE_DRIVER no puede ser "memory" con NODE_ENV=production. Vease ADR-019.',
    )
  }

  const internalServiceAuthSecret = readString(env, 'INTERNAL_SERVICE_AUTH_SECRET', '')

  const readIntegrationDriver = (name: string): IntegrationDriver => {
    const driver = readEnum(
      env,
      name,
      [IntegrationDriver.Memory, IntegrationDriver.Http],
      nodeEnv === 'production' ? IntegrationDriver.Http : IntegrationDriver.Memory,
    )

    // Un doble que concede sin preguntar dejaria al mismo heroe en una batalla y
    // en una mision a la vez, guardaria habilidades que el heroe no tiene o daria
    // por simulada una mision que Combat nunca jugo.
    if (nodeEnv === 'production' && driver === IntegrationDriver.Memory) {
      throw new ConfigurationError(`${name} no puede ser "memory" con NODE_ENV=production.`)
    }

    return driver
  }

  const heroCommitmentsDriver = readIntegrationDriver('HERO_COMMITMENTS_DRIVER')
  const heroAbilitiesDriver = readIntegrationDriver('HERO_ABILITIES_DRIVER')
  const combatSimulationDriver = readIntegrationDriver('COMBAT_SIMULATION_DRIVER')

  const exampleCatalog = readBoolean(env, 'MISSIONS_EXAMPLE_CATALOG', false)

  if (exampleCatalog && persistenceDriver !== PersistenceDriver.Memory) {
    throw new ConfigurationError(
      'MISSIONS_EXAMPLE_CATALOG solo se admite con PERSISTENCE_DRIVER=memory: el ejemplo del ' +
        'curso no es contenido aprobado.',
    )
  }

  const playerInventoryBaseUrl = readString(env, 'PLAYER_INVENTORY_BASE_URL', '').replace(
    /\/+$/,
    '',
  )
  const combatBaseUrl = readString(env, 'COMBAT_BASE_URL', '').replace(/\/+$/, '')

  return {
    nodeEnv,
    serviceName: readString(env, 'SERVICE_NAME', 'nexus-battle-missions'),
    version: readString(env, 'SERVICE_VERSION', '0.1.0'),
    logLevel: readEnum(env, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
    port: readInteger(env, 'PORT', 3007, 1, 65_535),
    globalPrefix: readString(env, 'GLOBAL_PREFIX', 'api'),
    // La documentacion interactiva permanece deshabilitada en produccion salvo
    // decision explicita: expone la superficie completa de la API.
    swaggerEnabled: readBoolean(env, 'SWAGGER_ENABLED', nodeEnv !== 'production'),
    persistenceDriver,
    databaseUrl: databaseUrl === '' ? null : databaseUrl,
    authMode,
    cognito:
      authMode === AuthMode.Jwt
        ? { userPoolId: cognitoUserPoolId, clientId: cognitoClientId }
        : null,
    internalServiceAuthSecret: internalServiceAuthSecret === '' ? null : internalServiceAuthSecret,
    heroCommitmentsDriver,
    heroAbilitiesDriver,
    playerInventoryBaseUrl: playerInventoryBaseUrl === '' ? null : playerInventoryBaseUrl,
    internalHttpTimeoutMs: readInteger(env, 'INTERNAL_HTTP_TIMEOUT_MS', 3_000, 100, 30_000),
    enrollmentReconcilerEnabled: readBoolean(env, 'ENROLLMENT_RECONCILER_ENABLED', false),
    enrollmentReconcilerIntervalMs: readInteger(
      env,
      'ENROLLMENT_RECONCILER_INTERVAL_MS',
      15_000,
      1_000,
      3_600_000,
    ),
    combatSimulationDriver,
    combatBaseUrl: combatBaseUrl === '' ? null : combatBaseUrl,
    combatSimulationTimeoutMs: readInteger(
      env,
      'COMBAT_SIMULATION_TIMEOUT_MS',
      15_000,
      1_000,
      120_000,
    ),
    missionExecutionEnabled: readBoolean(env, 'MISSION_EXECUTION_ENABLED', false),
    missionExecutionIntervalMs: readInteger(
      env,
      'MISSION_EXECUTION_INTERVAL_MS',
      15_000,
      1_000,
      3_600_000,
    ),
    exampleCatalog,
  }
}
