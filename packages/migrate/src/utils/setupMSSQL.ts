import fs from 'fs'
import mssql from 'mssql'
import path from 'path'
import { URL } from 'url'

export type SetupParams = {
  connectionString: string
  dirname: string
}
function getMSSQLConfig(url: string): mssql.config {
  const connectionUrl = new URL(url)
  return {
    user: connectionUrl.username,
    password: connectionUrl.password,
    server: connectionUrl.hostname,
    port: Number(connectionUrl.port),
    database: connectionUrl.pathname.substring(1),
    pool: {
      max: 1,
    },
    options: {
      enableArithAbort: false,
      trustServerCertificate: true, // change to true for local dev / self-signed certs
    },
  }
}

export async function setupMSSQL(options: SetupParams): Promise<void> {
  const { connectionString } = options
  const { dirname } = options
  const config = getMSSQLConfig(connectionString)
  const connectionPool = new mssql.ConnectionPool(config)
  const connection = await connectionPool.connect()

  try {
    await connection.query(`
      CREATE DATABASE [tests-migrate-shadowdb]
      CREATE DATABASE [tests-migrate]
    `)
  } catch (e) {
    console.warn(e)
  }

  if (dirname !== '') {
    let schema = 'USE [tests-migrate]\n'
    schema += fs.readFileSync(path.join(dirname, 'setup.sql'), 'utf-8')
    await connection.query(schema)
  }

  await connection.close()
}

export async function tearDownMSSQL(options: SetupParams) {
  const { connectionString } = options
  const config = getMSSQLConfig(connectionString)
  const connectionPool = new mssql.ConnectionPool(config)
  const connection = await connectionPool.connect()

  await connection.query(`
    DROP DATABASE IF EXISTS "tests-migrate-shadowdb";
    DROP DATABASE IF EXISTS "tests-migrate";
`)
  await connection.close()
}
